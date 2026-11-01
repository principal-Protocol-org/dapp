"use client"

import { useAccountState } from "@/hooks/use-account-state"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketState } from "@/hooks/use-market-state"
import { useWallet } from "@/hooks/use-wallet"
import { formatAmount } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { Live } from "@/lib/protocol/types"
import { Skeleton } from "@/components/ui/skeleton"
import { safetyIssues } from "@/components/app/market/attention"
import { formatDuration, showLive, UNAVAILABLE } from "@/components/app/live"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <dt className="label">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">{children}</dd>
    </div>
  )
}

const pause = (paused: boolean) => (paused ? "Paused: new actions are refused" : "Not paused")

/** Room left under a window limit. A limit of 0 means the limit is off. */
function roomLeft(limit: Live<bigint>, volume: Live<bigint>, amount: (v: bigint) => string): string {
  if (limit.status === "unavailable" || volume.status === "unavailable") return UNAVAILABLE
  if (limit.value <= 0n) return "No limit (disabled)"
  const left = limit.value > volume.value ? limit.value - volume.value : 0n
  return `${amount(left)} left of ${amount(limit.value)}`
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

  const oracle = (): string => {
    if (!ms) return UNAVAILABLE
    if (ms.oracleFresh.status === "unavailable") return UNAVAILABLE
    const fresh = ms.oracleFresh.value ? "Fresh (updated within the last hour)" : "Stale (not updated within the last hour)"
    if (ledgerTime === null || ms.oracleTimestamp.status === "unavailable") return fresh
    return `${fresh}, updated ${formatDuration(ledgerTime - Number(ms.oracleTimestamp.value))} ago`
  }

  const depositCap = (): string => {
    if (state.status !== "connected") return "Connect a wallet to see your cap"
    const acc = account.stale ? undefined : account.data
    if (!acc) return account.isPending ? "Loading" : UNAVAILABLE
    if (acc.depositCap.status === "unavailable" || acc.netDeposited.status === "unavailable") return UNAVAILABLE
    if (acc.depositCap.value <= 0n) return "No cap (disabled)"
    const left = acc.depositCap.value > acc.netDeposited.value ? acc.depositCap.value - acc.netDeposited.value : 0n
    return `${amount(left)} left of ${amount(acc.depositCap.value)}`
  }

  return ms ? (
    <dl className="grid gap-3 text-ink">
      <Row label="SY wrapper">{showLive(ms.syPaused, pause)}</Row>
      <Row label="Market pool">{showLive(ms.poolPaused, pause)}</Row>
      <Row label="Risk control">{showLive(ms.riskPaused, pause)}</Row>
      <Row label="Oracle">{oracle()}</Row>
      <Row label="Circuit breaker, protocol-wide">{roomLeft(ms.cb.limit, ms.cb.volume, amount)}</Row>
      <Row label={`Circuit breaker, ${market.underlying.code}`}>
        {roomLeft(ms.cb.assetLimit, ms.cb.assetVolume, amount)}
      </Row>
      <Row label="Your deposit cap">{depositCap()}</Row>
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
