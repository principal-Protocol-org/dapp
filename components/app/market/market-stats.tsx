"use client"

import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketHistory } from "@/hooks/use-market-history"
import { useMarketState } from "@/hooks/use-market-state"
import { formatAmount, formatPercent } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { leverage, marketTvl } from "@/lib/protocol/rates"
import type { MarketState } from "@/lib/protocol/market-state"
import { useManifest } from "@/components/app/manifest-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { UNAVAILABLE } from "@/components/app/live"
import { UnavailableTip } from "@/components/app/info-tip"
import { FixedApy } from "@/components/app/market/fixed-apy"
import { liquidityOf } from "@/components/app/market/liquidity"
import { Metric } from "@/components/app/market/metric"
import { underlyingApyOf } from "@/components/app/market/underlying-apy"

/** Unavailable, with its reason behind an info tip (M10). `label` is the stat's. */
function Unavailable({ label, reason }: { label: string; reason: string }) {
  return <UnavailableTip label={label} reason={reason} className="text-ink-muted" />
}

function yt(ms: MarketState): React.ReactNode {
  const label = "YT leverage"
  if (ms.poolSeeded.status === "unavailable") return <Unavailable label={label} reason="Whether the pool has liquidity could not be read." />
  if (!ms.poolSeeded.value) return "No liquidity yet"
  if (ms.ptPrice.status === "unavailable") return <Unavailable label={label} reason="The PT price could not be read." />
  const l = leverage(ms.ptPrice.value)
  return l === undefined ? <Unavailable label={label} reason="The PT is priced at or above par, so a YT has no leverage." /> : `${Math.round(l)}x`
}

function UnderlyingApyStat({ pool }: { pool: string }) {
  const { data, isPending } = useMarketHistory(pool, "7d")
  if (isPending) return <Skeleton className="h-6 w-20" />
  const f = underlyingApyOf(data)
  if (f.kind === "none") return <Unavailable label="Underlying APY (7 d)" reason={f.reason} />
  return (
    <>
      <span>{formatPercent(f.value)}</span> <span className="block font-sans text-xs text-ink-muted">{f.caption}</span>
    </>
  )
}

/** The five stats above the chart (spec 0002 §3). Nothing is shown from a failed refresh. */
export function MarketStats({ marketId }: { marketId: string }) {
  const market = getMarket(useManifest(), marketId)
  const { data, isPending, stale } = useMarketState(marketId)
  const { ledgerTime } = useLedgerClock()
  const ms = stale ? undefined : data
  if (!market) return null
  if (!ms) {
    return isPending ? (
      <Skeleton className="h-24 w-full" />
    ) : (
      <p role="alert" className="rounded-lg border border-line bg-surface p-5 text-ink">
        {stale ? "Unavailable — last update failed." : `${UNAVAILABLE}: this market could not be read right now.`} Nothing below is current.
      </p>
    )
  }
  const { decimals, code } = market.underlying
  const amount = (v: bigint) => `≈ ${formatAmount(v, decimals, 2, { group: true })} ${code}`
  const l = liquidityOf(ms)
  const tvl = marketTvl(ms)
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 rounded-lg border border-line bg-surface p-5 min-[900px]:grid-cols-5">
      <Metric label="Liquidity">
        {l.kind === "value" ? amount(l.value) : l.kind === "none" ? "No liquidity yet" : <Unavailable label="Liquidity" reason="The pool's value could not be read." />}
      </Metric>
      <Metric label="TVL">{tvl.status === "live" ? amount(tvl.value) : <Unavailable label="TVL" reason="The TVL could not be read." />}</Metric>
      <Metric label="Underlying APY (7 d)">
        <UnderlyingApyStat pool={market.contracts.pool} />
      </Metric>
      <Metric label="PT fixed APY">
        <FixedApy impliedRate={ms.impliedRate} maturity={ms.maturity} ledgerTime={ledgerTime} poolSeeded={ms.poolSeeded} />
      </Metric>
      <Metric label="YT leverage">{yt(ms)}</Metric>
    </dl>
  )
}
