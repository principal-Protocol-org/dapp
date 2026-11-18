// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../../manifest"
import { SCALE } from "../../math"
import { pendingOf } from "../../position"
import { liveValue } from "../../reader"
import type { Manifest, Market } from "../../types"
import { tvlOf } from "../../rates"
import { indexFor, pendingYield } from "../../yield"
import { TVL_LABEL, fetchMarketDashboard, fetchProtocolState, pendingClaim } from "../protocol-state"
import { verifyCommand } from "../verify"
import { CREATOR, fakeReader, marketTable, ownMarket, sweepTable, TREASURY, type Calls, type Handler } from "./fake-reader"

const base = parseManifest(testnetJson)
const m1 = base.markets[0]
const ACCOUNT = CREATOR

/** A second market with its own SY, pool and escrow, sharing the rest; enough to sum totals. */
const m2: Market = {
  ...m1,
  marketId: "second",
  contracts: { ...m1.contracts, sy: "SY2", pool: "POOL2", recoveryEscrow: "ESCROW2" },
}
const two: Manifest = { ...base, markets: [m1, m2] }

describe("fetchProtocolState", () => {
  it("TVL equals total_underlying and includes escrow underlying, labelled", async () => {
    const state = await fetchProtocolState(fakeReader(marketTable(m1, base)), base, [m1.marketId])
    const d = state.markets[m1.marketId]
    expect(d.syUnderlying).toMatchObject({ status: "live", value: 2_230_113_029_038n, source: { contractId: m1.contracts.sy, fn: "total_underlying" } })
    expect(d.escrowUnderlying).toMatchObject({
      status: "live",
      value: 5_000_000n,
      source: { contractId: m1.underlying.sac, fn: "balance", args: [{ type: "address", value: m1.contracts.recoveryEscrow }] },
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
    // Both pools read the same reserves here: 600 SY at rate 1.0 + 500 PT at 0.95 / 1.05, floored.
    const pool = 600n + (500n * 9_500_000n) / 10_500_000n
    expect(pool).toBe(1052n)
    expect(state.totals.liquidity).toMatchObject({ status: "live", value: 2n * pool })
  })

  it("the reference total adds each market's tvl × oracle / SCALE (two markets)", async () => {
    const reader = fakeReader({ ...marketTable(m1, two), ...marketTable(m2, two, { totalUnderlying: 1_000n, escrow: 5_000_000n }) })
    const state = await fetchProtocolState(reader, two, [m1.marketId, m2.marketId])
    const ref1 = ((2_230_113_029_038n + 5_000_000n) * 10_500_000n) / SCALE // 2_341_623_930_489
    const ref2 = ((1_000n + 5_000_000n) * 10_500_000n) / SCALE // 5_251_050
    expect(ref1).toBe(2_341_623_930_489n)
    expect(ref2).toBe(5_251_050n)
    expect(state.markets[m1.marketId].tvlReference).toMatchObject({ status: "live", value: ref1 })
    expect(state.markets[m2.marketId].tvlReference).toMatchObject({ status: "live", value: ref2 })
    expect(state.totals.tvlReference).toMatchObject({ status: "live", value: 2_341_629_181_539n })
  })

  it("no markets: every total is unavailable, never a live 0", async () => {
    const state = await fetchProtocolState(fakeReader({}), base, [])
    expect(state.markets).toEqual({})
    for (const t of Object.values(state.totals)) expect(t).toEqual({ status: "unavailable", error: "no markets" })
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

  it("TVL is /app's tvlOf over the market state: total_underlying and the escrow balance are read once (D-8)", async () => {
    const calls: Calls = []
    const state = await fetchProtocolState(fakeReader(marketTable(m1, base), calls), base, [m1.marketId])
    const d = state.markets[m1.marketId]
    expect(d.tvl).toEqual(tvlOf(d))
    expect(calls.filter((x) => x.key === `${m1.contracts.sy}.total_underlying`)).toHaveLength(1)
    expect(calls.filter((x) => x.key === `${m1.underlying.sac}.balance`)).toHaveLength(1)
    expect(calls.some((x) => x.key === `${m1.contracts.sy}.balance_of`)).toBe(false)
  })

  it("fee buckets: protocol and creator, the pool's plus the manager's accrued_fees, in SY and in underlying at the exchange rate", async () => {
    const table = { ...marketTable(m1, base), [`${m1.contracts.sy}.exchange_rate`]: 10_500_000n }
    const d = (await fetchProtocolState(fakeReader(table), base, [m1.marketId])).markets[m1.marketId]
    expect(d.feeBuckets.protocol.sy).toMatchObject({ status: "live", value: 7_150_331n + 112_374_969n })
    expect(d.feeBuckets.creator.sy).toMatchObject({ status: "live", value: 28_601_503n + 449_499_977n })
    expect(d.feeBuckets.protocol.underlying).toMatchObject({ status: "live", value: ((7_150_331n + 112_374_969n) * 10_500_000n) / SCALE })
    expect(d.feeBuckets.creator.underlying).toMatchObject({ status: "live", value: ((28_601_503n + 449_499_977n) * 10_500_000n) / SCALE })
    const sy = d.feeBuckets.protocol.sy
    expect(sy.status === "live" && sy.sources?.map((x) => [x.contractId, x.fn])).toEqual([
      [m1.contracts.pool, "accrued_fees"],
      [m1.contracts.manager, "accrued_fees"],
    ])
    const usd = d.feeBuckets.creator.underlying
    expect(usd.status === "live" && usd.sources?.map((x) => x.fn)).toEqual(["accrued_fees", "accrued_fees", "exchange_rate"])
  })

  it("a fee bucket is unavailable when either accrued_fees read is, never a partial sum", async () => {
    const table = { ...marketTable(m1, base), [`${m1.contracts.manager}.accrued_fees`]: new Error("rpc down") }
    const d = (await fetchProtocolState(fakeReader(table), base, [m1.marketId])).markets[m1.marketId]
    for (const b of [d.feeBuckets.protocol, d.feeBuckets.creator]) {
      expect(b.sy).toMatchObject({ status: "unavailable" })
      expect(b.underlying).toMatchObject({ status: "unavailable" })
    }
  })

  it("fetchMarketDashboard reads one market's figures, the same ones the sweep gives", async () => {
    const reader = fakeReader(marketTable(m1, base))
    const one = await fetchMarketDashboard(reader, base, m1)
    const swept = (await fetchProtocolState(reader, base, [m1.marketId])).markets[m1.marketId]
    expect(one.tvl).toEqual(swept.tvl)
    expect(one.feeBuckets).toEqual(swept.feeBuckets)
    expect(one.feeRecipients).toEqual(swept.feeRecipients)
  })

  it("an unknown market id throws", async () => {
    await expect(fetchProtocolState(fakeReader({}), base, ["nope"])).rejects.toThrow(/nope/)
  })
})

describe("many markets (Review Focus 5)", () => {
  const N = 30
  const markets = Array.from({ length: N }, (_, i) => ownMarket(m1, i))
  const many: Manifest = { ...base, markets }
  const table = (over: Record<string, Handler> = {}) => sweepTable(markets, many, over)

  /** The views each market reads on its own contracts (and the escrow balance, and its Router entry). */
  const PER_MARKET = [
    "manager.maturity", "manager.settled_rate", "manager.is_paused", "manager.accrued_fees",
    "yt.is_frozen", "yt.accrued_yield_index", "yt.total_supply", "pt.total_supply",
    "pool.pool_state", "pool.reserves", "pool.pt_price", "pool.implied_rate", "pool.lp_total_supply", "pool.is_paused", "pool.accrued_fees",
    "config.tokenization_fee_bps", "config.yt_fee_bps", "config.swap_fee_tier_bps", "config.protocol_share_bps", "config.swap_fee_rate",
    "config.treasury", "config.creator", "config.protocol_admin",
    "sy.exchange_rate", "sy.is_paused", "sy.total_underlying",
    "sac.balance(escrow)", "router.market(pool)",
  ]
  /** Views of contracts every market shares: read once per refresh, not once per market. */
  const SHARED = [
    "oracle.get_reference_value", "oracle.get_reference_timestamp", "oracle.is_available", "oracle.max_stale_seconds",
    "oracle.max_deviation_bps", "oracle.get_primary_source", "oracle.get_fallback_source", "oracle.last_rejection",
    "risk.is_paused", "risk.get_cb_limit", "risk.get_cb_volume", "risk.get_asset_limit", "risk.get_asset_volume",
  ]
  const callKey = (x: { key: string; args: unknown[] }) => `${x.key}(${JSON.stringify(x.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))})`

  it("one sweep reads each market's own views once and each shared view once: 30 × 28 + 13 = 853 reads", async () => {
    expect(PER_MARKET).toHaveLength(28)
    expect(SHARED).toHaveLength(13)
    const calls: Calls = []
    const state = await fetchProtocolState(fakeReader(table(), calls), many, markets.map((m) => m.marketId))
    expect(Object.keys(state.markets)).toHaveLength(N)
    expect(calls).toHaveLength(N * PER_MARKET.length + SHARED.length)
    expect(calls).toHaveLength(853)
    // No call (contract, function, arguments) is made twice in one sweep.
    const keys = calls.map(callKey)
    expect(new Set(keys).size).toBe(keys.length)
    for (const m of markets) {
      expect(calls.filter((x) => x.key === `${m.contracts.sy}.total_underlying`)).toHaveLength(1)
      expect(calls.filter((x) => x.key.startsWith(`${m.contracts.pool}.`))).toHaveLength(7)
    }
    expect(calls.filter((x) => x.key === `${m1.contracts.oracle}.get_reference_value`)).toHaveLength(1)
    expect(calls.filter((x) => x.key === `${base.shared.riskControl}.get_cb_limit`)).toHaveLength(1)
    for (const m of markets) expect(state.markets[m.marketId].topology).toMatchObject({ status: "live", value: { matches: true } })
    expect(state.totals.tvl).toMatchObject({ status: "live", value: BigInt(N) * (2_230_113_029_038n + 5_000_000n) })
  })

  it("each refresh reads afresh: a second sweep makes the same 853 reads again", async () => {
    const calls: Calls = []
    const reader = fakeReader(table(), calls)
    const ids = markets.map((m) => m.marketId)
    await fetchProtocolState(reader, many, ids)
    await fetchProtocolState(reader, many, ids)
    expect(calls).toHaveLength(2 * 853)
  })

  it("one market failing turns every total Unavailable, naming it; the other 29 markets still read", async () => {
    const state = await fetchProtocolState(
      fakeReader(table({ [`SY17.total_underlying`]: new Error("rpc down"), [`POOL17.reserves`]: new Error("rpc down") })),
      many,
      markets.map((m) => m.marketId),
    )
    for (const t of [state.totals.tvl, state.totals.tvlReference, state.totals.liquidity]) {
      expect(t).toMatchObject({ status: "unavailable" })
      expect(t.status === "unavailable" && t.error).toMatch(/^m17: rpc down/)
    }
    expect(state.markets.m17.tvl.status).toBe("unavailable")
    expect(markets.filter((m) => state.markets[m.marketId].tvl.status === "live")).toHaveLength(N - 1)
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

  /** What `claim_yield` pays for the `ytTable` reads, whichever account asks (the fake keys by contract only). */
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

  it("is net of the YT fee, the same way /app shows it (pendingOf)", async () => {
    const reader = fakeReader(ytTable())
    const state = await fetchProtocolState(reader, base, [m1.marketId])
    const ms = state.markets[m1.marketId]
    const live = await pendingClaim(reader, m1, ACCOUNT, ms)
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
    const calls: Calls = []
    const live = await pendingClaim(fakeReader(ytTable(), calls), m1, c.router, ms)
    expect(live).toMatchObject({ status: "live", value: expected.net })
    expect(calls.filter((x) => x.key.startsWith(`${c.yt}.`)).every((x) => x.args[0]?.value === c.router)).toBe(true)
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
