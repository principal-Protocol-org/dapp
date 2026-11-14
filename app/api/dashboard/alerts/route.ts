import "server-only"

/**
 * `GET /api/dashboard/alerts`: the alert check's state (spec 0004 D-12, D-20), public and read-only,
 * no wallet. It answers `{ open, recent, lastTest }` for this network (`AlertsAnswer`):
 * - `open`: the open alerts (`Alert`, `lib/app/alert-types`), oldest first;
 * - `recent`: every alert open at some time in the last 7 days, closed ones with their `resolvedAt`
 *   (the risk page's exhaustion history), newest first;
 * - `lastTest`: the last `?test=1` of `cron/alerts` and whether the webhook took it, or null.
 * Test alerts are never in `open` or `recent`. No webhook URL and no secret: payloads hold contract
 * ids, public keys and figures only.
 *
 * Cached 30 s at the edge; errors never (503 `not_configured` without `DATABASE_URL`, 503
 * `unavailable` when the database fails). `connection()` keeps it out of the build's prerender: it
 * reads no request data, and a prerendered answer would never change.
 */
import { connection } from "next/server"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { listAlerts } from "@/lib/server/alerts"
import { DatabaseConfigError, sql } from "@/lib/server/db"

const CACHED = "public, s-maxage=30, stale-while-revalidate=30"

const json = (body: unknown, status = 200, cache = "no-store") => Response.json(body, { status, headers: { "cache-control": cache } })

export async function GET() {
  await connection()
  try {
    // Inside the try: a manifest that cannot be read is a 503, never an unhandled 500.
    const { network } = activeManifest()
    return json(await listAlerts(sql, network), 200, CACHED)
  } catch (error) {
    if (error instanceof DatabaseConfigError) return json({ error: "not_configured" }, 503)
    console.error("dashboard alerts route:", error instanceof Error ? error.name : "unknown")
    return json({ error: "unavailable" }, 503)
  }
}
