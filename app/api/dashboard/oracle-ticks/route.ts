import "server-only"

/**
 * `GET /api/dashboard/oracle-ticks`: the oracle keeper's telemetry (spec 0004 D-19), public, no wallet.
 *
 * `?limit=1..100` (20 by default). The answer is `{ ticks, health, intervalSeconds }`:
 * - `ticks`: the newest recorded `cron/oracle` runs of this network's oracle (`RecordedTick`), each
 *   with its time, mode, decision, value, reason, tx hash and signer (a public key; no secret is
 *   ever recorded);
 * - `health`: `keeperHealth` over the same rows (healthy while the last success is younger than
 *   2 × `intervalSeconds`; `lastTickAt` null when no run is recorded);
 * - `intervalSeconds`: the keeper's schedule, `ORACLE_TICK_INTERVAL_SECONDS`.
 *
 * Bad input is 400. A database answer is cached 60 s at the edge; errors are never cached (503
 * `not_configured` without `DATABASE_URL`, 503 `unavailable` when the database fails). It reads the
 * request, so under Cache Components it runs at request time.
 */
import { activeManifest } from "@/lib/protocol/manifest-source"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { keeperHealth, listTicks, ORACLE_TICK_INTERVAL_SECONDS } from "@/lib/server/oracle-ticks"

const CACHED = "public, s-maxage=60, stale-while-revalidate=300"
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

const json = (body: unknown, status = 200, cache = "no-store") =>
  Response.json(body, { status, headers: { "cache-control": cache } })

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("limit")
  if (raw !== null && (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_LIMIT)) return json({ error: "invalid_limit" }, 400)
  const limit = raw === null ? DEFAULT_LIMIT : Number(raw)

  try {
    // Inside the try: a manifest that cannot be read is a 503, never an unhandled 500.
    const manifest = activeManifest()
    const { network } = manifest
    const oracle = manifest.shared.oracle
    const [ticks, health] = await Promise.all([
      listTicks(sql, { network, oracle, limit }),
      keeperHealth(sql, network, ORACLE_TICK_INTERVAL_SECONDS, { oracle }),
    ])
    return json({ ticks, health, intervalSeconds: ORACLE_TICK_INTERVAL_SECONDS }, 200, CACHED)
  } catch (error) {
    if (error instanceof DatabaseConfigError) return json({ error: "not_configured" }, 503)
    console.error("dashboard oracle-ticks route:", error instanceof Error ? error.name : "unknown")
    return json({ error: "unavailable" }, 503)
  }
}
