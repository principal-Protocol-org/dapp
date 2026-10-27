// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { ActionId, ActionInput } from "../actions"
import { guardsFrom, minAfterSlippage, openGuards, parseOutput, type ActionOutput } from "../guards"

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
  it("non-sensitive actions need no guards", () => {
    expect(guardsFrom("claim_yield", input("claim_yield"), { kind: "amount", value: 0n }, 50n)).toEqual({ ok: true, guards: {} })
    const red: ActionOutput = { kind: "redeem", underlying_from_pt: 0n, underlying_from_yt: 0n }
    expect(guardsFrom("redeem", input("redeem"), red, 50n)).toEqual({ ok: true, guards: {} })
  })
})
