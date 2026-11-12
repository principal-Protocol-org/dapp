// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { parseManifest } from "../manifest"
import { ACTION_META, invocationFor, type ActionId } from "../actions"
import type { ActionOutput } from "../guards"
import { previewDeposit } from "../previews"
import {
  describeHoldings,
  planRoute,
  resolveStep,
  routeHoldings,
  FLASH_BUY_YT,
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

describe("one-step Router functions (0004 Task 5; 0005 Task 3: R5-2, R5-4, R5-5, R5-6)", () => {
  /** The five names a 97ac23e manifest lists; the planner's own table, with no test override. */
  const FIVE = ["swap_underlying_for_pt", "swap_pt_for_underlying", "swap_underlying_for_yt", "swap_yt_for_underlying", "add_liquidity_keep_yt"]
  /** What a 665bb67 manifest adds: the two flash Buy YTs and LP in and out of USDY in one call. */
  const NEW = ["flash_mint_yt", "flash_mint_yt_from_underlying", "add_liquidity_single_underlying", "remove_liquidity_to_underlying"]
  const XR = 10_200_000n
  const listed: RouteContext = {
    ...ctx,
    routerFunctions: [...FIVE, ...NEW],
    keepYtMintSy: 62n,
    keepYtDesired: { pt: 41n, sy: 38n },
    buyYtFlash: { syIn: 4_216n },
    exchangeRate: XR,
  }
  const plan = (r: RouteRequest, c: RouteContext = listed) => {
    const p = planRoute(r, c)
    if ("disabled" in p) throw new Error(p.disabled)
    return p
  }

  it("the table names one function per kind, none of them flagged as sweeping SY (R5-4), and the flash is chosen by the pay token (R5-2)", () => {
    expect(SINGLE_STEP).toEqual({
      buy_pt: { fn: "swap_underlying_for_pt", action: "buy_pt_underlying" },
      sell_pt: { fn: "swap_pt_for_underlying", action: "sell_pt_underlying" },
      sell_yt: { fn: "swap_yt_for_underlying", action: "sell_yt_underlying" },
      lp_keep_yt: { fn: "add_liquidity_keep_yt", action: "add_liquidity_keep_yt" },
      lp_only: { fn: "add_liquidity_single_underlying", action: "add_liquidity_underlying" },
      lp_withdraw: { fn: "remove_liquidity_to_underlying", action: "remove_liquidity_underlying" },
    })
    expect(FLASH_BUY_YT).toEqual({
      sy: { fn: "flash_mint_yt", action: "buy_yt_flash" },
      underlying: { fn: "flash_mint_yt_from_underlying", action: "buy_yt_flash_underlying" },
    })
  })

  it("with the five names listed, each kind paid or received in USDY is one step with its amounts", () => {
    expect(plan({ ...base, kind: "buy_pt" })).toEqual([{ action: "buy_pt_underlying", amount: { from: "input" }, gives: "USDY", takes: "PT" }])
    expect(plan({ ...base, kind: "sell_pt" })).toEqual([{ action: "sell_pt_underlying", amount: { from: "input" }, gives: "PT", takes: "USDY" }])
    expect(plan({ ...base, kind: "sell_yt" })).toEqual([{ action: "sell_yt_underlying", amount: { from: "input" }, gives: "YT", takes: "USDY" }])
    // R4-4: Keep YT deposits the whole input and mints the SY shares the dApp sized; R5-7: it also
    // signs the PT and SY offered to the pool.
    expect(plan({ ...base, kind: "lp_keep_yt" })).toEqual([
      {
        action: "add_liquidity_keep_yt",
        amount: { from: "input" },
        secondaryAmount: { from: "value", value: 62n },
        desired: { pt: 41n, sy: 38n },
        gives: "USDY",
        takes: "LP + YT",
      },
    ])
    const r = { ...base, kind: "lp_keep_yt" as const }
    expect(resolveStep(plan(r)[0], r, [])).toEqual({ amount: 100n, secondaryAmount: 62n, desired: { pt: 41n, sy: 38n } })
  })

  it("R5-2: with the flash functions listed, Buy YT is one flash step for either payer: the budget in, the solved sy_in signed", () => {
    expect(plan({ ...base, kind: "buy_yt", pay: "sy" })).toEqual([
      { action: "buy_yt_flash", amount: { from: "input" }, secondaryAmount: { from: "value", value: 4_216n }, gives: "SY", takes: "YT" },
    ])
    expect(plan({ ...base, kind: "buy_yt", pay: "underlying" })).toEqual([
      { action: "buy_yt_flash_underlying", amount: { from: "input" }, secondaryAmount: { from: "value", value: 4_216n }, gives: "USDY", takes: "YT" },
    ])
    const r = { ...base, kind: "buy_yt" as const }
    expect(resolveStep(plan(r)[0], r, [])).toEqual({ amount: 100n, secondaryAmount: 4_216n })
    // Each payer's flash is used only when its own function is listed.
    const syOnly = { ...listed, routerFunctions: ["flash_mint_yt"] }
    expect(actions({ ...base, kind: "buy_yt", pay: "sy" }, syOnly)).toEqual(["buy_yt_flash"])
    expect(actions({ ...base, kind: "buy_yt", pay: "underlying" }, syOnly)).toEqual(["deposit", "buy_yt", "withdraw"])
    const usdyOnly = { ...listed, routerFunctions: ["flash_mint_yt_from_underlying"] }
    expect(actions({ ...base, kind: "buy_yt", pay: "underlying" }, usdyOnly)).toEqual(["buy_yt_flash_underlying"])
    expect(actions({ ...base, kind: "buy_yt", pay: "sy" }, usdyOnly)).toEqual(["buy_yt"])
    // Not sized yet: the flash is disabled, never signed with a stand-in sy_in.
    const noFlash: RouteContext = { routerFunctions: listed.routerFunctions, exchangeRate: XR }
    expect(planRoute({ ...base, kind: "buy_yt" }, noFlash)).toEqual({ disabled: expect.stringMatching(/needs the solved SY amount first/) })
  })

  it("Review Focus 4: without the flash functions (a 97ac23e manifest), Buy YT keeps its multi-step route", () => {
    const old = { ...listed, routerFunctions: FIVE }
    expect(actions({ ...base, kind: "buy_yt", pay: "underlying" }, old)).toEqual(["deposit", "buy_yt", "withdraw"])
    expect(actions({ ...base, kind: "buy_yt", pay: "sy" }, old)).toEqual(["buy_yt"])
  })

  it("R5-5: LP only in USDY is one step whose sy_in is the deposit's SY at the exchange rate, signed as a literal", () => {
    const r = { ...base, kind: "lp_only" as const, amount: 1_000_000_000n }
    expect(plan(r)).toEqual([
      {
        action: "add_liquidity_underlying",
        amount: { from: "input" },
        secondaryAmount: { from: "value", value: previewDeposit(1_000_000_000n, XR) },
        gives: "USDY",
        takes: "LP",
      },
    ])
    expect(resolveStep(plan(r)[0], r, [])).toEqual({ amount: 1_000_000_000n, secondaryAmount: previewDeposit(1_000_000_000n, XR) })
    // Paid in SY it is the plain zap; not listed, deposit then the zap.
    expect(actions({ ...r, pay: "sy" }, listed)).toEqual(["add_liquidity_sy"])
    expect(actions(r, { ...listed, routerFunctions: FIVE })).toEqual(["deposit", "add_liquidity_sy"])
    // Without the rate the sy_in cannot be worked out: unavailable, with the reason.
    const noRate: RouteContext = { routerFunctions: listed.routerFunctions }
    expect(planRoute(r, noRate)).toEqual({ disabled: expect.stringMatching(/needs the SY exchange rate/) })
  })

  it("R5-6: LP withdraw to USDY is one step before maturity and the old route after it", () => {
    expect(plan({ ...base, kind: "lp_withdraw" })).toEqual([{ action: "remove_liquidity_underlying", amount: { from: "input" }, gives: "LP", takes: "USDY" }])
    expect(actions({ ...base, kind: "lp_withdraw", matured: true }, listed)).toEqual(["remove_liquidity", "redeem", "withdraw"])
    expect(actions({ ...base, kind: "lp_withdraw", receive: "sy" }, listed)).toEqual(["remove_liquidity", "sell_pt"])
    expect(actions({ ...base, kind: "lp_withdraw" }, { ...listed, routerFunctions: FIVE })).toEqual(["remove_liquidity", "sell_pt", "withdraw"])
  })

  it("without the names, or paying / receiving SY, the old routes stand", () => {
    for (const c of [ctx, { ...listed, routerFunctions: [] }]) {
      expect(actions({ ...base, kind: "buy_pt" }, c)).toEqual(["deposit", "buy_pt"])
      expect(actions({ ...base, kind: "sell_pt" }, c)).toEqual(["sell_pt", "withdraw"])
      expect(actions({ ...base, kind: "buy_yt" }, c)).toEqual(["deposit", "buy_yt", "withdraw"])
      expect(actions({ ...base, kind: "sell_yt" }, c)).toEqual(["sell_yt", "withdraw"])
      expect(actions({ ...base, kind: "lp_keep_yt" }, c)).toEqual(["mint", "deposit", "add_liquidity"])
      expect(actions({ ...base, kind: "lp_only" }, c)).toEqual(["deposit", "add_liquidity_sy"])
      expect(actions({ ...base, kind: "lp_withdraw" }, c)).toEqual(["remove_liquidity", "sell_pt", "withdraw"])
    }
    expect(actions({ ...base, kind: "buy_pt", pay: "sy" }, listed)).toEqual(["buy_pt"])
    expect(actions({ ...base, kind: "sell_pt", receive: "sy" }, listed)).toEqual(["sell_pt"])
    expect(actions({ ...base, kind: "sell_yt", receive: "sy" }, listed)).toEqual(["sell_yt"])
    expect(planRoute({ ...base, kind: "lp_keep_yt", pay: "sy" }, listed)).toEqual({ disabled: expect.stringMatching(/needs USDY/) })
    // Only a listed name replaces its route.
    const one = { ...listed, routerFunctions: ["swap_underlying_for_pt"] }
    expect(actions({ ...base, kind: "buy_pt" }, one)).toEqual(["buy_pt_underlying"])
    expect(actions({ ...base, kind: "sell_pt" }, one)).toEqual(["sell_pt", "withdraw"])
  })

  it("R5-4: no route carries a sweep fallback: routerFunctions alone decides the one step", () => {
    const kinds = ["buy_pt", "sell_pt", "buy_yt", "sell_yt", "lp_keep_yt", "lp_only", "lp_withdraw", "split", "recombine"] as const
    for (const c of [ctx, listed])
      for (const kind of kinds)
        for (const matured of [false, true])
          for (const pay of ["underlying", "sy"] as const)
            for (const receive of ["underlying", "sy"] as const) {
              const p = planRoute({ ...base, kind, matured, pay, receive }, c)
              if ("disabled" in p) continue
              for (const s of p) expect(Object.keys(s)).not.toContain("fallback")
            }
  })

  it("a one step whose amount is sized by the dApp is disabled until it is, Keep YT's desired PT and SY too (R5-7)", () => {
    const fns = [...FIVE, ...NEW]
    expect(planRoute({ ...base, kind: "lp_keep_yt" }, { routerFunctions: fns, keepYtMintSy: 62n })).toEqual({ disabled: expect.stringMatching(/needs the SY to mint first/) })
    expect(planRoute({ ...base, kind: "lp_keep_yt" }, { routerFunctions: fns })).toEqual({ disabled: expect.stringMatching(/needs the SY to mint first/) })
  })

  it("resolveStep hands Keep YT's desired PT and SY through on their own, never tied to the second amount", () => {
    const plan: StepPlan = { action: "add_liquidity_keep_yt", amount: { from: "input" }, desired: { pt: 1n, sy: 2n }, gives: "USDY", takes: "LP + YT" }
    expect(resolveStep(plan, base, [])).toEqual({ amount: 100n, desired: { pt: 1n, sy: 2n } })
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

  it("R5-4: the way back never depends on the SY the wallet holds: no reason mentions it", () => {
    const cases: Parameters<typeof unwindFrom>[0][] = [{ pt: S }, { yt: S, sy: S }, { lp: S }, { pt: S, sy: 2n * S }, { underlying: S }, {}, undefined]
    for (const h of cases)
      for (const matured of [false, true]) {
        const u = unwindFrom(h, { matured })
        if (!u.available) expect(u.reason).not.toMatch(/holds? no SY|withdraw all your SY/)
      }
  })

  it("LP keep YT interrupted before add_liquidity lists PT, YT and SY", () => {
    const r = { ...base, kind: "lp_keep_yt" as const }
    const outs: ActionOutput[] = [
      { kind: "mint", pt_minted: 40n * S, yt_minted: 40n * S, fee_shares: 1n },
      { kind: "amount", value: 59n * S },
    ]
    expect(describeHoldings(routeHoldings(r, plan(r), outs, 2)!, usdy)).toBe("You hold 40 PT, 40 YT and 59 SY")
  })

  describe("one-transaction Router actions (0004 Task 3, 0005 Task 3)", () => {
    const ONE_STEP: RouteContext["singleStep"] = {
      buy_pt: { fn: "swap_underlying_for_pt", action: "buy_pt_underlying" },
      sell_pt: { fn: "swap_pt_for_underlying", action: "sell_pt_underlying" },
      sell_yt: { fn: "swap_yt_for_underlying", action: "sell_yt_underlying" },
      lp_keep_yt: { fn: "add_liquidity_keep_yt", action: "add_liquidity_keep_yt" },
    }
    const oneStep: RouteContext = { ...scaled, keepYtMintSy: 60n * S, keepYtDesired: { pt: 41n * S, sy: 38n * S }, routerFunctions: Object.values(ONE_STEP).map((x) => x!.fn), singleStep: ONE_STEP }
    const held = (kind: RouteRequest["kind"], out: ActionOutput, amount = 100n * S) => {
      const r = { ...base, kind, amount }
      const plans = planRoute(r, oneStep) as StepPlan[]
      expect(plans).toHaveLength(1)
      return routeHoldings(r, plans, [out], 1)
    }
    /** `action` after a step that left 300 USDY: shows the underlying the action takes or pays. */
    const afterUsdy = (action: ActionId, out: ActionOutput, extra: Partial<StepPlan> = {}) => {
      const r = { ...base, amount: 100n * S }
      const plans: StepPlan[] = [
        { action: "withdraw", amount: { from: "value", value: 300n * S }, gives: "SY", takes: "USDY" },
        { action, amount: { from: "input" }, gives: "x", takes: "y", ...extra },
      ]
      return routeHoldings(r, plans, [{ kind: "amount", value: 300n * S }, out], 2)
    }
    /** `action` as the route's only step, on 100 of the input: what it leaves beside the LP or YT. */
    const alone = (action: ActionId, out: ActionOutput, extra: Partial<StepPlan> = {}) =>
      routeHoldings({ ...base, amount: 100n * S }, [{ action, amount: { from: "input" }, gives: "x", takes: "y", ...extra }], [out], 1)

    it("Buy PT and Sell PT / YT: the underlying in or out, PT out or in", () => {
      expect(held("buy_pt", { kind: "amount", value: 98n * S })).toEqual({ pt: 98n * S })
      expect(held("sell_pt", { kind: "amount", value: 9n * S }, 10n * S)).toEqual({ underlying: 9n * S })
      expect(held("sell_yt", { kind: "amount", value: 3n * S }, 10n * S)).toEqual({ underlying: 3n * S })
      expect(afterUsdy("buy_pt_underlying", { kind: "amount", value: 98n * S })).toEqual({ pt: 98n * S, underlying: 200n * S })
      expect(afterUsdy("sell_pt_underlying", { kind: "amount", value: 9n * S })).toEqual({ underlying: 309n * S })
      expect(afterUsdy("sell_yt_underlying", { kind: "amount", value: 3n * S })).toEqual({ underlying: 303n * S })
    })

    it("flash Buy YT: the YT arrives, and only the net cost leaves (R5-2)", () => {
      const sy: ActionOutput = { kind: "flash_yt", yt_out: 40n * S, net_cost: 10n * S }
      const syIn = { secondaryAmount: { from: "value", value: 4_000n * S } as const }
      expect(afterUsdy("buy_yt_flash", sy, syIn)).toEqual({ yt: 40n * S, underlying: 300n * S })
      // The USDY payer's budget goes in and underlying_back comes back with the YT.
      const usdy: ActionOutput = { kind: "flash_yt_underlying", yt_out: 40n * S, net_cost: 10n * S, underlying_back: 85n * S }
      expect(afterUsdy("buy_yt_flash_underlying", usdy, syIn)).toEqual({ yt: 40n * S, underlying: 285n * S })
      expect(afterUsdy("buy_yt_flash_underlying", sy, syIn)).toBeUndefined()
    })

    it("LP only from USDY: the LP, and the SY of its sy_in the pool did not use, which it sends back (R5-5)", () => {
      const add: ActionOutput = { kind: "add_liquidity", pt_used: 1n * S, sy_used: 97n * S, lp: 50n * S }
      expect(alone("add_liquidity_underlying", add, { secondaryAmount: { from: "value", value: 98n * S } })).toEqual({ lp: 50n * S, sy: 1n * S })
      // All of it used: nothing comes back.
      expect(alone("add_liquidity_underlying", add, { secondaryAmount: { from: "value", value: 97n * S } })).toEqual({ lp: 50n * S })
      expect(afterUsdy("add_liquidity_underlying", add, { secondaryAmount: { from: "value", value: 98n * S } })).toMatchObject({ lp: 50n * S, underlying: 200n * S })
      // Without the sy_in it signed, what came back cannot be said: unknown, never guessed.
      expect(alone("add_liquidity_underlying", add)).toBeUndefined()
    })

    it("LP out to USDY: the LP in, the underlying out (R5-6)", () => {
      expect(afterUsdy("remove_liquidity_underlying", { kind: "amount", value: 90n * S })).toEqual({ underlying: 390n * S })
    })

    it("Keep YT: LP and YT, the PT the pool did not take (PT is minted 1:1 with YT) and the SY it did not take (R5-7)", () => {
      // desired.sy is 38: the pool took 37 of it.
      const out: ActionOutput = { kind: "keep_yt", pt_used: 38n * S, sy_used: 37n * S, lp: 50n * S, yt_minted: 40n * S }
      const h = held("lp_keep_yt", out)
      expect(h).toEqual({ pt: 2n * S, yt: 40n * S, lp: 50n * S, sy: 1n * S })
      expect(describeHoldings(h!, usdy)).toBe("You hold 2 PT, 40 YT, 50 LP and 1 SY")
      // All the SY taken: only the PT is left.
      expect(held("lp_keep_yt", { ...out, sy_used: 38n * S })).toEqual({ pt: 2n * S, yt: 40n * S, lp: 50n * S })
      const desired = { secondaryAmount: { from: "value", value: 60n * S } as const, desired: { pt: 41n * S, sy: 38n * S } }
      expect(alone("add_liquidity_keep_yt", out, desired)).toEqual({ pt: 2n * S, yt: 40n * S, lp: 50n * S, sy: 1n * S })
      expect(afterUsdy("add_liquidity_keep_yt", out, desired)).toMatchObject({ pt: 2n * S, yt: 40n * S, lp: 50n * S, underlying: 200n * S })
      expect(held("lp_keep_yt", { kind: "add_liquidity", pt_used: 1n, sy_used: 1n, lp: 1n })).toBeUndefined()
      // A plan without the desired amounts cannot say what SY is left: unknown, never guessed.
      expect(alone("add_liquidity_keep_yt", out, { secondaryAmount: { from: "value", value: 60n * S } })).toBeUndefined()
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
