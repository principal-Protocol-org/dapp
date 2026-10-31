import "server-only"

/**
 * History data access (spec 0002 §2, §6): turns the rows the recorder stores in
 * `market_state_snapshots` into the series the charts and spark lines show.
 *
 * - Fixed APY at a snapshot: `aprToApy(implied_rate, maturity - close time)`.
 * - Underlying APY (7 d): `underlyingApy7d` over the oracle-rate points of the 7 days up to that
 *   snapshot. Near the start of history the window is shorter; it is never extrapolated, and with
 *   fewer than two points the value is `null`.
 * - Liquidity: pool value in underlying (ruling R34), as a decimal number in underlying units.
 * - A missing 900 s slot between the first and last snapshot of the range is `{ at, value: null }`:
 *   a gap is never interpolated.
 *
 * The database keeps numerics (exact); series values are `number | null` (ruling R2-32).
 */
import { aprToApy, SCALE } from "@/lib/protocol/math"
import { underlyingApy7d } from "@/lib/protocol/rates"
import { poolValueInUnderlying } from "@/lib/protocol/yield"
import type { Sql } from "./db"
import { SLOT_SECONDS } from "./recorder"

export type Range = "7d" | "30d" | "90d" | "all"
export const RANGES: readonly Range[] = ["7d", "30d", "90d", "all"]
export type Series = { at: number; value: number | null }[]
export type MarketHistory = {
  fixedApy: Series
  underlyingApy7d: Series
  liquidity: Series
  latestAt: number | null
  stale: boolean
}
export type Spark = { points: Series; changePts: number | null }

/** A latest snapshot older than this (vs the server clock) marks the history stale. */
export const STALE_SECONDS = 3600
const DAY = 86_400
const WEEK = 7 * DAY
const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 }
const SPARK_DAYS = 30

export type HistoryOptions = {
  /** The market's maturity, unix seconds. */
  maturity: number
  /** Wall clock in ms; defaults to `Date.now`. */
  now?: () => number
}

type Row = {
  pool: string
  slot: string | number
  at: string | number
  implied_rate: string
  pt_price: string
  pt_reserve: string
  sy_reserve: string
  sy_rate: string
  oracle_rate: string
}

/** A numeric column (text from `pg`) as a bigint; the stored values are integers. */
function big(text: string): bigint {
  return BigInt(String(text).split(".")[0])
}

/** One query for every pool: rows from `since` (unix s) on, oldest first. */
async function fetchRows(sql: Sql, pools: string[], since: number): Promise<Row[]> {
  return sql<Row>`
    select pool, slot, extract(epoch from close_time)::bigint as at,
           implied_rate, pt_price, pt_reserve, sy_reserve, sy_rate, oracle_rate
    from market_state_snapshots
    where pool = any(${pools}) and close_time >= to_timestamp(${since})
    order by pool, slot`
}

type Built = { fixedApy: Series; underlying: Series; liquidity: Series; latestAt: number | null }

/** Series over `rows` (one pool, oldest first); only rows at or after `from` are emitted. */
function build(rows: Row[], maturity: number, from: number): Built {
  const points = rows.map((r) => ({ at: Number(r.at), slot: Number(r.slot), rate: big(r.oracle_rate), row: r }))
  const shown = points.filter((p) => p.at >= from)
  const out: Built = { fixedApy: [], underlying: [], liquidity: [], latestAt: points.length ? points[points.length - 1].at : null }
  let prevSlot: number | undefined
  for (const p of shown) {
    if (prevSlot !== undefined) {
      for (let s = prevSlot + 1; s < p.slot; s++) {
        const gap = { at: s * SLOT_SECONDS, value: null }
        out.fixedApy.push(gap)
        out.underlying.push({ ...gap })
        out.liquidity.push({ ...gap })
      }
    }
    prevSlot = p.slot
    const r = p.row
    out.fixedApy.push({ at: p.at, value: aprToApy(big(r.implied_rate), BigInt(Math.max(0, maturity - p.at))) })
    const window = points.filter((q) => q.at <= p.at && p.at - q.at <= WEEK).map((q) => ({ at: q.at, rate: q.rate }))
    out.underlying.push({ at: p.at, value: underlyingApy7d(window)?.apy ?? null })
    const value = poolValueInUnderlying({
      syReserve: big(r.sy_reserve),
      ptReserve: big(r.pt_reserve),
      exchangeRate: big(r.sy_rate),
      ptPrice: big(r.pt_price),
      oracleRate: big(r.oracle_rate),
    })
    out.liquidity.push({ at: p.at, value: value === null ? null : Number(value) / Number(SCALE) })
  }
  return out
}

function isStale(latestAt: number | null, nowSeconds: number): boolean {
  return latestAt === null || nowSeconds - latestAt > STALE_SECONDS
}

export async function getHistory(sql: Sql, pool: string, range: Range, opts: HistoryOptions): Promise<MarketHistory> {
  const nowSeconds = Math.floor((opts.now ?? Date.now)() / 1000)
  const from = range === "all" ? 0 : nowSeconds - RANGE_DAYS[range] * DAY
  // The 7 days before the range feed the first underlying-APY windows.
  const rows = await fetchRows(sql, [pool], Math.max(0, from - WEEK))
  const built = build(rows, opts.maturity, from)
  return {
    fixedApy: built.fixedApy,
    underlyingApy7d: built.underlying,
    liquidity: built.liquidity,
    latestAt: built.latestAt,
    stale: isStale(built.latestAt, nowSeconds),
  }
}

/** Last 30 days of fixed APY per pool; `changePts` = (last - first) x 100 percentage points. */
export async function getSparks(
  sql: Sql,
  pools: string[],
  maturities: Record<string, number>,
  now: () => number = Date.now,
): Promise<Record<string, Spark>> {
  const from = Math.floor(now() / 1000) - SPARK_DAYS * DAY
  const known = pools.filter((p) => maturities[p] !== undefined)
  const rows = known.length ? await fetchRows(sql, known, from) : []
  const result: Record<string, Spark> = {}
  for (const pool of pools) {
    const poolRows = rows.filter((r) => r.pool === pool)
    const points = maturities[pool] === undefined ? [] : build(poolRows, maturities[pool], from).fixedApy
    const values = points.map((p) => p.value).filter((v): v is number => v !== null)
    result[pool] = {
      points,
      changePts: values.length < 2 ? null : (values[values.length - 1] - values[0]) * 100,
    }
  }
  return result
}
