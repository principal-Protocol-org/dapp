// @vitest-environment node
/**
 * Trade adapter #1 (ruling R2-55): quotes from the curve port on a realistic pool, and the routes
 * of today's contracts. The pool is curve.test.ts's state A (150 days left, oracle 1.05, fee
 * 0.3 % x 150/365), whose figures the Rust contract printed: buying with 100 SY gives 107.0237019
 * PT for a 0.1232877 SY fee and moves `implied_rate` 501023 -> 498176; selling 100 PT gives
 * 93.1966515 SY for a 0.1150419 SY fee (gross 93.3116934) and moves it to 503687.
 */
import { describe, expect, it } from "vitest"
import { buyPt, impliedRate, sellPt, type CurveState } from "../curve"
import { minAfterSlippage } from "../guards"
import type { MarketState } from "../market-state"
import { aprToApy, ceilDiv, FEE_RATE_SCALE, SCALE } from "../math"
import { previewDeposit, previewWithdraw } from "../previews"
import { effectiveFixedApy, fixedPayoffUsd } from "../rates"
import { planRoute, type StepPlan } from "../routes"
import { currentContractsAdapter, toRouteRequest, type TradeQuote, type TradeRequest } from "../trade-adapter"
import type { Live } from "../types"

const A: CurveState = {
  ptReserve: 1000000000000n,
  syReserve: 580000000000n,
  totalLp: 760000000000n,
  rate: 10500000n,
  exponent: 958904109589041096n,
  feeRate: 1232876712n,
  secondsToMaturity: 12960000n,
}
const ORACLE = 10_500_000n
const SPOT_A = 9798253n // pt_price on state A (contract vector)
const SY_100 = 1_000_000_000n
const PT_100 = 1_000_000_000n

const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 7 })
const down: Live<never> = { status: "unavailable", error: "rpc down" }

function market(over: Partial<Record<"poolState" | "oracleRate" | "exchangeRate", Live<unknown>>> = {}): MarketState {
  return { poolState: live(A), oracleRate: live(ORACLE), exchangeRate: live(SCALE), ...over } as unknown as MarketState
}

const apy = (implied: bigint) => aprToApy(implied, A.secondsToMaturity)
const buy = (pay: TradeRequest["pay"], amount = SY_100): TradeRequest => ({ kind: "buy_pt", amount, pay, receive: pay })
const sell = (receive: TradeRequest["receive"], amount = PT_100): TradeRequest => ({ kind: "sell_pt", amount, pay: receive, receive })

function quoted(result: Live<TradeQuote>): TradeQuote {
  if (result.status !== "live") throw new Error(`expected a live quote, got: ${result.error}`)
  return result.value
}
const CTX = { marketId: "m1", source: "GABC", matured: false, routerFunctions: [] as string[] }

/** Today's route for `req` (adapter #1's plan). */
function plansFor(req: TradeRequest): StepPlan[] {
  const plans = currentContractsAdapter.plan(req, CTX)
  if (!Array.isArray(plans)) throw new Error(plans.disabled)
  return plans
}

/**
 * A one-step route, as `planRoute` builds one once a single-step Router function ships and the
 * manifest lists it (`SINGLE_STEP`, empty today); `action` stands in for that function's action.
 */
function oneStep(req: TradeRequest): StepPlan[] {
  const single = { fn: "swap_one_step", action: req.kind === "buy_pt" ? ("buy_pt" as const) : ("sell_pt" as const) }
  const plans = planRoute(toRouteRequest(req, CTX), { routerFunctions: [single.fn], singleStep: { [req.kind]: single } })
  if (!Array.isArray(plans) || plans.length !== 1) throw new Error("expected a one-step route")
  return plans
}

const quote = (req: TradeRequest, state: Partial<Parameters<typeof currentContractsAdapter.quote>[1]> = {}) =>
  currentContractsAdapter.quote(req, { ms: market(), slippageBps: 50n, ...state, plans: state.plans ?? plansFor(req) })

describe("trade adapter #1 — buy PT", () => {
  it("an SY payer gets the curve's PT for the curve's fee, and the fixed APY falls (R2-15)", () => {
    const q = quoted(quote(buy("sy")))
    expect(q).toMatchObject({ kind: "buy_pt", out: 1070237019n, outToken: "pt", fee: 1232877n, feeToken: "sy", exactness: "indicative" })
    expect(q.minOut).toBe(minAfterSlippage(1070237019n, 50n))
    expect(q.minOutToken).toBe("pt")
    expect(q.apyBefore).toBe(apy(501023n))
    expect(q.apyAfter).toBe(apy(498176n))
    expect(q.apyAfter).toBeLessThan(q.apyBefore)
  })

  it("a USDY payer is priced on the SY its deposit gives, with the fee shown in USDY", () => {
    const rate = 10_200_000n // 1.02 USDY per SY share
    const q = quoted(quote(buy("underlying"), { ms: market({ exchangeRate: live(rate) }) }))
    const syIn = previewDeposit(SY_100, rate)
    const curve = buyPt(A, syIn)
    expect(q.out).toBe(curve.amountOut)
    expect(q.feeToken).toBe("underlying")
    expect(q.fee).toBe(previewWithdraw(curve.feeShares, rate))
    // The USDY paid is valued at today's oracle rate (spec §3), not counted as SY.
    expect(q.effectiveApy).toBe(effectiveFixedApy({ paidUnderlying: SY_100, oracleRate: ORACLE, ptOut: curve.amountOut, secondsToMaturity: A.secondsToMaturity }))
  })

  it("at an SY rate of 1, paying 100 SY or 100 USDY gives the same PT and the same effective APY", () => {
    const sy = quoted(quote(buy("sy")))
    const usdy = quoted(quote(buy("underlying")))
    expect(usdy.out).toBe(sy.out)
    expect(usdy.effectiveApy).toBe(sy.effectiveApy)
    expect(sy.effectiveApy).toBeGreaterThan(0)
  })

  it("an SY payer's SY is valued in USDY at the SY rate, then in USD at the oracle rate", () => {
    const rate = 10_200_000n
    const q = quoted(quote(buy("sy"), { ms: market({ exchangeRate: live(rate) }) }))
    const paid = previewWithdraw(SY_100, rate)
    expect(q.effectiveApy).toBe(effectiveFixedApy({ paidUnderlying: paid, oracleRate: ORACLE, ptOut: 1070237019n, secondsToMaturity: A.secondsToMaturity }))
    expect(q.payoff).toMatchObject(fixedPayoffUsd(1070237019n, paid, ORACLE))
  })

  it("the payoff is fixed in USD and the PT's value today is at the pool's spot price, in USDY", () => {
    const q = quoted(quote(buy("underlying")))
    // 107.0237019 PT redeem for $107.0237019; 100 USDY at 1.05 cost $105.
    expect(q.payoff).toMatchObject(fixedPayoffUsd(1070237019n, SY_100, ORACLE))
    expect(q.payoff!.gainUsd).toBe(1070237019n - 1_050_000_000n)
    // The same gain in USDY at today's 1.05: indicative, since it moves with USDY's price.
    expect(q.payoff!.gainUnderlying).toBe(((1070237019n - 1_050_000_000n) * SCALE) / ORACLE)
    expect(q.valueToday).toBe((1070237019n * SPOT_A) / ORACLE)
    // Fee and price impact make the PT worth less today than the USDY paid.
    expect(q.valueToday!).toBeLessThan(SY_100)
    expect(q.priceImpactPpm!).toBeGreaterThan(0n)
  })

  it("a simulated PT out replaces the curve's, and the APY after is recomputed from it", () => {
    const simulated = 1_060_000_000n
    const q = quoted(quote(buy("sy"), { firstStep: { action: "buy_pt", output: { kind: "amount", value: simulated } } }))
    expect(q).toMatchObject({ out: simulated, exactness: "simulated", fee: 1232877n })
    expect(q.minOut).toBe(minAfterSlippage(simulated, 50n))
    // swap_sy_for_pt writes pt − pt_out and sy + (sy_in − fee) (market_pool lib.rs:295-296).
    const after = impliedRate({ ...A, ptReserve: A.ptReserve - simulated, syReserve: A.syReserve + SY_100 - 1232877n })
    expect(q.apyAfter).toBe(apy(after))
    expect(q.apyAfter).not.toBe(apy(498176n))
    expect(q.effectiveApy).toBe(effectiveFixedApy({ paidUnderlying: SY_100, oracleRate: ORACLE, ptOut: simulated, secondsToMaturity: A.secondsToMaturity }))
  })

  it("a USDY payer's swap stays indicative: a simulated deposit only fixes the SY it is priced with", () => {
    const q = quoted(quote(buy("underlying"), { firstStep: { action: "deposit", output: { kind: "amount", value: 990_000_000n } } }))
    expect(q.out).toBe(buyPt(A, 990_000_000n).amountOut)
    expect(q.exactness).toBe("indicative")
  })

  it("a simulation of another action is never used", () => {
    const q = quoted(quote(buy("sy"), { firstStep: { action: "sell_pt", output: { kind: "amount", value: 1n } } }))
    expect(q).toMatchObject({ out: 1070237019n, exactness: "indicative" })
  })
})

describe("trade adapter #1 — sell PT", () => {
  it("an SY receiver gets the curve's SY for the curve's fee, and the fixed APY rises (R2-15)", () => {
    const q = quoted(quote(sell("sy")))
    expect(q).toMatchObject({ kind: "sell_pt", out: 931966515n, outToken: "sy", fee: 1150419n, feeToken: "sy", exactness: "indicative" })
    expect(q.minOut).toBe(minAfterSlippage(931966515n, 50n))
    expect(q.apyBefore).toBe(apy(501023n))
    expect(q.apyAfter).toBe(apy(503687n))
    expect(q.apyAfter).toBeGreaterThan(q.apyBefore)
    expect(q.payoff).toBeUndefined()
  })

  it("a USDY receiver's SY is withdrawn at the SY rate; the minimum is the swap step's own SY floor", () => {
    const rate = 10_200_000n
    const q = quoted(quote(sell("underlying"), { ms: market({ exchangeRate: live(rate) }) }))
    expect(q).toMatchObject({ out: previewWithdraw(931966515n, rate), outToken: "underlying", exactness: "indicative" })
    expect(q.swapOut).toEqual({ amount: 931966515n, token: "sy", exactness: "indicative", step: 1 })
    // No USDY floor exists before step 2 is prepared: the floor shown is step 1's, in SY.
    expect(q).toMatchObject({ minOut: minAfterSlippage(931966515n, 50n), minOutToken: "sy" })
    expect(q).toMatchObject({ fee: previewWithdraw(1150419n, rate), feeToken: "underlying" })
  })

  it("a simulated SY out is exact, and the APY after uses the gross sale it implies", () => {
    const simulated = 930_000_000n
    const q = quoted(quote(sell("sy"), { firstStep: { action: "sell_pt", output: { kind: "amount", value: simulated } } }))
    expect(q).toMatchObject({ out: simulated, exactness: "simulated" })
    // net = gross − ceil(gross · fee / 1e12): the smallest such gross.
    const gross = ceilDiv(simulated * FEE_RATE_SCALE, FEE_RATE_SCALE - A.feeRate)
    expect(gross - ceilDiv(gross * A.feeRate, FEE_RATE_SCALE)).toBe(simulated)
    expect(q.fee).toBe(gross - simulated)
    expect(q.apyAfter).toBe(apy(impliedRate({ ...A, ptReserve: A.ptReserve + PT_100, syReserve: A.syReserve - gross })))
  })

  it("the gross the curve uses is the one a simulation equal to the curve's output implies", () => {
    const curve = sellPt(A, PT_100)
    const q = quoted(quote(sell("sy"), { firstStep: { action: "sell_pt", output: { kind: "amount", value: curve.amountOut } } }))
    expect(q.apyAfter).toBe(apy(503687n))
    expect(q.fee).toBe(curve.feeShares)
  })

  it("a USDY receiver with step 1 simulated: the SY is exact, the USDY after the withdraw stays indicative", () => {
    const q = quoted(quote(sell("underlying"), { firstStep: { action: "sell_pt", output: { kind: "amount", value: 930_000_000n } } }))
    expect(q.swapOut).toEqual({ amount: 930_000_000n, token: "sy", exactness: "simulated", step: 1 })
    expect(q).toMatchObject({ out: 930_000_000n, exactness: "indicative" })
  })
})

describe("trade adapter #1 — exactness follows the route, not an assumed shape", () => {
  it("a one-step USDY buy: the step's simulation is the PT received, and the APY after is recomputed", () => {
    const req = buy("underlying")
    const simulated = 1_060_000_000n
    const indicative = quoted(quote(req, { plans: oneStep(req) }))
    expect(indicative).toMatchObject({ out: 1070237019n, exactness: "indicative" })
    const q = quoted(quote(req, { plans: oneStep(req), firstStep: { action: "buy_pt", output: { kind: "amount", value: simulated } } }))
    expect(q).toMatchObject({ out: simulated, exactness: "simulated", minOut: minAfterSlippage(simulated, 50n), minOutToken: "pt" })
    // The SY the pool receives is the deposit's (SY rate 1): 100 SY, less the fee.
    expect(q.apyAfter).toBe(apy(impliedRate({ ...A, ptReserve: A.ptReserve - simulated, syReserve: A.syReserve + SY_100 - 1232877n })))
  })

  it("a one-step USDY sale: the simulated USDY is exact, with its own floor and no separate SY leg", () => {
    const req = sell("underlying")
    const rate = 10_200_000n
    const ms = market({ exchangeRate: live(rate) })
    const indicative = quoted(quote(req, { ms, plans: oneStep(req) }))
    expect(indicative).toMatchObject({ out: previewWithdraw(931966515n, rate), exactness: "indicative", minOutToken: "underlying" })
    expect(indicative.swapOut).toBeUndefined()
    const usdy = 950_000_000n
    const q = quoted(quote(req, { ms, plans: oneStep(req), firstStep: { action: "sell_pt", output: { kind: "amount", value: usdy } } }))
    expect(q).toMatchObject({ out: usdy, outToken: "underlying", exactness: "simulated", minOut: minAfterSlippage(usdy, 50n), minOutToken: "underlying" })
    expect(q.swapOut).toBeUndefined()
  })

  it("a simulation is used only for the route's first step", () => {
    // Paying USDY today deposits first: a simulated swap cannot be that step's.
    const q = quoted(quote(buy("underlying"), { firstStep: { action: "buy_pt", output: { kind: "amount", value: 1n } } }))
    expect(q).toMatchObject({ out: 1070237019n, exactness: "indicative" })
  })

  it("a loss in USDY is never understated: its magnitude rounds away from zero", () => {
    // 100 SY ($105 at 1.05) for 100 PT redeeming $100: a $5 loss, 4.76190476… USDY.
    const q = quoted(quote(buy("sy"), { firstStep: { action: "buy_pt", output: { kind: "amount", value: SY_100 } } }))
    expect(q.payoff!.gainUsd).toBe(-50_000_000n)
    expect(q.payoff!.gainUnderlying).toBe(-47_619_048n)
  })
})

describe("trade adapter #1 — unavailable, never a guess", () => {
  it("names the read that failed", () => {
    for (const [field, what] of [
      ["poolState", "the pool"],
      ["oracleRate", "the oracle rate"],
      ["exchangeRate", "the SY exchange rate"],
    ] as const) {
      const r = quote(buy("sy"), { ms: market({ [field]: down }) })
      expect(r).toEqual({ status: "unavailable", error: `Could not read ${what} (rpc down).` })
    }
  })

  it("a trade the pool would refuse carries the pool's reason", () => {
    const r = quote(buy("sy", 29_000_000_000_000n))
    expect(r).toEqual({ status: "unavailable", error: "the pool does not have enough liquidity for this trade" })
    expect(quote(sell("sy", 0n)).status).toBe("unavailable")
  })

  it("an amount too small for a non-zero floor is not quoted", () => {
    // 2 raw SY buy 1 raw PT; 1 · (1 − 0.5 %) floors to 0.
    const r = quote(buy("sy", 2n))
    expect(r.status).toBe("unavailable")
    expect(r.status === "unavailable" && r.error).toMatch(/too small/)
  })

  it("a matured pool is not quoted", () => {
    const r = quote(buy("sy"), { ms: market({ poolState: live({ ...A, secondsToMaturity: 0n }) }) })
    expect(r.status === "unavailable" && r.error).toMatch(/matured/)
  })

  it("kinds the later tabs add are not quoted yet", () => {
    const r = quote({ kind: "buy_yt", amount: SY_100, pay: "sy", receive: "sy" }, { plans: [] })
    expect(r.status).toBe("unavailable")
  })
})

describe("trade adapter #1 — plan", () => {
  const ctx = { marketId: "m1", source: "GABC", matured: false, routerFunctions: [] as string[] }
  const actions = (req: TradeRequest) => {
    const plans = currentContractsAdapter.plan(req, ctx)
    if (!Array.isArray(plans)) throw new Error(plans.disabled)
    return plans.map((p) => p.action)
  }

  it("paying in SY is one step; paying in USDY deposits first", () => {
    expect(actions(buy("sy"))).toEqual(["buy_pt"])
    expect(actions(buy("underlying"))).toEqual(["deposit", "buy_pt"])
  })

  it("receiving SY is one step; receiving USDY withdraws last", () => {
    expect(actions(sell("sy"))).toEqual(["sell_pt"])
    expect(actions(sell("underlying"))).toEqual(["sell_pt", "withdraw"])
  })

  it("the route request carries the market, the signer and the maturity", () => {
    expect(toRouteRequest(buy("underlying"), ctx)).toEqual({
      kind: "buy_pt",
      marketId: "m1",
      source: "GABC",
      amount: SY_100,
      pay: "underlying",
      receive: "underlying",
      matured: false,
    })
  })
})
