// @vitest-environment node
import { describe, expect, it } from "vitest"
import { type ActionId, type ActionInput } from "../actions"
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
  it("the flash simulates with the whole budget as its cost bound, in SY (R5-3)", () => {
    expect(openGuards("buy_yt_flash", 5n)).toEqual({ minOut: 0n, maxNetCost: 5n })
    // USDY payer: the budget is the SY its deposit produces, so it needs the exchange rate.
    expect(openGuards("buy_yt_flash_underlying", 1_000_000_000n, { exchangeRate: SCALE })).toEqual({ minOut: 0n, maxNetCost: 1_000_000_000n, minOut2: 0n })
    expect(openGuards("buy_yt_flash_underlying", 1_000_000_000n, { exchangeRate: 10_500_000n })).toEqual({
      minOut: 0n,
      maxNetCost: 952_380_952n,
      minOut2: 0n,
    })
  })
  it("the USDY flash is refused without the exchange rate", () => {
    expect(() => openGuards("buy_yt_flash_underlying", 5n)).toThrow(/exchange rate/)
    expect(() => openGuards("buy_yt_flash_underlying", 5n, { exchangeRate: 0n })).toThrow(/exchange rate/)
  })
  it("the new one-step actions simulate with one zero floor", () => {
    for (const action of ["buy_pt_underlying", "sell_pt_underlying", "sell_yt_underlying", "add_liquidity_keep_yt", "add_liquidity_underlying", "remove_liquidity_underlying"] as const) {
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
  it("parses the shapes of the eight one-transaction Router actions", () => {
    expect(parseOutput("buy_pt_underlying", 5n)).toEqual({ kind: "amount", value: 5n })
    expect(parseOutput("sell_pt_underlying", 6n)).toEqual({ kind: "amount", value: 6n })
    expect(parseOutput("sell_yt_underlying", 7n)).toEqual({ kind: "amount", value: 7n })
    // flash_mint_yt -> (yt_out, net_cost); flash_mint_yt_from_underlying -> (yt_out, net_cost, underlying_back)
    expect(parseOutput("buy_yt_flash", [9n, 4n])).toEqual({ kind: "flash_yt", yt_out: 9n, net_cost: 4n })
    expect(parseOutput("buy_yt_flash_underlying", [9n, 4n, 7n])).toEqual({ kind: "flash_yt_underlying", yt_out: 9n, net_cost: 4n, underlying_back: 7n })
    // add_liquidity_single_underlying -> (pt_used, sy_used, lp); remove_liquidity_to_underlying -> i128
    expect(parseOutput("add_liquidity_underlying", [1n, 2n, 3n])).toEqual({ kind: "add_liquidity", pt_used: 1n, sy_used: 2n, lp: 3n })
    expect(parseOutput("remove_liquidity_underlying", 8n)).toEqual({ kind: "amount", value: 8n })
    // add_liquidity_keep_yt -> KeepYtResult { pt_used, sy_used, lp_minted, yt_minted }
    expect(parseOutput("add_liquidity_keep_yt", { pt_used: 1n, sy_used: 2n, lp_minted: 3n, yt_minted: 4n })).toEqual({
      kind: "keep_yt",
      pt_used: 1n,
      sy_used: 2n,
      lp: 3n,
      yt_minted: 4n,
    })
  })
  it("refuses any other shape for the eight one-transaction Router actions", () => {
    expect(() => parseOutput("buy_pt_underlying", [5n])).toThrow()
    expect(() => parseOutput("sell_yt_underlying", 5)).toThrow()
    expect(() => parseOutput("buy_yt_flash", 5n)).toThrow()
    expect(() => parseOutput("buy_yt_flash", [1n])).toThrow()
    expect(() => parseOutput("buy_yt_flash", [1n, 2n, 3n])).toThrow()
    expect(() => parseOutput("buy_yt_flash", [1n, 2])).toThrow()
    expect(() => parseOutput("buy_yt_flash", { yt_out: 1n, net_cost: 2n })).toThrow()
    expect(() => parseOutput("buy_yt_flash_underlying", [1n, 2n])).toThrow()
    expect(() => parseOutput("buy_yt_flash_underlying", [1n, 2n, 3n, 4n])).toThrow()
    expect(() => parseOutput("buy_yt_flash_underlying", [1n, 2n, "3"])).toThrow()
    expect(() => parseOutput("buy_yt_flash_underlying", 5n)).toThrow()
    expect(() => parseOutput("remove_liquidity_underlying", [1n])).toThrow()
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
      expect(r).toEqual({ ok: false, reason: "The YT price is not positive, so buying YT is not offered." })
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

  describe("flash Buy YT: max_net_cost from the simulated net cost, capped at the budget (R5-3)", () => {
    const flash = (amount: bigint) => input("buy_yt_flash", amount)
    const flashUsdy = (amount: bigint) => input("buy_yt_flash_underlying", amount)
    it("SY payer: net cost plus the slippage margin, and the YT floor", () => {
      const out: ActionOutput = { kind: "flash_yt", yt_out: 99_0000000n, net_cost: 5_0000000n }
      // 5 SY · 1.005 = 5.025 SY, well inside the 100 SY budget
      expect(guardsFrom("buy_yt_flash", flash(100_0000000n), out, 50n)).toEqual({
        ok: true,
        guards: { minOut: (99_0000000n * 9950n) / 10000n, maxNetCost: 50_250_000n },
      })
    })
    it("never exceeds the budget, so the pool cannot take SY the wallet held before", () => {
      const out: ActionOutput = { kind: "flash_yt", yt_out: 99_0000000n, net_cost: 99_8000000n }
      // 99.8 · 1.005 = 100.299 SY: capped at the 100 SY budget
      const r = guardsFrom("buy_yt_flash", flash(100_0000000n), out, 50n)
      expect(r).toMatchObject({ ok: true, guards: { maxNetCost: 100_0000000n } })
    })
    it("USDY payer at an exchange rate of 1: budget SY is the amount, minOut2 is what the unspent SY unwraps to", () => {
      const out: ActionOutput = { kind: "flash_yt_underlying", yt_out: 99_0000000n, net_cost: 5_0000000n, underlying_back: 95_0000000n }
      const r = guardsFrom("buy_yt_flash_underlying", flashUsdy(100_0000000n), out, 50n, { exchangeRate: SCALE })
      // maxNetCost 5.025 SY; minOut2 = previewWithdraw(100 − 5.025 SY) = 94.975
      expect(r).toEqual({ ok: true, guards: { minOut: (99_0000000n * 9950n) / 10000n, maxNetCost: 50_250_000n, minOut2: 949_750_000n } })
    })
    it("USDY payer at another rate: the budget floors like the deposit, minOut2 floors like the withdraw", () => {
      const out: ActionOutput = { kind: "flash_yt_underlying", yt_out: 123_456_789n, net_cost: 95_238_093n, underlying_back: 900_000_001n }
      const r = guardsFrom("buy_yt_flash_underlying", flashUsdy(1_000_000_000n), out, 50n, { exchangeRate: 10_500_000n })
      // budget = floor(1e9 · 1e7 / 1.05e7) = 952380952; max_net_cost = ceil(95238093 · 10050 / 10000) = 95714284;
      // minOut2 = floor((952380952 − 95714284) · 1.05) = 899500001.
      expect(r).toEqual({ ok: true, guards: { minOut: 122_839_505n, maxNetCost: 95_714_284n, minOut2: 899_500_001n } })
    })
    it("USDY payer: the cap leaves nothing to come back, and then min_underlying_back is 0 (the one zero floor)", () => {
      const out: ActionOutput = { kind: "flash_yt_underlying", yt_out: 99_0000000n, net_cost: 99_9000000n, underlying_back: 1n }
      expect(guardsFrom("buy_yt_flash_underlying", flashUsdy(100_0000000n), out, 50n, { exchangeRate: SCALE })).toMatchObject({
        ok: true,
        guards: { maxNetCost: 100_0000000n, minOut2: 0n },
      })
    })
    it("the USDY flash is refused, with the reason, without the exchange rate", () => {
      const out: ActionOutput = { kind: "flash_yt_underlying", yt_out: 99_0000000n, net_cost: 5_0000000n, underlying_back: 95_0000000n }
      const r = guardsFrom("buy_yt_flash_underlying", flashUsdy(100_0000000n), out, 50n)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/exchange rate/)
      for (const exchangeRate of [0n, -1n]) {
        const bad = guardsFrom("buy_yt_flash_underlying", flashUsdy(100_0000000n), out, 50n, { exchangeRate })
        expect(bad.ok).toBe(false)
        if (!bad.ok) expect(bad.reason).toMatch(/exchange rate/)
      }
    })
    it("is refused when the YT is free or paid for (net_cost <= 0: PT at or above par)", () => {
      for (const net_cost of [0n, -1n, -5_0000000n]) {
        const sy: ActionOutput = { kind: "flash_yt", yt_out: 10_0000000n, net_cost }
        expect(guardsFrom("buy_yt_flash", flash(100_0000000n), sy, 50n)).toEqual({ ok: false, reason: "The YT price is not positive, so buying YT is not offered." })
        const usdy: ActionOutput = { kind: "flash_yt_underlying", yt_out: 10_0000000n, net_cost, underlying_back: 1n }
        expect(guardsFrom("buy_yt_flash_underlying", flashUsdy(100_0000000n), usdy, 50n, { exchangeRate: SCALE })).toEqual({
          ok: false,
          reason: "The YT price is not positive, so buying YT is not offered.",
        })
      }
    })
    it("is refused when the YT floor rounds to zero", () => {
      const out: ActionOutput = { kind: "flash_yt", yt_out: 1n, net_cost: 5_0000000n }
      expect(guardsFrom("buy_yt_flash", flash(100_0000000n), out, 50n).ok).toBe(false)
    })
    it("refuses the other result shapes", () => {
      expect(guardsFrom("buy_yt_flash", flash(100n), { kind: "buy_yt", yt_out: 99n, sy_back: 95n }, 50n).ok).toBe(false)
      const usdy: ActionOutput = { kind: "flash_yt_underlying", yt_out: 99n, net_cost: 5n, underlying_back: 1n }
      expect(guardsFrom("buy_yt_flash", flash(100n), usdy, 50n).ok).toBe(false)
    })
  })
  it("LP only from USDY and the exit to USDY floor their one output", () => {
    const add: ActionOutput = { kind: "add_liquidity", pt_used: 1n, sy_used: 2n, lp: 1_000_000n }
    expect(guardsFrom("add_liquidity_underlying", input("add_liquidity_underlying"), add, 50n)).toEqual({ ok: true, guards: { minOut: 995_000n } })
    const exit: ActionOutput = { kind: "amount", value: 1_000_000n }
    expect(guardsFrom("remove_liquidity_underlying", input("remove_liquidity_underlying"), exit, 50n)).toEqual({ ok: true, guards: { minOut: 995_000n } })
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
