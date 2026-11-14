import { notFound } from "next/navigation"
import { getMarket } from "@/lib/protocol/manifest"
import { manifestPending } from "@/lib/protocol/manifest-source"
import { MarketView } from "@/components/app/market/market-view"
import { resolvedManifest } from "@/lib/server/manifest"

/**
 * The part of the market page that depends on the URL. It reads `params` inside the page's
 * `<Suspense>`, so the route's App Shell, shared by every market link, stays free of URL data.
 * An unknown id renders the not-found page; behind Suspense the response keeps status 200 and
 * Next adds `noindex`. Known ids are the resolved markets: seeds and valid registry markets.
 */
export async function MarketRoute({ params }: { params: Promise<{ marketId: string }> }) {
  // Next renders pages in parallel with their layout, even one it does not show: while the Mainnet
  // manifest is the pending stub (D-24) the layout shows "not deployed yet", and this reads nothing.
  if (manifestPending()) return null
  const { marketId } = await params
  if (!getMarket(await resolvedManifest(), marketId)) notFound()
  return <MarketView marketId={marketId} />
}
