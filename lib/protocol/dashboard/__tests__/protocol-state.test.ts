// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../../manifest"
import { SCALE } from "../../math"
import { pendingOf } from "../../position"
import { liveValue } from "../../reader"
import type { Manifest, Market } from "../../types"
import { indexFor, pendingYield } from "../../yield"
import { TVL_LABEL, fetchProtocolState, pendingClaim } from "../protocol-state"
import { verifyCommand } from "../verify"
import { fakeReader, type Handler } from "./fake-reader"

const base = parseManifest(testnetJson)
const m1 = base.markets[0]
const TREASURY = "GBBPZ6KVXM72MVKSZMAPMM6O4UN6XID22ZO7EOEXGCKFCOZTNVY3JVXG"
const CREATOR = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const ACCOUNT = CREATOR

/** A second market with its own SY, pool and escrow, sharing the rest; enough to sum totals. */
const m2: Market = {
  ...m1,
  marketId: "second",
  contracts: { ...m1.contracts, sy: "SY2", pool: "POOL2", recoveryEscrow: "ESCROW2" },
}
const two: Manifest = { ...base, markets: [m1, m2] }

const poolState = {
  pt_reserve: 500n,
  sy_reserve: 600n,
  total_lp: 400n,
  rate: 10_500_000n,
  exponent: 10n ** 18n,
  fee_rate: 3n,
  seconds_to_maturity: 86_400n,
}

/** Every view `fetchMarketState` and the dashboard read, for one market. */
function marketTable(market: Market, m: Manifest, over: { totalUnderlying?: unknown; escrow?: unknown; reserves?: unknown } = {}): Record<string, Handler> {
  const c = market.contracts
  const risk = m.shared.riskControl
  const sac = market.underlying.sac
  return {
    [`${c.oracle}.get_reference_value`]: 10_500_000n,
    [`${c.oracle}.get_reference_timestamp`]: 1_790_000_000n,
    [`${c.oracle}.is_available`]: true,
    [`${c.oracle}.max_stale_seconds`]: 3600n,
    [`${c.oracle}.max_deviation_bps`]: 1000,
    [`${c.oracle}.get_primary_source`]: new Uint8Array(32).fill(0xab),
    [`${c.oracle}.get_fallback_source`]: null,
    [`${c.oracle}.last_rejection`]: null,
    [`${c.manager}.maturity`]: BigInt(market.maturity),
    [`${c.manager}.settled_rate`]: null,
    [`${c.yt}.is_frozen`]: false,
    [`${c.yt}.accrued_yield_index`]: indexFor(10_500_000n),
    [`${c.pt}.total_supply`]: 1000n,
    [`${c.yt}.total_supply`]: 1000n,
    [`${c.pool}.pool_state`]: poolState,
    [`${c.pool}.reserves`]: over.reserves ?? [500n, 600n],
    [`${c.pool}.pt_price`]: 9_500_000n,
    [`${c.pool}.implied_rate`]: 600_000n,
    [`${c.pool}.lp_total_supply`]: 400n,
    [`${c.pool}.is_paused`]: false,
    [`${c.manager}.is_paused`]: false,
    [`${c.config}.tokenization_fee_bps`]: 10,
    [`${c.config}.yt_fee_bps`]: 20,
    [`${c.config}.swap_fee_tier_bps`]: 30,
    [`${c.config}.protocol_share_bps`]: 40,
    [`${c.config}.swap_fee_rate`]: 123n,
    [`${c.config}.treasury`]: TREASURY,
    [`${c.config}.creator`]: CREATOR,
    [`${c.config}.protocol_admin`]: CREATOR,
    [`${c.sy}.exchange_rate`]: 10_000_000n,
    [`${c.sy}.is_paused`]: false,
    [`${c.sy}.balance_of`]: 700n,
    [`${c.sy}.total_underlying`]: over.totalUnderlying ?? 2_230_113_029_038n,
    [`${sac}.balance`]: over.escrow ?? 5_000_000n,
    [`${risk}.is_paused`]: false,
    [`${risk}.get_cb_limit`]: 1_000n,
    [`${risk}.get_cb_volume`]: 100n,
    [`${risk}.get_asset_limit`]: 2_000n,
    [`${risk}.get_asset_volume`]: 200n,
    [`${c.router}.market`]: { pool: c.pool, manager: c.manager, sy: c.sy, pt: c.pt, yt: c.yt, underlying: sac },
  }
}

describe("fetchProtocolState", () => {
  it("TVL equals total_underlying and includes escrow underlying, labelled", async () => {
    const state = await fetchProtocolState(fakeReader(marketTable(m1, base)), base, [m1.marketId])
    const d = state.markets[m1.marketId]
    expect(d.syUnderlying).toMatchObject({ status: "live", value: 2_230_113_029_038n, source: { contractId: m1.contracts.sy, fn: "total_underlying" } })
    expect(d.escrowUnderlying).toMatchObject({
      status: "live",
      value: 5_000_000n,
      source: { contractId: m1.underlying.sac, fn: "balance", args: [{ type: "address", value: m1.contracts.recoveryEscrow, name: "id" }] },
    })
    expect(d.tvl).toMatchObject({ status: "live", value: 2_230_113_029_038n + 5_000_000n })
    expect(d.tvl.status === "live" && d.tvl.sources?.map((s) => s.fn)).toEqual(["total_underlying", "balance"])
    expect(TVL_LABEL).toMatch(/SY wrapper/)
    expect(TVL_LABEL).toMatch(/RecoveryEscrow.*included/)
  })

  it("with an empty escrow, TVL is exactly total_underlying", async () => {
    const state = await fetchProtocolState(fakeReader(marketTable(m1, base, { escrow: 0n })), base, [m1.marketId])
    expect(state.markets[m1.marketId].tvl).toMatchObject({ status: "live", value: 2_230_113_029_038n })
  })

  it("the escrow balance read verifies with balance --id <escrow>", async () => {
    const state = await fetchProtocolState(fakeReader(marketTable(m1, base)), base, [m1.marketId])
    const e = state.markets[m1.marketId].escrowUnderlying
    expect(e.status === "live" && verifyCommand("testnet", e.source!)).toMatch(new RegExp(`-- balance --id ${m1.contracts.recoveryEscrow}$`))
  })

  it("the reference value is tvl × oracle value / SCALE", async () => {
    const state = await fetchProtocolState(fakeReader(marketTable(m1, base)), base, [m1.marketId])
    const tvl = 2_230_113_029_038n + 5_000_000n
    expect(state.markets[m1.marketId].tvlReference).toMatchObject({ status: "live", value: (tvl * 10_500_000n) / SCALE })
    expect(state.totals.tvlReference).toMatchObject({ status: "live", value: (tvl * 10_500_000n) / SCALE })
  })

  it("keeps every MarketState figure (fetchMarketState is reused)", async () => {
    const state = await fetchProtocolState(fakeReader(marketTable(m1, base)), base, [m1.marketId])
    const d = state.markets[m1.marketId]
    expect(d.totalPt).toMatchObject({ status: "live", value: 1000n })
    expect(d.cb.limit).toMatchObject({ status: "live", value: 1000n })
    expect(d.topology).toMatchObject({ status: "live", value: { matches: true } })
  })

  it("reads the fee recipients", async () => {
    const state = await fetchProtocolState(fakeReader(marketTable(m1, base)), base, [m1.marketId])
    expect(state.markets[m1.marketId].feeRecipients).toMatchObject({
      treasury: { status: "live", value: TREASURY, source: { fn: "treasury" } },
      creator: { status: "live", value: CREATOR },
      protocolAdmin: { status: "live", value: CREATOR, source: { fn: "protocol_admin" } },
    })
  })

  it("liquidity is the pool value in underlying, 0 for an unseeded pool", async () => {
    const seeded = await fetchProtocolState(fakeReader(marketTable(m1, base)), base, [m1.marketId])
    // 600 × 1.0 + 500 × 0.95 / 1.05 (each term floored)
    expect(seeded.markets[m1.marketId].liquidity).toMatchObject({ status: "live", value: 600n + (500n * 9_500_000n) / 10_500_000n })
    const empty = await fetchProtocolState(fakeReader(marketTable(m1, base, { reserves: [0n, 0n] })), base, [m1.marketId])
    expect(empty.markets[m1.marketId].liquidity).toMatchObject({ status: "live", value: 0n })
  })

  it("totals sum every market", async () => {
    const reader = fakeReader({ ...marketTable(m1, two), ...marketTable(m2, two, { totalUnderlying: 1_000n, escrow: 5_000_000n }) })
    const state = await fetchProtocolState(reader, two, [m1.marketId, m2.marketId])
    // Both escrows hold the same SAC in this fake, so each reads 5_000_000.
    expect(state.totals.tvl).toMatchObject({ status: "live", value: 2_230_113_029_038n + 5_000_000n + 1_000n + 5_000_000n })
    expect(state.totals.escrowUnderlying).toMatchObject({ status: "live", value: 10_000_000n })
    expect(state.totals.liquidity).toMatchObject({ status: "live" })
  })

  it("the protocol total is unavailable when any market's is", async () => {
    const reader = fakeReader({ ...marketTable(m1, two), ...marketTable(m2, two, { totalUnderlying: new Error("rpc down") }) })
    const state = await fetchProtocolState(reader, two, [m1.marketId, m2.marketId])
    expect(state.markets[m1.marketId].tvl.status).toBe("live")
    expect(state.markets[m2.marketId].tvl.status).toBe("unavailable")
    expect(state.totals.tvl).toMatchObject({ status: "unavailable" })
    expect(state.totals.tvl.status === "unavailable" && state.totals.tvl.error).toMatch(/second.*rpc down/)
    expect(state.totals.tvlReference.status).toBe("unavailable")
    // Escrow balances were all read, so their total stands.
    expect(state.totals.escrowUnderlying.status).toBe("live")
  })

  it("amount totals are unavailable across different underlyings; the reference total stands", async () => {
    const other: Market = { ...m2, underlying: { ...m2.underlying, sac: "OTHER_SAC", code: "XYZ" } }
    const mixed: Manifest = { ...base, markets: [m1, other] }
    const reader = fakeReader({ ...marketTable(m1, mixed), ...marketTable(other, mixed) })
    const state = await fetchProtocolState(reader, mixed, [m1.marketId, other.marketId])
    expect(state.totals.tvl).toMatchObject({ status: "unavailable" })
    expect(state.totals.tvl.status === "unavailable" && state.totals.tvl.error).toMatch(/different underlying/)
    expect(state.totals.tvlReference.status).toBe("live")
  })

  it("an unknown market id throws", async () => {
    await expect(fetchProtocolState(fakeReader({}), base, ["nope"])).rejects.toThrow(/nope/)
  })
})

describe("pendingClaim", () => {
  const c = m1.contracts
  const ytTable = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
    ...marketTable(m1, base),
    [`${c.yt}.balance`]: 1_000_0000000n,
    [`${c.yt}.last_claimed_index`]: indexFor(10_000_000n),
    [`${c.yt}.pending_claim`]: 7_0000000n,
    ...over,
  })

  it("is net of the YT fee, the same way /app shows it (pendingOf)", async () => {
    const reader = fakeReader(ytTable())
    const state = await fetchProtocolState(reader, base, [m1.marketId])
    const ms = state.markets[m1.marketId]
    const live = await pendingClaim(reader, m1, ACCOUNT, ms)
    const expected = pendingYield({
      balance: 1_000_0000000n,
      lastClaimedIndex: indexFor(10_000_000n),
      pendingClaim: 7_0000000n,
      liveOracleRate: 10_500_000n,
      ytFrozen: false,
      accruedYieldIndex: indexFor(10_500_000n),
      ytFeeBps: 20n,
      exchangeRate: 10_000_000n,
    })
    expect(expected.fee).toBeGreaterThan(0n)
    expect(live).toMatchObject({ status: "live", value: expected.net })
    const app = pendingOf(ms, {
      yt: liveValue(1_000_0000000n, 1),
      ytLastClaimedIndex: liveValue(indexFor(10_000_000n), 1),
      ytPendingClaim: liveValue(7_0000000n, 1),
    })
    expect(app.status === "live" && app.value.net).toBe(expected.net)
  })

  it("records the YT reads so each re-reads with --account", async () => {
    const reader = fakeReader(ytTable())
    const ms = (await fetchProtocolState(reader, base, [m1.marketId])).markets[m1.marketId]
    const live = await pendingClaim(reader, m1, ACCOUNT, ms)
    const yt = live.status === "live" ? (live.sources ?? []).filter((s) => s.contractId === c.yt && s.args.length > 0) : []
    expect(yt.map((s) => s.fn).sort()).toEqual(["balance", "last_claimed_index", "pending_claim"])
    for (const s of yt) expect(verifyCommand("testnet", s)).toMatch(new RegExp(`-- ${s.fn} --account ${ACCOUNT}$`))
  })

  it("accepts a contract address", async () => {
    const reader = fakeReader(ytTable())
    const ms = (await fetchProtocolState(reader, base, [m1.marketId])).markets[m1.marketId]
    const live = await pendingClaim(reader, m1, c.router, ms)
    expect(live.status).toBe("live")
  })

  it("an invalid address is unavailable and reads nothing", async () => {
    const reader = fakeReader(ytTable())
    const ms = (await fetchProtocolState(reader, base, [m1.marketId])).markets[m1.marketId]
    const calls: { key: string }[] = []
    const live = await pendingClaim(fakeReader(ytTable(), calls as never), m1, "GNOTANADDRESS", ms)
    expect(live).toMatchObject({ status: "unavailable" })
    expect(live.status === "unavailable" && live.error).toMatch(/valid Stellar address/)
    expect(calls).toHaveLength(0)
  })

  it("a frozen YT index reads no oracle and reports no fake ledger 0 in its spread", async () => {
    const reader = fakeReader(ytTable({ [`${c.yt}.is_frozen`]: true, [`${c.oracle}.get_reference_value`]: new Error("stale") }))
    const ms = (await fetchProtocolState(reader, base, [m1.marketId])).markets[m1.marketId]
    const live = await pendingClaim(reader, m1, ACCOUNT, ms)
    expect(live.status).toBe("live")
    expect(live.status === "live" && live.ledgerSpread).toBeUndefined()
  })

  it("is unavailable when a YT read fails", async () => {
    const reader = fakeReader(ytTable({ [`${c.yt}.pending_claim`]: new Error("down") }))
    const ms = (await fetchProtocolState(reader, base, [m1.marketId])).markets[m1.marketId]
    expect((await pendingClaim(reader, m1, ACCOUNT, ms)).status).toBe("unavailable")
  })
})
