import "server-only"

/**
 * `GET` or `POST /api/cron/oracle`: the oracle keeper for the app's own test deployments, called
 * every 30 minutes by a scheduler (the OracleAdapter's value is fresh for its max_stale_seconds). The same callers
 * as the recorder may run it (`cronAuthorized`); any other caller gets 401 and nothing runs. It
 * answers the tick (`unchanged` or `updated`), 500 with the reason for a `rejected` one (the
 * oracle refused the value; the transaction itself succeeded, R4-8), 503 `not_configured` when the keeper cannot run (no
 * `ORACLE_ADMIN_SECRET`, a key that is not the oracle admin, or mainnet), else 500 `failed`.
 *
 * Every run, whatever its outcome, writes one `oracle_ticks` row (spec 0004 D-19), the dashboard's
 * keeper telemetry. A row that cannot be written never changes the answer: the scheduler sees the
 * run's own outcome, and the log names the error only.
 */
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { Manifest } from "@/lib/protocol/types"
import { cronAuthorized, cronJson as json } from "@/lib/server/cron-auth"
import { sql } from "@/lib/server/db"
import { keeperSigner, OracleKeeperConfigError, tickOracle, type OracleTick } from "@/lib/server/oracle-keeper"
import { recordTick, type KeeperFailure } from "@/lib/server/oracle-ticks"

// Three reads, one prepared transaction, up to 30 s of confirmation polling, then the tick's row
// (the database's own timeouts bound it: 5 s to connect, 5 s per query).
export const maxDuration = 60

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown")

/** Writes the run's row; a failure is logged by name and swallowed. */
async function record(manifest: Manifest, outcome: OracleTick | KeeperFailure): Promise<void> {
  try {
    await recordTick(sql, manifest.network, manifest.shared.oracle, outcome)
  } catch (error) {
    console.error(`oracle keeper: the tick was not recorded: ${errorName(error)}`)
  }
}

export async function GET(request: Request) {
  if (!(await cronAuthorized(request))) return json({ error: "unauthorized" }, 401)
  const secret = process.env.ORACLE_ADMIN_SECRET
  // Push only for now; spec 0004 D-21 adds the feed mode.
  const mode = "push"
  let manifest: Manifest | null = null
  let outcome: OracleTick | KeeperFailure
  let response: Response
  try {
    manifest = activeManifest()
    const tick = await tickOracle({ manifest, secret })
    outcome = tick
    if (tick.status === "rejected") {
      // The scheduler sees a 500; the log says why. Public values only: the key is never in a tick.
      console.error(`oracle keeper: the oracle rejected value ${tick.value} at timestamp ${tick.timestamp} (reason ${tick.reason}, tx ${tick.hash})`)
      response = json(tick, 500)
    } else response = json(tick, 200)
  } catch (error) {
    // The config errors are this app's own words; anything else is logged by name only (RPC text
    // may carry a provider URL). The run's row says the same.
    if (error instanceof OracleKeeperConfigError) {
      console.error(`oracle keeper: ${error.message}`)
      outcome = { status: "not_configured", mode, signer: keeperSigner(secret), message: error.message }
      response = json({ error: "not_configured" }, 503)
    } else {
      console.error("oracle keeper failed:", errorName(error))
      outcome = { status: "failed", mode, signer: keeperSigner(secret), name: errorName(error) }
      response = json({ error: "failed" }, 500)
    }
  }
  // Without a manifest there is no network or oracle to file the run under (the log above has it).
  if (manifest) await record(manifest, outcome)
  return response
}

/** QStash schedules call with POST unless told otherwise: the same handler, the same checks. */
export const POST = GET
