import { notFound } from "next/navigation"
import { MarketPanel } from "@/components/dashboard/market-panel"
import { getMarket } from "@/lib/protocol/manifest"
import { manifestPending } from "@/lib/protocol/manifest-source"
import { resolvedManifest } from "@/lib/server/manifest"

/**
 * The part of the dashboard market page that depends on the URL, read inside the page's `<Suspense>`
 * (as `/app`'s market route). Known ids are the resolved markets: seeds and valid registry markets.
 * An unknown id renders the dashboard's not-found page; behind Suspense the response keeps status 200
 * and Next adds `noindex`.
 */
export async function DashboardMarketRoute({ params }: { params: Promise<{ marketId: string }> }) {
  // Next renders pages in parallel with their layout, even one it does not show: while the Mainnet
  // manifest is the pending stub (D-24) the layout shows "not deployed yet", and this reads nothing.
  if (manifestPending()) return null
  const { marketId } = await params
  if (!getMarket(await resolvedManifest(), marketId)) notFound()
  return <MarketPanel marketId={marketId} />
}
