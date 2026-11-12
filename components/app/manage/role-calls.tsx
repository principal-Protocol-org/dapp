"use client"

import { UNAVAILABLE } from "@/components/app/live"
import { ManagerSignFlow } from "@/components/app/manage/manager-sign-flow"
import { useManifestFindings } from "@/hooks/use-manifest-findings"
import { useWallet } from "@/hooks/use-wallet"
import type { Blocker } from "@/lib/protocol/gates"
import type { ManagerCall } from "@/lib/protocol/manager-calls"
import { evaluateManagerGates, REQUIRED_ROLE } from "@/lib/protocol/manager-gates"
import type { Live, Network } from "@/lib/protocol/types"

/**
 * One thing steps 4 and 5 may need signed (spec 0002 §5): what it is, whether the chain already
 * shows it, who must sign it (`admin`, read from the contract; `undefined` while it is being read)
 * and how to build the call for that signer.
 */
export type RoleItem = {
  key: string
  text: string
  held: boolean
  admin: Live<string> | undefined
  build(source: string): ManagerCall
}

export type RoleCallsProps = {
  /** The accessible name of the list. */
  listLabel: string
  items: RoleItem[]
  /** The button's text and the dialog's title. */
  label: string
  account: string | null
  ledgerTime: number | null
  network: Network
}

/**
 * The missing calls of a step, each with the account that must sign it (R5-10: no key is held by the
 * app). Only the calls the connected wallet can sign are offered, each reviewed and signed on its
 * own (`ManagerSignFlow`); the rest name their signer, and the step can be finished later from that
 * wallet (the progress is read from the chain). Stays mounted while a flow is in progress.
 */
export function RoleCalls({ listLabel, items, label, account, ledgerTime, network }: RoleCallsProps) {
  const { state: wallet } = useWallet()
  const findings = useManifestFindings()

  const mine = items.filter((it) => !it.held && account !== null && it.admin?.status === "live" && it.admin.value === account)
  let calls: ManagerCall[] = []
  let buildError: string | null = null
  try {
    calls = mine.map((it) => it.build(account as string))
  } catch (error) {
    buildError = error instanceof Error ? error.message : String(error)
  }
  // The signer was matched against the contract's own admin above, so the role holds for each call.
  // Re-checked against the chain on every render: a call whose effect has already landed (another
  // admin signed it while this review was open) is not signed again, and the dialog says so plainly.
  const alreadyDone = (call: ManagerCall): boolean =>
    items.some((it) => {
      if (!it.held) return false
      try {
        return it.build(call.source).label === call.label
      } catch {
        return false
      }
    })
  const blockersFor = (call: ManagerCall): Blocker[] => {
    const role = REQUIRED_ROLE[call.kind]?.role
    const blockers = evaluateManagerGates(call, {
      wallet,
      roles: { status: "live", value: role ? [role] : [], ledger: 0 },
      findings,
      listed: true,
    })
    if (alreadyDone(call)) {
      blockers.push({ code: "topology", message: "This is already done on chain, so there is nothing to sign. Close this; the wizard moves on." })
    }
    return blockers
  }

  return (
    <div className="grid gap-4">
      <ul aria-label={listLabel} className="grid gap-2">
        {items.map((it) => (
          <li key={it.key} className="grid gap-1 rounded-lg border border-line bg-surface p-3 break-words">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-ink">{it.text}</span>
              <span className={it.held ? "text-sm text-positive" : "text-sm text-ink-muted"}>{it.held ? "Done" : "To do"}</span>
            </div>
            {it.held ? null : <Signer admin={it.admin} account={account} />}
          </li>
        ))}
      </ul>
      {buildError ? (
        <p role="alert" className="text-sm text-negative">
          {buildError}
        </p>
      ) : null}
      {calls.length > 0 && calls.length < items.filter((i) => !i.held).length ? (
        <p className="text-sm text-ink-muted">
          This wallet can sign {calls.length} of the {items.filter((i) => !i.held).length} left. The others need their own wallets; the page&apos;s link keeps your place.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <ManagerSignFlow
          label={label}
          title={label}
          steps={calls}
          disabled={calls.length === 0}
          blockersFor={blockersFor}
          ledgerTime={ledgerTime}
          network={network}
        />
      </div>
    </div>
  )
}

function Signer({ admin, account }: { admin: Live<string> | undefined; account: string | null }) {
  if (admin === undefined) return <p className="text-sm text-ink-muted">Reading who must sign this…</p>
  if (admin.status === "unavailable") {
    return (
      <p role="alert" className="text-sm text-negative">
        {UNAVAILABLE}: who must sign this could not be read ({admin.error}). Signing it stays off until it can.
      </p>
    )
  }
  return admin.value === account ? (
    <p className="text-sm text-ink-muted">You sign this: you are its admin.</p>
  ) : (
    <p className="font-mono text-xs break-all text-ink-muted">Must be signed by {admin.value}</p>
  )
}
