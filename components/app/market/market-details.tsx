"use client"

import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketState } from "@/hooks/use-market-state"
import { formatAmount, formatBps, formatFeeRate, formatRate } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { InfoTip, LiveFigure } from "@/components/app/info-tip"
import { formatDuration, UNAVAILABLE } from "@/components/app/live"
import { MATURITY_DATE } from "@/components/app/market/market-header"

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
    <div className="grid grid-cols-1 gap-x-10 gap-y-6 sm:grid-cols-2">
      <Group title="Oracle & maturity">
        <Row label="Oracle rate" tip="Notional per SY share, read from the market oracle. PT and YT are counted in notional units.">
          <LiveFigure label="Oracle rate" live={ms.oracleRate} format={formatRate} />
        </Row>
        <Row label="Oracle updated">{oracleAge}</Row>
        <Row label="Maturity"><LiveFigure label="Maturity" live={ms.maturity} format={(v) => MATURITY_DATE.format(new Date(Number(v) * 1000))} /></Row>
        {ms.settledRate.status === "live" && ms.settledRate.value !== null ? (
          <Row label="Settlement rate">{formatRate(ms.settledRate.value)}</Row>
        ) : null}
      </Group>
      <Group title="Pool & fees">
        <Row label="PT outstanding"><LiveFigure label="PT outstanding" live={ms.totalPt} format={amount} /></Row>
        <Row label="YT outstanding"><LiveFigure label="YT outstanding" live={ms.totalYt} format={amount} /></Row>
        <Row label="PT price (pool spot)" tip="Notional value per PT, from the pool's spot price.">
          <LiveFigure label="PT price (pool spot)" live={ms.ptPrice} format={formatRate} />
        </Row>
        <Row label="Pool PT reserve"><LiveFigure label="Pool PT reserve" live={ms.poolState} format={(p) => amount(p.ptReserve)} /></Row>
        <Row label="Pool SY reserve"><LiveFigure label="Pool SY reserve" live={ms.poolState} format={(p) => amount(p.syReserve)} /></Row>
        <Row label="Tokenization fee"><LiveFigure label="Tokenization fee" live={ms.fees.tokenizationBps} format={formatBps} /></Row>
        <Row label="YT fee"><LiveFigure label="YT fee" live={ms.fees.ytBps} format={formatBps} /></Row>
        <Row label="Swap fee" tip="The current swap fee. It decreases to 0 at maturity.">
          <LiveFigure label="Swap fee" live={ms.swapFeeRate} format={formatFeeRate} />
        </Row>
      </Group>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="label mb-1">{title}</h3>
      <dl className="grid">{children}</dl>
    </section>
  )
}

/** One title -> value row, like the trade details table: the title on the left, the value on the right. */
function Row({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2.5 first:border-t-0">
      <dt className="flex min-w-0 items-center gap-1.5 text-ink-muted">
        <span>{label}</span>
        {tip ? <InfoTip label={label}>{tip}</InfoTip> : null}
      </dt>
      <dd className="text-right font-mono text-[15px]/6 tabular-nums text-ink">{children}</dd>
    </div>
  )
}
