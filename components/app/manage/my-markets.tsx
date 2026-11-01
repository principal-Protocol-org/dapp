"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { ManagerSignFlow } from "@/components/app/manage/manager-sign-flow"
import { formatDuration, UNAVAILABLE } from "@/components/app/live"
import { liquidityText } from "@/components/app/market/liquidity"
import { marketStatus } from "@/components/app/markets/market-groups"
import { StatusBadge } from "@/components/app/markets/status-badge"
import { useManifest } from "@/components/app/manifest-provider"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useManifestFindings } from "@/hooks/use-manifest-findings"
import { useMarketStates } from "@/hooks/use-market-state"
import { useAccruedFees, useMyRoles } from "@/hooks/use-manage"
import { useWallet } from "@/hooks/use-wallet"
import type { Blocker } from "@/lib/protocol/gates"
import { formatAmount, shorten } from "@/lib/protocol/format"
import {
  claimCreatorFeesCall,
  claimProtocolFeesCall,
  setPausedCall,
  type FeeContract,
  type ManagerCall,
  type PausableContract,
} from "@/lib/protocol/manager-calls"
import { evaluateManagerGates } from "@/lib/protocol/manager-gates"
import type { MarketState } from "@/lib/protocol/market-state"
import {
  heldRoles,
  rolesForCall,
  type AdminContract,
  type HeldRoles,
  type MarketRoles,
  type Role,
  type SharedRoles,
} from "@/lib/protocol/roles"
import type { InvalidMarket } from "@/lib/server/registry"
import type { Live, Market } from "@/lib/protocol/types"

/** Passed from the server page: the registry rows the app does not list (R2-38). */
export type InvalidMarkets = { status: "ok"; rows: InvalidMarket[] } | { status: "unavailable" }

const ROLE_NAME: Record<Role, string> = {
  issuer: "Issuer",
  creator: "Creator",
  protocolAdmin: "Protocol admin",
  contractAdmin: "Contract admin",
  routerAdmin: "Router admin",
  riskControlAdmin: "RiskControl admin",
  permissioningAdmin: "Permissioning admin",
}
const CONTRACT_NAME: Record<AdminContract, string> = { pool: "pool", sy: "SY wrapper", manager: "manager" }

function unavailableText(error: string) {
  return `${UNAVAILABLE} (${error})`
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="label">{label}</dt>
      <dd className="text-sm break-words text-ink">{children}</dd>
    </div>
  )
}

function rolesText(held: HeldRoles) {
  const names = held.held.map((r) =>
    r === "contractAdmin" ? `${ROLE_NAME[r]} (${held.contractAdminOf.map((k) => CONTRACT_NAME[k]).join(", ")})` : ROLE_NAME[r],
  )
  return names
}

function oracleText(ms: MarketState | undefined, ledgerTime: number | null): string {
  if (!ms) return "Loading"
  if (ms.oracleFresh.status === "unavailable") return unavailableText(ms.oracleFresh.error)
  const age =
    ledgerTime !== null && ms.oracleTimestamp.status === "live" ? `, updated ${formatDuration(ledgerTime - Number(ms.oracleTimestamp.value))} ago` : ""
  return `${ms.oracleFresh.value ? "Fresh" : "Stale"}${age}`
}

type CardProps = {
  market: Market
  ms: MarketState | undefined
  ledgerTime: number | null
  /** Read-only: the "All" view of a market the wallet holds no role on. */
  readOnly: boolean
  roles?: MarketRoles
  shared?: SharedRoles
  account: string | null
}

const PAUSE_STATE: Record<AdminContract, keyof Pick<MarketState, "poolPaused" | "syPaused"> | null> = {
  pool: "poolPaused",
  sy: "syPaused",
  manager: null,
}

function MarketCard({ market, ms, ledgerTime, readOnly, roles, shared, account }: CardProps) {
  const manifest = useManifest()
  const findings = useManifestFindings()
  const { state: wallet } = useWallet()
  const fees = useAccruedFees(market.marketId).data
  const held = roles ? heldRoles(roles) : undefined
  const status = ms ? marketStatus(ms, ledgerTime) : "loading"

  // The roles that apply to this call's own contract, and the gates they feed (R2-52, R2-53).
  const blockersFor = (call: ManagerCall): Blocker[] =>
    evaluateManagerGates(call, { wallet, roles: rolesForCall(call, roles, shared), findings, listed: true })

  const isCreator = held?.held.includes("creator") ?? false
  const isProtocolAdmin = held?.held.includes("protocolAdmin") ?? false

  const claimSteps = (kind: "creator" | "protocol"): ManagerCall[] => {
    if (!account || !fees || fees.status !== "live") return []
    const contracts: FeeContract[] = (["pool", "manager"] as const).filter((c) => fees.value[c][kind] > 0n)
    const build = kind === "creator" ? claimCreatorFeesCall : claimProtocolFeesCall
    return contracts.map((contract) => build(manifest, { source: account, marketId: market.marketId, contract }))
  }

  const feeLine = (kind: "creator" | "protocol", label: string) => {
    const value = fees === undefined ? "Loading" : fees.status === "unavailable" ? unavailableText(fees.error) : `${formatAmount(fees.value[kind], market.underlying.decimals, 4, { group: true })} SY`
    const none = fees?.status === "live" && fees.value[kind] === 0n
    return (
      <Fact label={label}>
        {value}
        {none ? <span className="text-ink-muted"> · Nothing to claim</span> : null}
      </Fact>
    )
  }

  const claimButton = (kind: "creator" | "protocol", text: string) => {
    const steps = claimSteps(kind)
    return (
      <ManagerSignFlow
        key={kind}
        label={text}
        title={text}
        steps={steps}
        // Nothing accrued, or not readable: off. A contract refuses a claim of zero.
        disabled={steps.length === 0}
        blockersFor={blockersFor}
        ledgerTime={ledgerTime}
        network={manifest.network}
      />
    )
  }

  const pauseButtons: React.ReactNode[] = []
  if (!readOnly && account && held && roles) {
    for (const contract of held.contractAdminOf) {
      const key = PAUSE_STATE[contract]
      if (key === null) continue // the manager has no view of its pause flag
      const flag: Live<boolean> | undefined = ms?.[key]
      const paused = flag?.status === "live" ? flag.value : undefined
      const name = CONTRACT_NAME[contract]
      const call =
        paused === undefined ? undefined : setPausedCall(manifest, { source: account, marketId: market.marketId, contract: contract as PausableContract, paused: !paused })
      pauseButtons.push(
        <ManagerSignFlow
          key={contract}
          label={`${paused ? "Unpause" : "Pause"} ${name}`}
          title={`${paused ? "Unpause" : "Pause"} ${name}`}
          steps={call ? [call] : []}
          disabled={call === undefined}
          blockersFor={blockersFor}
          ledgerTime={ledgerTime}
          network={manifest.network}
        />,
      )
    }
  }

  const pauseFacts = held?.contractAdminOf
    .filter((c) => PAUSE_STATE[c] !== null)
    .map((c) => {
      const flag = ms?.[PAUSE_STATE[c] as "poolPaused" | "syPaused"]
      const text = !flag ? "Loading" : flag.status === "unavailable" ? unavailableText(flag.error) : flag.value ? "Paused" : "Running"
      return (
        <Fact key={c} label={`${CONTRACT_NAME[c][0].toUpperCase()}${CONTRACT_NAME[c].slice(1)}`}>
          {text}
        </Fact>
      )
    })

  const claimButtons: React.ReactNode[] = []
  if (!readOnly && account) {
    if (isCreator) claimButtons.push(claimButton("creator", "Claim creator fees"))
    if (isProtocolAdmin) claimButtons.push(claimButton("protocol", "Claim protocol fees (to treasury)"))
  }
  const buttons = [...pauseButtons, ...claimButtons]

  return (
    <article className="grid gap-4 rounded-lg border border-line bg-surface p-4" aria-label={market.displayName}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="min-w-0 font-serif text-xl break-words text-ink">{market.displayName}</h2>
        <StatusBadge status={status} />
      </div>
      <dl className="grid grid-cols-[minmax(0,1fr)] gap-3 min-[560px]:grid-cols-2">
        {held ? (
          <Fact label="My roles">
            {rolesText(held).length > 0 ? rolesText(held).join(" · ") : held.unavailable.length === 0 ? "None" : null}
            {held.unavailable.length > 0 ? (
              <span className="block text-ink-muted">{unavailableText(held.unavailable.join("; "))}</span>
            ) : null}
          </Fact>
        ) : null}
        <Fact label="Oracle">{oracleText(ms, ledgerTime)}</Fact>
        <Fact label="Liquidity">{ms ? liquidityText(ms, market.underlying.decimals, market.underlying.code) : "Loading"}</Fact>
        {pauseFacts}
        {!readOnly && isCreator ? feeLine("creator", "Creator fees to claim") : null}
        {!readOnly && isProtocolAdmin ? feeLine("protocol", "Protocol fees to claim (treasury)") : null}
      </dl>
      {buttons.length > 0 ? <div className="flex flex-wrap gap-2">{buttons}</div> : null}
      {!readOnly && held?.contractAdminOf.includes("manager") ? (
        <p className="text-xs text-ink-muted">
          You also administer the manager. It has no readable pause flag, so it is not offered here.
        </p>
      ) : null}
    </article>
  )
}

type View = "mine" | "all"

/**
 * The manager view (spec 0002 §5): the listed markets where the connected wallet holds a role, with
 * only the actions that role can sign, and an "All" toggle for every listed market read-only. Roles
 * are read on each market's own contracts and scoped to them. An unreadable figure says
 * "Unavailable" with its reason, never a zero.
 */
export function MyMarkets({ invalid }: { invalid: InvalidMarkets }) {
  const manifest = useManifest()
  const { state } = useWallet()
  const { account, roles, pending } = useMyRoles()
  const { ledgerTime } = useLedgerClock()
  const [view, setView] = useState<View>("mine")
  const states = useMarketStates(manifest.markets.map((m) => m.marketId))

  const rolesFor = (m: Market) => roles.markets.get(m.marketId)
  // A market whose roles could not be read is listed with the reason, not hidden.
  const mine = manifest.markets.filter((m) => {
    const r = rolesFor(m)
    if (!r) return false
    const h = heldRoles(r)
    return h.held.length > 0 || h.unavailable.length > 0
  })
  const shown = view === "mine" ? mine : manifest.markets
  const unreadRoles = account !== null && !pending && roles.markets.size < manifest.markets.length

  return (
    <div className="grid min-w-0 gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-ink-muted">
          {account ? <>Connected as <span className="font-mono text-ink" title={account}>{shorten(account)}</span></> : "No wallet connected"}
        </p>
        <div role="group" aria-label="Markets to show" className="flex gap-2">
          <Button type="button" size="toggle" variant={view === "mine" ? "primary" : "secondary"} aria-pressed={view === "mine"} onClick={() => setView("mine")}>
            My markets ({mine.length})
          </Button>
          <Button type="button" size="toggle" variant={view === "all" ? "primary" : "secondary"} aria-pressed={view === "all"} onClick={() => setView("all")}>
            All ({manifest.markets.length})
          </Button>
        </div>
      </div>

      {view === "mine" && state.status !== "connected" ? (
        <p className="rounded-lg border border-line bg-surface p-5 text-ink">
          Connect your wallet to see the markets you manage. Your roles are read on each market&apos;s contracts.
        </p>
      ) : null}
      {view === "mine" && state.status === "connected" && pending ? <p className="text-ink-muted">Reading your roles on each market…</p> : null}
      {view === "mine" && state.status === "connected" && !pending && mine.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-5 text-ink">
          This wallet does not hold a role on any listed market. Roles are the asset issuer, the market creator, the protocol admin and
          the admin of a market&apos;s pool, SY wrapper or manager.
        </p>
      ) : null}
      {unreadRoles ? <p className="text-sm text-ink-muted">{UNAVAILABLE}: the roles on some markets could not be read yet, so they are not shown.</p> : null}

      {(view === "all" || state.status === "connected") && !(view === "mine" && pending) ? (
        <div className="grid gap-4">
          {shown.map((market) => {
            const i = manifest.markets.indexOf(market)
            const r = rolesFor(market)
            const manages = r ? heldRoles(r).held.length > 0 : false
            return (
              <MarketCard
                key={market.marketId}
                market={market}
                ms={states[i]?.stale ? undefined : states[i]?.data}
                ledgerTime={ledgerTime}
                readOnly={!manages}
                roles={r}
                shared={roles.shared}
                account={account}
              />
            )
          })}
        </div>
      ) : null}

      {view === "all" ? (
        <section aria-labelledby="unlisted-heading" className="grid gap-2">
          <h2 id="unlisted-heading" className="font-serif text-xl text-ink">
            Not listed
          </h2>
          {invalid.status === "unavailable" ? (
            <p className="text-sm text-ink-muted">The markets that failed the registry&apos;s checks could not be read right now.</p>
          ) : invalid.rows.length === 0 ? (
            <p className="text-sm text-ink-muted">Every market the registry knows is listed.</p>
          ) : (
            <ul className="grid gap-2">
              {invalid.rows.map((row) => (
                <li key={row.pool} className="grid gap-1 rounded-lg border border-line bg-surface p-3 text-sm">
                  <span className="font-medium break-words text-ink">{row.name ?? "Unnamed market"}</span>
                  <span className="font-mono text-xs break-all text-ink-muted" title={row.pool}>{shorten(row.pool)}</span>
                  <span className="text-ink">Not listed because {row.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  )
}
