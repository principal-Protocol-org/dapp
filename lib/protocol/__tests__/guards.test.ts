// @vitest-environment node
import { describe, expect, it } from "vitest"
import { MAX_I128, type ActionId, type ActionInput } from "../actions"
import { guardsFrom, minAfterSlippage, openGuards, parseOutput, type ActionOutput } from "../guards"
import { SCALE } from "../math"

const input = (action: ActionId, amount = 100_0000000n): ActionInput => ({
  action,
  marketId: "m",
  source: "G",
  amount,
  guards: {},
  deadline: 0n,
})

describe("minAfterSlippage", () => {
  it("floors", () => {
    expect(minAfterSlippage(1_000_000n, 50n)).toBe(995_000n)
    expect(minAfterSlippage(999n, 50n)).toBe(994n)
  })
  it("rejects bad bps and non-positive output", () => {
    expect(() => minAfterSlippage(1n, -1n)).toThrow()
    expect(() => minAfterSlippage(1n, 10_000n)).toThrow()
    expect(() => minAfterSlippage(0n, 50n)).toThrow()
  })
})

describe("openGuards", () => {
  it("is zero for simulation, amount for buy_yt cost", () => {
    expect(openGuards("sell_pt", 5n)).toEqual({ minOut: 0n })
    expect(openGuards("remove_liquidity", 5n)).toEqual({ minOut: 0n, minOut2: 0n })
    expect(openGuards("buy_yt", 5n)).toEqual({ minOut: 0n, maxNetCost: 5n })
    expect(openGuards("claim_yield", 5n)).toEqual({})
    expect(openGuards("redeem", 5n)).toEqual({})
  })
  it("one-step Buy YT simulates with no cost bound at all (MAX_I128: the Router then asks for no SY back)", () => {
    expect(openGuards("buy_yt_underlying", 5n)).toEqual({ minOut: 0n, maxNetCost: MAX_I128 })
    for (const action of ["buy_pt_underlying", "sell_pt_underlying", "sell_yt_underlying", "add_liquidity_keep_yt"] as const) {
      expect(openGuards(action, 5n)).toEqual({ minOut: 0n })
    }
  })
})

describe("parseOutput", () => {
  it("parses each return shape", () => {
    expect(parseOutput("deposit", 5n)).toEqual({ kind: "amount", value: 5n })
    expect(parseOutput("mint", { pt_minted: 1n, yt_minted: 2n, fee_shares: 3n })).toEqual({
      kind: "mint",
      pt_minted: 1n,
      yt_minted: 2n,
      fee_shares: 3n,
    })
    expect(parseOutput("buy_yt", [9n, 4n])).toEqual({ kind: "buy_yt", yt_out: 9n, sy_back: 4n })
    expect(parseOutput("add_liquidity", [1n, 2n, 3n])).toEqual({ kind: "add_liquidity", pt_used: 1n, sy_used: 2n, lp: 3n })
    expect(parseOutput("add_liquidity_sy", [1n, 2n, 3n]).kind).toBe("add_liquidity")
    expect(parseOutput("remove_liquidity", [1n, 2n])).toEqual({ kind: "remove_liquidity", pt: 1n, sy: 2n })
    expect(parseOutput("redeem", { underlying_from_pt: 1n, underlying_from_yt: 2n })).toEqual({
      kind: "redeem",
      underlying_from_pt: 1n,
      underlying_from_yt: 2n,
    })
  })
  it("parses the shapes of the five one-transaction Router actions", () => {
    expect(parseOutput("buy_pt_underlying", 5n)).toEqual({ kind: "amount", value: 5n })
    expect(parseOutput("sell_pt_underlying", 6n)).toEqual({ kind: "amount", value: 6n })
    expect(parseOutput("sell_yt_underlying", 7n)).toEqual({ kind: "amount", value: 7n })
    // swap_underlying_for_yt -> (yt_minted, underlying_back)
    expect(parseOutput("buy_yt_underlying", [9n, 4n])).toEqual({ kind: "buy_yt_underlying", yt_out: 9n, underlying_back: 4n })
    // add_liquidity_keep_yt -> KeepYtResult { pt_used, sy_used, lp_minted, yt_minted }
    expect(parseOutput("add_liquidity_keep_yt", { pt_used: 1n, sy_used: 2n, lp_minted: 3n, yt_minted: 4n })).toEqual({
      kind: "keep_yt",
      pt_used: 1n,
      sy_used: 2n,
      lp: 3n,
      yt_minted: 4n,
    })
  })
  it("refuses any other shape for the five one-transaction Router actions", () => {
    expect(() => parseOutput("buy_pt_underlying", [5n])).toThrow()
    expect(() => parseOutput("sell_yt_underlying", 5)).toThrow()
    expect(() => parseOutput("buy_yt_underlying", 5n)).toThrow()
    expect(() => parseOutput("buy_yt_underlying", [1n])).toThrow()
    expect(() => parseOutput("buy_yt_underlying", [1n, 2n, 3n])).toThrow()
    expect(() => parseOutput("buy_yt_underlying", [1n, 2])).toThrow()
    expect(() => parseOutput("buy_yt_underlying", { yt_out: 1n, underlying_back: 2n })).toThrow()
    expect(() => parseOutput("add_liquidity_keep_yt", [1n, 2n, 3n, 4n])).toThrow()
    expect(() => parseOutput("add_liquidity_keep_yt", [1n, 2n, 3n])).toThrow()
    expect(() => parseOutput("add_liquidity_keep_yt", { pt_used: 1n, sy_used: 2n, lp_minted: 3n })).toThrow()
    expect(() => parseOutput("add_liquidity_keep_yt", { pt_used: 1n, sy_used: 2n, lp: 3n, yt_minted: 4n })).toThrow()
    expect(() => parseOutput("add_liquidity_keep_yt", { pt_used: 1n, sy_used: 2n, lp_minted: "3", yt_minted: 4n })).toThrow()
    expect(() => parseOutput("add_liquidity_keep_yt", null)).toThrow()
  })
  it("throws on anything malformed, never coerces", () => {
    expect(() => parseOutput("sell_pt", 5)).toThrow()
    expect(() => parseOutput("sell_pt", "5")).toThrow()
    expect(() => parseOutput("sell_pt", undefined)).toThrow()
    expect(() => parseOutput("sell_pt", null)).toThrow()
    expect(() => parseOutput("mint", { pt_minted: 1n, yt_minted: 2n })).toThrow()
    expect(() => parseOutput("mint", { pt_minted: 1n, yt_minted: 2n, fee_shares: "3" })).toThrow()
    expect(() => parseOutput("buy_yt", [1n])).toThrow()
    expect(() => parseOutput("buy_yt", [1n, 2n, 3n])).toThrow()
    expect(() => parseOutput("buy_yt", [1n, 2])).toThrow()
    expect(() => parseOutput("remove_liquidity", { pt: 1n, sy: 2n })).toThrow()
    expect(() => parseOutput("redeem", [1n, 2n])).toThrow()
  })
})

describe("guardsFrom", () => {
  it("applies the floor to single-output actions", () => {
    const r = guardsFrom("sell_pt", input("sell_pt"), { kind: "amount", value: 1_000_000n }, 50n)
    expect(r).toEqual({ ok: true, guards: { minOut: 995_000n } })
  })
  it("derives minOut from the right field", () => {
    const mint: ActionOutput = { kind: "mint", pt_minted: 2_000n, yt_minted: 1n, fee_shares: 1n }
    expect(guardsFrom("mint", input("mint"), mint, 100n)).toEqual({ ok: true, guards: { minOut: 1_980n } })
    const add: ActionOutput = { kind: "add_liquidity", pt_used: 1n, sy_used: 1n, lp: 1_000n }
    expect(guardsFrom("add_liquidity_sy", input("add_liquidity_sy"), add, 100n)).toEqual({
      ok: true,
      guards: { minOut: 990n },
    })
  })
  it("buy_yt guards: floor on yt_out, ceil on net cost", () => {
    const out: ActionOutput = { kind: "buy_yt", yt_out: 99_0000000n, sy_back: 95_0000000n }
    const r = guardsFrom("buy_yt", input("buy_yt", 100_0000000n), out, 50n)
    expect(r).toEqual({ ok: true, guards: { minOut: (99_0000000n * 9950n) / 10000n, maxNetCost: 50_250_000n } })
  })
  it("buy_yt ceils a non-exact net cost", () => {
    const out: ActionOutput = { kind: "buy_yt", yt_out: 1_000n, sy_back: 99n }
    const r = guardsFrom("buy_yt", input("buy_yt", 200n), out, 50n)
    // net 101 * 10050 / 10000 = 101.505 -> 102
    expect(r).toEqual({ ok: true, guards: { minOut: 995n, maxNetCost: 102n } })
  })
  it("buy_yt refuses when YT price is not positive", () => {
    for (const back of [100n, 150n]) {
      const r = guardsFrom("buy_yt", input("buy_yt", 100n), { kind: "buy_yt", yt_out: 10n, sy_back: back }, 50n)
      expect(r).toEqual({ ok: false, reason: "YT price is not positive — buying YT is not offered" })
    }
  })
  it("remove_liquidity sets two floors", () => {
    const out: ActionOutput = { kind: "remove_liquidity", pt: 1_000_000n, sy: 2_000_000n }
    expect(guardsFrom("remove_liquidity", input("remove_liquidity"), out, 50n)).toEqual({
      ok: true,
      guards: { minOut: 995_000n, minOut2: 1_990_000n },
    })
  })
  it("zero output refuses", () => {
    const r = guardsFrom("sell_pt", input("sell_pt"), { kind: "amount", value: 0n }, 50n)
    expect(r.ok).toBe(false)
  })
  it("negative output refuses", () => {
    expect(guardsFrom("sell_pt", input("sell_pt"), { kind: "amount", value: -5n }, 50n).ok).toBe(false)
  })
  it("floor that rounds to zero refuses", () => {
    expect(guardsFrom("sell_pt", input("sell_pt"), { kind: "amount", value: 1n }, 50n).ok).toBe(false)
    const rl: ActionOutput = { kind: "remove_liquidity", pt: 1_000_000n, sy: 1n }
    expect(guardsFrom("remove_liquidity", input("remove_liquidity"), rl, 50n).ok).toBe(false)
  })
  it("rejects invalid slippage", () => {
    const out: ActionOutput = { kind: "amount", value: 1_000_000n }
    expect(guardsFrom("sell_pt", input("sell_pt"), out, -1n).ok).toBe(false)
    expect(guardsFrom("sell_pt", input("sell_pt"), out, 10_000n).ok).toBe(false)
    expect(guardsFrom("sell_pt", input("sell_pt"), out, 0n)).toEqual({ ok: true, guards: { minOut: 1_000_000n } })
  })
  it("refuses an output whose shape does not match the action", () => {
    expect(guardsFrom("buy_yt", input("buy_yt"), { kind: "amount", value: 5n }, 50n).ok).toBe(false)
    expect(guardsFrom("sell_pt", { ...input("buy_pt") }, { kind: "amount", value: 5n }, 50n).ok).toBe(false)
  })
  it("one-step Buy PT, Sell PT and Sell YT floor their single output", () => {
    for (const action of ["buy_pt_underlying", "sell_pt_underlying", "sell_yt_underlying"] as const) {
      expect(guardsFrom(action, input(action), { kind: "amount", value: 1_000_000n }, 50n)).toEqual({ ok: true, guards: { minOut: 995_000n } })
      expect(guardsFrom(action, input(action), { kind: "amount", value: 1n }, 50n).ok).toBe(false)
    }
  })
  it("one-step Keep YT floors the LP minted, and only it", () => {
    const out: ActionOutput = { kind: "keep_yt", pt_used: 5n, sy_used: 6n, lp: 1_000n, yt_minted: 7n }
    expect(guardsFrom("add_liquidity_keep_yt", input("add_liquidity_keep_yt"), out, 100n)).toEqual({ ok: true, guards: { minOut: 990n } })
    expect(guardsFrom("add_liquidity_keep_yt", input("add_liquidity_keep_yt"), { ...out, lp: 0n }, 100n).ok).toBe(false)
    // An add_liquidity tuple is not Keep YT's result.
    const tuple: ActionOutput = { kind: "add_liquidity", pt_used: 1n, sy_used: 1n, lp: 1_000n }
    expect(guardsFrom("add_liquidity_keep_yt", input("add_liquidity_keep_yt"), tuple, 100n).ok).toBe(false)
  })

  describe("one-step Buy YT: max_net_cost in SY from the simulation and the exchange rate (R4-6)", () => {
    const buy = (amount: bigint) => input("buy_yt_underlying", amount)
    it("at an exchange rate of 1, sy_in is the amount and the bound is the SY not paid back", () => {
      const out: ActionOutput = { kind: "buy_yt_underlying", yt_out: 99_0000000n, underlying_back: 95_0000000n }
      const r = guardsFrom("buy_yt_underlying", buy(100_0000000n), out, 50n, { exchangeRate: SCALE })
      // net 5 SY · 1.005 = 5.025 SY
      expect(r).toEqual({ ok: true, guards: { minOut: (99_0000000n * 9950n) / 10000n, maxNetCost: 50_250_000n, syIn: 100_0000000n } })
    })
    it("at another rate: sy_in floors like the deposit, the SY back is rounded up, the bound is rounded up", () => {
      const out: ActionOutput = { kind: "buy_yt_underlying", yt_out: 123_456_789n, underlying_back: 900_000_001n }
      const r = guardsFrom("buy_yt_underlying", buy(1_000_000_000n), out, 50n, { exchangeRate: 10_500_000n })
      // sy_in = floor(1e9 · 1e7 / 1.05e7) = 952380952; sy_back_min = ceil(900000001 · 1e7 / 1.05e7) = 857142859;
      // net = 95238093; max_net_cost = ceil(95238093 · 10050 / 10000) = 95714284.
      expect(r).toEqual({ ok: true, guards: { minOut: 122_839_505n, maxNetCost: 95_714_284n, syIn: 952_380_952n } })
    })
    it("is refused, with the reason, without the exchange rate", () => {
      const out: ActionOutput = { kind: "buy_yt_underlying", yt_out: 99_0000000n, underlying_back: 95_0000000n }
      const r = guardsFrom("buy_yt_underlying", buy(100_0000000n), out, 50n)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/exchange rate/)
      for (const exchangeRate of [0n, -1n]) {
        const bad = guardsFrom("buy_yt_underlying", buy(100_0000000n), out, 50n, { exchangeRate })
        expect(bad.ok).toBe(false)
        if (!bad.ok) expect(bad.reason).toMatch(/exchange rate/)
      }
    })
    it("is refused when the YT costs nothing or less", () => {
      for (const back of [100_0000000n, 150_0000000n]) {
        const out: ActionOutput = { kind: "buy_yt_underlying", yt_out: 10_0000000n, underlying_back: back }
        const r = guardsFrom("buy_yt_underlying", buy(100_0000000n), out, 50n, { exchangeRate: SCALE })
        expect(r).toEqual({ ok: false, reason: "YT price is not positive — buying YT is not offered" })
      }
    })
    it("is refused when the YT floor rounds to zero", () => {
      const out: ActionOutput = { kind: "buy_yt_underlying", yt_out: 1n, underlying_back: 95_0000000n }
      expect(guardsFrom("buy_yt_underlying", buy(100_0000000n), out, 50n, { exchangeRate: SCALE }).ok).toBe(false)
    })
    it("refuses the two-step Buy YT's result shape", () => {
      const out: ActionOutput = { kind: "buy_yt", yt_out: 99n, sy_back: 95n }
      expect(guardsFrom("buy_yt_underlying", buy(100n), out, 50n, { exchangeRate: SCALE }).ok).toBe(false)
    })
  })
  it("the exchange rate changes no other action's floors", () => {
    const out: ActionOutput = { kind: "buy_yt", yt_out: 99_0000000n, sy_back: 95_0000000n }
    const without = guardsFrom("buy_yt", input("buy_yt", 100_0000000n), out, 50n)
    expect(guardsFrom("buy_yt", input("buy_yt", 100_0000000n), out, 50n, { exchangeRate: 10_500_000n })).toEqual(without)
  })
  it("non-sensitive actions need no guards", () => {
    expect(guardsFrom("claim_yield", input("claim_yield"), { kind: "amount", value: 0n }, 50n)).toEqual({ ok: true, guards: {} })
    const red: ActionOutput = { kind: "redeem", underlying_from_pt: 0n, underlying_from_yt: 0n }
    expect(guardsFrom("redeem", input("redeem"), red, 50n)).toEqual({ ok: true, guards: {} })
  })
})
