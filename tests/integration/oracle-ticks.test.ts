/**
 * The keeper telemetry's SQL on the local Postgres (spec 0004 D-19): `recordTick` writes every kind
 * of run into `oracle_ticks` (the table's checks accept them), `listTicks` reads them back newest
 * first with exact values, and `keeperHealth` counts only the last 24 h and only successes for
 * health. The fakes in `lib/server/__tests__/oracle-ticks.test.ts` pin the queries' shape; this pins
 * what Postgres does with them.
 *
 * Needs `principal-pg` migrated (`pnpm db:migrate`) and `DATABASE_URL` on this machine (a shared
 * database is refused: this suite writes and deletes rows). Its rows use an oracle id of their own,
 * deleted afterwards, so the local stack's real ticks are untouched. No chain is needed.
 */
import { randomBytes } from "node:crypto"
import { afterAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { sql } from "@/lib/server/db"
import { keeperHealth, listTicks, ORACLE_TICK_INTERVAL_SECONDS, recordTick } from "@/lib/server/oracle-ticks"
import { loadDatabaseUrl } from "./local-stack"

async function reason(): Promise<string | null> {
  loadDatabaseUrl()
  const url = process.env.DATABASE_URL
  if (!url) return "DATABASE_URL is not set (scripts/dev-stack/deploy.sh writes it to .env.local)"
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return "DATABASE_URL is not a connection string"
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(host)) return "DATABASE_URL is not a database on this machine; this suite writes and deletes rows"
  try {
    await sql`select signer from oracle_ticks limit 1`
  } catch (error) {
    return `the local database is not reachable or not migrated (pnpm db:migrate): ${error instanceof Error ? error.name : "unknown"}`
  }
  return null
}

const skip = await reason()
if (skip) console.warn(`[oracle-ticks] skipped: ${skip}`)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
/** A contract-shaped id no deployment uses: this suite's rows, and only them, carry it. */
const ORACLE = `C${[...randomBytes(55)].map((b) => B32[b % 32]).join("")}`
const SIGNER = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const HASH = "ab".repeat(32)

describe.skipIf(skip !== null)("oracle_ticks on the local Postgres", () => {
  afterAll(async () => {
    await sql`delete from oracle_ticks where oracle = ${ORACLE}`
  })

  it("no run recorded for this oracle: no last tick, no success, zero counts", async () => {
    expect(await keeperHealth(sql, "local", ORACLE_TICK_INTERVAL_SECONDS, { oracle: ORACLE })).toEqual({
      healthy: false,
      lastSuccessAt: null,
      lastTickAt: null,
      rejected24h: 0,
      failures24h: 0,
    })
    expect(await listTicks(sql, { network: "local", oracle: ORACLE, limit: 5 })).toEqual([])
  })

  it("records every kind of run, and reads them back newest first with exact values", async () => {
    // A rejected run 25 h ago: outside the 24 h window.
    await sql`
      insert into oracle_ticks (at, network, oracle, mode, decision, value, reason, tx_hash, signer)
      values (now() - interval '25 hours', 'local', ${ORACLE}, 'push', 'rejected', 1, 'deviate', ${HASH}, ${SIGNER})`
    await recordTick(sql, "local", ORACLE, { status: "failed", mode: "push", signer: SIGNER, name: "TypeError" })
    await recordTick(sql, "local", ORACLE, { status: "not_configured", mode: "push", signer: null, message: "ORACLE_ADMIN_SECRET is not set." })
    await recordTick(sql, "local", ORACLE, { status: "rejected", mode: "push", signer: SIGNER, value: "12000000", timestamp: 1, hash: HASH, reason: "deviate" })

    // Errors and rejections only: not healthy, no success yet.
    const before = await keeperHealth(sql, "local", ORACLE_TICK_INTERVAL_SECONDS, { oracle: ORACLE })
    expect(before).toMatchObject({ healthy: false, lastSuccessAt: null, rejected24h: 1, failures24h: 2 })
    expect(before.lastTickAt).not.toBeNull()

    await recordTick(sql, "local", ORACLE, { status: "unchanged", mode: "push", signer: SIGNER, value: "10000919", timestamp: 1 })
    // A skipped run is no success.
    expect((await keeperHealth(sql, "local", ORACLE_TICK_INTERVAL_SECONDS, { oracle: ORACLE })).lastSuccessAt).toBeNull()

    // 34 digits: numeric keeps an i128-sized value exactly.
    await recordTick(sql, "local", ORACLE, { status: "updated", mode: "push", signer: SIGNER, value: "1234567890123456789012345678901234", timestamp: 1, hash: HASH })
    const after = await keeperHealth(sql, "local", ORACLE_TICK_INTERVAL_SECONDS, { oracle: ORACLE })
    expect(after).toMatchObject({ healthy: true, rejected24h: 1, failures24h: 2 })
    expect(after.lastSuccessAt).toBe(after.lastTickAt)

    const ticks = await listTicks(sql, { network: "local", oracle: ORACLE, limit: 10 })
    expect(ticks.map((t) => t.decision)).toEqual(["pushed", "skipped", "rejected", "error", "error", "rejected"])
    expect(ticks[0]).toMatchObject({ mode: "push", value: "1234567890123456789012345678901234", reason: null, txHash: HASH, signer: SIGNER, oracle: ORACLE })
    expect(ticks[1]).toMatchObject({ value: "10000919", txHash: null })
    expect(ticks[3]).toMatchObject({ value: null, reason: "not_configured: ORACLE_ADMIN_SECRET is not set.", signer: null })
    expect(ticks[4]).toMatchObject({ reason: "failed: TypeError" })
    expect(ticks.every((t) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(t.at))).toBe(true)
    expect((await listTicks(sql, { network: "local", oracle: ORACLE, limit: 2 })).map((t) => t.decision)).toEqual(["pushed", "skipped"])

    // Another network's rows are not this one's.
    expect(await listTicks(sql, { network: "testnet", oracle: ORACLE, limit: 10 })).toEqual([])
  })

  it("the table refuses a decision or a mode D-19 does not name", async () => {
    await expect(sql`insert into oracle_ticks (network, oracle, mode, decision) values ('local', ${ORACLE}, 'push', 'updated')`).rejects.toThrow()
    await expect(sql`insert into oracle_ticks (network, oracle, mode, decision) values ('local', ${ORACLE}, 'pull', 'pushed')`).rejects.toThrow()
  })
})
