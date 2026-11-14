"use client"

import { useAccountState } from "@/hooks/use-account-state"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketState } from "@/hooks/use-market-state"
import { useWallet } from "@/hooks/use-wallet"
import { rejectionText } from "@/lib/protocol/dashboard/rejections"
import { formatAmount, formatBps, formatRate, formatWindow, shorten } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { Live } from "@/lib/protocol/types"
import { Skeleton } from "@/components/ui/skeleton"
import { safetyIssues } from "@/components/app/market/attention"
import { LiveFigure, ReasonFigure, type FigureText } from "@/components/app/info-tip"
import { formatDuration, UNAVAILABLE } from "@/components/app/live"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <dt className="label">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">{children}</dd>
    </div>
  )
}

const pause = (paused: boolean) => (paused ? "Paused: new actions are refused" : "Not paused")

/** "Unavailable" with the error of the first input that could not be read, or null when all are live. */
function firstDown(...inputs: Live<unknown>[]): FigureText | null {
  for (const i of inputs) if (i.status === "unavailable") return { text: UNAVAILABLE, reason: i.error }
  return null
}

/** Room left under a window limit. A limit of 0 means the limit is off. */
function roomLeft(limit: Live<bigint>, volume: Live<bigint>, amount: (v: bigint) => string): FigureText {
  const down = firstDown(limit, volume)
  if (down) return down
  if (limit.status !== "live" || volume.status !== "live") return { text: UNAVAILABLE }
  if (limit.value <= 0n) return { text: "No limit (disabled)" }
  const left = limit.value > volume.value ? limit.value - volume.value : 0n
  return { text: `${amount(left)} left of ${amount(limit.value)}` }
}

/** The safety body: pauses, oracle freshness, circuit-breaker room and the account's deposit cap. It sits in the market info card's tab. */
export function SafetyContent({ marketId }: { marketId: string }) {
  const market = getMarket(useManifest(), marketId)
  const { data, isPending, stale } = useMarketState(marketId)
  const ms = stale ? undefined : data
  const { ledgerTime } = useLedgerClock()
  const { state } = useWallet()
  const account = useAccountState(marketId)
  if (!market) return null
  const amount = (v: bigint) => formatAmount(v, market.underlying.decimals)

  const oracle = (): FigureText => {
    if (!ms) return { text: UNAVAILABLE }
    const down = firstDown(ms.oracleFresh, ms.oracleMaxStaleSeconds)
    if (down) return down
    if (ms.oracleFresh.status !== "live" || ms.oracleMaxStaleSeconds.status !== "live") return { text: UNAVAILABLE }
    const window = formatWindow(ms.oracleMaxStaleSeconds.value)
    const fresh = ms.oracleFresh.value ? `Fresh (updated within the last ${window})` : `Stale (not updated within the last ${window})`
    if (ledgerTime === null || ms.oracleTimestamp.status === "unavailable") return { text: fresh }
    return { text: `${fresh}, updated ${formatDuration(ledgerTime - Number(ms.oracleTimestamp.value))} ago` }
  }

  const source = (v: string | null) => (v === null ? "None" : shorten(v))

  const lastRejection = (): React.ReactNode => {
    if (!ms) return UNAVAILABLE
    return <LiveFigure label="Oracle last rejected update" live={ms.oracleLastRejection} format={(r) => {
      if (r === null) return "None"
      const why = rejectionText(r.reason)
      const when = ledgerTime === null ? null : `${formatDuration(ledgerTime - Number(r.timestamp))} ago`
      return `${why} (value ${formatRate(r.value)}${when ? `, ${when}` : ""})`
    }} />
  }

  const depositCap = (): FigureText => {
    if (state.status !== "connected") return { text: "Connect a wallet to see your cap" }
    const acc = account.stale ? undefined : account.data
    if (!acc) return { text: account.isPending ? "Loading" : UNAVAILABLE }
    const down = firstDown(acc.depositCap, acc.netDeposited)
    if (down) return down
    if (acc.depositCap.status !== "live" || acc.netDeposited.status !== "live") return { text: UNAVAILABLE }
    if (acc.depositCap.value <= 0n) return { text: "No cap (disabled)" }
    const left = acc.depositCap.value > acc.netDeposited.value ? acc.depositCap.value - acc.netDeposited.value : 0n
    return { text: `${amount(left)} left of ${amount(acc.depositCap.value)}` }
  }

  return ms ? (
    <dl className="grid gap-3 text-ink">
      <Row label="SY wrapper"><LiveFigure label="SY wrapper" live={ms.syPaused} format={pause} /></Row>
      <Row label="Market pool"><LiveFigure label="Market pool" live={ms.poolPaused} format={pause} /></Row>
      <Row label="Risk control"><LiveFigure label="Risk control" live={ms.riskPaused} format={pause} /></Row>
      <Row label="Principal manager"><LiveFigure label="Principal manager" live={ms.managerPaused} format={pause} /></Row>
      <Row label="Oracle"><ReasonFigure label="Oracle" figure={oracle()} /></Row>
      <Row label="Oracle deviation cap"><LiveFigure label="Oracle deviation cap" live={ms.oracleMaxDeviationBps} format={formatBps} /></Row>
      <Row label="Oracle primary source"><LiveFigure label="Oracle primary source" live={ms.oraclePrimarySource} format={source} /></Row>
      <Row label="Oracle fallback source"><LiveFigure label="Oracle fallback source" live={ms.oracleFallbackSource} format={source} /></Row>
      <Row label="Oracle last rejected update">{lastRejection()}</Row>
      <Row label="Circuit breaker, protocol-wide"><ReasonFigure label="Circuit breaker, protocol-wide" figure={roomLeft(ms.cb.limit, ms.cb.volume, amount)} /></Row>
      <Row label={`Circuit breaker, ${market.underlying.code}`}>
        <ReasonFigure label={`Circuit breaker, ${market.underlying.code}`} figure={roomLeft(ms.cb.assetLimit, ms.cb.assetVolume, amount)} />
      </Row>
      <Row label="Your deposit cap"><ReasonFigure label="Your deposit cap" figure={depositCap()} /></Row>
    </dl>
  ) : isPending ? (
    <Skeleton className="h-48 w-full" />
  ) : (
    <p className="text-sm text-ink">{stale ? "Unavailable — last update failed." : `${UNAVAILABLE}: safety data could not be read right now.`}</p>
  )
}

/**
 * How many problems the Safety tab reports; undefined while the market state, a counted value or a
 * connected account cannot be read (M3).
 */
export function useSafetyIssues(marketId: string): number | undefined {
  const { data, stale } = useMarketState(marketId)
  const { state } = useWallet()
  const account = useAccountState(marketId)
  // No wallet: the cap is not counted. A connected account still loading or unreadable: no count yet.
  const acc = state.status !== "connected" ? undefined : account.stale ? null : (account.data ?? null)
  return safetyIssues(stale ? undefined : data, acc)
}
