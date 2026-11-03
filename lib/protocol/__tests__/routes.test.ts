// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { parseManifest } from "../manifest"
import { ACTION_META, invocationFor, type ActionId } from "../actions"
import type { ActionOutput } from "../guards"
import {
  describeHoldings,
  planRoute,
  resolveStep,
  routeHoldings,
  SINGLE_STEP,
  unwindFrom,
  type RouteContext,
  type RouteRequest,
  type StepPlan,
} from "../routes"

const m = parseManifest(structuredClone(testnetJson))
const market = m.markets[0]
const base: RouteRequest = {
  kind: "buy_pt",
  marketId: "m",
  source: "GSRC",
  amount: 100n,
  pay: "underlying",
  receive: "underlying",
  matured: false,
}
const ctx: RouteContext = {
  routerFunctions: [],
  buyYt: { syIn: 90n, depositUnderlying: 95n },
  keepYtSplit: { mintUnderlying: 40n, depositUnderlying: 60n },
}
const actions = (r: RouteRequest, c = ctx) => {
  const p = planRoute(r, c)
  if ("disabled" in p) throw new Error("disabled")
  return p.map((s) => s.action)
}

describe("routes match spec §4", () => {
  it("one row per kind", () => {
    expect(actions({ ...base, kind: "buy_pt" })).toEqual(["deposit", "buy_pt"])
    expect(actions({ ...base, kind: "buy_yt" })).toEqual(["deposit", "buy_yt", "withdraw"])
    expect(actions({ ...base, kind: "lp_keep_yt" })).toEqual(["mint", "deposit", "add_liquidity"])
    expect(actions({ ...base, kind: "lp_withdraw" })).toEqual(["remove_liquidity", "sell_pt", "withdraw"])
    expect(actions({ ...base, kind: "lp_withdraw", matured: true })).toEqual(["remove_liquidity", "redeem", "withdraw"])
    expect(actions({ ...base, kind: "split" })).toEqual(["mint"])
    expect(actions({ ...base, kind: "recombine" })).toEqual(["recombine", "withdraw"])
  })
  it("paying in SY skips the deposit, and receiving SY skips the withdraw", () => {
    expect(actions({ ...base, kind: "buy_pt", pay: "sy" })).toEqual(["buy_pt"])
    expect(actions({ ...base, kind: "buy_yt", pay: "sy" })).toEqual(["buy_yt"])
    expect(actions({ ...base, kind: "buy_yt", pay: "sy", receive: "underlying" })).toEqual(["buy_yt"])
    expect(actions({ ...base, kind: "buy_yt", pay: "underlying", receive: "sy" })).toEqual(["deposit", "buy_yt", "withdraw"])
    expect(actions({ ...base, kind: "sell_pt", receive: "sy" })).toEqual(["sell_pt"])
    expect(actions({ ...base, kind: "lp_withdraw", receive: "sy" })).toEqual(["remove_liquidity", "sell_pt"])
    expect(actions({ ...base, kind: "recombine", receive: "sy" })).toEqual(["recombine"])
  })
})

describe("lp_only (R4-7)", () => {
  it("an SY payer's route is the one add; a USDY payer deposits first", () => {
    expect(actions({ ...base, kind: "lp_only", pay: "sy" })).toEqual(["add_liquidity_sy"])
    expect(actions({ ...base, kind: "lp_only", pay: "underlying" })).toEqual(["deposit", "add_liquidity_sy"])
  })
})

describe("single-step functions", () => {
  it("a listed single-step function replaces the route", () => {
    const singleStep = { buy_pt: { fn: "swap_underlying_for_pt", action: "buy_pt_underlying" as unknown as ActionId } }
    const on = planRoute({ ...base, kind: "buy_pt" }, { ...ctx, routerFunctions: ["swap_underlying_for_pt"], singleStep })
    expect(on).toHaveLength(1)
    expect((on as StepPlan[])[0].action).toBe("buy_pt_underlying")
    const off = planRoute({ ...base, kind: "buy_pt" }, { ...ctx, routerFunctions: [], singleStep })
    expect(off).toHaveLength(2)
  })
})

describe("one-step Router functions (0004 Task 5, R4-3)", () => {
  /** The five names a 97ac23e manifest lists; the planner's own table, with no test override. */
  const FIVE = ["swap_underlying_for_pt", "swap_pt_for_underlying", "swap_underlying_for_yt", "swap_yt_for_underlying", "add_liquidity_keep_yt"]
  const listed: RouteContext = { ...ctx, routerFunctions: FIVE, keepYtMintSy: 62n }
  const plan = (r: RouteRequest, c: RouteContext = listed) => {
    const p = planRoute(r, c)
    if ("disabled" in p) throw new Error(p.disabled)
    return p
  }
  const FALLBACK = (sy: string, k: number) =>
    `You hold ${sy} SY, so this takes ${k} signatures: the one-signature trade would withdraw all your SY. Withdraw it first (Quick actions → Withdraw) to trade in one signature.`
  const DUST = (sy: string, k: number) =>
    `You hold ${sy} SY, so this takes ${k} signatures: the one-signature trade would withdraw all your SY. An amount this small cannot be withdrawn, so this trade keeps its multi-step route.`

  it("the table names the five functions, and the three that end with withdraw_all sweep SY", () => {
    expect(SINGLE_STEP).toEqual({
      buy_pt: { fn: "swap_underlying_for_pt", action: "buy_pt_underlying" },
      sell_pt: { fn: "swap_pt_for_underlying", action: "sell_pt_underlying", sweepsSy: true },
      buy_yt: { fn: "swap_underlying_for_yt", action: "buy_yt_underlying", sweepsSy: true },
      sell_yt: { fn: "swap_yt_for_underlying", action: "sell_yt_underlying", sweepsSy: true },
      lp_keep_yt: { fn: "add_liquidity_keep_yt", action: "add_liquidity_keep_yt" },
    })
  })

  it("with the five names listed, each kind paid or received in USDY is one step with its amounts", () => {
    expect(plan({ ...base, kind: "buy_pt" })).toEqual([{ action: "buy_pt_underlying", amount: { from: "input" }, gives: "USDY", takes: "PT" }])
    expect(plan({ ...base, kind: "sell_pt" })).toEqual([{ action: "sell_pt_underlying", amount: { from: "input" }, gives: "PT", takes: "USDY" }])
    expect(plan({ ...base, kind: "sell_yt" })).toEqual([{ action: "sell_yt_underlying", amount: { from: "input" }, gives: "YT", takes: "USDY" }])
    // R4-5: Buy YT signs the solver's deposit, the whole amount tokenized, not the spend typed.
    expect(plan({ ...base, kind: "buy_yt" })).toEqual([{ action: "buy_yt_underlying", amount: { from: "value", value: 95n }, gives: "USDY", takes: "YT" }])
    // R4-4: Keep YT deposits the whole input and mints the SY shares the dApp sized.
    expect(plan({ ...base, kind: "lp_keep_yt" })).toEqual([
      { action: "add_liquidity_keep_yt", amount: { from: "input" }, secondaryAmount: { from: "value", value: 62n }, gives: "USDY", takes: "LP + YT" },
    ])
    const r = { ...base, kind: "lp_keep_yt" as const }
    expect(resolveStep(plan(r)[0], r, [])).toEqual({ amount: 100n, secondaryAmount: 62n })
  })

  it("without the names, or paying / receiving SY, the old routes stand", () => {
    for (const c of [ctx, { ...listed, routerFunctions: [] }]) {
      expect(actions({ ...base, kind: "buy_pt" }, c)).toEqual(["deposit", "buy_pt"])
      expect(actions({ ...base, kind: "sell_pt" }, c)).toEqual(["sell_pt", "withdraw"])
      expect(actions({ ...base, kind: "buy_yt" }, c)).toEqual(["deposit", "buy_yt", "withdraw"])
      expect(actions({ ...base, kind: "sell_yt" }, c)).toEqual(["sell_yt", "withdraw"])
      expect(actions({ ...base, kind: "lp_keep_yt" }, c)).toEqual(["mint", "deposit", "add_liquidity"])
    }
    expect(actions({ ...base, kind: "buy_pt", pay: "sy" }, listed)).toEqual(["buy_pt"])
    expect(actions({ ...base, kind: "buy_yt", pay: "sy" }, listed)).toEqual(["buy_yt"])
    expect(actions({ ...base, kind: "sell_pt", receive: "sy" }, listed)).toEqual(["sell_pt"])
    expect(actions({ ...base, kind: "sell_yt", receive: "sy" }, listed)).toEqual(["sell_yt"])
    expect(planRoute({ ...base, kind: "lp_keep_yt", pay: "sy" }, listed)).toEqual({ disabled: expect.stringMatching(/needs USDY/) })
    // Only a listed name replaces its route.
    const one = { ...listed, routerFunctions: ["swap_underlying_for_pt"] }
    expect(actions({ ...base, kind: "buy_pt" }, one)).toEqual(["buy_pt_underlying"])
    expect(actions({ ...base, kind: "sell_pt" }, one)).toEqual(["sell_pt", "withdraw"])
  })

  it("R4-3: a known SY balance above zero keeps the three sweeping routes, with the reason on their first step", () => {
    const held = { ...listed, syBalance: 87n }
    const sellPt = plan({ ...base, kind: "sell_pt" }, held)
    expect(sellPt.map((p) => p.action)).toEqual(["sell_pt", "withdraw"])
    expect(sellPt[0].fallback).toBe(FALLBACK("0.0000087", 2))
    expect(sellPt[1].fallback).toBeUndefined()
    const buyYt = plan({ ...base, kind: "buy_yt" }, held)
    expect(buyYt.map((p) => p.action)).toEqual(["deposit", "buy_yt", "withdraw"])
    expect(buyYt[0].fallback).toBe(FALLBACK("0.0000087", 3))
    const sellYt = plan({ ...base, kind: "sell_yt" }, { ...listed, syBalance: 1_000n * 10_000_000n })
    expect(sellYt.map((p) => p.action)).toEqual(["sell_yt", "withdraw"])
    expect(sellYt[0].fallback).toBe(FALLBACK("1,000", 2))
    // Buy PT and Keep YT do not sweep SY: they stay one step whatever the wallet holds.
    expect(plan({ ...base, kind: "buy_pt" }, held)).toEqual([{ action: "buy_pt_underlying", amount: { from: "input" }, gives: "USDY", takes: "PT" }])
    expect(plan({ ...base, kind: "lp_keep_yt" }, held).map((p) => [p.action, p.fallback])).toEqual([["add_liquidity_keep_yt", undefined]])
  })

  it("final review 2: SY that withdraws to under 2 raw USDY cannot be withdrawn (its floor is 0), and the reason says so", () => {
    const SCALE = 10_000_000n
    const reason = (syBalance: bigint, exchangeRate?: bigint) =>
      plan({ ...base, kind: "sell_pt" }, { ...listed, syBalance, ...(exchangeRate !== undefined ? { exchangeRate } : {}) })[0].fallback
    expect(reason(1n, SCALE)).toBe(DUST("0.0000001", 2))
    expect(plan({ ...base, kind: "buy_yt" }, { ...listed, syBalance: 1n, exchangeRate: SCALE })[0].fallback).toBe(DUST("0.0000001", 3))
    // 2 raw SY at 0.9999999 USDY each withdraw to 1 raw USDY; at 1.0, to 2.
    expect(reason(2n, 9_999_999n)).toBe(DUST("0.0000002", 2))
    expect(reason(2n, SCALE)).toBe(FALLBACK("0.0000002", 2))
    // 1 raw SY at 2.0 USDY each withdraws to 2 raw USDY: it can be withdrawn.
    expect(reason(1n, 2n * SCALE)).toBe(FALLBACK("0.0000001", 2))
    // No SY rate read: the reason cannot tell, so it keeps the withdraw text.
    expect(reason(1n)).toBe(FALLBACK("0.0000001", 2))
  })

  it("the SY held is grouped like the other amounts", () => {
    expect(plan({ ...base, kind: "sell_yt" }, { ...listed, syBalance: 12_345_678_901_234n })[0].fallback).toBe(FALLBACK("1,234,567.8901234", 2))
  })

  it("R4-3: a zero or unknown SY balance plans the one step (the sy_balance gate checks the live balance)", () => {
    for (const c of [{ ...listed, syBalance: 0n }, listed]) {
      for (const kind of ["sell_pt", "buy_yt", "sell_yt"] as const) {
        const p = plan({ ...base, kind }, c)
        expect(p).toHaveLength(1)
        expect(p[0].fallback).toBeUndefined()
      }
    }
  })

  it("a one step whose amount is sized by the dApp is disabled until it is", () => {
    expect(planRoute({ ...base, kind: "buy_yt" }, { routerFunctions: FIVE })).toEqual({ disabled: expect.stringMatching(/Buy YT with USDY needs the amount of USDY to deposit first/) })
    expect(planRoute({ ...base, kind: "lp_keep_yt" }, { routerFunctions: FIVE })).toEqual({ disabled: expect.stringMatching(/needs the SY to mint first/) })
  })

  it("a fallback route stays plain data", () => {
    const p = plan({ ...base, kind: "buy_yt" }, { ...listed, syBalance: 5n })
    expect(JSON.parse(JSON.stringify(p, (_, x) => (typeof x === "bigint" ? String(x) : x)))[0].fallback).toBe(FALLBACK("0.0000005", 3))
  })
})

describe("resolveStep", () => {
  const out = (o: ActionOutput) => o
  it("step 2 amount comes from step 1's actual output", () => {
    const plan = planRoute({ ...base, kind: "buy_pt" }, ctx) as StepPlan[]
    expect(resolveStep(plan[0], base, [])).toEqual({ amount: 100n })
    expect(resolveStep(plan[1], base, [out({ kind: "amount", value: 97n })])).toEqual({ amount: 97n })
  })
  it("LP keep YT and LP withdraw pick fields and sums", () => {
    const keep = planRoute({ ...base, kind: "lp_keep_yt" }, ctx) as StepPlan[]
    const outs = [
      out({ kind: "mint", pt_minted: 40n, yt_minted: 40n, fee_shares: 0n }),
      out({ kind: "amount", value: 59n }),
    ]
    expect(resolveStep(keep[2], base, outs)).toEqual({ amount: 40n, secondaryAmount: 59n })
    const w = planRoute({ ...base, kind: "lp_withdraw" }, ctx) as StepPlan[]
    const wo = [out({ kind: "remove_liquidity", pt: 10n, sy: 5n }), out({ kind: "amount", value: 9n })]
    expect(resolveStep(w[2], base, wo)).toEqual({ amount: 14n })
  })
  it("buy YT uses the solved sy_in and checks the deposit produced enough", () => {
    const plan = planRoute({ ...base, kind: "buy_yt" }, ctx) as StepPlan[]
    expect(resolveStep(plan[1], base, [out({ kind: "amount", value: 90n })])).toEqual({ amount: 90n })
    expect(() => resolveStep(plan[1], base, [out({ kind: "amount", value: 89n })])).toThrow(/less SY/)
    expect(resolveStep(plan[2], base, [out({ kind: "amount", value: 90n }), out({ kind: "buy_yt", yt_out: 1n, sy_back: 3n })])).toEqual({ amount: 3n })
  })
  it("throws plain errors for a missing field or step", () => {
    const plan = planRoute({ ...base, kind: "buy_pt" }, ctx) as StepPlan[]
    expect(() => resolveStep(plan[1], base, [])).toThrow(/has not run/)
    expect(() => resolveStep(plan[1], base, [out({ kind: "remove_liquidity", pt: 1n, sy: 1n })])).toThrow(/did not report/)
  })
  it("matured LP withdraw unwraps only the removed SY", () => {
    const plan = planRoute({ ...base, kind: "lp_withdraw", matured: true }, ctx) as StepPlan[]
    const outs = [
      out({ kind: "remove_liquidity", pt: 10n, sy: 5n }),
      out({ kind: "redeem", underlying_from_pt: 1000n, underlying_from_yt: 7n }),
    ]
    expect(resolveStep(plan[2], base, outs)).toEqual({ amount: 5n })
  })
  it("plans are serializable data", () => {
    const enc = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $big: String(x) } : x))
    const dec = (j: string) => JSON.parse(j, (_, x) => (x && typeof x === "object" && "$big" in x ? BigInt(x.$big) : x))
    for (const kind of ["buy_pt", "buy_yt", "lp_keep_yt", "lp_withdraw", "recombine"] as const) {
      const plan = planRoute({ ...base, kind }, ctx) as StepPlan[]
      expect(dec(enc(plan))).toEqual(plan)
    }
  })
})

describe("no step is ever PrincipalManager.mint", () => {
  it("every action is known and mint is wrap_and_mint", () => {
    const kinds = ["buy_pt", "sell_pt", "buy_yt", "sell_yt", "lp_keep_yt", "lp_withdraw", "split", "recombine"] as const
    for (const kind of kinds)
      for (const matured of [false, true])
        for (const pay of ["underlying", "sy"] as const)
          for (const receive of ["underlying", "sy"] as const) {
            const p = planRoute({ ...base, kind, matured, pay, receive }, ctx)
            if ("disabled" in p) continue
            for (const s of p) expect(ACTION_META[s.action]).toBeDefined()
          }
    const inv = invocationFor(m, {
      action: "mint",
      marketId: market.marketId,
      source: "GCWFJKLE45TMVZS42TMIYKAORKGBWE74753YPOSCC5ESJR2G2UMBXBDB",
      amount: 1n,
      guards: { minOut: 1n },
      deadline: 1n,
    })
    expect(inv.functionName).toBe("wrap_and_mint")
  })
})

describe("route holdings (spec §4 interruption)", () => {
  /** One whole token: every Principal token, and the test USDY, have 7 decimals. */
  const S = 10_000_000n
  const usdy = { code: "USDY", decimals: 7 }
  const scaled: RouteContext = {
    routerFunctions: [],
    buyYt: { syIn: 90n * S, depositUnderlying: 95n * S },
    keepYtSplit: { mintUnderlying: 40n * S, depositUnderlying: 60n * S },
  }
  const plan = (r: RouteRequest) => planRoute(r, scaled) as StepPlan[]

  it("after a deposit the user holds the SY it produced, and unwind is one withdraw of it", () => {
    const r = { ...base, kind: "buy_pt" as const, amount: 1_000n * S }
    const h = routeHoldings(r, plan(r), [{ kind: "amount", value: 1_000n * S }], 1)
    expect(h).toEqual({ sy: 1_000n * S })
    expect(describeHoldings(h!, usdy)).toBe("You hold 1,000 SY")
    expect(describeHoldings(h!, usdy, "held")).toBe("You held 1,000 SY")
    expect(unwindFrom(h)).toEqual({
      available: true,
      amount: 1_000n * S,
      plan: { action: "withdraw", amount: { from: "value", value: 1_000n * S }, gives: "SY", takes: "USDY" },
    })
  })

  it("shows an exact small amount rather than rounding it to 0", () => {
    const r = { ...base, kind: "buy_pt" as const }
    const h = routeHoldings(r, plan(r), [{ kind: "amount", value: 87n }], 1)
    expect(describeHoldings(h!, usdy)).toBe("You hold 0.0000087 SY")
  })

  it("nets what later steps consumed: Buy YT leaves the YT and the SY refund (plus deposit dust)", () => {
    const r = { ...base, kind: "buy_yt" as const }
    // deposit 95 USDY -> 92 SY; buy_yt spends sy_in 90 SY -> 40 YT + 85 SY back: 2 + 85 SY left
    const outs: ActionOutput[] = [
      { kind: "amount", value: 92n * S },
      { kind: "buy_yt", yt_out: 40n * S, sy_back: 85n * S },
    ]
    const h = routeHoldings(r, plan(r), outs, 2)
    expect(h).toEqual({ yt: 40n * S, sy: 87n * S })
    expect(describeHoldings(h!, usdy)).toBe("You hold 40 YT and 87 SY")
    const u = unwindFrom(h)
    expect(u.available).toBe(false)
    if (!u.available) expect(u.reason).toMatch(/YT/)
  })

  it("matured LP withdraw keeps the removed SY after the redeem paid USDY", () => {
    const r = { ...base, kind: "lp_withdraw" as const, matured: true }
    const outs: ActionOutput[] = [
      { kind: "remove_liquidity", pt: 10n * S, sy: 5n * S },
      { kind: "redeem", underlying_from_pt: 1000n * S, underlying_from_yt: 0n },
    ]
    const h = routeHoldings(r, plan(r), outs, 2)
    expect(h).toEqual({ sy: 5n * S, underlying: 1000n * S })
    expect(describeHoldings(h!, usdy)).toBe("You hold 5 SY and 1,000 USDY")
    expect(unwindFrom(h)).toMatchObject({ available: true, amount: 5n * S })
  })

  it("PT and SY after removing liquidity cannot go back to USDY in one call", () => {
    const r = { ...base, kind: "lp_withdraw" as const }
    const h = routeHoldings(r, plan(r), [{ kind: "remove_liquidity", pt: 10n * S, sy: 5n * S }], 1)
    expect(h).toEqual({ pt: 10n * S, sy: 5n * S })
    expect(describeHoldings(h!, usdy)).toBe("You hold 10 PT and 5 SY")
    const u = unwindFrom(h)
    expect(u.available).toBe(false)
    if (!u.available) expect(u.reason).toMatch(/PT/)
  })

  it("after maturity the way out names Redeem in the PT tab, never a sale that has closed (with Continue and the SY withdraw)", () => {
    const r = { ...base, kind: "lp_withdraw" as const }
    const h = routeHoldings(r, plan(r), [{ kind: "remove_liquidity", pt: 10n * S, sy: 5n * S }], 1)
    const before = unwindFrom(h)
    if (before.available) throw new Error("expected no single call")
    expect(before.reason).toMatch(/sell the PT from the Trade tab/)
    const after = unwindFrom(h, { matured: true })
    expect(after).toEqual({
      available: false,
      reason:
        "Going back to USDY in one call works only from SY, and you also hold PT. Trading closed at maturity: continue the route, or redeem the PT with Redeem in the PT tab and withdraw the SY with Quick actions → Withdraw.",
    })
    // PT and YT together; LP stays a withdraw, which maturity does not close.
    const both = unwindFrom({ pt: S, yt: S }, { matured: true })
    if (both.available) throw new Error("expected no single call")
    expect(both.reason).toBe(
      "Going back to USDY in one call works only from SY, and you also hold PT and YT. Trading closed at maturity: continue the route, or redeem the PT and YT with Redeem in the PT tab.",
    )
    const lp = unwindFrom({ lp: S }, { matured: true })
    if (lp.available) throw new Error("expected no single call")
    expect(lp.reason).toBe("Going back to USDY in one call works only from SY, and you also hold LP. Continue the route, or withdraw the LP in the LP tab.")
    expect(lp.reason).not.toMatch(/sell/)
    // SY alone is still one withdraw after maturity.
    expect(unwindFrom({ sy: 5n * S }, { matured: true })).toMatchObject({ available: true, amount: 5n * S })
  })

  it("LP keep YT interrupted before add_liquidity lists PT, YT and SY", () => {
    const r = { ...base, kind: "lp_keep_yt" as const }
    const outs: ActionOutput[] = [
      { kind: "mint", pt_minted: 40n * S, yt_minted: 40n * S, fee_shares: 1n },
      { kind: "amount", value: 59n * S },
    ]
    expect(describeHoldings(routeHoldings(r, plan(r), outs, 2)!, usdy)).toBe("You hold 40 PT, 40 YT and 59 SY")
  })

  describe("one-transaction Router actions (0004 Task 3)", () => {
    const ONE_STEP: RouteContext["singleStep"] = {
      buy_pt: { fn: "swap_underlying_for_pt", action: "buy_pt_underlying" },
      sell_pt: { fn: "swap_pt_for_underlying", action: "sell_pt_underlying" },
      buy_yt: { fn: "swap_underlying_for_yt", action: "buy_yt_underlying" },
      sell_yt: { fn: "swap_yt_for_underlying", action: "sell_yt_underlying" },
      lp_keep_yt: { fn: "add_liquidity_keep_yt", action: "add_liquidity_keep_yt" },
    }
    const oneStep: RouteContext = { ...scaled, keepYtMintSy: 60n * S, routerFunctions: Object.values(ONE_STEP).map((x) => x!.fn), singleStep: ONE_STEP }
    const held = (kind: RouteRequest["kind"], out: ActionOutput, amount = 100n * S) => {
      const r = { ...base, kind, amount }
      const plans = planRoute(r, oneStep) as StepPlan[]
      expect(plans).toHaveLength(1)
      return routeHoldings(r, plans, [out], 1)
    }
    /** `action` after a step that left 300 USDY: shows the underlying the action takes or pays. */
    const afterUsdy = (action: ActionId, out: ActionOutput) => {
      const r = { ...base, amount: 100n * S }
      const plans: StepPlan[] = [
        { action: "withdraw", amount: { from: "value", value: 300n * S }, gives: "SY", takes: "USDY" },
        { action, amount: { from: "input" }, gives: "x", takes: "y" },
      ]
      return routeHoldings(r, plans, [{ kind: "amount", value: 300n * S }, out], 2)
    }

    it("Buy PT and Sell PT / YT: the underlying in or out, PT out or in", () => {
      expect(held("buy_pt", { kind: "amount", value: 98n * S })).toEqual({ pt: 98n * S })
      expect(held("sell_pt", { kind: "amount", value: 9n * S }, 10n * S)).toEqual({ underlying: 9n * S })
      expect(held("sell_yt", { kind: "amount", value: 3n * S }, 10n * S)).toEqual({ underlying: 3n * S })
      expect(afterUsdy("buy_pt_underlying", { kind: "amount", value: 98n * S })).toEqual({ pt: 98n * S, underlying: 200n * S })
      expect(afterUsdy("sell_pt_underlying", { kind: "amount", value: 9n * S })).toEqual({ underlying: 309n * S })
      expect(afterUsdy("sell_yt_underlying", { kind: "amount", value: 3n * S })).toEqual({ underlying: 303n * S })
    })

    it("Buy YT: the whole amount goes in and underlying_back comes back with the YT (R4-5)", () => {
      const out: ActionOutput = { kind: "buy_yt_underlying", yt_out: 40n * S, underlying_back: 85n * S }
      expect(held("buy_yt", out)).toEqual({ yt: 40n * S })
      expect(afterUsdy("buy_yt_underlying", out)).toEqual({ yt: 40n * S, underlying: 285n * S })
      expect(held("buy_yt", { kind: "buy_yt", yt_out: 40n * S, sy_back: 85n * S })).toBeUndefined()
    })

    it("Keep YT: LP and YT, and the PT the pool did not take (PT is minted 1:1 with YT)", () => {
      const out: ActionOutput = { kind: "keep_yt", pt_used: 38n * S, sy_used: 59n * S, lp: 50n * S, yt_minted: 40n * S }
      const h = held("lp_keep_yt", out)
      expect(h).toEqual({ pt: 2n * S, yt: 40n * S, lp: 50n * S })
      expect(describeHoldings(h!, usdy)).toBe("You hold 2 PT, 40 YT and 50 LP")
      expect(afterUsdy("add_liquidity_keep_yt", out)).toEqual({ pt: 2n * S, yt: 40n * S, lp: 50n * S, underlying: 200n * S })
      expect(held("lp_keep_yt", { kind: "add_liquidity", pt_used: 1n, sy_used: 1n, lp: 1n })).toBeUndefined()
    })
  })

  it("holdings after the add: the SY it did not keep (sy_used is split + sy_used) and the LP", () => {
    const r = { ...base, kind: "lp_only" as const, pay: "underlying" as const, amount: 100n * S }
    const plans = planRoute(r, scaled) as StepPlan[]
    const outs: ActionOutput[] = [{ kind: "amount", value: 100n * S }, { kind: "add_liquidity", pt_used: 40n * S, sy_used: 98n * S, lp: 50n * S }]
    expect(routeHoldings(r, plans, outs, 2)).toEqual({ sy: 2n * S, lp: 50n * S })
  })

  it("nothing confirmed: no holdings, and no unwind", () => {
    const r = { ...base, kind: "buy_pt" as const }
    const h = routeHoldings(r, plan(r), [], 0)
    expect(h).toEqual({})
    expect(describeHoldings(h!, usdy)).toBeUndefined()
    const u = unwindFrom(h)
    expect(u.available).toBe(false)
    if (!u.available) expect(u.reason).toMatch(/Nothing has moved/)
  })

  it("a confirmed step whose result could not be read makes the holdings unknown, never a guess", () => {
    const r = { ...base, kind: "buy_pt" as const }
    expect(routeHoldings(r, plan(r), [null], 1)).toBeUndefined()
    const u = unwindFrom(undefined)
    expect(u.available).toBe(false)
    if (!u.available) expect(u.reason).toMatch(/could not read/)
  })
})
