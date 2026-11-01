// @vitest-environment node
/**
 * The real history queries against Postgres (`principal-pg`; `DATABASE_URL` from `.env.local`).
 * Skipped when the database is unreachable, and refused unless it is the local container (never a
 * hosted database). Run `pnpm db:migrate` first. Prints counts and verdicts only.
 *
 * - The queries: seeds a throwaway pool id, runs `getHistory` and `getSparks` for real, and deletes
 *   its rows.
 * - The recorder (Task 24): `recordAll` reads the live local market and writes one snapshot row, and
 *   `getHistory` / `getSparks` return it. Skipped when the local network is down. The row is deleted
 *   afterwards, so the database is left as it was found.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { aprToApy } from "@/lib/protocol/math"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer } from "@/lib/protocol/stellar"
import { createLog, loadDatabaseUrl, MINUTE, readManifest, skipReason, sleep } from "./local-stack"

const POOL = "C" + "Z".repeat(55)
const SLOT = 900

loadDatabaseUrl()

/** Only the dev stack's own Postgres: a hosted database is never written by this suite. */
function localDatabase(): boolean {
  try {
    const host = new URL(process.env.DATABASE_URL ?? "").hostname
    return host === "localhost" || host === "127.0.0.1"
  } catch {
    return false
  }
}

let reachable = false
let sql: typeof import("@/lib/server/db").sql

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return
  if (!localDatabase()) {
    console.info("[history] skipped: DATABASE_URL is not the local principal-pg container")
    return
  }
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

describe("the recorder on the local stack (Task 24)", () => {
  const out = createLog("recorder")
  /** The row this test wrote, removed afterwards. */
  let written: { pool: string; slot: number; ledger: number } | undefined

  afterAll(async () => {
    if (reachable && written) {
      await sql`delete from market_state_snapshots where pool = ${written.pool} and slot = ${written.slot} and ledger = ${written.ledger}`
      out.log(`removed the test's row (slot ${written.slot}, ledger ${written.ledger})`)
    }
    out.summary()
  })

  it("recordAll writes one snapshot of the live market, and History returns it", async (ctx) => {
    if (!reachable) return ctx.skip()
    const down = await skipReason()
    if (down) {
      console.info(`[recorder] skipped: ${down}`)
      return ctx.skip()
    }
    const { recordAll, SLOT_SECONDS } = await import("@/lib/server/recorder")
    const { getHistory, getSparks } = await import("@/lib/server/history")
    const manifest = readManifest()
    const market = manifest.markets[0]
    const pool = market.contracts.pool
    const server = createRpcServer(manifest.rpcUrl)
    // As the cron route reads it (app/api/cron/record/route.ts).
    const ledgerCloseTime = async (ledger: number) => {
      const page = await server.getLedgers({ startLedger: ledger, pagination: { limit: 1 } })
      const found = page.ledgers.find((l) => l.sequence === ledger)
      if (!found) throw new Error(`ledger ${ledger} not found on the RPC node`)
      return Number(found.ledgerCloseTime)
    }
    const slotNow = async () => Math.floor((await ledgerCloseTime((await server.getLatestLedger()).sequence)) / SLOT_SECONDS)
    const taken = async (slot: number) => (await sql<{ n: string }>`select count(*)::text as n from market_state_snapshots where pool = ${pool} and slot = ${slot}`)[0].n !== "0"

    const deps = { reader: createRpcReader(manifest), sql, manifest, markets: async () => [market], now: () => Date.now(), ledgerCloseTime }
    const nextSlot = async (slot: number) => {
      while ((await slotNow()) <= slot) await sleep(15_000)
    }

    // A row already in this slot is someone else's (another recorder, such as a dev server's cron:
    // the recorder inserts once per slot). It is never touched: the test records in the next slot,
    // once, and skips if that one is taken too. A run that records 0 because another recorder took
    // the slot in between is that same race, never a failure.
    let recorded: { before: number; after: number } | undefined
    for (let attempt = 1; attempt <= 2 && !recorded; attempt++) {
      const slot = await slotNow()
      if (await taken(slot)) {
        out.log(`slot ${slot} already has a row for this pool${attempt === 1 ? "; waiting for the next slot" : ""}`)
      } else {
        const before = (await server.getLatestLedger()).sequence
        const result = await recordAll(deps)
        const after = (await server.getLatestLedger()).sequence
        expect(result.failed).toEqual([])
        if (result.recorded === 1) recorded = { before, after }
        else out.log(`slot ${slot} was taken by another recorder while this one ran${attempt === 1 ? "; trying the next slot" : ""}`)
      }
      if (!recorded && attempt === 1) await nextSlot(slot)
    }
    if (!recorded) {
      console.info("[recorder] skipped: another recorder took two slots in a row, so this test could not write its own row")
      return ctx.skip()
    }
    const { before, after } = recorded

    const rows = await sql<{ slot: string; ledger: string; at: string; implied_rate: string; pt_reserve: string; sy_reserve: string; oracle_rate: string }>`
      select slot::text, ledger::text, extract(epoch from close_time)::bigint::text as at, implied_rate::text, pt_reserve::text,
             sy_reserve::text, oracle_rate::text
      from market_state_snapshots where pool = ${pool} and ledger between ${before} and ${after}`
    // This test's row: the only one read between the two clock reads.
    expect(rows).toHaveLength(1)
    const row = rows[0]
    written = { pool, slot: Number(row.slot), ledger: Number(row.ledger) }
    const closeTime = Number(row.at)
    // One ledger, read between the two clock reads; keyed by that ledger's close time.
    expect(written.ledger).toBeGreaterThanOrEqual(before)
    expect(written.ledger).toBeLessThanOrEqual(after)
    expect(closeTime).toBe(await ledgerCloseTime(written.ledger))
    expect(written.slot).toBe(Math.floor(closeTime / SLOT_SECONDS))
    for (const v of [row.implied_rate, row.pt_reserve, row.sy_reserve, row.oracle_rate]) expect(BigInt(v) > 0n).toBe(true)
    out.log(
      `recorded pool ${pool.slice(0, 8)}… slot ${written.slot} ledger ${written.ledger} (read between ledgers ${before} and ${after}): ` +
        `implied_rate ${row.implied_rate}, pt ${row.pt_reserve}, sy ${row.sy_reserve}, oracle ${row.oracle_rate}`,
    )

    // History returns it: the newest point of the 7-day series, at its close time, not stale.
    const h = await getHistory(sql, pool, "7d", { maturity: market.maturity })
    expect(h.latestAt).toBe(closeTime)
    expect(h.stale).toBe(false)
    expect(h.fixedApy.at(-1)).toEqual({ at: closeTime, value: aprToApy(BigInt(row.implied_rate), BigInt(market.maturity - closeTime)) })
    expect(h.liquidity.at(-1)?.at).toBe(closeTime)
    expect(h.liquidity.at(-1)?.value).not.toBeNull()
    const sparks = await getSparks(sql, [pool], { [pool]: market.maturity })
    expect(sparks[pool].points.at(-1)?.at).toBe(closeTime)
    expect(sparks[pool].stale).toBe(false)
    out.log(`getHistory 7d: ${h.fixedApy.length} points, latest at ${closeTime}, fixed APY ${h.fixedApy.at(-1)?.value}; spark ${sparks[pool].points.length} points`)

    // A retry inside the same slot inserts nothing (on conflict do nothing).
    if ((await slotNow()) === written.slot) {
      expect(await recordAll(deps)).toEqual({ recorded: 0, failed: [] })
      out.log("a second run in the same slot recorded 0 rows")
    }
  }, 18 * MINUTE)
})
