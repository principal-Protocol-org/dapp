// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { Sql } from "@/lib/server/db"
import type { KeeperFailure } from "@/lib/server/oracle-ticks"
import { keeperHealth, listTicks, ORACLE_TICK_INTERVAL_SECONDS, recordTick, tickRow } from "@/lib/server/oracle-ticks"
import type { OracleTick } from "@/lib/server/oracle-keeper"

const ORACLE = "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS"
const SIGNER = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const HASH = "ab".repeat(32)
const NOW = Date.parse("2026-11-14T12:00:00.000Z")

/** A stand-in for `sql`: records each query's text and values, and answers `rows`. */
function fakeSql(rows: Record<string, unknown>[] = []) {
  const calls: { text: string; values: unknown[] }[] = []
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$?").replace(/\s+/g, " ").trim(), values })
    return rows
  })
  return { sql: sql as unknown as Sql, calls }
}

const updated: OracleTick = { status: "updated", mode: "push", signer: SIGNER, value: "10000919", timestamp: 1_794_621_599, hash: HASH }
const unchanged: OracleTick = { status: "unchanged", mode: "push", signer: SIGNER, value: "10000919", timestamp: 1_794_621_599 }
const rejected: OracleTick = { status: "rejected", mode: "push", signer: SIGNER, value: "12000000", timestamp: 1_794_621_599, hash: HASH, reason: "deviate" }
const notConfigured: KeeperFailure = { status: "not_configured", mode: "push", signer: null, message: "ORACLE_ADMIN_SECRET is not set." }
const failed: KeeperFailure = { status: "failed", mode: "push", signer: SIGNER, name: "TypeError" }

describe("tickRow: one cron/oracle run as an oracle_ticks row (D-19)", () => {
  it("an update is pushed, with its value, tx hash and signer", () => {
    expect(tickRow(updated)).toEqual({ mode: "push", decision: "pushed", value: "10000919", reason: null, txHash: HASH, signer: SIGNER })
  })
  it("a run that changed nothing is skipped, with the current value and no hash", () => {
    expect(tickRow(unchanged)).toEqual({ mode: "push", decision: "skipped", value: "10000919", reason: null, txHash: null, signer: SIGNER })
  })
  it("a rejection keeps the attempted value, the contract's reason and the hash", () => {
    expect(tickRow(rejected)).toEqual({ mode: "push", decision: "rejected", value: "12000000", reason: "deviate", txHash: HASH, signer: SIGNER })
  })
  it("a run that could not start is an error naming not_configured, in the app's own words", () => {
    expect(tickRow(notConfigured)).toEqual({ mode: "push", decision: "error", value: null, reason: "not_configured: ORACLE_ADMIN_SECRET is not set.", txHash: null, signer: null })
  })
  it("any other failure is an error with the error's name only", () => {
    expect(tickRow(failed)).toEqual({ mode: "push", decision: "error", value: null, reason: "failed: TypeError", txHash: null, signer: SIGNER })
  })
  it("a submitted transaction that did not land keeps its hash, with its result code or 'not confirmed'", () => {
    expect(tickRow({ status: "failed", mode: "push", signer: SIGNER, name: "invokeHostFunctionTrapped", hash: HASH })).toEqual({
      mode: "push",
      decision: "error",
      value: null,
      reason: "failed: invokeHostFunctionTrapped",
      txHash: HASH,
      signer: SIGNER,
    })
    expect(tickRow({ status: "failed", mode: "push", signer: SIGNER, name: "not confirmed", hash: HASH })).toMatchObject({ reason: "failed: not confirmed", txHash: HASH })
  })
})

describe("recordTick", () => {
  it("inserts one row: network, oracle, mode, decision, value (numeric), reason, tx hash, signer", async () => {
    const { sql, calls } = fakeSql()
    await recordTick(sql, "testnet", ORACLE, rejected)
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toMatch(/^insert into oracle_ticks \(network, oracle, mode, decision, value, reason, tx_hash, signer\)/)
    expect(calls[0].text).toContain("$?::numeric")
    expect(calls[0].values).toEqual(["testnet", ORACLE, "push", "rejected", "12000000", "deviate", HASH, SIGNER])
  })
  it("records error runs too, with no value", async () => {
    const { sql, calls } = fakeSql()
    await recordTick(sql, "local", ORACLE, failed)
    expect(calls[0].values).toEqual(["local", ORACLE, "push", "error", null, "failed: TypeError", null, SIGNER])
  })
})

/** The health query's one row: when the last success and the last tick were, and the 24 h counts (pg returns counts as strings). */
const healthRow = (over: Partial<{ last_success: Date | null; last_tick: Date | null; rejected: string; failures: string }> = {}) => ({
  last_success: new Date(NOW - 600_000),
  last_tick: new Date(NOW - 60_000),
  rejected: "2",
  failures: "1",
  ...over,
})

describe("keeperHealth (D-19): healthy while the last success is younger than 2 × the interval", () => {
  it("the interval is the 30 min schedule", () => {
    expect(ORACLE_TICK_INTERVAL_SECONDS).toBe(1_800)
  })

  it("healthy 1 s before 2 × the interval; not healthy at exactly 2 × the interval or after", async () => {
    const at = async (ageSeconds: number) =>
      (await keeperHealth(fakeSql([healthRow({ last_success: new Date(NOW - ageSeconds * 1000) })]).sql, "testnet", 1_800, { now: NOW })).healthy
    expect(await at(3_599)).toBe(true)
    expect(await at(3_600)).toBe(false)
    expect(await at(3_601)).toBe(false)
    expect(await at(0)).toBe(true)
  })

  it("returns the last success, the last tick, and the rejected and failed runs of the last 24 h as numbers", async () => {
    const { sql, calls } = fakeSql([healthRow()])
    expect(await keeperHealth(sql, "testnet", 1_800, { now: NOW, oracle: ORACLE })).toEqual({
      healthy: true,
      lastSuccessAt: new Date(NOW - 600_000).toISOString(),
      lastTickAt: new Date(NOW - 60_000).toISOString(),
      rejected24h: 2,
      failures24h: 1,
    })
    // A success is an update that landed (pushed, or synced from a feed); skipped runs and errors are not.
    expect(calls[0].text).toContain("filter (where decision in ('pushed', 'synced'))")
    expect(calls[0].text).toContain("decision = 'rejected'")
    expect(calls[0].text).toContain("decision = 'error'")
    // The window starts 24 h before `now`; one network and, when given, one oracle.
    expect(calls[0].values).toEqual(expect.arrayContaining(["testnet", ORACLE, new Date(NOW - 86_400_000).toISOString()]))
  })

  it("errors and rejections with no success: not healthy, no last success", async () => {
    const { sql } = fakeSql([healthRow({ last_success: null })])
    expect(await keeperHealth(sql, "testnet", 1_800, { now: NOW })).toMatchObject({ healthy: false, lastSuccessAt: null, lastTickAt: new Date(NOW - 60_000).toISOString() })
  })

  it("no tick recorded: lastTickAt null (a neutral, unknown state for the page and the alerts), zero counts", async () => {
    const { sql, calls } = fakeSql([{ last_success: null, last_tick: null, rejected: "0", failures: "0" }])
    expect(await keeperHealth(sql, "testnet", 1_800, { now: NOW })).toEqual({ healthy: false, lastSuccessAt: null, lastTickAt: null, rejected24h: 0, failures24h: 0 })
    // Every oracle of the network when none is given.
    expect(calls[0].values).toContain(null)
  })

  it("accepts timestamps as ISO strings too", async () => {
    const { sql } = fakeSql([healthRow({ last_success: new Date(NOW - 5_000).toISOString() as unknown as Date })])
    expect((await keeperHealth(sql, "testnet", 1_800, { now: NOW })).lastSuccessAt).toBe(new Date(NOW - 5_000).toISOString())
  })
})

describe("listTicks", () => {
  it("the newest ticks first, public fields only (the signer's public key), value as an exact string", async () => {
    const { sql, calls } = fakeSql([
      { id: "12", at: new Date(NOW - 1_000), oracle: ORACLE, mode: "push", decision: "rejected", value: "12000000", reason: "deviate", tx_hash: HASH, signer: SIGNER },
      { id: "11", at: new Date(NOW - 1_801_000), oracle: ORACLE, mode: "push", decision: "error", value: null, reason: "failed: TypeError", tx_hash: null, signer: null },
    ])
    expect(await listTicks(sql, { network: "testnet", oracle: ORACLE, limit: 20 })).toEqual([
      { id: "12", at: new Date(NOW - 1_000).toISOString(), oracle: ORACLE, mode: "push", decision: "rejected", value: "12000000", reason: "deviate", txHash: HASH, signer: SIGNER },
      { id: "11", at: new Date(NOW - 1_801_000).toISOString(), oracle: ORACLE, mode: "push", decision: "error", value: null, reason: "failed: TypeError", txHash: null, signer: null },
    ])
    expect(calls[0].text).toContain("value::text")
    expect(calls[0].text).toContain("order by at desc, id desc")
    expect(calls[0].values).toEqual(["testnet", ORACLE, ORACLE, 20])
  })
})
