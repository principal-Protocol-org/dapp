import "server-only"

/**
 * `GET /api/markets/sparks?pools=a,b`: the last 30 days of fixed APY and the change in percentage
 * points for each pool (spec 0002 §6; ruling R2-32). Bad input is 400. When the database is down
 * the answer is 200 with empty sparks and `stale: true`.
 */
import { activeManifest } from "@/lib/protocol/manifest-source"
import { sql } from "@/lib/server/db"
import { getSparks, type Spark } from "@/lib/server/history"

const POOL = /^C[A-Z2-7]{55}$/
const MAX_POOLS = 50

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("pools") ?? ""
  const pools = [...new Set(raw.split(",").filter(Boolean))]
  if (pools.length === 0 || pools.length > MAX_POOLS || !pools.every((p) => POOL.test(p))) {
    return json({ error: "invalid_pools" }, 400)
  }

  const maturities: Record<string, number> = {}
  for (const m of activeManifest().markets) maturities[m.contracts.pool] = m.maturity

  try {
    return json({ sparks: await getSparks(sql, pools, maturities), stale: false })
  } catch (error) {
    console.error("sparks route:", error instanceof Error ? error.name : "unknown")
    const empty: Record<string, Spark> = {}
    for (const p of pools) empty[p] = { points: [], changePts: null }
    return json({ sparks: empty, stale: true })
  }
}
