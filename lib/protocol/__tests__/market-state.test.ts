// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { parseManifest } from "../manifest"
import { fetchMarketState } from "../market-state"
import type { ContractReader } from "../reader"
import type { ScArg } from "../stellar"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const c = market.contracts
const sac = market.underlying.sac

type Handler = unknown | ((args: ScArg[]) => unknown)
type Calls = { key: string; args: ScArg[] }[]

function fakeReader(table: Record<string, Handler>, calls: Calls = []): ContractReader {
  return (async <T,>({ contractId, functionName, args = [] }: { contractId: string; functionName: string; args?: ScArg[] }) => {
    const key = `${contractId}.${functionName}`
    calls.push({ key, args })
    if (!(key in table)) throw new Error(`no fixture for ${key}`)
    const h = table[key]
    const value = typeof h === "function" ? (h as (a: ScArg[]) => unknown)(args) : h
    if (value instanceof Error) throw value
    return { value: value as T, latestLedger: 777, minResourceFee: "100" }
  }) as ContractReader
}

const info = { pool: c.pool, manager: c.manager, sy: c.sy, pt: c.pt, yt: c.yt, underlying: sac }
const poolState = {
  pt_reserve: 500n,
  sy_reserve: 600n,
  total_lp: 400n,
  rate: 10_500_000n,
  exponent: 10n ** 18n,
  fee_rate: 3n,
  seconds_to_maturity: 86_400n,
}

function healthy(): Record<string, Handler> {
  return {
    [`${c.oracle}.get_reference_value`]: 10_500_000n,
    [`${c.oracle}.get_reference_timestamp`]: 1_790_000_000n,
    [`${c.oracle}.is_fresh`]: true,
    [`${c.manager}.maturity`]: BigInt(market.maturity),
    [`${c.manager}.settled_rate`]: null,
    [`${c.yt}.is_frozen`]: false,
    [`${c.yt}.accrued_yield_index`]: 952_380_952_381n,
    [`${c.pt}.total_supply`]: 1000n,
    [`${c.yt}.total_supply`]: 1000n,
    [`${c.pool}.pool_state`]: poolState,
    [`${c.pool}.reserves`]: [500n, 600n],
    [`${c.pool}.pt_price`]: 9_500_000n,
    [`${c.pool}.implied_rate`]: 600_000n,
    [`${c.pool}.lp_total_supply`]: 400n,
    [`${c.pool}.is_paused`]: false,
    [`${c.config}.tokenization_fee_bps`]: 10,
    [`${c.config}.yt_fee_bps`]: 20,
    [`${c.config}.swap_fee_tier_bps`]: 30,
    [`${c.config}.protocol_share_bps`]: 40,
    [`${c.config}.swap_fee_rate`]: 123n,
    [`${c.sy}.exchange_rate`]: 10_000_000n,
    [`${c.sy}.is_paused`]: false,
    [`${c.sy}.balance_of`]: 700n,
    [`${manifest.shared.riskControl}.is_paused`]: false,
    [`${manifest.shared.riskControl}.get_cb_limit`]: 1_000n,
    [`${manifest.shared.riskControl}.get_cb_volume`]: 100n,
    [`${manifest.shared.riskControl}.get_asset_limit`]: 2_000n,
    [`${manifest.shared.riskControl}.get_asset_volume`]: 200n,
    [`${c.router}.market`]: info,
  }
}

describe("fetchMarketState", () => {
  it("reads every market value as Live with its ledger", async () => {
    const s = await fetchMarketState(fakeReader(healthy()), manifest, market.marketId)
    expect(s.oracleRate).toEqual({ status: "live", value: 10_500_000n, ledger: 777 })
    expect(s.oracleTimestamp).toMatchObject({ status: "live", value: 1_790_000_000n })
    expect(s.oracleFresh).toMatchObject({ status: "live", value: true })
    expect(s.maturity).toMatchObject({ status: "live", value: BigInt(market.maturity) })
    expect(s.settledRate).toMatchObject({ status: "live", value: null })
    expect(s.ytFrozen).toMatchObject({ value: false })
    expect(s.ytAccruedIndex).toMatchObject({ value: 952_380_952_381n })
    expect(s.totalPt).toMatchObject({ value: 1000n })
    expect(s.totalYt).toMatchObject({ value: 1000n })
    expect(s.poolSeeded).toMatchObject({ value: true })
    expect(s.ptPrice).toMatchObject({ value: 9_500_000n })
    expect(s.impliedRate).toMatchObject({ value: 600_000n })
    expect(s.lpTotalSupply).toMatchObject({ value: 400n })
    expect(s.fees).toMatchObject({
      tokenizationBps: { value: 10n },
      ytBps: { value: 20n },
      swapTierBps: { value: 30n },
      protocolShareBps: { value: 40n },
    })
    expect(s.swapFeeRate).toMatchObject({ value: 123n })
    expect(s.exchangeRate).toMatchObject({ value: 10_000_000n })
    expect(s.syPaused).toMatchObject({ value: false })
    expect(s.poolPaused).toMatchObject({ value: false })
    expect(s.riskPaused).toMatchObject({ value: false })
    expect(s.cb.limit).toMatchObject({ value: 1_000n })
    expect(s.cb.assetVolume).toMatchObject({ value: 200n })
    expect(s.topology).toMatchObject({ status: "live", value: { matches: true, mismatches: [] } })
  })

  it("reads the SY the PrincipalManager holds, via balance_of(manager)", async () => {
    const calls: Calls = []
    const s = await fetchMarketState(fakeReader(healthy(), calls), manifest, market.marketId)
    expect(s.managerSy).toMatchObject({ status: "live", value: 700n })
    expect(calls.find((x) => x.key === `${c.sy}.balance_of`)?.args).toEqual([{ type: "address", value: c.manager }])
  })

  it("an unreadable manager SY balance is unavailable, not zero", async () => {
    const table = healthy()
    table[`${c.sy}.balance_of`] = new Error("rpc 429")
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.managerSy).toEqual({ status: "unavailable", error: "rpc 429" })
  })

  it("passes is_fresh(3600) as u64 and the underlying SAC as the risk-control asset key", async () => {
    const calls: Calls = []
    await fetchMarketState(fakeReader(healthy(), calls), manifest, market.marketId)
    expect(calls.find((x) => x.key.endsWith(".is_fresh"))?.args).toEqual([{ type: "u64", value: 3600 }])
    for (const fn of ["get_asset_limit", "get_asset_volume"]) {
      expect(calls.find((x) => x.key === `${manifest.shared.riskControl}.${fn}`)?.args).toEqual([
        { type: "address", value: sac },
      ])
    }
    expect(calls.find((x) => x.key === `${c.router}.market`)?.args).toEqual([{ type: "address", value: c.pool }])
  })

  it("unavailable read is Live unavailable not zero", async () => {
    const table = healthy()
    table[`${c.pt}.total_supply`] = new Error("rpc 429")
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.totalPt).toEqual({ status: "unavailable", error: "rpc 429" })
    expect(s.totalYt.status).toBe("live")
  })

  it("a wrongly typed value is unavailable, not coerced", async () => {
    const table = healthy()
    table[`${c.sy}.exchange_rate`] = "oops"
    table[`${c.sy}.is_paused`] = 0
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.exchangeRate.status).toBe("unavailable")
    expect(s.syPaused.status).toBe("unavailable")
  })

  it("settled_rate Some(rate) is live bigint", async () => {
    const table = healthy()
    table[`${c.manager}.settled_rate`] = 10_700_000n
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.settledRate).toMatchObject({ status: "live", value: 10_700_000n })
  })

  it("swap fee read at seconds to maturity", async () => {
    const calls: Calls = []
    const s = await fetchMarketState(fakeReader(healthy(), calls), manifest, market.marketId)
    expect(calls.find((x) => x.key === `${c.config}.swap_fee_rate`)?.args).toEqual([{ type: "u64", value: 86_400n }])
    expect(s.swapFeeRate).toMatchObject({ status: "live", value: 123n })
  })

  it("swap fee is unavailable (and never read) when pool_state is unavailable", async () => {
    const table = healthy()
    table[`${c.pool}.pool_state`] = new Error("oracle unreadable")
    const calls: Calls = []
    const s = await fetchMarketState(fakeReader(table, calls), manifest, market.marketId)
    expect(s.poolState.status).toBe("unavailable")
    expect(s.swapFeeRate.status).toBe("unavailable")
    expect(calls.some((x) => x.key.endsWith(".swap_fee_rate"))).toBe(false)
  })

  it("does not read pt_price or implied_rate on an unseeded pool", async () => {
    const table = healthy()
    table[`${c.pool}.reserves`] = [0n, 0n]
    const calls: Calls = []
    const s = await fetchMarketState(fakeReader(table, calls), manifest, market.marketId)
    expect(s.poolSeeded).toMatchObject({ status: "live", value: false })
    expect(s.ptPrice.status).toBe("unavailable")
    expect(s.impliedRate.status).toBe("unavailable")
    expect(calls.some((x) => x.key.endsWith(".pt_price") || x.key.endsWith(".implied_rate"))).toBe(false)
  })

  it("one empty reserve counts as unseeded", async () => {
    const table = healthy()
    table[`${c.pool}.reserves`] = [500n, 0n]
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.poolSeeded).toMatchObject({ value: false })
  })

  it("unreadable reserves leave the seeded flag and the price unavailable", async () => {
    const table = healthy()
    table[`${c.pool}.reserves`] = new Error("boom")
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.poolSeeded.status).toBe("unavailable")
    expect(s.ptPrice.status).toBe("unavailable")
  })

  it("topology mismatch is reported", async () => {
    const table = healthy()
    table[`${c.router}.market`] = { ...info, sy: "CSOMETHINGELSE", underlying: "CANOTHER" }
    table[`${c.manager}.maturity`] = BigInt(market.maturity) + 1n
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.topology).toMatchObject({
      status: "live",
      value: { matches: false, mismatches: ["sy", "underlying", "maturity"] },
    })
  })

  it("topology is unavailable when Router.market cannot be read", async () => {
    const table = healthy()
    table[`${c.router}.market`] = new Error("archived")
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.topology).toEqual({ status: "unavailable", error: "archived" })
  })

  it("topology is unavailable when maturity cannot be read", async () => {
    const table = healthy()
    table[`${c.manager}.maturity`] = new Error("rpc down")
    const s = await fetchMarketState(fakeReader(table), manifest, market.marketId)
    expect(s.topology.status).toBe("unavailable")
  })

  it("rejects an unknown market id", async () => {
    await expect(fetchMarketState(fakeReader(healthy()), manifest, "nope")).rejects.toThrow(/nope/)
  })
})
