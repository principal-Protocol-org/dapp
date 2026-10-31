/** Client-visible history types (no `server-only`): shared by lib/server/history and the UI. */
export type Range = "7d" | "30d" | "90d" | "all"
/** A null value is a gap in the data; it is never interpolated. */
export type Series = { at: number; value: number | null }[]
export type MarketHistory = {
  fixedApy: Series
  underlyingApy7d: Series
  liquidity: Series
  latestAt: number | null
  stale: boolean
  /** Window of the latest underlying-APY point (shorter than 7 d near the start of history); null without one. */
  underlyingWindowSeconds: number | null
}
export type Spark = { points: Series; changePts: number | null; stale: boolean }
