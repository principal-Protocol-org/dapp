// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { parseManifest } from "@/lib/protocol/manifest"
import type { ContractReader } from "@/lib/protocol/reader"

vi.mock("server-only", () => ({}))

import { ledgerCloseTimeOf, recordAll, SLOT_SECONDS } from "@/lib/server/recorder"
import { DatabaseConfigError, type Sql } from "@/lib/server/db"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const c = market.contracts

const CLOSE_TIME = 1_800_000_123
const SLOT = Math.floor(CLOSE_TIME / SLOT_SECONDS)

/** Values per function name; `ledger` per call decides which ledger the "RPC" answered at. */
function makeReader(opts: { ledger?: (fn: string, contractId: string) => number; fail?: (fn: string, contractId: string) => boolean } = {}) {
  const ledger = opts.ledger ?? (() => 500)
  const values: Record<string, unknown> = {
    pool_state: { pt_reserve: 1000n, sy_reserve: 2000n, total_lp: 3000n, rate: 5n, exponent: 6n, fee_rate: 7n, seconds_to_maturity: 86_400n },
    reserves: [1000n, 2000n],
    pt_price: 9_500_000n,
    implied_rate: 400_000n,
    lp_total_supply: 3000n,
    exchange_rate: 1_050_000n,
    get_reference_value: 1_020_000n,
    get_reference_timestamp: 1_799_999_000n,
    maturity: 1_900_000_000n,
    settled_rate: null,
    total_supply: 777n,
    market: { pool: c.pool, manager: c.manager, sy: c.sy, pt: c.pt, yt: c.yt, underlying: market.underlying.sac },
    is_available: true,
    max_stale_seconds: 3600n,
    is_frozen: false,
    is_paused: false,
    accrued_yield_index: 1n,
    balance_of: 10n,
  }
  const reader = vi.fn(async (call: { contractId: string; functionName: string }) => {
    if (opts.fail?.(call.functionName, call.contractId)) throw new Error("HostError: boom")
    let value: unknown
    if (call.functionName === "accrued_fees") value = call.contractId === c.pool ? [10n, 20n] : [1n, 2n]
    else if (call.functionName === "total_supply") value = call.contractId === c.pt ? 555n : 666n
    else if (call.functionName in values) value = values[call.functionName]
    else value = 1n
    return { value, latestLedger: ledger(call.functionName, call.contractId), minResourceFee: "0" }
  })
  return reader as unknown as ContractReader & typeof reader
}

/** In-memory stand-in for the snapshots table: enforces primary key (pool, slot). */
function makeSql() {
  const rows = new Map<string, unknown[]>()
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?")
    expect(text).toMatch(/on conflict \(pool, slot\) do nothing/i)
    const key = `${values[0]}:${values[1]}`
    if (rows.has(key)) return []
    rows.set(key, values)
    return [{ pool: values[0] }]
  }) as unknown as Sql & ReturnType<typeof vi.fn>
  return { sql, rows }
}

const base = (reader: ContractReader, sql: Sql) => ({
  reader,
  sql,
  manifest,
  markets: async () => [market],
  now: () => CLOSE_TIME * 1000,
  ledgerCloseTime: async () => CLOSE_TIME,
})

describe("recordAll", () => {
  it("one row per market per slot: running twice in the same slot inserts once", async () => {
    const { sql, rows } = makeSql()
    const deps = base(makeReader(), sql)
    expect(await recordAll(deps)).toEqual({ recorded: 1, failed: [] })
    expect(await recordAll(deps)).toEqual({ recorded: 0, failed: [] })
    expect(rows.size).toBe(1)
    const [pool, slot, ledger] = [...rows.values()][0]
    expect(pool).toBe(c.pool)
    expect(slot).toBe(SLOT)
    expect(ledger).toBe(500)
  })

  it("stores exact bigint values as strings, fees summed over pool and manager", async () => {
    const { sql, rows } = makeSql()
    await recordAll(base(makeReader(), sql))
    const values = [...rows.values()][0]
    expect(values).toContain("400000") // implied rate
    expect(values).toContain("9500000") // pt price
    expect(values).toContain("1020000") // oracle rate
    expect(values).toContain("11") // protocol fees 10 + 1
    expect(values).toContain("22") // creator fees 20 + 2
    expect(values.every((v) => typeof v !== "bigint")).toBe(true)
  })

  it("a failed read stores nothing for that market and is reported", async () => {
    const { sql, rows } = makeSql()
    const reader = makeReader({ fail: (fn) => fn === "implied_rate" })
    const result = await recordAll(base(reader, sql))
    expect(result.recorded).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].pool).toBe(c.pool)
    expect(result.failed[0].error).toMatch(/implied rate/i)
    expect(rows.size).toBe(0)
    expect(sql).not.toHaveBeenCalled()
  })

  it("a failed accrued_fees read on the manager also stores nothing", async () => {
    const { sql } = makeSql()
    const reader = makeReader({ fail: (fn, id) => fn === "accrued_fees" && id === c.manager })
    const result = await recordAll(base(reader, sql))
    expect(result.failed).toHaveLength(1)
    expect(sql).not.toHaveBeenCalled()
  })

  it("all values come from one ledger: reads that straddle two ledgers are not stored", async () => {
    const { sql, rows } = makeSql()
    const reader = makeReader({ ledger: (fn) => (fn === "pt_price" ? 501 : 500) })
    const result = await recordAll(base(reader, sql))
    expect(result.recorded).toBe(0)
    expect(result.failed[0].error).toMatch(/ledger/i)
    expect(rows.size).toBe(0)
  })

  it("retries once the chain has settled on a single ledger", async () => {
    const { sql, rows } = makeSql()
    let attempt = 0
    const reader = makeReader({
      ledger: (fn) => {
        if (fn === "implied_rate") attempt++
        return attempt === 1 && fn === "pt_price" ? 501 : 500 + (attempt > 1 ? 1 : 0)
      },
    })
    const result = await recordAll(base(reader, sql))
    expect(result).toEqual({ recorded: 1, failed: [] })
    expect(rows.size).toBe(1)
  })

  it("refuses a ledger whose close time is more than an hour behind the clock", async () => {
    const { sql } = makeSql()
    const deps = { ...base(makeReader(), sql), now: () => (CLOSE_TIME + 7200) * 1000 }
    const result = await recordAll(deps)
    expect(result.recorded).toBe(0)
    expect(result.failed[0].error).toMatch(/stale/i)
  })

  it("a database error is reported by code only, never its message", async () => {
    const sql = vi.fn(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED postgres://user:secret@host/db"), { code: "ECONNREFUSED" })
    }) as unknown as Sql
    const result = await recordAll(base(makeReader(), sql))
    expect(result.failed[0].error).toContain("ECONNREFUSED")
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  it("rethrows a missing DATABASE_URL instead of reporting it as a failed market", async () => {
    const sql = vi.fn(async () => {
      throw new DatabaseConfigError()
    }) as unknown as Sql
    await expect(recordAll(base(makeReader(), sql))).rejects.toBeInstanceOf(DatabaseConfigError)
  })
})

describe("recordAll and the registry (R2-4)", () => {
  it("refreshes the registry first, then records the markets it resolves, a discovered one included", async () => {
    const { sql, rows } = makeSql()
    const order: string[] = []
    // A market the static manifest does not list: found by discovery, served by `markets`.
    const discovered = { ...market, marketId: "testnet-sta-discovered" }
    const result = await recordAll({
      ...base(makeReader(), sql),
      refreshRegistry: async () => {
        order.push("refresh")
      },
      markets: async () => {
        order.push("markets")
        return [discovered]
      },
    })
    expect(order).toEqual(["refresh", "markets"])
    expect(result).toEqual({ recorded: 1, failed: [] })
    expect([...rows.values()][0][0]).toBe(c.pool)
  })

  it("a failed refresh is logged and the run goes on with the cached verdicts", async () => {
    const { sql } = makeSql()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await recordAll({
      ...base(makeReader(), sql),
      refreshRegistry: async () => {
        throw new Error("getEvents: 503")
      },
    })
    expect(result).toEqual({ recorded: 1, failed: [] })
    expect(String(logged.mock.calls[0][0])).toMatch(/registry refresh failed: getEvents: 503/)
    logged.mockRestore()
  })

  it("a refresh past its time budget does not hold up recording; the refresh is given the deadline", async () => {
    const { sql } = makeSql()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    let deadline = 0
    const result = await recordAll({
      ...base(makeReader(), sql),
      registryBudgetMs: 20,
      refreshRegistry: (d: number) => {
        deadline = d
        return new Promise(() => {})
      },
    })
    expect(result).toEqual({ recorded: 1, failed: [] })
    expect(deadline).toBe(CLOSE_TIME * 1000 + 20)
    expect(String(logged.mock.calls[0][0])).toMatch(/time budget/)
    logged.mockRestore()
  })

  it("a refresh that fails after its budget ran out is logged, not left as an unhandled rejection (R2-41)", async () => {
    const { sql } = makeSql()
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    const result = await recordAll({
      ...base(makeReader(), sql),
      registryBudgetMs: 10,
      refreshRegistry: () => new Promise((_, reject) => setTimeout(() => reject(new Error("getEvents: 503")), 40)),
    })
    expect(result).toEqual({ recorded: 1, failed: [] })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(logged.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/after its time budget.*getEvents: 503/))
    logged.mockRestore()
  })

  it("a missing DATABASE_URL during the refresh is thrown, not logged", async () => {
    const { sql } = makeSql()
    const refreshRegistry = async () => {
      throw new DatabaseConfigError()
    }
    await expect(recordAll({ ...base(makeReader(), sql), refreshRegistry })).rejects.toBeInstanceOf(DatabaseConfigError)
  })
})

describe("ledgerCloseTimeOf", () => {
  const page = (sequence: number, closeTime: string) => ({ ledgers: [{ sequence, ledgerCloseTime: closeTime }] })
  const noSleep = vi.fn(async () => {})

  it("asks getLedgers for that one ledger and answers its close time in seconds", async () => {
    const getLedgers = vi.fn(async () => page(100, "1795269896"))
    expect(await ledgerCloseTimeOf({ getLedgers }, 100, { sleep: noSleep })).toBe(1_795_269_896)
    expect(getLedgers).toHaveBeenCalledWith({ startLedger: 100, pagination: { limit: 1 } })
  })

  it("asks again after a pause when the node does not have the ledger yet (dRPC: HTTP 400 Unknown block for the newest one)", async () => {
    const sleep = vi.fn(async () => {})
    const getLedgers = vi
      .fn()
      .mockRejectedValueOnce(new Error("Request failed with status code 400"))
      .mockResolvedValueOnce({ ledgers: [] })
      .mockResolvedValueOnce(page(100, "1795269896"))
    expect(await ledgerCloseTimeOf({ getLedgers }, 100, { sleep, pauseMs: 2_000 })).toBe(1_795_269_896)
    expect(getLedgers).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(2_000)
  })

  it("takes the newest ledger's close time from getLatestLedger when getLedgers cannot serve it yet, with no pause", async () => {
    const sleep = vi.fn(async () => {})
    const getLedgers = vi.fn(async (): Promise<ReturnType<typeof page>> => {
      throw new Error("Request failed with status code 400")
    })
    const getLatestLedger = vi.fn(async () => ({ sequence: 100, closeTime: "1795270346" }))
    expect(await ledgerCloseTimeOf({ getLedgers, getLatestLedger }, 100, { sleep })).toBe(1_795_270_346)
    expect(sleep).not.toHaveBeenCalled()
    // Another newest ledger, or one with no close time, is no answer for this one: ask again.
    getLatestLedger.mockResolvedValueOnce({ sequence: 101, closeTime: "1795270351" }).mockResolvedValueOnce({ sequence: 100, closeTime: "0" })
    getLedgers.mockRejectedValueOnce(new Error("Request failed with status code 400")).mockRejectedValueOnce(new Error("Request failed with status code 400")).mockResolvedValueOnce(page(100, "1795270346"))
    expect(await ledgerCloseTimeOf({ getLedgers, getLatestLedger }, 100, { sleep })).toBe(1_795_270_346)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it("stops at its deadline: no pause or attempt past it, and the last failure is reported", async () => {
    let clock = 1_000
    const sleep = vi.fn(async (ms: number) => {
      clock += ms
    })
    const getLedgers = vi.fn(async (): Promise<ReturnType<typeof page>> => {
      throw new Error("Request failed with status code 400")
    })
    // Room for one pause only: two attempts, then the deadline.
    await expect(ledgerCloseTimeOf({ getLedgers }, 100, { sleep, now: () => clock, pauseMs: 2_000, deadlineMs: 4_500 })).rejects.toThrow("status code 400")
    expect(getLedgers).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it("does not wait on a call that hangs: each call has its own timeout", async () => {
    const getLedgers = vi.fn(() => new Promise<ReturnType<typeof page>>(() => {}))
    const getLatestLedger = vi.fn(() => new Promise<{ sequence: number; closeTime: string }>(() => {}))
    await expect(ledgerCloseTimeOf({ getLedgers, getLatestLedger }, 100, { sleep: noSleep, attempts: 2, callTimeoutMs: 20 })).rejects.toThrow("timed out")
    expect(getLedgers).toHaveBeenCalledTimes(2)
  })

  it("gives up after its attempts with the last failure, never a made-up time", async () => {
    const getLedgers = vi.fn(async () => {
      throw new Error("Request failed with status code 400")
    })
    await expect(ledgerCloseTimeOf({ getLedgers }, 100, { sleep: noSleep, attempts: 3 })).rejects.toThrow("Request failed with status code 400")
    expect(getLedgers).toHaveBeenCalledTimes(3)
    const missing = vi.fn(async () => page(99, "1"))
    await expect(ledgerCloseTimeOf({ getLedgers: missing }, 100, { sleep: noSleep, attempts: 2 })).rejects.toThrow("ledger 100 not found on the RPC node")
  })
})
