import "server-only"

/**
 * `GET /api/dashboard/oracle-ticks`: the oracle keeper's telemetry (spec 0004 D-19), public, no wallet.
 *
 * `?oracle=C…` (one of the manifest's oracles; every one by default) and `?limit=1..100` (20 by
 * default, per oracle). The answer is `{ intervalSeconds, oracles: [{ oracle, asset, health, ticks }] }`,
 * one entry per oracle of the manifest's markets (`manifestOracles`, in order), or only the one asked:
 * - `asset`: the underlying codes of the markets on that oracle, joined by ", ";
 * - `ticks`: the newest recorded `cron/oracle` runs of that oracle (`RecordedTick`), each with its
 *   time, mode, decision, value, reason, tx hash and signer (a public key; no secret is ever recorded);
 * - `health`: `keeperHealth` over its rows (healthy while the last run that did not fail, `lastOkAt`,
 *   is younger than 2 × `intervalSeconds`; `lastTickAt` null when no run is recorded);
 * - `intervalSeconds`: the keeper's schedule, `keeperIntervalSeconds` (`ORACLE_KEEPER_INTERVAL_SECONDS`, read per request).
 *
 * Bad input is 400 (`invalid_limit`; `unknown_oracle` for an `oracle` that is not a contract id or not
 * one of the manifest's oracles), never cached. A database answer is cached 60 s at the edge (the
 * query is part of the URL); errors are never cached (503 `not_configured` without `DATABASE_URL`,
 * 503 `unavailable` when the database fails). It reads the request, so under Cache Components it runs
 * at request time.
 */
import { assetCodes, manifestOracles } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { keeperHealth, keeperIntervalSeconds, listTicks } from "@/lib/server/oracle-ticks"

const CACHED = "public, s-maxage=60, stale-while-revalidate=300"
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
/** A contract id: `C` and 55 base32 characters. */
const CONTRACT = /^C[A-Z2-7]{55}$/

const json = (body: unknown, status = 200, cache = "no-store") =>
  Response.json(body, { status, headers: { "cache-control": cache } })

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const raw = params.get("limit")
  if (raw !== null && (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_LIMIT)) return json({ error: "invalid_limit" }, 400)
  const limit = raw === null ? DEFAULT_LIMIT : Number(raw)
  const asked = params.get("oracle")
  if (asked !== null && !CONTRACT.test(asked)) return json({ error: "unknown_oracle" }, 400)

  try {
    // Inside the try: a manifest that cannot be read is a 503, never an unhandled 500.
    const manifest = activeManifest()
    const { network } = manifest
    const all = manifestOracles(manifest)
    const oracles = asked === null ? all : all.filter((o) => o.oracle === asked)
    if (oracles.length === 0) return json({ error: "unknown_oracle" }, 400)
    // A bad schedule is a config error (logged by name below), never a silent default.
    const intervalSeconds = keeperIntervalSeconds(process.env)
    const entries = await Promise.all(
      oracles.map(async ({ oracle, markets }) => {
        const [ticks, health] = await Promise.all([listTicks(sql, { network, oracle, limit }), keeperHealth(sql, network, intervalSeconds, { oracle })])
        return { oracle, asset: assetCodes(markets), health, ticks }
      }),
    )
    return json({ intervalSeconds, oracles: entries }, 200, CACHED)
  } catch (error) {
    if (error instanceof DatabaseConfigError) return json({ error: "not_configured" }, 503)
    console.error("dashboard oracle-ticks route:", error instanceof Error ? error.name : "unknown")
    return json({ error: "unavailable" }, 503)
  }
}
