// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "@/lib/protocol/manifest"
import type { ContractReader } from "@/lib/protocol/reader"

vi.mock("server-only", () => ({}))

import { recordAll, SLOT_SECONDS } from "@/lib/server/recorder"
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
    is_fresh: true,
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

  it("a missing DATABASE_URL during the refresh is thrown, not logged", async () => {
    const { sql } = makeSql()
    const refreshRegistry = async () => {
      throw new DatabaseConfigError()
    }
    await expect(recordAll({ ...base(makeReader(), sql), refreshRegistry })).rejects.toBeInstanceOf(DatabaseConfigError)
  })
})
