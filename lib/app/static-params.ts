import { activeManifest } from "@/lib/protocol/manifest-source"

/** A market id no manifest uses: its page answers not found. */
export const NO_SEED_MARKET = "no-seed-market"

/**
 * The market ids `/app/markets/[marketId]` and `/dashboard/markets/[marketId]` prerender: the
 * manifest's seeds. Cache Components needs at least one, so a manifest without seeds (a fresh local
 * stack) gives a placeholder id that is never a market. Other ids (registry markets) render on request.
 */
export function seedMarketParams(): { marketId: string }[] {
  const seeds = activeManifest().markets.map((m) => ({ marketId: m.marketId }))
  return seeds.length > 0 ? seeds : [{ marketId: NO_SEED_MARKET }]
}
