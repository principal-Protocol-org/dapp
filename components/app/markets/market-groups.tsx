"use client"

import { useId, useState, type ReactNode } from "react"
import Link from "next/link"
import { ChevronDownIcon } from "lucide-react"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketHistory, useSparks, type Spark } from "@/hooks/use-market-history"
import { useMarketStates } from "@/hooks/use-market-state"
import { useManifest } from "@/components/app/manifest-provider"
import { aprToApy } from "@/lib/protocol/math"
import { formatAmount, formatPercent } from "@/lib/protocol/format"
import { leverage, marketTvl } from "@/lib/protocol/rates"
import type { MarketState } from "@/lib/protocol/market-state"
import type { Manifest, Market } from "@/lib/protocol/types"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { SparkLine } from "@/components/app/charts/spark-line"
import { liquidityOf, type Liquidity } from "@/components/app/market/liquidity"
import { underlyingApyOf } from "@/components/app/market/underlying-apy"
import { UNAVAILABLE } from "@/components/app/live"
import { InfoTip, UnavailableTip } from "@/components/app/info-tip"
import { StatusBadge, type MarketStatus } from "@/components/app/markets/status-badge"

export type { MarketStatus }

const SPARK_WINDOW_SECONDS = 30 * 86_400
const TEST_NOTE = "Test token issued by Principal for Stellar Testnet, not Ondo's USDY"
/** One grid for the asset row and the maturity rows, so their columns line up from `md` up. */
const COLUMNS =
  "md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_2.75rem] md:items-center md:gap-4"

type Slot = { data: MarketState | undefined; isPending: boolean; stale: boolean }

/**
 * Paused (SY, pool or RiskControl) wins; then settled; then matured; else live.
 * Needs the ledger clock and the fields it reads: anything missing is "unavailable", never a guess.
 */
export function marketStatus(ms: MarketState, ledgerTime: number | null): MarketStatus {
  if (ledgerTime === null) return "unavailable"
  const pauses = [ms.syPaused, ms.poolPaused, ms.riskPaused]
  if (pauses.some((p) => p.status === "live" && p.value)) return "paused"
  if (pauses.some((p) => p.status === "unavailable")) return "unavailable"
  if (ms.maturity.status === "unavailable" || ms.settledRate.status === "unavailable") return "unavailable"
  if (ms.settledRate.value !== null) return "settled"
  if (BigInt(Math.floor(ledgerTime)) >= ms.maturity.value) return "matured"
  return "live"
}

function secondsLeft(ms: MarketState, ledgerTime: number | null): bigint | undefined {
  if (ledgerTime === null || ms.maturity.status === "unavailable") return undefined
  return ms.maturity.value - BigInt(Math.floor(ledgerTime))
}

function daysLeft(seconds: bigint | undefined): string {
  if (seconds === undefined) return UNAVAILABLE
  if (seconds <= 0n) return "Matured"
  if (seconds >= 86400n) return `${seconds / 86400n} d left`
  return seconds >= 3600n ? `${seconds / 3600n} h left` : "<1 h left"
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** What a chip or best-figure shows: a number, or the reason there is none. */
type Figure = { kind: "value"; value: number } | { kind: "none"; reason: string }
const noFigure = (reason: string): Figure => ({ kind: "none", reason })

/** Fixed APY (pool implied rate, an APR, compounded over the time left). */
function fixedApyOf(ms: MarketState, ledgerTime: number | null): Figure {
  const seconds = secondsLeft(ms, ledgerTime)
  if (seconds === undefined) return noFigure("The ledger time or the maturity could not be read.")
  if (seconds <= 0n) return noFigure("This market has matured.")
  if (ms.poolSeeded.status === "unavailable") return noFigure("Whether the pool has liquidity could not be read.")
  if (!ms.poolSeeded.value) return noFigure("No liquidity yet, so there is no price.")
  if (ms.impliedRate.status === "unavailable") return noFigure("The pool's rate could not be read.")
  const apy = aprToApy(ms.impliedRate.value, seconds)
  return Number.isFinite(apy) ? { kind: "value", value: apy } : noFigure("The fixed APY could not be computed.")
}

function leverageOf(ms: MarketState): Figure {
  if (ms.poolSeeded.status === "unavailable") return noFigure("Whether the pool has liquidity could not be read.")
  if (!ms.poolSeeded.value) return noFigure("No liquidity yet, so there is no price.")
  if (ms.ptPrice.status === "unavailable") return noFigure("The PT price could not be read.")
  const l = leverage(ms.ptPrice.value)
  return l === undefined ? noFigure("The PT is priced at or above par, so a YT has no leverage.") : { kind: "value", value: l }
}

/** A market whose figures count towards the asset's "best" ones. */
const isLive = (ms: MarketState, ledgerTime: number | null) => marketStatus(ms, ledgerTime) === "live"

function amountText(raw: bigint, decimals: number) {
  return formatAmount(raw, decimals, 2, { group: true })
}

function Amount({ raw, decimals, unit }: { raw: bigint; decimals: number; unit: string }) {
  return (
    <>
      <span>{amountText(raw, decimals)}</span> <span className="text-xs text-ink-muted">{unit}</span>
    </>
  )
}

/**
 * Unavailable, with its reason. In a market row the reason is behind an info tip a tap or focus
 * opens (M10). An asset row is itself the toggle button (R2-70), where a tip's own button cannot
 * nest: there the text keeps a `title` for pointer users, and each reason it sums up sits behind a
 * tip in the market rows it expands to.
 */
function Unavailable({ label, reason, inButton = false }: { label: string; reason?: string; inButton?: boolean }) {
  if (inButton || !reason) {
    return (
      <span title={reason} className="text-ink-muted">
        {UNAVAILABLE}
      </span>
    )
  }
  return <UnavailableTip label={label} reason={reason} className="text-ink-muted" />
}

function Cell({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 md:block md:text-right ${className}`}>
      <span className="text-xs text-ink-muted md:hidden">{label}</span>
      <div className="min-w-0 text-right">{children}</div>
    </div>
  )
}

/** Liquidity over TVL, in the asset's own units. */
function LiquidityTvl({
  liquidity,
  tvl,
  decimals,
  unit,
  inButton = false,
}: {
  liquidity: Liquidity
  tvl: { kind: "value"; value: bigint } | { kind: "unavailable" }
  decimals: number
  unit: string
  /** In the asset row's toggle button: no info tip can nest there. */
  inButton?: boolean
}) {
  return (
    <span className="flex flex-col items-end font-mono tabular-nums">
      <span className="text-ink">
        {liquidity.kind === "value" ? (
          <Amount raw={liquidity.value} decimals={decimals} unit={unit} />
        ) : liquidity.kind === "none" ? (
          "No liquidity yet"
        ) : (
          <Unavailable label="Liquidity" reason="The pool's value could not be read." inButton={inButton} />
        )}
      </span>
      <span className="text-xs text-ink-muted">
        {tvl.kind === "value" ? <Amount raw={tvl.value} decimals={decimals} unit={unit} /> : <Unavailable label="TVL" reason="The TVL could not be read." inButton={inButton} />}
      </span>
    </span>
  )
}

function tvlOf(ms: MarketState) {
  const t = marketTvl(ms)
  return t.status === "live" ? ({ kind: "value", value: t.value } as const) : ({ kind: "unavailable" } as const)
}

function chipClass(kind: "yt" | "pt") {
  return [
    "ml-auto flex w-40 items-center justify-between gap-4 rounded-md md:w-full border px-3 py-2 font-mono text-sm font-semibold tabular-nums",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
    kind === "yt"
      ? "border-coupon bg-coupon-wash text-coupon-ink hover:bg-coupon/25"
      : "border-par bg-surface-sunk text-par hover:bg-line",
  ].join(" ")
}

function Chip({ kind, marketId, figure, text }: { kind: "yt" | "pt"; marketId: string; figure: Figure; text: string }) {
  const label = kind === "yt" ? "YT" : "PT"
  if (figure.kind === "none") {
    return (
      <span className="flex justify-end text-sm">
        <UnavailableTip label={kind === "yt" ? "YT leverage" : "PT fixed APY"} reason={figure.reason} text={text} className="text-ink-muted" />
      </span>
    )
  }
  return (
    <Link href={`/app/markets/${marketId}?tab=${kind}&side=buy`} className={chipClass(kind)}>
      <span>{label}</span>
      <span>{text}</span>
    </Link>
  )
}

/** The 7-day underlying APY with the window it covers (R2-44). */
function UnderlyingApy({ pool }: { pool: string }) {
  const { data, isPending } = useMarketHistory(pool, "7d")
  if (isPending) return <Skeleton className="ml-auto h-5 w-16" />
  const f = underlyingApyOf(data)
  if (f.kind === "none") {
    return (
      <div data-cell="underlying-apy" className="inline-flex items-center gap-1.5">
        {UNAVAILABLE}
        <InfoTip label={`Underlying APY (7 d) (${UNAVAILABLE.toLowerCase()})`}>{f.reason}</InfoTip>
      </div>
    )
  }
  return (
    <div data-cell="underlying-apy" className="flex flex-col items-end">
      <span>{formatPercent(f.value)}</span>
      <span className="text-xs text-ink-muted">{f.caption}</span>
    </div>
  )
}

function SparkCell({ spark, isPending, failed }: { spark: Spark | undefined; isPending: boolean; failed: boolean }) {
  if (isPending) return <Skeleton className="h-7 w-24" />
  if (failed) return <Unavailable label="Fixed APY, 30 d" reason="History could not be read right now." />
  const points = spark?.points ?? []
  const change = spark?.changePts ?? null
  const dated = points.filter((p) => p.value !== null)
  // A spark that starts later than its 30-day window says so; nothing is stretched to fill it.
  const short = dated.length > 0 && dated[dated.length - 1].at - dated[0].at < SPARK_WINDOW_SECONDS - 3600
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SparkLine points={points} changePts={change} />
      {short && <span className="text-xs text-ink-muted">{`since ${SHORT_DATE.format(new Date(dated[0].at * 1000))}`}</span>}
      {change !== null && points.length > 0 && (
        <span className={`font-mono text-xs ${change > 0 ? "text-positive" : change < 0 ? "text-negative" : "text-ink-muted"}`}>
          {`${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)} pt`}
        </span>
      )}
    </div>
  )
}

function MaturityRow({
  market,
  slot,
  ledgerTime,
  sparks,
}: {
  market: Market
  slot: Slot
  ledgerTime: number | null
  sparks: { spark: Spark | undefined; isPending: boolean; failed: boolean }
}) {
  // After a failed refetch the old data is not shown as current.
  const ms = slot.stale ? undefined : slot.data
  const decimals = market.underlying.decimals
  const unit = market.underlying.code
  return (
    <li aria-label={market.displayName} className={`border-t border-line px-4 py-4 ${COLUMNS} flex flex-col gap-3`}>
      <div className="min-w-0">
        <Link
          href={`/app/markets/${market.marketId}`}
          className="font-semibold text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {market.displayName}
        </Link>
        {ms && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <StatusBadge status={marketStatus(ms, ledgerTime)} />
            <span>{maturityText(ms, ledgerTime)}</span>
          </div>
        )}
      </div>
      {ms ? (
        <>
          <Cell label="Liquidity / TVL">
            <LiquidityTvl liquidity={liquidityOf(ms)} tvl={tvlOf(ms)} decimals={decimals} unit={unit} />
          </Cell>
          <Cell label="Underlying APY (7 d)" className="font-mono tabular-nums">
            <UnderlyingApy pool={market.contracts.pool} />
          </Cell>
          <Cell label="Fixed APY, 30 d" className="md:flex md:justify-end">
            <SparkCell {...sparks} spark={sparks.spark} />
          </Cell>
          <ChipCells market={market} ms={ms} ledgerTime={ledgerTime} />
        </>
      ) : slot.isPending ? (
        <div data-testid="market-loading" className="md:col-span-5">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <div className="text-sm text-ink-muted md:col-span-5">
          {slot.stale ? "Unavailable — last update failed." : `${UNAVAILABLE}: this market could not be read right now.`}
        </div>
      )}
    </li>
  )
}

function maturityText(ms: MarketState, ledgerTime: number | null): string {
  if (ms.maturity.status === "unavailable") return UNAVAILABLE
  return `${DATE.format(new Date(Number(ms.maturity.value) * 1000))} (${daysLeft(secondsLeft(ms, ledgerTime))})`
}

/** The YT and PT chips of one maturity; only a live or paused market offers them. */
function ChipCells({ market, ms, ledgerTime }: { market: Market; ms: MarketState; ledgerTime: number | null }) {
  const status = marketStatus(ms, ledgerTime)
  const open = status === "live" || status === "paused"
  const closed = status === "matured" ? "Matured" : status === "settled" ? "Settled" : UNAVAILABLE
  const closedReason = open ? undefined : "This market cannot be bought into right now."
  const lev = open ? leverageOf(ms) : noFigure(closedReason!)
  const fixed = open ? fixedApyOf(ms, ledgerTime) : noFigure(closedReason!)
  const noText = (f: Figure) => (open ? (f.kind === "none" && f.reason.startsWith("No liquidity") ? "No price yet" : UNAVAILABLE) : closed)
  return (
    <>
      <Cell label="YT · leverage">
        <Chip kind="yt" marketId={market.marketId} figure={lev} text={lev.kind === "value" ? `${Math.round(lev.value)}x` : noText(lev)} />
      </Cell>
      <Cell label="PT · fixed APY">
        <Chip kind="pt" marketId={market.marketId} figure={fixed} text={fixed.kind === "value" ? formatPercent(fixed.value) : noText(fixed)} />
      </Cell>
    </>
  )
}

type Group = { key: string; name: string; note: string | null; decimals: number; code: string; markets: Market[] }

function groupMarkets(manifest: Manifest): Group[] {
  const groups = new Map<string, Group>()
  for (const market of manifest.markets) {
    const u = market.underlying
    const key = u.sac || `${u.code}:${u.issuer}`
    let g = groups.get(key)
    if (!g) {
      const test = manifest.testAsset && (manifest.testAsset.sac === u.sac || (manifest.testAsset.code === u.code && manifest.testAsset.issuer === u.issuer))
      g = { key, name: test ? manifest.testAsset!.displayName : u.code, note: test ? TEST_NOTE : null, decimals: u.decimals, code: u.code, markets: [] }
      groups.set(key, g)
    }
    g.markets.push(market)
  }
  return [...groups.values()]
}

/** Sum of per-market values; Unavailable as soon as one market's is (never a partial total). */
function total(parts: ({ kind: "value"; value: bigint } | { kind: "none" } | { kind: "unavailable" } | undefined)[]) {
  let sum = 0n
  for (const p of parts) {
    if (p === undefined || p.kind === "unavailable") return { kind: "unavailable" } as const
    if (p.kind === "value") sum += p.value
  }
  // Every pool unseeded: no liquidity yet, not a zero.
  if (parts.length > 0 && parts.every((p) => p?.kind === "none")) return { kind: "none" } as const
  return { kind: "value", value: sum } as const
}

function best(figures: Figure[]): Figure {
  const values = figures.flatMap((f) => (f.kind === "value" ? [f.value] : []))
  return values.length > 0 ? { kind: "value", value: Math.max(...values) } : noFigure("No market of this asset is live with a readable price.")
}

function AssetGroup({
  group,
  slots,
  ledgerTime,
  defaultOpen,
  sparks,
}: {
  group: Group
  slots: Slot[]
  ledgerTime: number | null
  defaultOpen: boolean
  sparks: { map: Record<string, Spark> | undefined; isPending: boolean; failed: boolean }
}) {
  const [open, setOpen] = useState(defaultOpen)
  const listId = useId()
  const states = slots.map((s) => (s.stale ? undefined : s.data))
  const loading = slots.some((s) => s.isPending && s.data === undefined)
  const liquidity = total(states.map((ms) => (ms ? liquidityOf(ms) : undefined)))
  const tvl = total(states.map((ms) => (ms ? tvlOf(ms) : undefined)))
  const liveStates = states.filter((ms): ms is MarketState => ms !== undefined && isLive(ms, ledgerTime))
  const bestLev = best(liveStates.map(leverageOf))
  const bestApy = best(liveStates.map((ms) => fixedApyOf(ms, ledgerTime)))
  const count = group.markets.length
  return (
    <li className="border-b border-line last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className={`group relative flex w-full flex-col gap-3 bg-surface-sunk px-4 py-4 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus ${COLUMNS}`}
      >
        <span className="flex min-w-0 items-center gap-3 max-md:pr-12">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-coupon-wash font-sans text-xs font-bold text-coupon-ink">
            {group.code.slice(0, 2)}
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-ink">{group.name}</span>
              <Badge>{count === 1 ? "1 market" : `${count} markets`}</Badge>
            </span>
            {group.note && <span className="mt-1 block text-xs text-ink-muted">{group.note}</span>}
          </span>
        </span>
        {loading ? (
          <span className="md:col-span-5">
            <Skeleton className="h-10 w-full" />
          </span>
        ) : (
          <>
            <span className="flex items-baseline justify-between gap-3 md:block">
              <span className="text-xs text-ink-muted md:hidden">Liquidity / TVL</span>
              <LiquidityTvl liquidity={liquidity} tvl={tvl.kind === "value" ? tvl : ({ kind: "unavailable" } as const)} decimals={group.decimals} unit={group.code} inButton />
            </span>
            <span className="hidden md:block" />
            <span className="hidden md:block" />
            <span className="flex items-baseline justify-between gap-3 font-mono tabular-nums md:block md:text-right">
              <span className="text-xs text-ink-muted md:hidden">Best YT leverage</span>
              {bestLev.kind === "value" ? <span>{`${Math.round(bestLev.value)}x`}</span> : <Unavailable label="Best YT leverage" reason={bestLev.reason} inButton />}
            </span>
            <span className="flex items-baseline justify-between gap-3 font-mono tabular-nums md:block md:text-right">
              <span className="text-xs text-ink-muted md:hidden">Best fixed APY</span>
              {bestApy.kind === "value" ? <span className="text-par">{formatPercent(bestApy.value)}</span> : <Unavailable label="Best fixed APY" reason={bestApy.reason} inButton />}
            </span>
          </>
        )}
        <span
          aria-hidden="true"
          data-testid="chevron"
          className="grid size-9 place-items-center rounded-full border border-line text-ink-muted transition-colors group-hover:bg-surface group-hover:text-ink max-md:absolute max-md:top-3 max-md:right-4 md:justify-self-end"
        >
          <ChevronDownIcon className={`size-5 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <ul id={listId}>
          {group.markets.map((market, i) => (
            <MaturityRow
              key={market.marketId}
              market={market}
              slot={slots[i]}
              ledgerTime={ledgerTime}
              sparks={{ spark: sparks.map?.[market.contracts.pool], isPending: sparks.isPending, failed: sparks.failed }}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export function MarketGroups() {
  const manifest = useManifest()
  const { ledgerTime } = useLedgerClock()
  const slots = useMarketStates(manifest.markets.map((m) => m.marketId))
  const sparks = useSparks(manifest.markets.map((m) => m.contracts.pool))
  const groups = groupMarkets(manifest)
  const slotOf = new Map(manifest.markets.map((m, i) => [m.marketId, slots[i]]))
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
      <div className={`hidden border-b border-line-strong bg-surface px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-muted ${COLUMNS}`}>
        <span>Asset / market</span>
        <span className="text-right">Liquidity / TVL</span>
        <span className="text-right">Underlying APY (7 d)</span>
        <span>Fixed APY, 30 d</span>
        <span className="text-right">YT leverage</span>
        <span className="text-right">PT fixed APY</span>
        <span className="sr-only">Expand</span>
      </div>
      <ul>
        {groups.map((g) => (
          <AssetGroup
            key={g.key}
            group={g}
            slots={g.markets.map((m) => slotOf.get(m.marketId)!)}
            ledgerTime={ledgerTime}
            defaultOpen={groups.length === 1}
            sparks={{ map: sparks.data?.sparks, isPending: sparks.isPending && sparks.fetchStatus !== "idle", failed: sparks.isError }}
          />
        ))}
      </ul>
    </div>
  )
}
