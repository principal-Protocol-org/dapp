import "server-only"

/**
 * `GET /api/markets/sparks?pools=a,b`: the last 30 days of fixed APY and the change in percentage
 * points for each pool (spec 0002 §6; ruling R2-32). Bad input is 400. When the database is down
 * the answer is 200 with empty sparks and `stale: true`.
 * Cached 60 s at the CDN (stale-while-revalidate 300 s) when the answer came from the database.
 */
import { activeManifest } from "@/lib/protocol/manifest-source"
import { sql } from "@/lib/server/db"
import { getSparks, type Spark } from "@/lib/server/history"
import { resolvedMarkets, sqlRegistryStore } from "@/lib/server/registry"

const POOL = /^C[A-Z2-7]{55}$/
const MAX_POOLS = 50

const CACHED = "public, s-maxage=60, stale-while-revalidate=300"

/** Only a real answer from the database is cached; errors and the database-down fallback are not. */
const json = (body: unknown, status = 200, cache = "no-store") =>
  Response.json(body, { status, headers: { "cache-control": cache } })

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("pools") ?? ""
  const pools = [...new Set(raw.split(",").filter(Boolean))]
  if (pools.length === 0 || pools.length > MAX_POOLS || !pools.every((p) => POOL.test(p))) {
    return json({ error: "invalid_pools" }, 400)
  }

  // Seeds and valid registry markets (R2-33): a discovered pool has a maturity too.
  const maturities: Record<string, number> = {}
  for (const m of await resolvedMarkets({ store: sqlRegistryStore(sql), manifest: activeManifest() })) maturities[m.contracts.pool] = m.maturity

  try {
    const sparks = await getSparks(sql, pools, maturities)
    // Each spark carries its own `stale`; the top-level flag is set when any pool is stale.
    return json({ sparks, stale: Object.values(sparks).some((s) => s.stale) }, 200, CACHED)
  } catch (error) {
    console.error("sparks route:", error instanceof Error ? error.name : "unknown")
    const empty: Record<string, Spark> = {}
    for (const p of pools) empty[p] = { points: [], changePts: null, stale: true }
    return json({ sparks: empty, stale: true })
  }
}
