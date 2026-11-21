import { notFound } from "next/navigation"
import { getMarket } from "@/lib/protocol/manifest"
import { MarketView } from "@/components/app/market/market-view"
import { resolvedManifest } from "@/lib/server/manifest"

/**
 * The part of the market page that depends on the URL. It reads `params` inside the page's
 * `<Suspense>`, so the route's App Shell, shared by every market link, stays free of URL data.
 * An unknown id renders the not-found page; behind Suspense the response keeps status 200 and
 * Next adds `noindex`. Known ids are the resolved markets: the markets this network lists (on
 * Mainnet, the manifest's markets only).
 */
export async function MarketRoute({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params
  if (!getMarket(await resolvedManifest(), marketId)) notFound()
  return <MarketView marketId={marketId} />
}
