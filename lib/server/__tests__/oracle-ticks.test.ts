// @vitest-environment node
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import type { Sql } from "@/lib/server/db"
import type { KeeperFailure } from "@/lib/server/oracle-ticks"
import { keeperHealth, keeperIntervalSeconds, lastSubmittedRejection, listTicks, recordsRejections, recordTick, tickRow } from "@/lib/server/oracle-ticks"
import { OracleKeeperConfigError, type OracleTick } from "@/lib/server/oracle-keeper"

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
  it("feed mode (D-21): a sync is synced, with its value and hash", () => {
    expect(tickRow({ status: "synced", mode: "feed", signer: SIGNER, value: "10000000", timestamp: 1, hash: HASH })).toEqual({
      mode: "feed",
      decision: "synced",
      value: "10000000",
      reason: null,
      txHash: HASH,
      signer: SIGNER,
    })
    // A sync that landed against a rejected simulation: value unknown, never a made-up one.
    expect(tickRow({ status: "synced", mode: "feed", signer: SIGNER, value: null, timestamp: null, hash: HASH })).toMatchObject({ decision: "synced", value: null })
  })
  it("feed mode: a routine rejection is skipped and keeps its reason; no hash", () => {
    expect(tickRow({ status: "skipped", mode: "feed", signer: SIGNER, value: "10000000", timestamp: 1, reason: "stale_ts" })).toEqual({
      mode: "feed",
      decision: "skipped",
      value: "10000000",
      reason: "stale_ts",
      txHash: null,
      signer: SIGNER,
    })
    expect(tickRow({ status: "skipped", mode: "feed", signer: SIGNER, value: null, timestamp: null, reason: "no_data" })).toMatchObject({ value: null, reason: "no_data" })
    // An oracle with no feed source (M-13): a skipped run with the keeper's own reason, no value.
    expect(tickRow({ status: "skipped", mode: "feed", signer: SIGNER, value: null, timestamp: null, reason: "no_feed" })).toEqual({
      mode: "feed",
      decision: "skipped",
      value: null,
      reason: "no_feed",
      txHash: null,
      signer: SIGNER,
    })
  })
  it("feed mode: a rejection that was not submitted (a repeat, a broken feed) has no hash", () => {
    expect(tickRow({ status: "rejected", mode: "feed", signer: SIGNER, value: "-1", timestamp: 1, reason: "bad_price" })).toEqual({
      mode: "feed",
      decision: "rejected",
      value: "-1",
      reason: "bad_price",
      txHash: null,
      signer: SIGNER,
    })
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

/**
 * The health query's one row: when the last success, the last run that did not fail and the last
 * tick were, and the 24 h counts (pg returns counts as strings).
 */
const healthRow = (over: Partial<{ last_success: Date | null; last_ok: Date | null; last_tick: Date | null; rejected: string; failures: string }> = {}) => ({
  last_success: new Date(NOW - 600_000),
  last_ok: new Date(NOW - 300_000),
  last_tick: new Date(NOW - 60_000),
  rejected: "2",
  failures: "1",
  ...over,
})

describe("keeperIntervalSeconds and recordsRejections: the keeper's schedule and its on-chain rejections, from the environment", () => {
  it("the interval is ORACLE_KEEPER_INTERVAL_SECONDS, 1,800 s (30 min) when unset or blank", () => {
    expect(keeperIntervalSeconds({})).toBe(1_800)
    expect(keeperIntervalSeconds({ ORACLE_KEEPER_INTERVAL_SECONDS: "" })).toBe(1_800)
    expect(keeperIntervalSeconds({ ORACLE_KEEPER_INTERVAL_SECONDS: "  " })).toBe(1_800)
    expect(keeperIntervalSeconds({ ORACLE_KEEPER_INTERVAL_SECONDS: "300" })).toBe(300)
    expect(keeperIntervalSeconds({ ORACLE_KEEPER_INTERVAL_SECONDS: " 300 " })).toBe(300)
  })

  it("accepts 60 to 86,400 whole seconds, bounds included", () => {
    expect(keeperIntervalSeconds({ ORACLE_KEEPER_INTERVAL_SECONDS: "60" })).toBe(60)
    expect(keeperIntervalSeconds({ ORACLE_KEEPER_INTERVAL_SECONDS: "86400" })).toBe(86_400)
  })

  it("refuses anything else with a config error in plain words, never a silent default", () => {
    for (const raw of ["59", "0", "86401", "-300", "300.5", "3e2", "5m", "abc", "1_800"]) {
      const error = (() => {
        try {
          keeperIntervalSeconds({ ORACLE_KEEPER_INTERVAL_SECONDS: raw })
        } catch (e) {
          return e
        }
      })()
      expect(error, raw).toBeInstanceOf(OracleKeeperConfigError)
      expect((error as Error).message).toBe("ORACLE_KEEPER_INTERVAL_SECONDS must be a whole number of seconds from 60 to 86400.")
    }
  })

  it("rejections go on-chain only with ORACLE_KEEPER_RECORD_REJECTIONS exactly 1; anything else is off (a flag that spends fees)", () => {
    expect(recordsRejections({ ORACLE_KEEPER_RECORD_REJECTIONS: "1" })).toBe(true)
    for (const raw of [undefined, "", " 1", "1 ", " 1\n", "1\n", "0", "true", "yes", "on", "11", "01"]) {
      expect(recordsRejections({ ORACLE_KEEPER_RECORD_REJECTIONS: raw }), JSON.stringify(raw)).toBe(false)
    }
  })
})

describe("keeperHealth (M-15): healthy while the last run that did not fail is younger than 2 × the interval", () => {
  it("healthy 1 s before 2 × the interval; not healthy at exactly 2 × the interval or after", async () => {
    const at = async (ageSeconds: number) =>
      (await keeperHealth(fakeSql([healthRow({ last_ok: new Date(NOW - ageSeconds * 1000) })]).sql, "testnet", 1_800, { now: NOW })).healthy
    expect(await at(3_599)).toBe(true)
    expect(await at(3_600)).toBe(false)
    expect(await at(3_601)).toBe(false)
    expect(await at(0)).toBe(true)
    // The interval decides the window: 5 min runs are late after 10 min.
    expect((await keeperHealth(fakeSql([healthRow({ last_ok: new Date(NOW - 599_000) })]).sql, "mainnet", 300, { now: NOW })).healthy).toBe(true)
    expect((await keeperHealth(fakeSql([healthRow({ last_ok: new Date(NOW - 600_000) })]).sql, "mainnet", 300, { now: NOW })).healthy).toBe(false)
  })

  it("returns the last success, the last run that did not fail, the last tick, and the rejected and failed runs of the last 24 h as numbers", async () => {
    const { sql, calls } = fakeSql([healthRow()])
    expect(await keeperHealth(sql, "testnet", 1_800, { now: NOW, oracle: ORACLE })).toEqual({
      healthy: true,
      lastSuccessAt: new Date(NOW - 600_000).toISOString(),
      lastOkAt: new Date(NOW - 300_000).toISOString(),
      lastTickAt: new Date(NOW - 60_000).toISOString(),
      rejected24h: 2,
      failures24h: 1,
    })
    // A success is an update that landed (pushed, or synced from a feed); skipped runs and errors are not.
    expect(calls[0].text).toContain("filter (where decision in ('pushed', 'synced'))")
    // A run that did not fail is any decision but error: a skipped or rejected run is the keeper working.
    expect(calls[0].text).toContain("filter (where decision <> 'error') as last_ok")
    expect(calls[0].text).toContain("decision = 'rejected'")
    expect(calls[0].text).toContain("decision = 'error'")
    // The window starts 24 h before `now`; one network and, when given, one oracle.
    expect(calls[0].values).toEqual(expect.arrayContaining(["testnet", ORACLE, new Date(NOW - 86_400_000).toISOString()]))
  })

  it("healthy after a skipped run that changed nothing: health is about the keeper, not the oracle (M-15)", async () => {
    // No update ever landed, and the last run (a skipped one, say stale_ts or no_feed) finished.
    const { sql } = fakeSql([healthRow({ last_success: null, last_ok: new Date(NOW - 60_000), last_tick: new Date(NOW - 60_000) })])
    expect(await keeperHealth(sql, "mainnet", 300, { now: NOW })).toMatchObject({ healthy: true, lastSuccessAt: null, lastOkAt: new Date(NOW - 60_000).toISOString() })
  })

  it("only error runs: not healthy, no last ok run, however recent the last tick", async () => {
    const { sql } = fakeSql([healthRow({ last_success: null, last_ok: null, last_tick: new Date(NOW - 1_000) })])
    expect(await keeperHealth(sql, "testnet", 1_800, { now: NOW })).toMatchObject({ healthy: false, lastSuccessAt: null, lastOkAt: null, lastTickAt: new Date(NOW - 1_000).toISOString() })
    // An old success does not make it healthy either: the runs since have all failed.
    const old = fakeSql([healthRow({ last_success: new Date(NOW - 7_200_000), last_ok: new Date(NOW - 7_200_000), last_tick: new Date(NOW - 1_000) })])
    expect((await keeperHealth(old.sql, "testnet", 1_800, { now: NOW })).healthy).toBe(false)
  })

  it("no tick recorded: lastTickAt null (a neutral, unknown state for the page and the alerts), zero counts", async () => {
    const { sql, calls } = fakeSql([{ last_success: null, last_ok: null, last_tick: null, rejected: "0", failures: "0" }])
    expect(await keeperHealth(sql, "testnet", 1_800, { now: NOW })).toEqual({ healthy: false, lastSuccessAt: null, lastOkAt: null, lastTickAt: null, rejected24h: 0, failures24h: 0 })
    // Every oracle of the network when none is given.
    expect(calls[0].values).toContain(null)
  })

  it("accepts timestamps as ISO strings too", async () => {
    const { sql } = fakeSql([
      healthRow({ last_success: new Date(NOW - 5_000).toISOString() as unknown as Date, last_ok: new Date(NOW - 4_000).toISOString() as unknown as Date }),
    ])
    expect(await keeperHealth(sql, "testnet", 1_800, { now: NOW })).toMatchObject({
      lastSuccessAt: new Date(NOW - 5_000).toISOString(),
      lastOkAt: new Date(NOW - 4_000).toISOString(),
    })
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

describe("lastSubmittedRejection (D-21): the feed keeper's memory of the last rejection it put on-chain", () => {
  it("the newest feed-mode significant rejection with a tx hash, for this network and oracle", async () => {
    const { sql, calls } = fakeSql([{ reason: "deviate", value: "11500000" }])
    expect(await lastSubmittedRejection(sql, "local", ORACLE)).toEqual({ reason: "deviate", value: "11500000" })
    expect(calls).toHaveLength(1)
    const q = calls[0].text
    expect(q).toContain("value::text")
    expect(q).toContain("mode = 'feed'")
    expect(q).toContain("decision = 'rejected'")
    expect(q).toContain("tx_hash is not null")
    expect(q).toContain("order by at desc, id desc")
    expect(q).toContain("limit 1")
    // Only significant reasons: a submitted run whose reason is unknown is no memory of one.
    expect(calls[0].values).toEqual(["local", ORACLE, ["oob", "decrease", "deviate", "fb_value"]])
  })
  it("null when none is recorded", async () => {
    expect(await lastSubmittedRejection(fakeSql([]).sql, "local", ORACLE)).toBeNull()
    expect(await lastSubmittedRejection(fakeSql([{ reason: "deviate", value: null }]).sql, "local", ORACLE)).toBeNull()
  })
})
