"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { useManifest } from "@/components/app/manifest-provider"
import { MATURITY_DATE } from "@/components/app/market/market-header"
import { Metric } from "@/components/app/market/metric"
import { marketStatus } from "@/components/app/markets/market-groups"
import { StatusBadge } from "@/components/app/markets/status-badge"
import { Skeleton } from "@/components/ui/skeleton"
import { DASHBOARD_AGGREGATE_MS, useProtocolState } from "@/hooks/use-dashboard"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { TVL_LABEL, type MarketDashboard, type ProtocolState } from "@/lib/protocol/dashboard/protocol-state"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { formatAmountFixed, formatRate } from "@/lib/protocol/format"
import type { PoolStateView } from "@/lib/protocol/market-state"
import { unavailable } from "@/lib/protocol/reader"
import type { Live, Market } from "@/lib/protocol/types"
import { AsOf, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { decimalsScale, verifiable, type FigureSpec } from "./figure"
import { Panel } from "./panel"
import { current, NO_LIQUIDITY, noPoolSeeded, readOf, refuse, Shown, unitsOf, type QueryLike } from "./query-figures"

/** How long until maturity on the ledger clock, as /app words it: "89 d left", "5 h left", "<1 h left", "Matured". */
export function timeLeft(maturity: bigint, ledgerTime: number): string {
  const seconds = maturity - BigInt(Math.floor(ledgerTime))
  if (seconds <= 0n) return "Matured"
  if (seconds >= 86_400n) return `${seconds / 86_400n} d left`
  return seconds >= 3600n ? `${seconds / 3600n} h left` : "<1 h left"
}

/** Amounts in a column line up: 2 decimals for balances, 4 for fee buckets (they are small). */
export const amountIn = (decimals: number, unit: string, digits = 2) => (v: bigint) => `${formatAmountFixed(v, decimals, digits)} ${unit}`

export const settlementText = (rate: bigint | null) => (rate === null ? "Not settled" : `Settled at ${formatRate(rate)}`)

/** The SY exchange rate's scale, as the drawer states it for an underlying value of SY shares. */
export const feeUnderlyingScale = (decimals: number) => `${decimals} decimals; the SY shares × the SY exchange rate ÷ 10,000,000`

/** Every figure of one market, from the every-market sweep. Labels name the market, so the evidence table can tell rows apart. */
export type MarketSpecs = {
  maturity: FigureSpec<bigint>
  settlement: FigureSpec<bigint | null>
  ptSupply: FigureSpec<bigint>
  ytSupply: FigureSpec<bigint>
  ptReserve: FigureSpec<PoolStateView>
  syReserve: FigureSpec<PoolStateView>
  lpSupply: FigureSpec<bigint>
  liquidity: FigureSpec<bigint>
  tvl: FigureSpec<bigint>
  protocolSy: FigureSpec<bigint>
  protocolUnderlying: FigureSpec<bigint>
  creatorSy: FigureSpec<bigint>
  creatorUnderlying: FigureSpec<bigint>
}

function marketSpecs(market: Market, q: QueryLike<ProtocolState>, read: FigureSpec<unknown>["read"]): MarketSpecs {
  const id = market.marketId
  const { decimals, code } = market.underlying
  const pick = <T,>(f: (d: MarketDashboard) => Live<T>): Live<T> | undefined =>
    current(q, (s) => (s.markets[id] ? f(s.markets[id]) : unavailable("this market was not read")))
  const label = (name: string) => `${name} · ${id}`
  const d = q.stale ? undefined : q.data?.markets[id]
  const unseeded = d !== undefined && noPoolSeeded([d.poolSeeded])
  const amount = (unit: string) => amountIn(decimals, unit)
  const fee = (unit: string) => amountIn(decimals, unit, 4)
  const scale = (unit: string) => decimalsScale(decimals, unit)
  return {
    maturity: { label: label("Maturity"), live: pick((x) => x.maturity), format: (v) => MATURITY_DATE.format(new Date(Number(v) * 1000)), scale: "Unix time, seconds", read },
    settlement: { label: label("Settlement"), live: pick((x) => x.settledRate), format: settlementText, scale: "Scale 10,000,000 = 1.0", read },
    ptSupply: { label: label("PT supply"), live: pick((x) => x.totalPt), format: amount("PT"), scale: scale("PT"), read },
    ytSupply: { label: label("YT supply"), live: pick((x) => x.totalYt), format: amount("YT"), scale: scale("YT"), read },
    ptReserve: { label: label("PT reserve"), live: pick((x) => x.poolState), format: (p) => amount("PT")(p.ptReserve), scale: scale("PT"), read },
    syReserve: { label: label("SY reserve"), live: pick((x) => x.poolState), format: (p) => amount("SY")(p.syReserve), scale: scale("SY"), read },
    lpSupply: { label: label("LP supply"), live: pick((x) => x.lpTotalSupply), format: amount("LP"), scale: scale("LP"), read },
    liquidity: { label: label("Liquidity"), live: pick((x) => x.liquidity), format: (v) => (unseeded ? NO_LIQUIDITY : amount(code)(v)), scale: scale(code), read },
    tvl: { label: label("TVL"), live: pick((x) => x.tvl), format: amount(code), scale: scale(code), read },
    protocolSy: { label: label("Protocol fees (SY)"), live: pick((x) => x.feeBuckets.protocol.sy), format: fee("SY"), scale: scale("SY"), read },
    protocolUnderlying: {
      label: label(`Protocol fees (${code})`),
      live: pick((x) => x.feeBuckets.protocol.underlying),
      format: fee(code),
      scale: feeUnderlyingScale(decimals),
      read,
    },
    creatorSy: { label: label("Creator fees (SY)"), live: pick((x) => x.feeBuckets.creator.sy), format: fee("SY"), scale: scale("SY"), read },
    creatorUnderlying: {
      label: label(`Creator fees (${code})`),
      live: pick((x) => x.feeBuckets.creator.underlying),
      format: fee(code),
      scale: feeUnderlyingScale(decimals),
      read,
    },
  }
}

/** One grid for the header and every market from 1280 px; below it each market is a card. */
const COLUMNS = "xl:grid-cols-[repeat(4,minmax(0,1fr))_repeat(2,minmax(0,1.2fr))_repeat(2,minmax(0,1fr))]"
const HEADINGS = ["Market", "Supply", "Reserves", "LP supply", "Liquidity", "TVL", "Protocol fees", "Creator fees"]

/** A labelled value group: the label shows on a card and is for assistive tech only where the column header carries it. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-1 xl:justify-items-end xl:text-right">
      <span className="label xl:sr-only">{label}</span>
      <div className="grid min-w-0 gap-0.5 font-mono text-xs/5 tabular-nums text-ink xl:justify-items-end">{children}</div>
    </div>
  )
}

function MarketRow({ market, specs, status, left }: { market: Market; specs: MarketSpecs; status: ReturnType<typeof marketStatus> | "loading"; left: string | null }) {
  const s = specs
  return (
    <li
      aria-label={`${market.displayName} · ${market.marketId}`}
      className={`grid grid-cols-1 gap-x-6 gap-y-4 border-t border-line px-4 py-4 first:border-t-0 min-[480px]:grid-cols-2 md:grid-cols-4 xl:items-start xl:gap-x-3 ${COLUMNS}`}
    >
      <div className="grid min-w-0 content-start gap-1 min-[480px]:col-span-2 md:col-span-4 xl:col-span-1">
        <Link
          href={`/dashboard/markets/${market.marketId}`}
          className="w-fit font-semibold text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {market.displayName}
        </Link>
        <span className="font-mono text-xs text-ink-muted wrap-anywhere">{market.marketId}</span>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
          <StatusBadge status={status} />
          <Shown {...s.maturity} className="font-mono" />
          {left ? <span>{left}</span> : null}
        </div>
        <div className="text-xs text-ink-muted">
          <Shown {...s.settlement} />
        </div>
      </div>
      <Cell label="Supply">
        <Shown {...s.ptSupply} />
        <Shown {...s.ytSupply} />
      </Cell>
      <Cell label="Reserves">
        <Shown {...s.ptReserve} />
        <Shown {...s.syReserve} />
      </Cell>
      <Cell label="LP supply">
        <Shown {...s.lpSupply} />
      </Cell>
      <Cell label="Liquidity">
        <Shown {...s.liquidity} />
      </Cell>
      <Cell label="TVL">
        <Shown {...s.tvl} />
      </Cell>
      <Cell label="Protocol fees">
        <Shown {...s.protocolSy} />
        <Shown {...s.protocolUnderlying} />
      </Cell>
      <Cell label="Creator fees">
        <Shown {...s.creatorSy} />
        <Shown {...s.creatorUnderlying} />
      </Cell>
    </li>
  )
}

/**
 * `/dashboard/markets`: every market in the registry, one row each, with the totals over them. One
 * query reads them all (`useProtocolState`, one batch of reads per market every 60 s), so the rows and
 * the totals come from the same sweep. A total is Unavailable when any market's figure is. No wallet.
 */
export function MarketsView() {
  const m = useManifest()
  const { ledgerTime, isError: clockFailed } = useLedgerClock()
  const protocol = useProtocolState()
  const read = readOf(protocol, DASHBOARD_AGGREGATE_MS)
  const units = unitsOf(m)
  const refused = "refused" in units ? units.refused : null
  const total = (v: bigint) => ("refused" in units ? String(v) : `${formatAmountFixed(v, units.decimals)} ${units.code ?? "(underlying units)"}`)
  const totalScale = "refused" in units ? undefined : decimalsScale(units.decimals, units.code ?? "underlying unit")
  const data = protocol.stale ? undefined : protocol.data
  const unseeded = data !== undefined && noPoolSeeded(Object.values(data.markets).map((d) => d.poolSeeded))

  const totals: FigureSpec<bigint>[] = [
    { label: "TVL", live: refuse(current(protocol, (s) => s.totals.tvl), refused), format: total, scale: totalScale, read },
    {
      label: "TVL in USD",
      live: refuse(current(protocol, (s) => s.totals.tvlReference), refused),
      format: (v) => ("refused" in units ? String(v) : `${formatAmountFixed(v, units.decimals)} USD (oracle units)`),
      scale: "refused" in units ? undefined : `${units.decimals} decimals; TVL × the oracle value ÷ 10,000,000, in US dollars (oracle units)`,
      read,
    },
    { label: "Pool liquidity", live: refuse(current(protocol, (s) => s.totals.liquidity), refused), format: (v) => (unseeded ? NO_LIQUIDITY : total(v)), scale: totalScale, read },
    { label: "Held by RecoveryEscrow", live: refuse(current(protocol, (s) => s.totals.escrowUnderlying), refused), format: total, scale: totalScale, read },
  ]
  const rows = m.markets.map((market) => {
    const specs = marketSpecs(market, protocol, read)
    const d = data?.markets[market.marketId]
    const status = ledgerTime === null && !clockFailed ? ("loading" as const) : d ? marketStatus(d, ledgerTime) : null
    const left = d && ledgerTime !== null && d.maturity.status === "live" ? timeLeft(d.maturity.value, ledgerTime) : null
    return { market, specs, status, left }
  })
  const all = [...totals, ...rows.flatMap((r) => Object.values(r.specs) as FigureSpec<unknown>[])] as FigureSpec<unknown>[]
  const figures = all.map(verifiable).filter((f): f is VerifiableFigure => f !== null)
  const updatedAt = protocol.stale ? null : protocol.dataUpdatedAt || null

  return (
    <section aria-labelledby="markets-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 id="markets-heading" className="font-serif text-3xl text-ink">
              Markets
            </h1>
            <p className="mt-2 max-w-[68ch] text-ink-muted">
              Every market in the registry, read from its contracts. No wallet is needed. Open a market for its fee recipients, its settlement and a
              pending-yield lookup. Each figure&apos;s info button shows the contract call behind it.
            </p>
          </div>
          <CopyEvidence figures={figures} />
        </div>
        <AsOf sources={readsOf(all.map((f) => f.live))} updatedAt={updatedAt} cadenceMs={DASHBOARD_AGGREGATE_MS} />
      </div>

      <Panel title="Totals" meta={<p className="text-xs/5 text-ink-muted">Over every market below · a total is Unavailable when any market&apos;s figure is</p>}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-5 min-[420px]:grid-cols-2 lg:grid-cols-4">
          {totals.map((t) => (
            <Metric key={t.label} label={t.label}>
              <Shown {...t} />
            </Metric>
          ))}
        </dl>
        <p className="text-xs/5 text-ink-muted">
          TVL: {TVL_LABEL.charAt(0).toLowerCase() + TVL_LABEL.slice(1)}. The app shows the same figure. Fees are unclaimed: the pool&apos;s share of
          swap fees plus the manager&apos;s share of tokenization and YT fees, in SY shares and at the SY exchange rate.
        </p>
      </Panel>

      <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
        <div aria-hidden="true" className={`hidden border-b border-line-strong bg-surface-sunk px-4 py-3 text-[11px]/4 font-semibold tracking-[0.08em] text-ink-muted uppercase xl:grid xl:gap-x-3 ${COLUMNS}`}>
          {HEADINGS.map((h, i) => (
            <span key={h} className={i === 0 ? undefined : "text-right"}>
              {h}
            </span>
          ))}
        </div>
        {m.markets.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">No market is listed in the registry yet.</p>
        ) : !data && !protocol.stale && protocol.isPending ? (
          <div className="grid gap-3 p-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <ul aria-label="Markets">
            {rows.map((r) => (
              <MarketRow key={r.market.marketId} market={r.market} specs={r.specs} status={r.status ?? "unavailable"} left={r.left} />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
