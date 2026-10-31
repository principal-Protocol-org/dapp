"use client"

import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketState } from "@/hooks/use-market-state"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import { Countdown } from "@/components/app/market/countdown"
import { marketStatus } from "@/components/app/markets/market-groups"
import { StatusBadge, type MarketStatus } from "@/components/app/markets/status-badge"

export const MATURITY_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

/** Asset, status, maturity date and countdown of one market. */
export function MarketHeader({ marketId }: { marketId: string }) {
  const market = getMarket(useManifest(), marketId)
  const { data, isPending, stale } = useMarketState(marketId)
  const ms = stale ? undefined : data
  const { ledgerTime, isError: clockFailed } = useLedgerClock()
  if (!market) return null
  // While the clock or the market data is still loading the badge says so (V6); "Unavailable" is
  // for a read that failed.
  const status: MarketStatus | null = ms
    ? ledgerTime === null
      ? clockFailed
        ? "unavailable"
        : "loading"
      : marketStatus(ms, ledgerTime)
    : isPending
      ? "loading"
      : null
  const maturity = ms && ms.maturity.status === "live" ? ms.maturity.value : null
  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="font-serif text-3xl text-ink">{market.displayName}</h1>
      {status ? <StatusBadge status={status} /> : null}
      <p className="font-mono text-sm text-ink-muted">
        {maturity !== null ? <span>{MATURITY_DATE.format(new Date(Number(maturity) * 1000))} · </span> : null}
        <Countdown maturity={maturity} />
      </p>
    </header>
  )
}
