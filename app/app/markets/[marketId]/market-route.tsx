import { notFound } from "next/navigation"
import { getMarket } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { MarketView } from "@/components/app/market/market-view"

/**
 * The part of the market page that depends on the URL. It reads `params` inside the page's
 * `<Suspense>`, so the route's App Shell, shared by every market link, stays free of URL data.
 * An unknown id renders the not-found page; behind Suspense the response keeps status 200 and
 * Next adds `noindex`.
 */
export async function MarketRoute({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params
  if (!getMarket(activeManifest(), marketId)) notFound()
  return <MarketView marketId={marketId} />
}
