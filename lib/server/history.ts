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
  /** Window of the latest underlying-APY point (shorter than 7 d near the start of history); null without one. */
  underlyingWindowSeconds: number | null
}
export type Spark = { points: Series; changePts: number | null; stale: boolean }

/** A latest snapshot older than this (vs the server clock) marks the history stale. */
export const STALE_SECONDS = 3600
/** No series is longer than this: longer ranges are bucketed (last snapshot of each bucket of `k` slots). */
export const MAX_POINTS = 1000
// Bucket sizes aim a little under the cap so a partial bucket at each end still fits.
const TARGET_POINTS = 990
const DAY = 86_400
const WEEK = 7 * DAY
/** A 7-day window spans 672 slots; the SQL bound is looser than that to be safe, the time test is exact. */
const WINDOW_SLOT_BOUND = 700
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
  /** Earliest snapshot within 7 days up to this one (the window start for the underlying APY). */
  w_at?: string | number | null
  w_rate?: string | null
}

/** A numeric column (text from `pg`) as a bigint; the stored values are integers. */
function big(text: string): bigint {
  return BigInt(String(text).split(".")[0])
}

/** Slots per bucket so that `slots` fit within the point cap. */
function bucketSize(slots: number): number {
  return Math.max(1, Math.ceil(slots / TARGET_POINTS))
}

/**
 * Rows of the given pools from `since` (unix s), oldest first, at most one per bucket of `k` slots
 * (the last snapshot of the bucket). With `window`, each row also carries the earliest snapshot
 * within the 7 days up to it (one index lookup per row), which is all `underlyingApy7d` needs.
 */
async function fetchRows(sql: Sql, pools: string[], since: number, k: number, window: boolean): Promise<Row[]> {
  if (!window) {
    return sql<Row>`
      select distinct on (pool, bucket)
             pool, slot, extract(epoch from close_time)::bigint as at,
             implied_rate, pt_price, pt_reserve, sy_reserve, sy_rate, oracle_rate
      from (
        select *, slot / ${k}::bigint as bucket
        from market_state_snapshots
        where pool = any(${pools}::text[]) and close_time >= to_timestamp(${since})
      ) t
      order by pool, bucket, slot desc`
  }
  return sql<Row>`
    select b.pool, b.slot, b.at, b.implied_rate, b.pt_price, b.pt_reserve, b.sy_reserve, b.sy_rate,
           b.oracle_rate, w.at as w_at, w.oracle_rate as w_rate
    from (
      select distinct on (pool, bucket)
             pool, slot, close_time, extract(epoch from close_time)::bigint as at,
             implied_rate, pt_price, pt_reserve, sy_reserve, sy_rate, oracle_rate
      from (
        select *, slot / ${k}::bigint as bucket
        from market_state_snapshots
        where pool = any(${pools}::text[]) and close_time >= to_timestamp(${since})
      ) t
      order by pool, bucket, slot desc
    ) b
    left join lateral (
      select extract(epoch from o.close_time)::bigint as at, o.oracle_rate
      from market_state_snapshots o
      where o.pool = b.pool and o.slot between b.slot - ${WINDOW_SLOT_BOUND}::bigint and b.slot
        and o.close_time >= b.close_time - interval '7 days'
      order by o.slot
      limit 1
    ) w on true
    order by b.pool, b.slot`
}

/** First stored slot of a pool, or undefined (used to size buckets for the `all` range). */
async function firstSlot(sql: Sql, pool: string): Promise<number | undefined> {
  const rows = await sql<{ first_slot: string | number | null }>`
    select min(slot) as first_slot from market_state_snapshots where pool = ${pool}`
  const n = Number(rows[0]?.first_slot)
  return Number.isFinite(n) ? n : undefined
}

type Built = {
  fixedApy: Series
  underlying: Series
  liquidity: Series
  latestAt: number | null
  windowSeconds: number | null
}

/**
 * Series over `rows` (one pool, oldest first, at most one row per `k` slots). Linear in the rows:
 * the 7-day window comes from the row's own window-start columns. A bucket without a row between
 * the first and last is a gap (`null`), never interpolated. As a safeguard the rows are bucketed
 * again if they would still exceed the point cap.
 */
function build(rows: Row[], maturity: number, from: number, k: number): Built {
  const parsed = rows.map((r) => ({ at: Number(r.at), slot: Number(r.slot), row: r })).filter((p) => p.at >= from)
  const out: Built = {
    fixedApy: [],
    underlying: [],
    liquidity: [],
    latestAt: rows.length ? Number(rows[rows.length - 1].at) : null,
    windowSeconds: null,
  }
  if (parsed.length === 0) return out
  const span = parsed[parsed.length - 1].slot - parsed[0].slot + 1
  const size = Math.max(k, bucketSize(span))
  // Last row of each bucket.
  const kept: typeof parsed = []
  for (const p of parsed) {
    const last = kept[kept.length - 1]
    if (last && Math.floor(last.slot / size) === Math.floor(p.slot / size)) kept[kept.length - 1] = p
    else kept.push(p)
  }
  let prevBucket: number | undefined
  for (const p of kept) {
    const bucket = Math.floor(p.slot / size)
    if (prevBucket !== undefined) {
      for (let b = prevBucket + 1; b < bucket; b++) {
        const gap = { at: b * size * SLOT_SECONDS, value: null }
        out.fixedApy.push(gap)
        out.underlying.push({ ...gap })
        out.liquidity.push({ ...gap })
      }
    }
    prevBucket = bucket
    const r = p.row
    out.fixedApy.push({ at: p.at, value: aprToApy(big(r.implied_rate), BigInt(Math.max(0, maturity - p.at))) })
    const start =
      r.w_at !== undefined && r.w_at !== null && r.w_rate != null
        ? { at: Number(r.w_at), rate: big(r.w_rate) }
        : { at: p.at, rate: big(r.oracle_rate) }
    const apy = underlyingApy7d([start, { at: p.at, rate: big(r.oracle_rate) }])
    out.underlying.push({ at: p.at, value: apy?.apy ?? null })
    out.windowSeconds = apy?.windowSeconds ?? null
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
  let slots: number
  if (range === "all") {
    const first = await firstSlot(sql, pool)
    slots = first === undefined ? 1 : Math.floor(nowSeconds / SLOT_SECONDS) - first + 1
  } else {
    slots = (RANGE_DAYS[range] * DAY) / SLOT_SECONDS
  }
  const k = bucketSize(slots)
  const rows = await fetchRows(sql, [pool], from, k, true)
  const built = build(rows, opts.maturity, from, k)
  return {
    fixedApy: built.fixedApy,
    underlyingApy7d: built.underlying,
    liquidity: built.liquidity,
    latestAt: built.latestAt,
    stale: isStale(built.latestAt, nowSeconds),
    underlyingWindowSeconds: built.windowSeconds,
  }
}

/**
 * Last 30 days of fixed APY per pool; `changePts` = (last - first) x 100 percentage points;
 * `stale` per pool from that pool's latest snapshot.
 */
export async function getSparks(
  sql: Sql,
  pools: string[],
  maturities: Record<string, number>,
  now: () => number = Date.now,
): Promise<Record<string, Spark>> {
  const nowSeconds = Math.floor(now() / 1000)
  const from = nowSeconds - SPARK_DAYS * DAY
  const known = pools.filter((p) => maturities[p] !== undefined)
  const k = bucketSize((SPARK_DAYS * DAY) / SLOT_SECONDS)
  const rows = known.length ? await fetchRows(sql, known, from, k, false) : []
  const result: Record<string, Spark> = {}
  for (const pool of pools) {
    const built = build(
      rows.filter((r) => r.pool === pool),
      maturities[pool] ?? 0,
      from,
      k,
    )
    const points = maturities[pool] === undefined ? [] : built.fixedApy
    const values = points.map((p) => p.value).filter((v): v is number => v !== null)
    result[pool] = {
      points,
      changePts: values.length < 2 ? null : (values[values.length - 1] - values[0]) * 100,
      stale: isStale(built.latestAt, nowSeconds),
    }
  }
  return result
}
