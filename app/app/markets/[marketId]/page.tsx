import { notFound } from "next/navigation"
import { getMarket } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { MarketView } from "@/components/app/market/market-view"

// Cache Components needs at least one prerendered param; other ids render on request.
export function generateStaticParams() {
  return activeManifest().markets.map((m) => ({ marketId: m.marketId }))
}

export default async function MarketPage({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params
  if (!getMarket(activeManifest(), marketId)) notFound()
  return <MarketView marketId={marketId} />
}
