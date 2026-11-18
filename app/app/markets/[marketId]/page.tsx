import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { seedMarketParams } from "@/lib/app/static-params"
import { MarketRoute } from "./market-route"

// Cache Components needs at least one prerendered param; other ids (registry markets) render on
// request. A manifest without seeds still builds: its placeholder id is not a market (404).
export function generateStaticParams() {
  return seedMarketParams()
}

function MarketFallback() {
  return (
    <div className="grid gap-8" aria-busy="true">
      <p className="sr-only">Loading the market…</p>
      <Skeleton className="h-9 w-64 max-w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  )
}

/** The market id is URL data: it is read inside Suspense, never in the shared App Shell (V3). */
export default function MarketPage({ params }: { params: Promise<{ marketId: string }> }) {
  return (
    <Suspense fallback={<MarketFallback />}>
      <MarketRoute params={params} />
    </Suspense>
  )
}
