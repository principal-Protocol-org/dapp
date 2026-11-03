import "server-only"

/**
 * `GET` or `POST /api/cron/oracle`: the oracle keeper for the app's own test deployments, called
 * every 30 minutes by a scheduler (the OracleAdapter's value is fresh for its max_stale_seconds). The same callers
 * as the recorder may run it (`cronAuthorized`); any other caller gets 401 and nothing runs. It
 * answers the tick (`unchanged` or `updated`), 500 with the reason for a `rejected` one (the
 * oracle refused the value; the transaction itself succeeded, R4-8), 503 `not_configured` when the keeper cannot run (no
 * `ORACLE_ADMIN_SECRET`, a key that is not the oracle admin, or mainnet), else 500 `failed`.
 */
import { activeManifest } from "@/lib/protocol/manifest-source"
import { cronAuthorized, cronJson as json } from "@/lib/server/cron-auth"
import { OracleKeeperConfigError, tickOracle } from "@/lib/server/oracle-keeper"

// Three reads, one prepared transaction, then up to 30 s of confirmation polling.
export const maxDuration = 60

export async function GET(request: Request) {
  if (!(await cronAuthorized(request))) return json({ error: "unauthorized" }, 401)
  try {
    const tick = await tickOracle({ manifest: activeManifest(), secret: process.env.ORACLE_ADMIN_SECRET })
    if (tick.status === "rejected") {
      // The scheduler sees a 500; the log says why. Public values only: the key is never in a tick.
      console.error(`oracle keeper: the oracle rejected value ${tick.value} at timestamp ${tick.timestamp} (reason ${tick.reason}, tx ${tick.hash})`)
      return json(tick, 500)
    }
    return json(tick, 200)
  } catch (error) {
    // The config errors are this app's own words; anything else is logged by name only (RPC text
    // may carry a provider URL).
    if (error instanceof OracleKeeperConfigError) {
      console.error(`oracle keeper: ${error.message}`)
      return json({ error: "not_configured" }, 503)
    }
    console.error("oracle keeper failed:", error instanceof Error ? error.name : "unknown")
    return json({ error: "failed" }, 500)
  }
}

/** QStash schedules call with POST unless told otherwise: the same handler, the same checks. */
export const POST = GET
