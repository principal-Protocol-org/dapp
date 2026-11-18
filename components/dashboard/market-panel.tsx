"use client"

import Link from "next/link"
import { useState } from "react"
import { ArrowLeftIcon } from "lucide-react"
import { useManifest } from "@/components/app/manifest-provider"
import { MATURITY_DATE } from "@/components/app/market/market-header"
import { Metric } from "@/components/app/market/metric"
import { marketStatus } from "@/components/app/markets/market-groups"
import { StatusBadge } from "@/components/app/markets/status-badge"
import { DASHBOARD_LIVE_MS, useMarketDashboard, usePendingClaim } from "@/hooks/use-dashboard"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { TVL_LABEL, type MarketDashboard } from "@/lib/protocol/dashboard/protocol-state"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { explorerUrl } from "@/lib/protocol/explorer"
import { formatAmountFixed, formatBps, formatRate } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { unavailable } from "@/lib/protocol/reader"
import type { Live, Network } from "@/lib/protocol/types"
import { AsOf, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { accountShort } from "./event-words"
import { decimalsScale, verifiable, type FigureRender, type FigureSpec } from "./figure"
import { amountIn, feeUnderlyingScale, timeLeft } from "./markets-table"
import { Panel, Row } from "./panel"
import { PendingYieldLookup } from "./pending-yield-lookup"
import { current, NO_LIQUIDITY, noPoolSeeded, readOf, Shown } from "./query-figures"

/** A figure spec, typed from its read: `format` and `render` get the read's value type. */
const spec = <T,>(s: FigureSpec<T>): FigureSpec<T> => s

const LINK = "font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"

/** A fee recipient: shortened, linking to its stellar.expert page (an account, or a contract for `C…`); the full address in the evidence. */
function AddressLink({ network, label, address }: { network: Network; label: string; address: string }) {
  const url = explorerUrl(network, address.startsWith("C") ? "contract" : "account", address)
  if (!url) return <span title={address}>{accountShort(address)}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" title={address} aria-label={`${label} ${address} on stellar.expert`} className={LINK}>
      {accountShort(address)}
    </a>
  )
}

function addressLink(network: Network, label: string): FigureRender<string> {
  return function renderAddress(address) {
    return <AddressLink network={network} label={label} address={address} />
  }
}

/**
 * `/dashboard/markets/[marketId]`: one market's figures, its settlement state, its fee buckets and
 * recipients, and the pending-yield address lookup (D-9). One batch of reads every 15 s
 * (`useMarketDashboard`); the lookup adds an address's three YT reads once one is entered. No wallet.
 */
export function MarketPanel({ marketId }: { marketId: string }) {
  const m = useManifest()
  const market = getMarket(m, marketId)
  const q = useMarketDashboard(marketId)
  const { ledgerTime, isError: clockFailed } = useLedgerClock()
  const [account, setAccount] = useState<string | null>(null)
  const d = q.stale ? undefined : q.data
  const pending = usePendingClaim(marketId, account, d)
  if (!market) return null

  const { decimals, code } = market.underlying
  const read = readOf(q, DASHBOARD_LIVE_MS)
  const pick = <T,>(f: (x: MarketDashboard) => Live<T>) => current(q, f)
  const amount = (unit: string) => amountIn(decimals, unit)
  const fee = (unit: string) => amountIn(decimals, unit, 4)
  const scale = (unit: string) => decimalsScale(decimals, unit)
  const unseeded = d !== undefined && noPoolSeeded([d.poolSeeded])

  const figures = {
    ptSupply: spec({ label: "PT supply", live: pick((x) => x.totalPt), format: amount("PT"), scale: scale("PT"), read }),
    ytSupply: spec({ label: "YT supply", live: pick((x) => x.totalYt), format: amount("YT"), scale: scale("YT"), read }),
    ptReserve: spec({ label: "PT reserve", live: pick((x) => x.poolState), format: (p) => amount("PT")(p.ptReserve), scale: scale("PT"), read }),
    syReserve: spec({ label: "SY reserve", live: pick((x) => x.poolState), format: (p) => amount("SY")(p.syReserve), scale: scale("SY"), read }),
    lpSupply: spec({ label: "LP supply", live: pick((x) => x.lpTotalSupply), format: amount("LP"), scale: scale("LP"), read }),
    liquidity: spec({ label: "Pool liquidity", live: pick((x) => x.liquidity), format: (v) => (unseeded ? NO_LIQUIDITY : amount(code)(v)), scale: scale(code), read }),
    tvl: spec({ label: "TVL", live: pick((x) => x.tvl), format: amount(code), scale: scale(code), read }),
    tvlUsd: spec({
      label: "TVL in USD",
      live: pick((x) => x.tvlReference),
      format: (v) => `${formatAmountFixed(v, decimals)} USD (oracle units)`,
      scale: `${decimals} decimals; TVL × the oracle value ÷ 10,000,000, in US dollars (oracle units)`,
      read,
    }),
    syUnderlying: spec({ label: "Underlying held by the SY wrapper", live: pick((x) => x.syUnderlying), format: amount(code), scale: scale(code), read }),
    escrowUnderlying: spec({ label: "Underlying held by RecoveryEscrow", live: pick((x) => x.escrowUnderlying), format: amount(code), scale: scale(code), read }),
  }
  const settlement = {
    maturity: { label: "Maturity", live: pick((x) => x.maturity), format: (v: bigint) => MATURITY_DATE.format(new Date(Number(v) * 1000)), scale: "Unix time, seconds", read },
    settledRate: {
      label: "Settlement rate",
      live: pick((x) => x.settledRate),
      format: (v: bigint | null) => (v === null ? "Not settled yet" : `Settled at ${formatRate(v)}`),
      scale: "Scale 10,000,000 = 1.0",
      read,
    },
    ytIndex: { label: "YT yield index", live: pick((x) => x.ytFrozen), format: (frozen: boolean) => (frozen ? "Frozen" : "Accruing"), read },
  }
  const fees = {
    protocolSy: { label: "Protocol fees (SY)", live: pick((x) => x.feeBuckets.protocol.sy), format: fee("SY"), scale: scale("SY"), read },
    protocolUnderlying: { label: `Protocol fees (${code})`, live: pick((x) => x.feeBuckets.protocol.underlying), format: fee(code), scale: feeUnderlyingScale(decimals), read },
    creatorSy: { label: "Creator fees (SY)", live: pick((x) => x.feeBuckets.creator.sy), format: fee("SY"), scale: scale("SY"), read },
    creatorUnderlying: { label: `Creator fees (${code})`, live: pick((x) => x.feeBuckets.creator.underlying), format: fee(code), scale: feeUnderlyingScale(decimals), read },
    protocolShare: { label: "Protocol share", live: pick((x) => x.fees.protocolShareBps), format: formatBps, scale: "Basis points: 10,000 = 100%", read },
    tokenization: { label: "Tokenization fee", live: pick((x) => x.fees.tokenizationBps), format: formatBps, scale: "Basis points: 10,000 = 100%", read },
    yt: { label: "YT fee", live: pick((x) => x.fees.ytBps), format: formatBps, scale: "Basis points: 10,000 = 100%", read },
    swapTier: { label: "Swap fee tier", live: pick((x) => x.fees.swapTierBps), format: formatBps, scale: "Basis points: 10,000 = 100%", read },
  }
  const recipients = {
    treasury: { label: "Treasury", live: pick((x) => x.feeRecipients.treasury), format: (a: string) => a, read },
    creator: { label: "Creator", live: pick((x) => x.feeRecipients.creator), format: (a: string) => a, read },
    protocolAdmin: { label: "Protocol admin", live: pick((x) => x.feeRecipients.protocolAdmin), format: (a: string) => a, read },
  }
  // The lookup's answer; Unavailable, not the last answer, once the market itself failed to refresh.
  const pendingLive: Live<bigint> | undefined = !account
    ? undefined
    : q.stale
      ? unavailable(`the market's last refresh failed: ${q.error?.message ?? "unknown error"}`)
      : current(pending, (x) => x)
  const pendingFigure: FigureSpec<bigint> | null = account
    ? { label: "Pending yield", live: pendingLive, format: amountIn(decimals, code, decimals), scale: scale(code), read: readOf(pending, DASHBOARD_LIVE_MS) }
    : null

  const all = [
    ...Object.values(figures),
    ...Object.values(settlement),
    ...Object.values(fees),
    ...Object.values(recipients),
    ...(pendingFigure ? [pendingFigure] : []),
  ] as FigureSpec<unknown>[]
  const evidence = all.map(verifiable).filter((f): f is VerifiableFigure => f !== null)
  const status = ledgerTime === null && !clockFailed ? "loading" : d ? marketStatus(d, ledgerTime) : "unavailable"
  const left = d && ledgerTime !== null && d.maturity.status === "live" ? timeLeft(d.maturity.value, ledgerTime) : null
  const ytFee = d && d.fees.ytBps.status === "live" ? formatBps(d.fees.ytBps.value) : null
  const updatedAt = Math.max(0, ...[q, pending].map((x) => (x.stale ? 0 : x.dataUpdatedAt))) || null

  return (
    <section aria-labelledby="market-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid gap-3">
        <Link href="/dashboard/markets" className={`inline-flex w-fit items-center gap-1.5 text-sm ${LINK}`}>
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          All markets
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid min-w-0 gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h1 id="market-heading" className="font-serif text-3xl text-ink">
                {market.displayName}
              </h1>
              <StatusBadge status={status} />
            </div>
            <p className="font-mono text-xs text-ink-muted wrap-anywhere">{market.marketId}</p>
            <p className="max-w-[68ch] text-ink-muted">
              This market&apos;s state, read from its contracts. No wallet is needed. Each figure&apos;s info button shows the contract call behind it
              and a command to repeat it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link href={`/app/markets/${market.marketId}`} className={`text-sm ${LINK}`}>
              Open in the app
            </Link>
            <CopyEvidence figures={evidence} />
          </div>
        </div>
        <AsOf sources={readsOf(all.map((f) => f.live))} updatedAt={updatedAt} cadenceMs={DASHBOARD_LIVE_MS} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 min-[900px]:grid-cols-2">
        <Panel title="Market figures" className="min-[900px]:col-span-2">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-5 min-[420px]:grid-cols-2 lg:grid-cols-4">
            <Metric label="PT supply">
              <Shown {...figures.ptSupply} />
            </Metric>
            <Metric label="YT supply">
              <Shown {...figures.ytSupply} />
            </Metric>
            <Metric label="PT reserve">
              <Shown {...figures.ptReserve} />
            </Metric>
            <Metric label="SY reserve">
              <Shown {...figures.syReserve} />
            </Metric>
            <Metric label="LP supply">
              <Shown {...figures.lpSupply} />
            </Metric>
            <Metric label="Pool liquidity">
              <Shown {...figures.liquidity} />
            </Metric>
            <Metric label="TVL">
              <Shown {...figures.tvl} />
            </Metric>
            <Metric label="TVL in USD">
              <Shown {...figures.tvlUsd} />
            </Metric>
            <Metric label="Held by the SY wrapper">
              <Shown {...figures.syUnderlying} />
            </Metric>
            <Metric label="Held by RecoveryEscrow">
              <Shown {...figures.escrowUnderlying} />
            </Metric>
          </dl>
          <ul className="grid gap-1 text-xs/5 text-ink-muted">
            <li>TVL: {TVL_LABEL.charAt(0).toLowerCase() + TVL_LABEL.slice(1)}. The app shows the same figure.</li>
            <li>Pool liquidity: the pool&apos;s PT and SY reserves, valued at the pool price.</li>
          </ul>
        </Panel>

        <Panel title="Settlement">
          <dl className="grid gap-3">
            <Row label="Maturity">
              <Shown {...settlement.maturity} />
              {left ? <span className="block font-sans text-xs/5 text-ink-muted">{left}</span> : null}
            </Row>
            <Row label="Settlement rate">
              <Shown {...settlement.settledRate} />
            </Row>
            <Row label="YT yield index">
              <Shown {...settlement.ytIndex} />
              <span className="block font-sans text-xs/5 text-ink-muted">Frozen once the market settles: YT then earns no more yield.</span>
            </Row>
          </dl>
        </Panel>

        <Panel title="Fees">
          <dl className="grid gap-3">
            <Row label="Protocol fees, unclaimed">
              <Shown {...fees.protocolSy} />
              <span className="block">
                <Shown {...fees.protocolUnderlying} />
              </span>
            </Row>
            <Row label="Creator fees, unclaimed">
              <Shown {...fees.creatorSy} />
              <span className="block">
                <Shown {...fees.creatorUnderlying} />
              </span>
            </Row>
            <Row label="Protocol share">
              <Shown {...fees.protocolShare} />
            </Row>
            <Row label="Tokenization fee">
              <Shown {...fees.tokenization} />
            </Row>
            <Row label="YT fee">
              <Shown {...fees.yt} />
            </Row>
            <Row label="Swap fee tier">
              <Shown {...fees.swapTier} />
            </Row>
          </dl>
          <p className="text-xs/5 text-ink-muted">
            Unclaimed fees are the pool&apos;s share of swap fees plus the manager&apos;s share of tokenization and YT fees, in SY shares, and in{" "}
            {code} at the SY exchange rate.
          </p>
        </Panel>

        <Panel title="Fee recipients">
          <dl className="grid gap-3">
            <Row label="Treasury">
              <Shown {...recipients.treasury} render={addressLink(m.network, "Treasury")} />
              <span className="block font-sans text-xs/5 text-ink-muted">Paid the protocol fees when they are claimed.</span>
            </Row>
            <Row label="Creator">
              <Shown {...recipients.creator} render={addressLink(m.network, "Creator")} />
              <span className="block font-sans text-xs/5 text-ink-muted">Paid the creator fees: the asset issuer.</span>
            </Row>
            <Row label="Protocol admin">
              <Shown {...recipients.protocolAdmin} render={addressLink(m.network, "Protocol admin")} />
              <span className="block font-sans text-xs/5 text-ink-muted">Can change the protocol share and the treasury.</span>
            </Row>
          </dl>
        </Panel>

        <Panel title="Pending yield">
          <p className="text-sm text-ink-muted">
            What an address would be paid by claiming its YT yield now, net of the YT fee, as the app shows it.
          </p>
          <PendingYieldLookup account={account} onLookup={setAccount} result={pendingFigure} ytFee={ytFee} />
        </Panel>
      </div>
    </section>
  )
}
