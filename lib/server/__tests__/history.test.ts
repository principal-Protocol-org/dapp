// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { getHistory, getSparks } from "@/lib/server/history"
import { SLOT_SECONDS } from "@/lib/server/recorder"
import type { Sql } from "@/lib/server/db"

const POOL = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const DAY = 86_400
const NOW = 1_800_000_000
const SLOT0 = Math.floor(NOW / SLOT_SECONDS) - 100
const MATURITY = NOW + 365 * DAY

type Row = { pool?: string; slot: number; at: number; rate?: string; liq?: [string, string] }

/** A fake `sql` answering with the given snapshot rows (text numerics, as `pg` returns them). */
function fakeSql(rows: Row[]): Sql {
  return (async () =>
    rows.map((r) => ({
      pool: r.pool ?? POOL,
      slot: String(r.slot),
      at: String(r.at),
      implied_rate: r.rate ?? "400000",
      pt_price: "9500000",
      pt_reserve: r.liq?.[0] ?? "1000000000",
      sy_reserve: r.liq?.[1] ?? "2000000000",
      sy_rate: "10000000",
      oracle_rate: "10000000",
    }))) as unknown as Sql
}

const row = (i: number, extra: Partial<Row> = {}): Row => ({ slot: SLOT0 + i, at: (SLOT0 + i) * SLOT_SECONDS, ...extra })
const opts = { maturity: MATURITY, now: () => NOW * 1000 }

describe("getHistory", () => {
  it("fixed APY is compounded from the stored APR", async () => {
    const at = (SLOT0 + 1) * SLOT_SECONDS
    const h = await getHistory(fakeSql([row(1, { rate: "400000" })]), POOL, "7d", opts)
    const secs = MATURITY - at
    const expected = Math.pow(1 + (0.04 * secs) / 31_536_000, 31_536_000 / secs) - 1
    expect(h.fixedApy).toHaveLength(1)
    expect(h.fixedApy[0].at).toBe(at)
    expect(h.fixedApy[0].value).toBeCloseTo(expected, 10)
    expect(h.fixedApy[0].value).not.toBeCloseTo(0.04, 6) // compounded, not the raw APR
  })

  it("gap is not interpolated", async () => {
    const h = await getHistory(fakeSql([row(0), row(1), row(3)]), POOL, "7d", opts)
    expect(h.fixedApy.map((p) => p.at)).toEqual([0, 1, 2, 3].map((i) => (SLOT0 + i) * SLOT_SECONDS))
    expect(h.fixedApy[2].value).toBeNull()
    expect(h.liquidity[2].value).toBeNull()
    expect(h.underlyingApy7d[2].value).toBeNull()
    expect(h.fixedApy[3].value).not.toBeNull()
  })

  it("stale after 3600 s", async () => {
    const fresh = await getHistory(fakeSql([row(0, { at: NOW - 3600 })]), POOL, "7d", opts)
    expect(fresh.stale).toBe(false)
    const old = await getHistory(fakeSql([row(0, { at: NOW - 3601 })]), POOL, "7d", opts)
    expect(old.stale).toBe(true)
    expect(old.latestAt).toBe(NOW - 3601)
  })

  it("empty history returns latestAt null", async () => {
    const h = await getHistory(fakeSql([]), POOL, "30d", opts)
    expect(h).toEqual({
      fixedApy: [],
      underlyingApy7d: [],
      liquidity: [],
      latestAt: null,
      stale: true,
      underlyingWindowSeconds: null,
    })
  })

  it("underlying APY uses only the preceding window and liquidity follows the pool value", async () => {
    const rows = [row(0, { at: NOW - 2 * DAY }), row(1, { at: NOW - DAY })].map((r, i) => ({
      ...r,
      slot: SLOT0 + i * 96,
    }))
    const sql = (async () =>
      rows.map((r, i) => ({
        pool: POOL,
        slot: String(r.slot),
        at: String(r.at),
        implied_rate: "400000",
        pt_price: "10000000",
        pt_reserve: "10000000",
        sy_reserve: "20000000",
        sy_rate: "10000000",
        oracle_rate: i === 0 ? "10000000" : "10001000",
        w_at: String(rows[0].at), // earliest snapshot within 7 days
        w_rate: "10000000",
      }))) as unknown as Sql
    const h = await getHistory(sql, POOL, "7d", opts)
    expect(h.underlyingApy7d[0].value).toBeNull() // one point: no window yet
    const last = h.underlyingApy7d[h.underlyingApy7d.length - 1].value as number
    expect(last).toBeCloseTo(Math.pow(1.0001, 365) - 1, 6)
    expect(h.liquidity[0].value).toBe(3) // (2 + 1) underlying units
    expect(h.underlyingWindowSeconds).toBe(DAY) // the window of the latest point, for the UI label
  })

  it("is linear and capped: 50 000 rows give at most 1 000 points per series, fast", async () => {
    const start = Math.floor(NOW / SLOT_SECONDS) - 8640
    const rows = Array.from({ length: 50_000 }, (_, i) => {
      const slot = start + Math.floor((i * 8640) / 50_000)
      return {
        pool: POOL, slot: String(slot), at: String(slot * SLOT_SECONDS), implied_rate: "400000",
        pt_price: "9500000", pt_reserve: "1000000000", sy_reserve: "2000000000", sy_rate: "10000000",
        oracle_rate: "10000000", w_at: String(slot * SLOT_SECONDS - DAY), w_rate: "9999000",
      }
    })
    const sql = (async () => rows) as unknown as Sql
    const t0 = performance.now()
    const h = await getHistory(sql, POOL, "90d", opts)
    expect(performance.now() - t0).toBeLessThan(500)
    for (const series of [h.fixedApy, h.underlyingApy7d, h.liquidity]) {
      expect(series.length).toBeLessThanOrEqual(1000)
      expect(series.length).toBeGreaterThan(500)
    }
  })

  it("asks the database for buckets of k slots and the 7-day window start", async () => {
    const calls: string[] = []
    const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(strings.join("?") + "|" + values.join(","))
      return []
    }) as unknown as Sql
    await getHistory(sql, POOL, "90d", opts)
    expect(calls[0]).toContain("distinct on (pool, bucket)")
    expect(calls[0]).toContain("lateral")
    expect(calls[0].split("|")[1].startsWith("9,")).toBe(true) // k = ceil(8640 / 990) = 9
  })
})

describe("getSparks", () => {
  it("30-day spark change in points", async () => {
    const rows = [
      row(0, { rate: "400000" }),
      row(3, { rate: "500000" }),
      row(0, { pool: "COTHER", rate: "400000" }),
    ]
    const sparks = await getSparks(fakeSql(rows), [POOL, "COTHER"], { [POOL]: MATURITY, COTHER: MATURITY }, opts.now)
    const s = sparks[POOL]
    expect(s.points).toHaveLength(2)
    const [a, b] = s.points.map((p) => p.value as number)
    expect(s.changePts).toBeCloseTo((b - a) * 100, 10)
    expect(s.changePts as number).toBeGreaterThan(0)
    expect(sparks.COTHER.changePts).toBeNull() // one point
  })

  it("stale is per pool, from that pool's latest snapshot", async () => {
    const rows = [
      { ...row(0, { at: NOW - 100 }), pool: POOL },
      { ...row(0, { at: NOW - 7200 }), pool: "COTHER" },
    ]
    const sparks = await getSparks(fakeSql(rows), [POOL, "COTHER", "CNONE"], { [POOL]: MATURITY, COTHER: MATURITY, CNONE: MATURITY }, opts.now)
    expect(sparks[POOL].stale).toBe(false)
    expect(sparks.COTHER.stale).toBe(true)
    expect(sparks.CNONE.stale).toBe(true)
  })

  it("returns an empty spark for a pool with no rows", async () => {
    const sparks = await getSparks(fakeSql([]), [POOL], { [POOL]: MATURITY }, opts.now)
    expect(sparks[POOL]).toEqual({ points: [], changePts: null, stale: true })
  })
})
