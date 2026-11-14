import { Suspense } from "react"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { Skeleton } from "@/components/ui/skeleton"
import { DashboardMarketRoute } from "./market-route"

// As /app's market page: Cache Components needs at least one prerendered param; other ids (registry
// markets) render on request. A manifest without seeds still builds: its placeholder id is not a market (404).
export function generateStaticParams() {
  const seeds = activeManifest().markets.map((m) => ({ marketId: m.marketId }))
  return seeds.length > 0 ? seeds : [{ marketId: "no-seed-market" }]
}

function MarketFallback() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <p className="sr-only">Loading the market…</p>
      <Skeleton className="h-9 w-64 max-w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

/** The market id is URL data: it is read inside Suspense, never in the dashboard's shared shell. */
export default function DashboardMarketPage({ params }: { params: Promise<{ marketId: string }> }) {
  return (
    <Suspense fallback={<MarketFallback />}>
      <DashboardMarketRoute params={params} />
    </Suspense>
  )
}
