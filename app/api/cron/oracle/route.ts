import "server-only"

/**
 * `GET` or `POST /api/cron/oracle`: the oracle keeper, called every 30 minutes by a scheduler (the
 * OracleAdapter's value is fresh for its max_stale_seconds). The same callers as the recorder may run
 * it (`cronAuthorized`); any other caller gets 401 and nothing runs. `ORACLE_KEEPER_MODE` picks how:
 *
 * - `push` (default): `tickOracle` signs with `ORACLE_ADMIN_SECRET`, the oracle admin's key, and
 *   pushes a value; testnet and local only.
 * - `feed` (spec 0004 D-21): `tickFeed` signs with `ORACLE_KEEPER_SECRET`, a key with no role, and has
 *   the oracle read its SEP-40 feed (`sync_from_feed`); any network. It targets
 *   `ORACLE_KEEPER_ORACLE_ID` when set (a test or local oracle), else the manifest's oracle, and reads
 *   its memory (the last rejection it submitted) from `oracle_ticks`.
 *
 * It answers the tick: 200 for `updated`, `unchanged`, `synced` or `skipped`. A `rejected` one (the
 * oracle refused the value, R4-8) answers 500 with the reason in push mode, and 200 in feed mode: a
 * feed's rejection is the feed's state, not a failed run, and a 5xx would make QStash retry and record
 * it again (the alert check raises `oracle_rejection` and `feed_broken` from the recorded runs). 503
 * `not_configured` when the keeper cannot run (an unknown mode, no key, a push key that is not the
 * oracle admin, a feed key that is, mainnet in push mode, an oracle with no feed, an override oracle
 * off the local network);
 * else 500 `failed`.
 *
 * Every run, whatever its outcome, writes one `oracle_ticks` row (spec 0004 D-19) under the oracle it
 * targeted, the dashboard's keeper telemetry. A row that cannot be written, or a memory that cannot
 * be read, never changes the answer: the scheduler sees the run's own outcome, and the log names the
 * error only.
 */
import { StrKey } from "@stellar/stellar-sdk"
import type { Manifest, Network } from "@/lib/protocol/types"
import { cronAuthorized, cronJson as json } from "@/lib/server/cron-auth"
import { sql } from "@/lib/server/db"
import { deployedManifest } from "@/lib/server/mainnet-pending"
import { keeperSigner, OracleKeeperConfigError, OracleSubmitError, tickFeed, tickOracle, type KeeperMode, type OracleTick } from "@/lib/server/oracle-keeper"
import { lastSubmittedRejection, recordTick, type KeeperFailure } from "@/lib/server/oracle-ticks"

// Three reads (or one read and a simulation), one prepared transaction, up to 30 s of confirmation
// polling, then the tick's row (the database's own timeouts bound it: 5 s to connect, 5 s per query).
export const maxDuration = 60

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown")

/** Writes the run's row; a failure is logged by name and swallowed. */
async function record(network: Network, oracle: string, outcome: OracleTick | KeeperFailure): Promise<void> {
  try {
    await recordTick(sql, network, oracle, outcome)
  } catch (error) {
    console.error(`oracle keeper: the tick was not recorded: ${errorName(error)}`)
  }
}

/** The feed keeper's memory; null when it cannot be read (every significant rejection is then submitted). */
async function memory(network: Network, oracle: string): Promise<{ reason: string; value: string } | null> {
  try {
    return await lastSubmittedRejection(sql, network, oracle)
  } catch (error) {
    console.error(`oracle keeper: the last submitted rejection was not read: ${errorName(error)}`)
    return null
  }
}

/**
 * The oracle feed mode targets: `ORACLE_KEEPER_ORACLE_ID` when set, else the manifest's. Another
 * oracle than the manifest's is for local proofs only: each run warns that the dashboard and the
 * alert check do not follow it, and off the local network it is refused.
 */
function feedOracle(manifest: Manifest): string {
  const id = process.env.ORACLE_KEEPER_ORACLE_ID?.trim()
  if (!id || id === manifest.shared.oracle) return manifest.shared.oracle
  if (!StrKey.isValidContract(id)) throw new OracleKeeperConfigError("ORACLE_KEEPER_ORACLE_ID is not a contract id.")
  console.warn(
    `oracle keeper: ORACLE_KEEPER_ORACLE_ID overrides the manifest's oracle (${manifest.shared.oracle}): this run syncs ${id}, which the dashboard and the alert check do not follow`,
  )
  if (manifest.network !== "local") {
    throw new OracleKeeperConfigError("ORACLE_KEEPER_ORACLE_ID names another oracle than the manifest's: the override oracle is for local proofs only.")
  }
  return id
}

export async function GET(request: Request) {
  if (!(await cronAuthorized(request))) return json({ error: "unauthorized" }, 401)
  const modeName = process.env.ORACLE_KEEPER_MODE?.trim() || "push"
  const knownMode = modeName === "push" || modeName === "feed"
  // An unknown mode is recorded under the default: the table knows only push and feed.
  const mode: KeeperMode = modeName === "feed" ? "feed" : "push"
  const secret = mode === "feed" ? process.env.ORACLE_KEEPER_SECRET : process.env.ORACLE_ADMIN_SECRET
  let manifest: Manifest | null = null
  let oracle: string | null = null
  let outcome: OracleTick | KeeperFailure
  let response: Response
  try {
    const deployed = deployedManifest()
    // Nothing runs, and no tick is recorded, until the Mainnet contracts are deployed (D-24).
    if (deployed instanceof Response) return deployed
    manifest = deployed
    oracle = manifest.shared.oracle
    if (!knownMode) throw new OracleKeeperConfigError("ORACLE_KEEPER_MODE is neither push nor feed.")
    let tick: OracleTick
    if (mode === "feed") {
      oracle = feedOracle(manifest)
      tick = await tickFeed({ manifest, secret, oracle, lastSubmittedRejection: await memory(manifest.network, oracle) })
    } else {
      tick = await tickOracle({ manifest, secret })
    }
    outcome = tick
    if (tick.status === "rejected") {
      // The log says why. Public values only: the key is never in a tick. Push: the scheduler sees a
      // 500. Feed: a 200 and a warning (a retry would record the same rejection again).
      const tx = tick.hash ? `tx ${tick.hash}` : "not submitted"
      const line = `oracle keeper: the oracle rejected value ${tick.value ?? "unknown"} at timestamp ${tick.timestamp ?? "unknown"} (reason ${tick.reason}, ${tx})`
      if (tick.mode === "feed") {
        console.warn(line)
        response = json(tick, 200)
      } else {
        console.error(line)
        response = json(tick, 500)
      }
    } else response = json(tick, 200)
  } catch (error) {
    // The config errors are this app's own words; anything else is logged by name only (RPC text
    // may carry a provider URL). The run's row says the same.
    const signer = knownMode ? keeperSigner(secret) : null
    if (error instanceof OracleKeeperConfigError) {
      console.error(`oracle keeper: ${error.message}`)
      outcome = { status: "not_configured", mode, signer, message: error.message }
      response = json({ error: "not_configured" }, 503)
    } else if (error instanceof OracleSubmitError) {
      // A transaction that did not land: its hash and result code are public, and the row keeps them.
      console.error(`oracle keeper: the oracle update did not land: ${error.code} (tx ${error.hash})`)
      outcome = { status: "failed", mode, signer, name: error.code, hash: error.hash }
      response = json({ error: "failed" }, 500)
    } else {
      console.error("oracle keeper failed:", errorName(error))
      outcome = { status: "failed", mode, signer, name: errorName(error) }
      response = json({ error: "failed" }, 500)
    }
  }
  // Without a manifest there is no network or oracle to file the run under (the log above has it).
  if (manifest && oracle) await record(manifest.network, oracle, outcome)
  return response
}

/** QStash schedules call with POST unless told otherwise: the same handler, the same checks. */
export const POST = GET
