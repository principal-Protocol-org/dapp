import "server-only"

/**
 * `GET /api/markets/[pool]/history?range=7d|30d|90d|all`: the market's fixed APY, 7-day underlying
 * APY and liquidity series (spec 0002 §6). Pages must never break: when the database is down or
 * not configured the answer is 200 with an empty history and `stale: true`. Bad input is 400, a
 * pool that is not a known market is 404. Params are async in this Next; the route is dynamic.
 */
import { activeManifest } from "@/lib/protocol/manifest-source"
import { sql } from "@/lib/server/db"
import { getHistory, RANGES, type MarketHistory, type Range } from "@/lib/server/history"

const POOL = /^C[A-Z2-7]{55}$/

const CACHED = "public, s-maxage=60, stale-while-revalidate=300"

/** Only a real answer from the database is cached; errors and the database-down fallback are not. */
const json = (body: unknown, status = 200, cache = "no-store") =>
  Response.json(body, { status, headers: { "cache-control": cache } })

const EMPTY: MarketHistory = { fixedApy: [], underlyingApy7d: [], liquidity: [], latestAt: null, stale: true, underlyingWindowSeconds: null }

export async function GET(request: Request, { params }: { params: Promise<{ pool: string }> }) {
  const { pool } = await params
  const range = new URL(request.url).searchParams.get("range") ?? "7d"
  if (!POOL.test(pool)) return json({ error: "invalid_pool" }, 400)
  if (!RANGES.includes(range as Range)) return json({ error: "invalid_range" }, 400)

  const market = activeManifest().markets.find((m) => m.contracts.pool === pool)
  if (!market) return json({ error: "unknown_market" }, 404)

  try {
    return json(await getHistory(sql, pool, range as Range, { maturity: market.maturity }), 200, CACHED)
  } catch (error) {
    console.error("history route:", error instanceof Error ? error.name : "unknown")
    return json(EMPTY)
  }
}
