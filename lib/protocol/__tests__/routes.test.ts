// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../manifest"
import { ACTION_META, invocationFor, type ActionId } from "../actions"
import type { ActionOutput } from "../guards"
import { planRoute, resolveStep, type RouteContext, type RouteRequest, type StepPlan } from "../routes"

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

describe("lp_only", () => {
  it("is disabled with the R47 reason", () => {
    expect(planRoute({ ...base, kind: "lp_only" }, ctx)).toEqual({
      disabled: ACTION_META.add_liquidity_sy.disabled!.reason,
    })
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
