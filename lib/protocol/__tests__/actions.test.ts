// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { parseManifest } from "../manifest"
import { ACTION_META, invocationFor, type ActionId, type ActionInput } from "../actions"
import type { ScArg } from "../stellar"

const m = parseManifest(structuredClone(testnetJson))
const market = m.markets[0]
const { router, sy, pool } = market.contracts
const SRC = "GCWFJKLE45TMVZS42TMIYKAORKGBWE74753YPOSCC5ESJR2G2UMBXBDB"

const addr = (value: string): ScArg => ({ type: "address", value })
const i = (n: bigint): ScArg => ({ type: "i128", value: n })
const DL: ScArg = { type: "u64", value: 1_000n }

const base = (action: ActionId, extra: Partial<ActionInput> = {}): ActionInput => ({
  action,
  marketId: market.marketId,
  source: SRC,
  amount: 100n,
  guards: { minOut: 90n, minOut2: 80n, maxNetCost: 70n },
  deadline: 1_000n,
  ...extra,
})

const from = addr(SRC)
const p = addr(pool)

describe("invocationFor", () => {
  const table: [ActionId, string, string, ScArg[], Partial<ActionInput>?][] = [
    ["deposit", sy, "deposit", [from, i(100n), i(90n)]],
    ["withdraw", router, "unwrap", [from, p, i(100n), i(90n), DL]],
    ["mint", router, "wrap_and_mint", [from, p, i(100n), i(90n), DL]],
    ["buy_pt", router, "swap_sy_for_pt", [from, p, i(100n), i(90n), DL]],
    ["sell_pt", router, "swap_pt_for_sy", [from, p, i(100n), i(90n), DL]],
    ["buy_yt", router, "swap_sy_for_yt", [from, p, i(100n), i(90n), i(70n), DL]],
    ["sell_yt", router, "swap_yt_for_sy", [from, p, i(100n), i(90n), DL]],
    ["add_liquidity", router, "add_liquidity", [from, p, i(100n), i(55n), i(90n), DL], { secondaryAmount: 55n }],
    ["add_liquidity_sy", router, "add_liquidity_single_sy", [from, p, i(100n), i(90n), DL]],
    ["remove_liquidity", router, "remove_liquidity", [from, p, i(100n), i(90n), i(80n), DL]],
    ["recombine", router, "recombine", [from, p, i(100n), i(90n), DL]],
    ["claim_yield", router, "claim_yield", [from, p]],
    ["redeem", router, "redeem_at_maturity", [from, p, i(100n), i(0n)]],
    // The five one-transaction Router functions (0004 Task 3): `(from, pool, …)` as in router/src/lib.rs.
    ["buy_pt_underlying", router, "swap_underlying_for_pt", [from, p, i(100n), i(90n), DL]],
    ["sell_pt_underlying", router, "swap_pt_for_underlying", [from, p, i(100n), i(90n), DL]],
    ["buy_yt_underlying", router, "swap_underlying_for_yt", [from, p, i(100n), i(90n), i(70n), DL]],
    ["sell_yt_underlying", router, "swap_yt_for_underlying", [from, p, i(100n), i(90n), DL]],
    ["add_liquidity_keep_yt", router, "add_liquidity_keep_yt", [from, p, i(100n), i(55n), i(90n), DL], { secondaryAmount: 55n }],
  ]

  it("every action maps to the contract signature", () => {
    expect(table.map((r) => r[0]).sort()).toEqual(Object.keys(ACTION_META).sort())
    for (const [action, contractId, functionName, args, extra] of table) {
      expect(invocationFor(m, base(action, extra))).toEqual({ contractId, functionName, args })
    }
  })

  it("redeem passes the YT leg when given", () => {
    const inv = invocationFor(m, base("redeem", { secondaryAmount: 40n }))
    expect(inv.args[3]).toEqual(i(40n))
  })

  it("throws when a slippage-sensitive action has no guard", () => {
    expect(() => invocationFor(m, base("buy_pt", { guards: {} }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("buy_yt", { guards: { minOut: 1n } }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("remove_liquidity", { guards: { minOut: 1n } }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("buy_yt_underlying", { guards: { minOut: 1n } }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("buy_pt_underlying", { guards: {} }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("add_liquidity_keep_yt", { guards: {}, secondaryAmount: 5n }))).toThrow("missing floor")
  })

  it("never signs the exchange-rate preview syIn: it is review data only (R4-6)", () => {
    const inv = invocationFor(m, base("buy_yt_underlying", { guards: { minOut: 90n, maxNetCost: 70n, syIn: 99n } }))
    expect(inv.args).toEqual([from, p, i(100n), i(90n), i(70n), DL])
  })

  it("allows zero floors (open simulation guards)", () => {
    expect(() => invocationFor(m, base("buy_pt", { guards: { minOut: 0n } }))).not.toThrow()
  })

  it("requires the SY amount for add_liquidity", () => {
    expect(() => invocationFor(m, base("add_liquidity"))).toThrow(/secondaryAmount/)
  })

  it("requires the SY to mint for add_liquidity_keep_yt", () => {
    expect(() => invocationFor(m, base("add_liquidity_keep_yt"))).toThrow(/secondaryAmount/)
  })

  it("throws for an unknown market", () => {
    expect(() => invocationFor(m, base("claim_yield", { marketId: "nope" }))).toThrow(/unknown market/i)
  })

  it("meta flags", () => {
    expect(ACTION_META.claim_yield.slippageSensitive).toBe(false)
    expect(ACTION_META.redeem.slippageSensitive).toBe(false)
    expect(ACTION_META.deposit).toMatchObject({ slippageSensitive: true, hasDeadline: false, tab: "mint" })
    expect(ACTION_META.recombine.tab).toBe("redeem")
    expect(ACTION_META.add_liquidity_sy.tab).toBe("liquidity")
    expect(ACTION_META.buy_yt.tab).toBe("trade")
  })

  it("meta of the five one-transaction Router actions", () => {
    const sensitive = { slippageSensitive: true, hasDeadline: true }
    expect(ACTION_META.buy_pt_underlying).toEqual({ label: "Buy PT", ...sensitive, tab: "trade" })
    expect(ACTION_META.sell_pt_underlying).toEqual({ label: "Sell PT", ...sensitive, tab: "trade" })
    expect(ACTION_META.buy_yt_underlying).toEqual({ label: "Buy YT", ...sensitive, tab: "trade" })
    expect(ACTION_META.sell_yt_underlying).toEqual({ label: "Sell YT", ...sensitive, tab: "trade" })
    expect(ACTION_META.add_liquidity_keep_yt).toEqual({ label: "Add liquidity, keep YT", ...sensitive, tab: "liquidity" })
  })
})
