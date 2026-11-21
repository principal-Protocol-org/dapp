import { notFound } from "next/navigation"
import { MarketPanel } from "@/components/dashboard/market-panel"
import { getMarket } from "@/lib/protocol/manifest"
import { resolvedManifest } from "@/lib/server/manifest"

/**
 * The part of the dashboard market page that depends on the URL, read inside the page's `<Suspense>`
 * (as `/app`'s market route). Known ids are the resolved markets: the markets this network lists
 * (on Mainnet, the manifest's markets only).
 * An unknown id renders the dashboard's not-found page; behind Suspense the response keeps status 200
 * and Next adds `noindex`.
 */
export async function DashboardMarketRoute({ params }: { params: Promise<{ marketId: string }> }) {
  const { marketId } = await params
  if (!getMarket(await resolvedManifest(), marketId)) notFound()
  return <MarketPanel marketId={marketId} />
}
