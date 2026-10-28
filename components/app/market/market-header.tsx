"use client"

import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketState } from "@/hooks/use-market-state"
import { formatAmount, formatBps, formatFeeRate, formatRate } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatDuration, showLive, UNAVAILABLE } from "@/components/app/live"
import { Countdown } from "@/components/app/market/countdown"
import { FixedApy } from "@/components/app/market/fixed-apy"
import { liquidityText } from "@/components/app/market/liquidity"
import { Metric } from "@/components/app/market/metric"
import { marketStatus } from "@/components/app/markets/markets-table"
import { StatusBadge } from "@/components/app/markets/status-badge"

export function MarketHeader({ marketId }: { marketId: string }) {
  const market = getMarket(activeManifest(), marketId)
  const { data, isPending, stale } = useMarketState(marketId)
  const ms = stale ? undefined : data
  const { ledgerTime } = useLedgerClock()
  if (!market) return null
  const decimals = market.underlying.decimals
  const amount = (v: bigint) => formatAmount(v, decimals)

  const oracleAge = (): string => {
    if (!ms || ledgerTime === null || ms.oracleTimestamp.status === "unavailable") return UNAVAILABLE
    return `${formatDuration(ledgerTime - Number(ms.oracleTimestamp.value))} ago`
  }

  return (
    <header className="grid gap-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="font-serif text-3xl text-ink">{market.displayName}</h1>
        {ms ? <StatusBadge status={marketStatus(ms, ledgerTime)} /> : null}
        <p className="font-mono text-sm text-ink-muted">
          <Countdown maturity={ms && ms.maturity.status === "live" ? ms.maturity.value : null} />
        </p>
      </div>
      {ms ? (
        <dl className="grid grid-cols-1 gap-x-8 gap-y-5 rounded-lg border border-line bg-surface p-5 min-[480px]:grid-cols-2 min-[900px]:grid-cols-3">
          <Metric label="Fixed APY">
            <FixedApy impliedRate={ms.impliedRate} maturity={ms.maturity} ledgerTime={ledgerTime} poolSeeded={ms.poolSeeded} />
          </Metric>
          <Metric label="PT price (pool spot)">
            {showLive(ms.ptPrice, (v) => `${formatRate(v)} SY per PT (notional)`)}
          </Metric>
          <Metric label="Oracle rate">
            {ms.oracleRate.status === "live" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="cursor-help underline decoration-dotted underline-offset-4">
                    {formatRate(ms.oracleRate.value)}
                  </button>
                </TooltipTrigger>
                <TooltipContent>Underlying per SY, read from the market oracle.</TooltipContent>
              </Tooltip>
            ) : (
              UNAVAILABLE
            )}
          </Metric>
          <Metric label="Oracle updated">{oracleAge()}</Metric>
          <Metric label="PT total supply">{showLive(ms.totalPt, amount)}</Metric>
          <Metric label="YT total supply">{showLive(ms.totalYt, amount)}</Metric>
          <Metric label="Pool PT reserve">{showLive(ms.poolState, (p) => amount(p.ptReserve))}</Metric>
          <Metric label="Pool SY reserve">{showLive(ms.poolState, (p) => amount(p.syReserve))}</Metric>
          <Metric label="Pool value (estimate)">
            {liquidityText(ms, decimals, market.underlying.code, true)}
          </Metric>
          <Metric label="Tokenization fee">{showLive(ms.fees.tokenizationBps, formatBps)}</Metric>
          <Metric label="YT fee">{showLive(ms.fees.ytBps, formatBps)}</Metric>
          <Metric label="Current swap fee (decreases to 0 at maturity)">
            {showLive(ms.swapFeeRate, formatFeeRate)}
          </Metric>
          {ms.settledRate.status === "live" && ms.settledRate.value !== null ? (
            <Metric label="Settlement rate">{formatRate(ms.settledRate.value)}</Metric>
          ) : null}
        </dl>
      ) : isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <p role="alert" className="rounded-lg border border-line bg-surface p-5 text-ink">
          {stale ? "Unavailable — last update failed." : `${UNAVAILABLE}: this market could not be read right now.`} Nothing below is current.
        </p>
      )}
    </header>
  )
}
