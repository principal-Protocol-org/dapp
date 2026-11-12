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
    ["sell_yt_underlying", router, "swap_yt_for_underlying", [from, p, i(100n), i(90n), DL]],
    // Keep YT at 665bb67 (R5-7): the desired PT and SY come after the SY to mint, as literals.
    [
      "add_liquidity_keep_yt",
      router,
      "add_liquidity_keep_yt",
      [from, p, i(100n), i(55n), i(40n), i(15n), i(90n), DL],
      { secondaryAmount: 55n, desired: { pt: 40n, sy: 15n } },
    ],
    // The flash swap (R5-2): `amount` is the budget, `secondaryAmount` is `sy_in`.
    ["buy_yt_flash", router, "flash_mint_yt", [from, p, i(60n), i(90n), i(70n), DL], { secondaryAmount: 60n }],
    [
      "buy_yt_flash_underlying",
      router,
      "flash_mint_yt_from_underlying",
      [from, p, i(60n), i(90n), i(70n), i(100n), i(80n), DL],
      { secondaryAmount: 60n },
    ],
    // LP only from USDY (R5-5) and the exit to USDY (R5-6).
    ["add_liquidity_underlying", router, "add_liquidity_single_underlying", [from, p, i(100n), i(60n), i(90n), DL], { secondaryAmount: 60n }],
    ["remove_liquidity_underlying", router, "remove_liquidity_to_underlying", [from, p, i(100n), i(90n), DL]],
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
    expect(() => invocationFor(m, base("buy_yt_flash", { guards: { minOut: 1n }, secondaryAmount: 5n }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("buy_yt_flash_underlying", { guards: { minOut: 1n, maxNetCost: 1n }, secondaryAmount: 5n }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("add_liquidity_underlying", { guards: {}, secondaryAmount: 5n }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("remove_liquidity_underlying", { guards: {} }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("buy_pt_underlying", { guards: {} }))).toThrow("missing floor")
    expect(() => invocationFor(m, base("add_liquidity_keep_yt", { guards: {}, secondaryAmount: 5n, desired: { pt: 1n, sy: 1n } }))).toThrow("missing floor")
  })

  it("the USDY flash signs a zero min_underlying_back (R5-3), but no other floor may be missing", () => {
    const inv = invocationFor(m, base("buy_yt_flash_underlying", { secondaryAmount: 60n, guards: { minOut: 90n, maxNetCost: 70n, minOut2: 0n } }))
    expect(inv.args[6]).toEqual(i(0n))
    expect(() => invocationFor(m, base("buy_yt_flash_underlying", { secondaryAmount: 60n, guards: { minOut: 90n, maxNetCost: 70n } }))).toThrow("missing floor")
  })

  it("allows zero floors (open simulation guards)", () => {
    expect(() => invocationFor(m, base("buy_pt", { guards: { minOut: 0n } }))).not.toThrow()
  })

  it("requires the SY amount for add_liquidity", () => {
    expect(() => invocationFor(m, base("add_liquidity"))).toThrow(/secondaryAmount/)
  })

  it("requires the SY to mint, and the desired PT and SY, for add_liquidity_keep_yt", () => {
    expect(() => invocationFor(m, base("add_liquidity_keep_yt", { desired: { pt: 1n, sy: 1n } }))).toThrow(/secondaryAmount/)
    expect(() => invocationFor(m, base("add_liquidity_keep_yt", { secondaryAmount: 5n }))).toThrow(/desired/)
  })

  it("requires the SY in (`sy_in`) for the flash and LP from USDY", () => {
    for (const action of ["buy_yt_flash", "buy_yt_flash_underlying", "add_liquidity_underlying"] as const) {
      expect(() => invocationFor(m, base(action))).toThrow(/secondaryAmount/)
    }
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

  it("meta of the 665bb67 actions (R5-2, R5-5, R5-6)", () => {
    const sensitive = { slippageSensitive: true, hasDeadline: true }
    expect(ACTION_META.buy_yt_flash).toEqual({ label: "Buy YT", ...sensitive, tab: "trade" })
    expect(ACTION_META.buy_yt_flash_underlying).toEqual({ label: "Buy YT", ...sensitive, tab: "trade" })
    expect(ACTION_META.add_liquidity_underlying).toEqual({ label: "Add liquidity (LP only)", ...sensitive, tab: "liquidity" })
    expect(ACTION_META.remove_liquidity_underlying).toEqual({ label: "Remove liquidity", ...sensitive, tab: "liquidity" })
    expect("buy_yt_underlying" in ACTION_META).toBe(false)
  })

  it("meta of the four one-transaction Router actions", () => {
    const sensitive = { slippageSensitive: true, hasDeadline: true }
    expect(ACTION_META.buy_pt_underlying).toEqual({ label: "Buy PT", ...sensitive, tab: "trade" })
    expect(ACTION_META.sell_pt_underlying).toEqual({ label: "Sell PT", ...sensitive, tab: "trade" })
    expect(ACTION_META.sell_yt_underlying).toEqual({ label: "Sell YT", ...sensitive, tab: "trade" })
    expect(ACTION_META.add_liquidity_keep_yt).toEqual({ label: "Add liquidity, keep YT", ...sensitive, tab: "liquidity" })
  })
})
