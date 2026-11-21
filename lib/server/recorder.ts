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
 * The registry (R2-4, R2-36): each run first refreshes it (`refreshRegistry`: discovery from the
 * Router and factory events, then re-validation of the listed markets), then records the markets
 * it resolves (`markets`). The refresh has a time budget (R2-40): it is given the deadline, stops
 * starting new checks there and saves its place, and recording starts at the deadline whatever it
 * is still doing, so a long scan never costs a snapshot. A failed refresh is logged and the run
 * goes on with the cached verdicts; a missing database is not a per-market failure and is thrown.
 */
import { readLive, toBigint, type ContractReader } from "@/lib/protocol/reader"
import { fetchMarketState } from "@/lib/protocol/market-state"
import type { Live, Manifest, Market } from "@/lib/protocol/types"
import { DatabaseConfigError, type Sql } from "./db"

export const SLOT_SECONDS = 900
/** The registry refresh's share of the route's 60 s (maxDuration); recording gets the rest. */
export const REGISTRY_BUDGET_MS = 20_000
const MAX_ATTEMPTS = 3
/** A ledger older than this behind the clock means the RPC node is stale: record nothing. */
const MAX_CLOSE_TIME_AGE_SECONDS = 3600

export type RecordResult = { recorded: number; failed: { pool: string; error: string }[] }

export type RecordDeps = {
  reader: ContractReader
  sql: Sql
  manifest: Manifest
  /** Discovers and re-validates registry markets before they are listed, until `deadline` (ms). */
  refreshRegistry?: (deadline: number) => Promise<unknown>
  /** The refresh's time budget; REGISTRY_BUDGET_MS by default. */
  registryBudgetMs?: number
  /** The markets to record: the markets this network lists (`resolvedMarkets`; on Mainnet, the seeds only). */
  markets: () => Promise<Market[]>
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

/** What `ledgerCloseTimeOf` asks of RPC. */
export type LedgersServer = {
  getLedgers(req: { startLedger: number; pagination: { limit: number } }): Promise<{ ledgers: { sequence: number; ledgerCloseTime: string | number }[] }>
  getLatestLedger?(): Promise<{ sequence: number; closeTime?: string | number }>
}

/**
 * The close time of `ledger`, in seconds, from RPC's `getLedgers`. The reads come from the newest
 * ledger, and a node may not serve that one through `getLedgers` yet: dRPC answers it `400 Unknown
 * block` (Mainnet, 2026-11-21) for up to several seconds, and the one before it at once. So after a
 * failure, or an answer without the ledger, `getLatestLedger` is asked: while `ledger` is still the
 * newest, its close time is there. Otherwise the lookup is tried again after `pauseMs` (a ledger
 * closes about every 5 s), `attempts` times in all. Each call gets `callTimeoutMs`, and nothing
 * starts past `deadlineMs` (the route's own time limit), so a provider that hangs cannot outlast
 * the run. Out of attempts or time, the last failure is thrown, never a guessed time.
 */
export async function ledgerCloseTimeOf(
  server: LedgersServer,
  ledger: number,
  opts: {
    attempts?: number
    pauseMs?: number
    callTimeoutMs?: number
    deadlineMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<number> {
  const {
    attempts = 4,
    pauseMs = 2_000,
    callTimeoutMs = 5_000,
    deadlineMs = Number.POSITIVE_INFINITY,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = opts
  const timed = async <T>(call: () => Promise<T>, what: string): Promise<T> => {
    const ms = Math.max(0, Math.min(callTimeoutMs, deadlineMs - now()))
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} for ledger ${ledger} timed out after ${ms} ms`)), ms)
    })
    try {
      return await Promise.race([call(), late])
    } finally {
      clearTimeout(timer)
    }
  }
  let last: unknown = new Error(`no time left to read the close time of ledger ${ledger}`)
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      if (now() + pauseMs >= deadlineMs) break
      await sleep(pauseMs)
    }
    if (now() >= deadlineMs) break
    try {
      const page = await timed(() => server.getLedgers({ startLedger: ledger, pagination: { limit: 1 } }), "getLedgers")
      const found = page.ledgers.find((l) => l.sequence === ledger)
      if (found) return Number(found.ledgerCloseTime)
      last = new Error(`ledger ${ledger} not found on the RPC node`)
    } catch (error) {
      last = error
    }
    const getLatest = server.getLatestLedger?.bind(server)
    if (!getLatest || now() >= deadlineMs) continue
    try {
      const latest = await timed(getLatest, "getLatestLedger")
      const closeTime = Number(latest.closeTime)
      if (latest.sequence === ledger && Number.isFinite(closeTime) && closeTime > 0) return closeTime
    } catch {
      // The newest ledger is only a shortcut: its failure leaves `getLedgers`'s to report.
    }
  }
  throw last
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
  const { reader, sql, now, ledgerCloseTime } = deps
  if (deps.refreshRegistry) {
    const budget = deps.registryBudgetMs ?? REGISTRY_BUDGET_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), budget)
    })
    try {
      const refresh = deps.refreshRegistry(now() + budget)
      const outcome = await Promise.race([refresh.then(() => "done" as const), late])
      if (outcome === "late") {
        console.error("recorder: the registry refresh ran past its time budget; recording the markets listed so far")
        // It is still running: a later failure is logged, never left unhandled or silent.
        refresh.catch((error) => console.error(`recorder: the registry refresh failed after its time budget: ${describeError(error)}`))
      }
    } catch (error) {
      if (error instanceof DatabaseConfigError) throw error
      console.error(`recorder: registry refresh failed: ${describeError(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  const markets = await deps.markets()
  // `fetchMarketState` finds each market by id: a discovered market is not in the static manifest.
  const manifest = { ...deps.manifest, markets }
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
