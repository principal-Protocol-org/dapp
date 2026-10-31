import "server-only"

/**
 * The 15-minute market recorder (spec 0002 §6). For each market it reads one snapshot and stores
 * one row in `market_state_snapshots`, keyed by (pool, slot) with slot = floor(close time / 900),
 * so a retry inside the same slot inserts nothing.
 *
 * One ledger: `fetchMarketState` is ~30 separate simulations, so two of them can land on different
 * ledgers. Each value used here carries the ledger it was read at (`Live.ledger`); if the values do
 * not all share one ledger the attempt is thrown away and retried (up to MAX_ATTEMPTS). A market
 * that never settles on one ledger stores nothing this run and is reported as failed. Mixed-ledger
 * rows are never written, and a gap is left as a gap (never interpolated).
 *
 * Seam for Tranche 3 / Task 11: `recordAll` takes the `markets` to record. Today the caller passes
 * the manifest's `markets[]`; the registry (with discovery) replaces that argument later, nothing
 * else here changes.
 */
import { readLive, toBigint, type ContractReader } from "@/lib/protocol/reader"
import { fetchMarketState } from "@/lib/protocol/market-state"
import type { Live, Manifest, Market } from "@/lib/protocol/types"
import { DatabaseConfigError, type Sql } from "./db"

export const SLOT_SECONDS = 900
const MAX_ATTEMPTS = 3
/** A ledger older than this behind the clock means the RPC node is stale: record nothing. */
const MAX_CLOSE_TIME_AGE_SECONDS = 3600

export type RecordResult = { recorded: number; failed: { pool: string; error: string }[] }

export type RecordDeps = {
  reader: ContractReader
  sql: Sql
  manifest: Manifest
  /** The markets to record (today the manifest's; later the registry's). */
  markets: Market[]
  /** Wall clock in ms. */
  now: () => number
  /** Close time (unix seconds) of the given ledger sequence. */
  ledgerCloseTime: (ledger: number) => Promise<number>
}

export type Snapshot = {
  ledger: number
  impliedRate: bigint
  ptPrice: bigint
  ptReserve: bigint
  syReserve: bigint
  totalLp: bigint
  ptSupply: bigint
  ytSupply: bigint
  syRate: bigint
  oracleRate: bigint
  oracleTs: bigint
  feesProtocol: bigint
  feesCreator: bigint
}

function need<T>(what: string, live: Live<T>, ledgers: Set<number>): T {
  if (live.status === "unavailable") throw new Error(`${what}: ${live.error}`)
  ledgers.add(live.ledger)
  return live.value
}

function parseFees(raw: unknown): [bigint, bigint] {
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error("accrued_fees did not return a pair")
  return [toBigint(raw[0]), toBigint(raw[1])]
}

async function readOnce(reader: ContractReader, manifest: Manifest, market: Market): Promise<Snapshot> {
  const [state, poolFees, managerFees] = await Promise.all([
    fetchMarketState(reader, manifest, market.marketId),
    readLive(reader, { contractId: market.contracts.pool, functionName: "accrued_fees" }, parseFees),
    readLive(reader, { contractId: market.contracts.manager, functionName: "accrued_fees" }, parseFees),
  ])
  const ledgers = new Set<number>()
  const pool = need("pool state", state.poolState, ledgers)
  const snapshot = {
    impliedRate: need("implied rate", state.impliedRate, ledgers),
    ptPrice: need("PT price", state.ptPrice, ledgers),
    ptReserve: pool.ptReserve,
    syReserve: pool.syReserve,
    totalLp: need("LP total supply", state.lpTotalSupply, ledgers),
    ptSupply: need("PT supply", state.totalPt, ledgers),
    ytSupply: need("YT supply", state.totalYt, ledgers),
    syRate: need("SY exchange rate", state.exchangeRate, ledgers),
    oracleRate: need("oracle reference value", state.oracleRate, ledgers),
    oracleTs: need("oracle timestamp", state.oracleTimestamp, ledgers),
  }
  const [poolProtocol, poolCreator] = need("pool accrued fees", poolFees, ledgers)
  const [managerProtocol, managerCreator] = need("manager accrued fees", managerFees, ledgers)
  if (ledgers.size !== 1) {
    throw new Error(`reads came from different ledgers (${[...ledgers].sort((a, b) => a - b).join(", ")})`)
  }
  return {
    ...snapshot,
    ledger: [...ledgers][0],
    feesProtocol: poolProtocol + managerProtocol,
    feesCreator: poolCreator + managerCreator,
  }
}

/** Reads one market at a single ledger, retrying when the reads straddle a ledger boundary. */
export async function readSnapshot(reader: ContractReader, manifest: Manifest, market: Market): Promise<Snapshot> {
  let last: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await readOnce(reader, manifest, market)
    } catch (error) {
      last = error
      // Only a ledger mismatch is worth retrying; a failed read repeats the same way.
      if (!(error instanceof Error) || !error.message.startsWith("reads came from different ledgers")) break
    }
  }
  throw last
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const first = text.split("\n")[0].trim() || "unknown error"
  return first.length > 200 ? `${first.slice(0, 199)}…` : first
}

/** A database failure by its code only: its message can carry the host or the connection string. */
function describeDbError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "unknown"
  return `database write failed (${code})`
}

export async function recordAll(deps: RecordDeps): Promise<RecordResult> {
  const { reader, sql, manifest, markets, now, ledgerCloseTime } = deps
  const result: RecordResult = { recorded: 0, failed: [] }
  const closeTimes = new Map<number, Promise<number>>()

  for (const market of markets) {
    const pool = market.contracts.pool
    let snapshot: Snapshot
    let closeTime: number
    try {
      snapshot = await readSnapshot(reader, manifest, market)
      let pending = closeTimes.get(snapshot.ledger)
      if (!pending) closeTimes.set(snapshot.ledger, (pending = ledgerCloseTime(snapshot.ledger)))
      closeTime = await pending
      if (now() / 1000 - closeTime > MAX_CLOSE_TIME_AGE_SECONDS) {
        throw new Error("the RPC node is stale: its latest ledger closed over an hour ago")
      }
    } catch (error) {
      const message = describeError(error)
      console.error(`recorder: ${pool} not recorded: ${message}`)
      result.failed.push({ pool, error: message })
      continue
    }

    const slot = Math.floor(closeTime / SLOT_SECONDS)
    const s = snapshot
    try {
      const rows = await sql<{ pool: string }>`
        insert into market_state_snapshots (
          pool, slot, ledger, close_time, implied_rate, pt_price, pt_reserve, sy_reserve, total_lp,
          pt_supply, yt_supply, sy_rate, oracle_rate, oracle_ts, fees_protocol, fees_creator
        ) values (
          ${pool}, ${slot}, ${s.ledger}, to_timestamp(${closeTime}), ${s.impliedRate.toString()}::numeric,
          ${s.ptPrice.toString()}::numeric, ${s.ptReserve.toString()}::numeric, ${s.syReserve.toString()}::numeric,
          ${s.totalLp.toString()}::numeric, ${s.ptSupply.toString()}::numeric, ${s.ytSupply.toString()}::numeric,
          ${s.syRate.toString()}::numeric, ${s.oracleRate.toString()}::numeric, ${s.oracleTs.toString()}::bigint,
          ${s.feesProtocol.toString()}::numeric, ${s.feesCreator.toString()}::numeric
        )
        on conflict (pool, slot) do nothing
        returning pool`
      result.recorded += rows.length
    } catch (error) {
      // Misconfiguration is not a per-market failure: the route answers 503 instead of 200.
      if (error instanceof DatabaseConfigError) throw error
      const message = describeDbError(error)
      console.error(`recorder: ${pool} not recorded: ${message}`)
      result.failed.push({ pool, error: message })
    }
  }
  return result
}
