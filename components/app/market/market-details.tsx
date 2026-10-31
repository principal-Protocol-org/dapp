"use client"

import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketState } from "@/hooks/use-market-state"
import { formatAmount, formatBps, formatFeeRate, formatRate } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatDuration, showLive, UNAVAILABLE } from "@/components/app/live"
import { MATURITY_DATE } from "@/components/app/market/market-header"
import { Metric } from "@/components/app/market/metric"

/** The market's facts: oracle rate and freshness, supplies, reserves, fees and maturity. */
export function MarketDetails({ marketId }: { marketId: string }) {
  const market = getMarket(useManifest(), marketId)
  const { data, isPending, stale } = useMarketState(marketId)
  const { ledgerTime } = useLedgerClock()
  const ms = stale ? undefined : data
  if (!market) return null
  if (!ms) {
    return isPending ? (
      <Skeleton className="h-40 w-full" />
    ) : (
      <p role="alert" className="rounded-lg border border-line bg-surface p-5 text-ink">
        {stale ? "Unavailable — last update failed." : `${UNAVAILABLE}: this market could not be read right now.`} Nothing below is current.
      </p>
    )
  }
  const amount = (v: bigint) => formatAmount(v, market.underlying.decimals, 4, { group: true })
  const oracleAge =
    ledgerTime === null || ms.oracleTimestamp.status === "unavailable"
      ? UNAVAILABLE
      : `${formatDuration(ledgerTime - Number(ms.oracleTimestamp.value))} ago`
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-5 min-[480px]:grid-cols-2 min-[900px]:grid-cols-3">
      <Metric label="Oracle rate">
        {ms.oracleRate.status === "live" ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="cursor-help underline decoration-dotted underline-offset-4">
                {formatRate(ms.oracleRate.value)}
              </button>
            </TooltipTrigger>
            <TooltipContent>Notional per SY share, read from the market oracle. PT and YT are counted in notional units.</TooltipContent>
          </Tooltip>
        ) : (
          UNAVAILABLE
        )}
      </Metric>
      <Metric label="Oracle updated">{oracleAge}</Metric>
      <Metric label="Maturity">{showLive(ms.maturity, (v) => MATURITY_DATE.format(new Date(Number(v) * 1000)))}</Metric>
      <Metric label="PT outstanding">{showLive(ms.totalPt, amount)}</Metric>
      <Metric label="YT outstanding">{showLive(ms.totalYt, amount)}</Metric>
      <Metric label="PT price (pool spot)">{showLive(ms.ptPrice, (v) => `${formatRate(v)} notional value per PT`)}</Metric>
      <Metric label="Pool PT reserve">{showLive(ms.poolState, (p) => amount(p.ptReserve))}</Metric>
      <Metric label="Pool SY reserve">{showLive(ms.poolState, (p) => amount(p.syReserve))}</Metric>
      <Metric label="Tokenization fee">{showLive(ms.fees.tokenizationBps, formatBps)}</Metric>
      <Metric label="YT fee">{showLive(ms.fees.ytBps, formatBps)}</Metric>
      <Metric label="Current swap fee (decreases to 0 at maturity)">{showLive(ms.swapFeeRate, formatFeeRate)}</Metric>
      {ms.settledRate.status === "live" && ms.settledRate.value !== null ? (
        <Metric label="Settlement rate">{formatRate(ms.settledRate.value)}</Metric>
      ) : null}
    </dl>
  )
}
