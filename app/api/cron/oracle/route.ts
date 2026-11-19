import "server-only"

/**
 * `GET` or `POST /api/cron/oracle`: the oracle keeper, called on a schedule by a scheduler (every 30
 * minutes by default, `ORACLE_KEEPER_INTERVAL_SECONDS`; the OracleAdapter's value is fresh for its
 * max_stale_seconds). The same callers as the recorder may run it (`cronAuthorized`); any other
 * caller gets 401 and nothing runs. `ORACLE_KEEPER_MODE` picks how:
 *
 * - `push` (default): `tickOracle` signs with `ORACLE_ADMIN_SECRET`, the oracle admin's key, and
 *   pushes a value to the manifest's oracle; testnet and local only. It answers the tick: 200 for
 *   `updated` or `unchanged`; 500 for `rejected` (the oracle refused the value, R4-8), with the
 *   reason; 503 `not_configured` when the keeper cannot run (an unknown mode, no key, a key that is
 *   not the oracle admin, mainnet); else 500 `failed`. One `oracle_ticks` row per run.
 * - `feed` (spec 0004 D-21, spec 0005 M-13): `tickFeedAll` signs with `ORACLE_KEEPER_SECRET`, a key
 *   with no role, and has every oracle of the manifest (`manifestOracles`) read its SEP-40 feed
 *   (`sync_from_feed`) in one run, inside 45 s; any network. On the local network only,
 *   `ORACLE_KEEPER_ORACLE_ID` replaces those oracles with one contract id or a comma-separated list (a
 *   test or local proof). New significant rejections go on-chain only with
 *   `ORACLE_KEEPER_RECORD_REJECTIONS=1` (M-14), and the keeper's memory of the last one it submitted
 *   is read per oracle from `oracle_ticks`. The answer is `{ mode: "feed", oracles: [{ oracle,
 *   ...outcome }] }`: 500 when any oracle failed; 503 when every oracle is `not_configured` (no key,
 *   say); else 200, a `rejected` oracle included (a feed's rejection is the feed's state, not a failed
 *   run, and a 5xx would make QStash retry and record it again; the alert check raises
 *   `oracle_rejection` and `feed_broken` from the recorded runs). A bad `ORACLE_KEEPER_INTERVAL_SECONDS`
 *   or override is 503 `{ error: "not_configured" }` before anything runs. One row per oracle.
 *
 * Whatever its outcome, every run writes its `oracle_ticks` rows (spec 0004 D-19) under the oracles
 * it targeted, the dashboard's keeper telemetry. A row that cannot be written, or a memory that
 * cannot be read, never changes the answer: the scheduler sees the run's own outcome, and the log
 * names the error only.
 */
import { StrKey } from "@stellar/stellar-sdk"
import { manifestOracles } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { Manifest, Network } from "@/lib/protocol/types"
import { cronAuthorized, cronJson as json } from "@/lib/server/cron-auth"
import { sql } from "@/lib/server/db"
import { keeperSigner, OracleKeeperConfigError, OracleSubmitError, tickFeedAll, tickOracle, type KeeperMode, type OracleTick } from "@/lib/server/oracle-keeper"
import { keeperIntervalSeconds, lastSubmittedRejection, recordsRejections, recordTick, type KeeperFailure } from "@/lib/server/oracle-ticks"

// Push: three reads, one prepared transaction, up to 30 s of confirmation polling, then the tick's
// row. Feed: every oracle's reads and simulation at once, one transaction after another (each in a
// ledger before the next), all inside FEED_BUDGET_MS, then the rows (the database's own timeouts
// bound them: 5 s to connect, 5 s per query).
export const maxDuration = 60
/**
 * The feed run's deadline after the route starts: no send and no confirmation look after it. The
 * rows are written after the run, and a cold database pool can take several seconds to connect, so
 * 15 s of the route's 60 s are left for them.
 */
const FEED_BUDGET_MS = 45_000

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
 * The oracles feed mode targets: the manifest's (`own`), or `ORACLE_KEEPER_ORACLE_ID` when set: one
 * contract id or a comma-separated list of them, each checked, a repeat kept once. Another oracle
 * than the manifest's is for local proofs only: each run warns that the dashboard and the alert check
 * do not follow it, and off the local network it is refused. The manifest's own single oracle named
 * is no override.
 */
function feedOracles(manifest: Manifest, own: string[]): string[] {
  const raw = process.env.ORACLE_KEEPER_ORACLE_ID?.trim()
  if (!raw || (own.length === 1 && raw === own[0])) return own
  const ids = raw.split(",").map((id) => id.trim())
  if (!ids.every((id) => StrKey.isValidContract(id))) {
    throw new OracleKeeperConfigError("ORACLE_KEEPER_ORACLE_ID is not a contract id or a comma-separated list of contract ids.")
  }
  const oracles = [...new Set(ids)]
  console.warn(
    `oracle keeper: ORACLE_KEEPER_ORACLE_ID overrides the manifest's oracles (${own.join(", ")}): this run syncs ${oracles.join(", ")}, which the dashboard and the alert check do not follow`,
  )
  if (manifest.network !== "local") {
    throw new OracleKeeperConfigError("ORACLE_KEEPER_ORACLE_ID names another oracle than the manifest's: the override oracle is for local proofs only.")
  }
  return oracles
}

/** Logs one oracle's feed outcome: a rejection as a warning, a failure as an error, by name and hash only. */
function logFeed(oracle: string, outcome: OracleTick | KeeperFailure): void {
  if (outcome.status === "rejected") {
    const tx = outcome.hash ? `tx ${outcome.hash}` : "not submitted"
    console.warn(
      `oracle keeper: ${oracle}: the oracle rejected value ${outcome.value ?? "unknown"} at timestamp ${outcome.timestamp ?? "unknown"} (reason ${outcome.reason}, ${tx})`,
    )
  } else if (outcome.status === "not_configured") {
    console.error(`oracle keeper: ${oracle}: ${outcome.message}`)
  } else if (outcome.status === "failed") {
    console.error(outcome.hash ? `oracle keeper: ${oracle}: the oracle update did not land: ${outcome.name} (tx ${outcome.hash})` : `oracle keeper: ${oracle}: the run failed: ${outcome.name}`)
  }
}

/** Feed mode: every oracle in one run (M-13), one row and one entry per oracle. */
async function feedRun(startedAt: number): Promise<Response> {
  const secret = process.env.ORACLE_KEEPER_SECRET
  let manifest: Manifest
  try {
    manifest = activeManifest()
  } catch (error) {
    // Without a manifest there is no network or oracle to file the run under (the log has it).
    console.error("oracle keeper failed:", errorName(error))
    return json({ error: "failed" }, 500)
  }
  const { network } = manifest
  const own = manifestOracles(manifest).map((o) => o.oracle)
  let oracles: string[]
  try {
    // The schedule is checked here too: a bad value would also skew the health rule and the alerts.
    keeperIntervalSeconds(process.env)
    oracles = feedOracles(manifest, own)
  } catch (error) {
    const outcome: KeeperFailure =
      error instanceof OracleKeeperConfigError
        ? { status: "not_configured", mode: "feed", signer: keeperSigner(secret), message: error.message }
        : { status: "failed", mode: "feed", signer: keeperSigner(secret), name: errorName(error) }
    console.error(outcome.status === "not_configured" ? `oracle keeper: ${outcome.message}` : `oracle keeper failed: ${errorName(error)}`)
    await Promise.all(own.map((oracle) => record(network, oracle, outcome)))
    return outcome.status === "not_configured" ? json({ error: "not_configured" }, 503) : json({ error: "failed" }, 500)
  }

  let runs: Awaited<ReturnType<typeof tickFeedAll>>
  try {
    runs = await tickFeedAll({
      manifest,
      secret,
      oracles,
      recordRejections: recordsRejections(process.env),
      deadlineMs: startedAt + FEED_BUDGET_MS,
      lastSubmittedRejection: (oracle) => memory(network, oracle),
    })
  } catch (error) {
    // tickFeedAll gives each oracle its own outcome; this is a fault in the run itself. Each oracle still gets its row.
    console.error("oracle keeper failed:", errorName(error))
    const outcome: KeeperFailure = { status: "failed", mode: "feed", signer: keeperSigner(secret), name: errorName(error) }
    await Promise.all(oracles.map((oracle) => record(network, oracle, outcome)))
    return json({ error: "failed" }, 500)
  }
  for (const { oracle, outcome } of runs) logFeed(oracle, outcome)
  await Promise.all(runs.map(({ oracle, outcome }) => record(network, oracle, outcome)))
  const status = runs.some((r) => r.outcome.status === "failed") ? 500 : runs.every((r) => r.outcome.status === "not_configured") ? 503 : 200
  return json({ mode: "feed", oracles: runs.map(({ oracle, outcome }) => ({ oracle, ...outcome })) }, status)
}

export async function GET(request: Request) {
  const startedAt = Date.now()
  if (!(await cronAuthorized(request))) return json({ error: "unauthorized" }, 401)
  const modeName = process.env.ORACLE_KEEPER_MODE?.trim() || "push"
  if (modeName === "feed") return feedRun(startedAt)
  const knownMode = modeName === "push"
  // An unknown mode is recorded under the default: the table knows only push and feed.
  const mode: KeeperMode = "push"
  const secret = process.env.ORACLE_ADMIN_SECRET
  let manifest: Manifest | null = null
  let oracle: string | null = null
  let outcome: OracleTick | KeeperFailure
  let response: Response
  try {
    manifest = activeManifest()
    oracle = manifest.shared.oracle
    if (!knownMode) throw new OracleKeeperConfigError("ORACLE_KEEPER_MODE is neither push nor feed.")
    const tick = await tickOracle({ manifest, secret })
    outcome = tick
    if (tick.status === "rejected") {
      // The log says why, public values only: the key is never in a tick. The scheduler sees a 500.
      const tx = tick.hash ? `tx ${tick.hash}` : "not submitted"
      console.error(`oracle keeper: the oracle rejected value ${tick.value ?? "unknown"} at timestamp ${tick.timestamp ?? "unknown"} (reason ${tick.reason}, ${tx})`)
      response = json(tick, 500)
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
