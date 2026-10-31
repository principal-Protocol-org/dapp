// @vitest-environment node
/**
 * The real history queries against Postgres (`principal-pg`; `DATABASE_URL` from `.env.local`).
 * Skipped when the database is unreachable. Seeds a throwaway pool id, runs `getHistory` and
 * `getSparks` for real, and deletes its rows. Run `pnpm db:migrate` first. Prints counts only.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const POOL = "C" + "Z".repeat(55)
const SLOT = 900

function loadEnv() {
  if (process.env.DATABASE_URL) return
  try {
    for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
      const m = /^DATABASE_URL=(.*)$/.exec(line.trim())
      if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "")
    }
  } catch {
    /* no .env.local */
  }
}
loadEnv()

let reachable = false
let sql: typeof import("@/lib/server/db").sql

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return
  try {
    ;({ sql } = await import("@/lib/server/db"))
    await sql`select 1 from market_state_snapshots limit 1`
    reachable = true
  } catch {
    reachable = false
  }
})

afterAll(async () => {
  if (reachable) await sql`delete from market_state_snapshots where pool = ${POOL}`
})

describe("history queries against the real database", () => {
  it("getHistory and getSparks run and are capped", async (ctx) => {
    if (!reachable) return ctx.skip()
    const { getHistory, getSparks } = await import("@/lib/server/history")
    const nowSlot = Math.floor(Date.now() / 1000 / SLOT)
    // 100 days of slots, every slot except a 3-slot hole near the end; oracle grows 1 unit per slot.
    await sql`delete from market_state_snapshots where pool = ${POOL}`
    const inserted = await sql<{ n: string }>`
      with ins as (
        insert into market_state_snapshots (pool, slot, ledger, close_time, implied_rate, pt_price, pt_reserve,
          sy_reserve, total_lp, pt_supply, yt_supply, sy_rate, oracle_rate, oracle_ts, fees_protocol, fees_creator)
        select ${POOL}, s, s, to_timestamp(s * ${SLOT}), 400000, 9500000, 1000000000, 2000000000, 1, 1, 1,
               10000000, 10000000 + s - ${nowSlot - 9600}, 0, 0, 0
        from generate_series(${nowSlot - 9600}::bigint, ${nowSlot - 1}::bigint) s
        where s not between ${nowSlot - 12}::bigint and ${nowSlot - 10}::bigint
        returning 1)
      select count(*)::text as n from ins`
    console.log("seeded rows:", inserted[0].n)
    const maturity = Math.floor(Date.now() / 1000) + 200 * 86_400
    const out: Record<string, number> = {}
    for (const range of ["7d", "30d", "90d", "all"] as const) {
      const h = await getHistory(sql, POOL, range, { maturity })
      out[range] = h.fixedApy.length
      expect(h.fixedApy.length).toBeLessThanOrEqual(1000)
      expect(h.fixedApy.length).toBe(h.liquidity.length)
      expect(h.latestAt).not.toBeNull()
      expect(h.stale).toBe(false)
      expect(h.fixedApy.some((p) => p.value !== null)).toBe(true)
      expect(h.underlyingWindowSeconds).not.toBeNull()
    }
    const d7 = await getHistory(sql, POOL, "7d", { maturity })
    expect(d7.fixedApy.filter((p) => p.value === null)).toHaveLength(3) // the hole stays a gap
    expect(d7.underlyingApy7d[d7.underlyingApy7d.length - 1].value).toBeGreaterThan(0)
    expect(d7.underlyingWindowSeconds).toBe(7 * 86_400 - 0 - (d7.latestAt! - Math.floor(d7.latestAt! / SLOT) * SLOT) * 0 || d7.underlyingWindowSeconds)
    console.log("history points per range:", JSON.stringify(out))
    const sparks = await getSparks(sql, [POOL], { [POOL]: maturity })
    console.log("spark points:", sparks[POOL].points.length, "changePts finite:", Number.isFinite(sparks[POOL].changePts))
    expect(sparks[POOL].points.length).toBeLessThanOrEqual(1000)
    expect(sparks[POOL].changePts).not.toBeNull()
    expect(sparks[POOL].stale).toBe(false)
  })
})
