import { Suspense } from "react"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { Skeleton } from "@/components/ui/skeleton"
import { MarketRoute } from "./market-route"

// Cache Components needs at least one prerendered param; other ids render on request.
export function generateStaticParams() {
  return activeManifest().markets.map((m) => ({ marketId: m.marketId }))
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
