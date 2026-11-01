"use client"

import { useState } from "react"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketHistory, type Range } from "@/hooks/use-market-history"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { UNAVAILABLE } from "@/components/app/live"
import { LineChart } from "@/components/app/charts/line-chart"

const SPREAD = { fixed: "fixed", variable: "underlying" } as const

/** APY and Liquidity history over a range, in two tabs. */
export function MarketChartBox({ marketId }: { marketId: string }) {
  const market = getMarket(useManifest(), marketId)
  const [range, setRange] = useState<Range>("30d")
  const [tab, setTab] = useState("apy")
  const history = useMarketHistory(market?.contracts.pool ?? "", range)
  const { ledgerTime } = useLedgerClock()
  if (!market) return null
  const { data } = history
  // Age of the data is measured on the ledger clock, never the browser clock; without it the
  // chart assumes no age rather than guessing.
  const now = ledgerTime !== null ? ledgerTime * 1000 : (data?.latestAt ?? 0) * 1000

  const chart = (kind: "apy" | "liquidity") => {
    if (history.isPending) return <Skeleton className="h-72 w-full" />
    if (!data) {
      return (
        <p role="alert" className="rounded-md border border-line bg-surface-sunk p-4 text-sm text-ink">
          {UNAVAILABLE}: History could not be read right now.
        </p>
      )
    }
    const common = { range, onRangeChange: setRange, stale: data.stale, latestAt: data.latestAt, now }
    return kind === "apy" ? (
      <LineChart
        {...common}
        series={[
          { id: "fixed", label: "Fixed APY", color: "pt", points: data.fixedApy },
          { id: "underlying", label: "Underlying APY (7 d)", color: "yt", points: data.underlyingApy7d },
        ]}
        spread={SPREAD}
      />
    ) : (
      <LineChart
        {...common}
        unit="amount"
        series={[{ id: "liquidity", label: `Liquidity (${market.underlying.code})`, color: "pt", points: data.liquidity }]}
      />
    )
  }

  return (
    <section aria-label="Market chart" className="min-w-0 rounded-lg border border-line bg-surface p-5">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="apy">APY</TabsTrigger>
          <TabsTrigger value="liquidity">Liquidity</TabsTrigger>
        </TabsList>
        <TabsContent value="apy">{chart("apy")}</TabsContent>
        <TabsContent value="liquidity">{chart("liquidity")}</TabsContent>
      </Tabs>
    </section>
  )
}
