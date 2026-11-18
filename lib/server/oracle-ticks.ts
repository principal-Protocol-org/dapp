import "server-only"

/**
 * The oracle keeper's telemetry (spec 0004 D-19): every `cron/oracle` run writes one `oracle_ticks`
 * row (time, mode, decision, value, reason, tx hash, signer), and the dashboard derives the last
 * successful update, the rejected runs, the failed runs and the keeper's health from them.
 *
 * - Decisions: `pushed` (an update landed), `synced` (the oracle took its feed's value, feed mode),
 *   `skipped` (the run changed nothing; in feed mode, a routine rejection, with its reason),
 *   `rejected` (the oracle refused the value, R4-8; in feed mode with a tx hash only when the keeper
 *   submitted it, D-21) and `error` (the run failed, or could not start).
 * - Rows are public (`GET /api/dashboard/oracle-ticks`): the signer is a public key, an error's
 *   reason is `not_configured: <the app's own words>` or `failed: <error name>`, never an error's
 *   text (RPC text may carry a provider URL).
 */
import { SIGNIFICANT } from "@/lib/protocol/dashboard/rejections"
import type { Network } from "@/lib/protocol/types"
import type { Sql } from "./db"
import type { KeeperMode, OracleTick } from "./oracle-keeper"

/** The keeper's schedule: every 30 minutes (the oracle is fresh for its `max_stale_seconds`, 3,600 s on our deployments). */
export const ORACLE_TICK_INTERVAL_SECONDS = 1_800

export type TickDecision = "pushed" | "synced" | "skipped" | "rejected" | "error"

/**
 * A run with no tick: the keeper could not start (`not_configured`: no key, a key that is not the
 * oracle admin, no primary source, mainnet; `message` is the app's own words), or it failed. A
 * failed run's `name` is the error's name only; for a transaction it sent that did not land
 * (`OracleSubmitError`), it is the result code or `not confirmed`, and `hash` is that transaction's.
 */
export type KeeperFailure =
  | { status: "not_configured"; mode: KeeperMode; signer: string | null; message: string }
  | { status: "failed"; mode: KeeperMode; signer: string | null; name: string; hash?: string }

/** The row a run writes, beside its network, oracle and time. */
export type TickRow = { mode: KeeperMode; decision: TickDecision; value: string | null; reason: string | null; txHash: string | null; signer: string | null }

/** One run as its `oracle_ticks` row. */
export function tickRow(tick: OracleTick | KeeperFailure): TickRow {
  const { mode, signer } = tick
  switch (tick.status) {
    case "updated":
      return { mode, decision: "pushed", value: tick.value, reason: null, txHash: tick.hash, signer }
    case "synced":
      return { mode, decision: "synced", value: tick.value, reason: null, txHash: tick.hash, signer }
    case "unchanged":
      return { mode, decision: "skipped", value: tick.value, reason: null, txHash: null, signer }
    case "skipped":
      // A routine rejection keeps its reason: the page and the alert check read it.
      return { mode, decision: "skipped", value: tick.value, reason: tick.reason, txHash: null, signer }
    case "rejected":
      // Feed mode sends only a new significant rejection: a repeat or a broken feed has no hash.
      return { mode, decision: "rejected", value: tick.value, reason: tick.reason, txHash: tick.hash ?? null, signer }
    case "not_configured":
      return { mode, decision: "error", value: null, reason: `not_configured: ${tick.message}`, txHash: null, signer }
    case "failed":
      return { mode, decision: "error", value: null, reason: `failed: ${tick.name}`, txHash: tick.hash ?? null, signer }
  }
}

/** Writes one run's row. The database stamps its time (`at`, `now()`). */
export async function recordTick(sql: Sql, network: Network, oracle: string, tick: OracleTick | KeeperFailure): Promise<void> {
  const r = tickRow(tick)
  await sql`
    insert into oracle_ticks (network, oracle, mode, decision, value, reason, tx_hash, signer)
    values (${network}, ${oracle}, ${r.mode}, ${r.decision}, ${r.value}::numeric, ${r.reason}, ${r.txHash}, ${r.signer})`
}

/**
 * The feed keeper's memory (D-21): the last significant rejection it submitted for `oracle`, from the
 * newest feed-mode `rejected` row with a tx hash. A rejection with the same (reason, value) is not
 * submitted again. Null when none is recorded.
 */
export async function lastSubmittedRejection(sql: Sql, network: Network, oracle: string): Promise<{ reason: string; value: string } | null> {
  const [row] = await sql<{ reason: string | null; value: string | null }>`
    select reason, value::text as value from oracle_ticks
    where network = ${network} and oracle = ${oracle} and mode = 'feed' and decision = 'rejected' and tx_hash is not null
      and reason = any(${[...SIGNIFICANT]}::text[])
    order by at desc, id desc
    limit 1`
  return row?.reason && row.value !== null ? { reason: row.reason, value: row.value } : null
}

/** A recorded run, as the API answers it: the value an exact decimal string (7 decimals, as the oracle stores it), never a float. */
export type RecordedTick = {
  id: string
  at: string
  oracle: string
  mode: KeeperMode
  decision: TickDecision
  value: string | null
  reason: string | null
  txHash: string | null
  signer: string | null
}

type TickRowIn = {
  id: string | number
  at: Date | string
  oracle: string
  mode: KeeperMode
  decision: TickDecision
  value: string | null
  reason: string | null
  tx_hash: string | null
  signer: string | null
}

const iso = (t: Date | string) => new Date(t).toISOString()

/** The newest `limit` runs of `network` (of one oracle when given), newest first. */
export async function listTicks(sql: Sql, q: { network: Network; oracle?: string; limit: number }): Promise<RecordedTick[]> {
  const oracle = q.oracle ?? null
  const rows = await sql<TickRowIn>`
    select id, at, oracle, mode, decision, value::text as value, reason, tx_hash, signer
    from oracle_ticks
    where network = ${q.network} and (${oracle}::text is null or oracle = ${oracle})
    order by at desc, id desc
    limit ${q.limit}`
  return rows.map((r) => ({
    id: String(r.id),
    at: iso(r.at),
    oracle: r.oracle,
    mode: r.mode,
    decision: r.decision,
    value: r.value,
    reason: r.reason,
    txHash: r.tx_hash,
    signer: r.signer,
  }))
}

export type KeeperHealth = {
  /** The last success is younger than 2 × the interval. False with no success recorded. */
  healthy: boolean
  /** The last run that landed an update (`pushed` or `synced`); null when none is recorded. */
  lastSuccessAt: string | null
  /**
   * The last run of any kind; null when no run is recorded. That is an unknown state, not an
   * unhealthy one: a page says "No keeper run recorded yet", and an alert check must not fire on it.
   */
  lastTickAt: string | null
  /** Runs the oracle rejected, in the last 24 h. */
  rejected24h: number
  /** Runs that failed or could not start (`error`), in the last 24 h. */
  failures24h: number
}

const DAY_MS = 86_400_000

/**
 * The keeper's health (D-19) from its recorded runs: healthy while the last success (an update that
 * landed) is younger than 2 × `intervalSeconds`. A skipped run is no success: it changed nothing. The
 * window of the counts and the age are measured from `now` (ms, `Date.now()` by default).
 */
export async function keeperHealth(
  sql: Sql,
  network: Network,
  intervalSeconds: number,
  opts: { oracle?: string; now?: number } = {},
): Promise<KeeperHealth> {
  const now = opts.now ?? Date.now()
  const oracle = opts.oracle ?? null
  const since = new Date(now - DAY_MS).toISOString()
  const [row] = await sql<{ last_success: Date | string | null; last_tick: Date | string | null; rejected: string | number; failures: string | number }>`
    select
      max(at) filter (where decision in ('pushed', 'synced')) as last_success,
      max(at) as last_tick,
      count(*) filter (where decision = 'rejected' and at > ${since}::timestamptz) as rejected,
      count(*) filter (where decision = 'error' and at > ${since}::timestamptz) as failures
    from oracle_ticks
    where network = ${network} and (${oracle}::text is null or oracle = ${oracle})`
  const lastSuccessAt = row?.last_success ? iso(row.last_success) : null
  return {
    healthy: lastSuccessAt !== null && now - Date.parse(lastSuccessAt) < 2 * intervalSeconds * 1000,
    lastSuccessAt,
    lastTickAt: row?.last_tick ? iso(row.last_tick) : null,
    rejected24h: Number(row?.rejected ?? 0),
    failures24h: Number(row?.failures ?? 0),
  }
}
