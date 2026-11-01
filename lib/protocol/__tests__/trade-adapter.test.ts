// @vitest-environment node
/**
 * Trade adapter #1 (ruling R2-55): quotes from the curve port on a realistic pool, and the routes
 * of today's contracts. The pool is curve.test.ts's state A (150 days left, oracle 1.05, fee
 * 0.3 % x 150/365), whose figures the Rust contract printed: buying with 100 SY gives 107.0237019
 * PT for a 0.1232877 SY fee and moves `implied_rate` 501023 -> 498176; selling 100 PT gives
 * 93.1966515 SY for a 0.1150419 SY fee (gross 93.3116934) and moves it to 503687.
 */
import { describe, expect, it } from "vitest"
import { buyExactPt, buyPt, impliedRate, sellPt, spotPrice, type CurveState } from "../curve"
import { minAfterSlippage } from "../guards"
import type { MarketState } from "../market-state"
import { aprToApy, BPS, ceilDiv, FEE_RATE_SCALE, SCALE } from "../math"
import { previewDeposit, previewMint, previewSellYt, previewWithdraw } from "../previews"
import { effectiveFixedApy, effectiveImpliedApy, fixedPayoffUsd, leverage } from "../rates"
import { planRoute, type StepPlan } from "../routes"
import { currentContractsAdapter, maxSpend, toRouteRequest, type TradeQuote, type TradeRequest } from "../trade-adapter"
import type { Live } from "../types"
import { solveBuyYt, type YtSolution } from "../yt-solver"

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

const FEE_BPS = 10n // tokenization fee 0.10 %

function market(over: Partial<Record<"poolState" | "oracleRate" | "exchangeRate" | "tokenizationBps", Live<unknown>>> = {}): MarketState {
  const { tokenizationBps = live(FEE_BPS), ...reads } = over
  return { poolState: live(A), oracleRate: live(ORACLE), exchangeRate: live(SCALE), fees: { tokenizationBps }, ...reads } as unknown as MarketState
}

const apy = (implied: bigint) => aprToApy(implied, A.secondsToMaturity)
const buy = (pay: TradeRequest["pay"], amount = SY_100): TradeRequest => ({ kind: "buy_pt", amount, pay, receive: pay })
const sell = (receive: TradeRequest["receive"], amount = PT_100): TradeRequest => ({ kind: "sell_pt", amount, pay: receive, receive })

function quoted(result: Live<TradeQuote>): TradeQuote {
  if (result.status !== "live") throw new Error(`expected a live quote, got: ${result.error}`)
  return result.value
}
const CTX = { marketId: "m1", source: "GABC", matured: false, routerFunctions: [] as string[] }

/** Today's route for `req` (adapter #1's plan), sized from `ms` (Buy YT's steps are). */
function plansFor(req: TradeRequest, ms: MarketState = market()): StepPlan[] {
  const plans = currentContractsAdapter.plan(req, { ...CTX, ms })
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
  currentContractsAdapter.quote(req, { ms: market(), slippageBps: 50n, ...state, plans: state.plans ?? plansFor(req, state.ms ?? market()) })

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
    const r = quote({ kind: "lp_keep_yt", amount: SY_100, pay: "underlying", receive: "underlying" }, { plans: [] })
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

// ---------------------------------------------------------------------------------------------
// YT (Task 17): Buy YT is sized by the solver from the spend; Sell YT is the pool's flash-redeem.
// ---------------------------------------------------------------------------------------------

const USDY_100 = 1_000_000_000n
const buyYt = (pay: TradeRequest["pay"], amount = USDY_100): TradeRequest => ({ kind: "buy_yt", amount, pay, receive: pay })
const sellYt = (receive: TradeRequest["receive"], amount = 1_000_000_000n): TradeRequest => ({ kind: "sell_yt", amount, pay: receive, receive })

/** The solver's answer for a spend of `spendSy` SY on state A, as the adapter must use it. */
function solved(spendSy: bigint): YtSolution {
  const r = solveBuyYt(A, { spendSy, oracleRate: ORACLE, tokenizationFeeBps: FEE_BPS })
  if ("error" in r) throw new Error(r.error)
  return r
}

describe("trade adapter #1 — buy YT: the spend in, the solver's sy_in moved", () => {
  it("a USDY payer's spend is converted to SY at the SY rate before solving, and the deposit yields at least sy_in", () => {
    const rate = 10_200_000n
    const ms = market({ exchangeRate: live(rate) })
    const r = solved(previewDeposit(USDY_100, rate))
    const plans = plansFor(buyYt("underlying"), ms)
    expect(plans.map((p) => p.action)).toEqual(["deposit", "buy_yt", "withdraw"])
    // Rounded up, then checked with the wrapper's own math: the smallest deposit that gives sy_in.
    const dep = ceilDiv(r.syIn * rate, SCALE)
    expect(plans[0].amount).toEqual({ from: "value", value: dep })
    expect(previewDeposit(dep, rate)).toBeGreaterThanOrEqual(r.syIn)
    expect(previewDeposit(dep - 1n, rate)).toBeLessThan(r.syIn)
    expect(plans[1].amount).toEqual({ from: "value", value: r.syIn })
    // The refund of the PT sale is withdrawn from the buy step's own output.
    expect(plans[2].amount).toEqual({ from: "step", index: 1, field: "sy_back" })
  })

  it("Buy YT's moved amounts are `value` sources, so the gates before the route starts see them (not a stand-in)", () => {
    for (const pay of ["underlying", "sy"] as const) {
      const plans = plansFor(buyYt(pay))
      for (const p of plans.filter((p) => p.action !== "withdraw")) expect(p.amount.from).toBe("value")
    }
  })

  it("an SY payer's route is the buy alone: its refund stays SY (R2-21)", () => {
    const r = solved(USDY_100)
    const plans = plansFor(buyYt("sy"))
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ action: "buy_yt", amount: { from: "value", value: r.syIn } })
  })

  it("with no amount yet, the route keeps its shape and moves nothing", () => {
    const plans = plansFor(buyYt("underlying", 0n))
    expect(plans.map((p) => p.action)).toEqual(["deposit", "buy_yt", "withdraw"])
    expect(plans[0].amount).toEqual({ from: "value", value: 0n })
  })

  it("a spend the solver refuses disables the route with the solver's reason", () => {
    const plans = currentContractsAdapter.plan(buyYt("sy", 29_000_000_000_000n), { ...CTX, ms: market() })
    expect(Array.isArray(plans)).toBe(false)
    expect(!Array.isArray(plans) && plans.disabled).toMatch(/pool cannot absorb/)
  })

  it("without the market's data the route cannot be sized", () => {
    const plans = currentContractsAdapter.plan(buyYt("sy"), CTX)
    expect(!Array.isArray(plans) && plans.disabled).toMatch(/market's data/)
  })

  it("an SY payer gets the solver's YT, and the capital line is the solver's sy_in and sy_back, never leverage × spend", () => {
    const r = solved(USDY_100)
    const q = quoted(quote(buyYt("sy")))
    expect(q).toMatchObject({ kind: "buy_yt", out: r.ytOut, outToken: "yt", exactness: "indicative", minOut: minAfterSlippage(r.ytOut, 50n), minOutToken: "yt" })
    // Moves sy_in, spends its net cost; sy_back comes back in the buy step itself (step 1).
    expect(q.capital).toEqual({ moved: r.syIn, spent: r.netCost, back: r.syBack, backStep: 1 })
    const spot = leverage(spotPrice(A))!
    expect(Number(r.syIn) / Number(USDY_100)).toBeLessThan(spot)
    expect(q.leverage?.spot).toBe(spot)
  })

  it("a USDY payer's capital is in USDY: the deposit moved, the withdraw back in step 3", () => {
    const rate = 10_200_000n
    const ms = market({ exchangeRate: live(rate) })
    const r = solved(previewDeposit(USDY_100, rate))
    const q = quoted(quote(buyYt("underlying"), { ms }))
    const moved = ceilDiv(r.syIn * rate, SCALE)
    const back = previewWithdraw(r.syBack, rate)
    expect(q.capital).toEqual({ moved, spent: moved - back, back, backStep: 3 })
    expect(q.feeToken).toBe("underlying")
    // The tokenization fee on sy_in and the pool's fee on the PT sold back, in USDY.
    const mint = previewMint(r.syIn, ORACLE, FEE_BPS)
    expect(q.fee).toBe(previewWithdraw(mint.feeShares + sellPt(A, mint.pt).feeShares, rate))
  })

  it("buying YT sells PT into the pool, so the fixed APY rises (R2-15)", () => {
    const r = solved(USDY_100)
    const q = quoted(quote(buyYt("sy")))
    const sale = sellPt(A, previewMint(r.syIn, ORACLE, FEE_BPS).pt)
    expect(q.apyBefore).toBe(apy(501023n))
    expect(q.apyAfter).toBe(apy(impliedRate(sale.next)))
    expect(q.apyAfter).toBeGreaterThan(q.apyBefore)
  })

  it("the effective implied APY and the break-even inputs come from the spend and the YT received", () => {
    const r = solved(USDY_100)
    const q = quoted(quote(buyYt("sy")))
    // An SY payer's net cost in USDY at the SY rate (1.0), valued in USD at the oracle rate.
    expect(q.effectiveApy).toBe(effectiveImpliedApy({ spentUnderlying: r.netCost, oracleRate: ORACLE, ytOut: r.ytOut, secondsToMaturity: A.secondsToMaturity }))
    // The yield-bearing amount: the YT's USD at today's oracle rate, floored (indicative).
    expect(q.yieldOn).toBe((r.ytOut * SCALE) / ORACLE)
    expect(q.leverage?.trade).toBe(Number(r.ytOut) / Number((r.netCost * ORACLE) / SCALE))
  })

  it("spends at most the net cost at the slippage setting, as guards.ts signs max_net_cost (R2-58)", () => {
    const r = solved(USDY_100)
    const maxNetCost = ceilDiv(r.netCost * (BPS + 50n), BPS)
    expect(quoted(quote(buyYt("sy"))).maxCost).toBe(maxNetCost)
    // A USDY payer: what is moved, less the least SY the sale may return, withdrawn.
    const usdy = quoted(quote(buyYt("underlying")))
    expect(usdy.maxCost).toBe(usdy.capital!.moved - previewWithdraw(r.syIn - maxNetCost, SCALE))
  })

  it("an SY payer's simulated buy is exact: YT out and SY back replace the solver's", () => {
    const r = solved(USDY_100)
    const sim = { yt_out: r.ytOut - 1000n, sy_back: r.syBack - 2000n }
    const q = quoted(quote(buyYt("sy"), { firstStep: { action: "buy_yt", output: { kind: "buy_yt", ...sim } } }))
    expect(q).toMatchObject({ out: sim.yt_out, exactness: "simulated" })
    expect(q.capital).toEqual({ moved: r.syIn, spent: r.syIn - sim.sy_back, back: sim.sy_back, backStep: 1 })
    expect(q.maxCost).toBe(ceilDiv((r.syIn - sim.sy_back) * (BPS + 50n), BPS))
  })

  it("a USDY payer's buy stays indicative: the simulated deposit is not the buy", () => {
    const q = quoted(quote(buyYt("underlying"), { firstStep: { action: "deposit", output: { kind: "amount", value: 5n } } }))
    expect(q.exactness).toBe("indicative")
    expect(q.out).toBe(solved(USDY_100).ytOut)
  })

  it("a spend the solver refuses, or a read it needs, is Unavailable with the reason, never a zero", () => {
    expect(quote(buyYt("sy", 29_000_000_000_000n), { plans: [] })).toEqual({ status: "unavailable", error: expect.stringMatching(/pool cannot absorb/) })
    expect(quote(buyYt("sy"), { ms: market({ tokenizationBps: down }), plans: [] })).toEqual({
      status: "unavailable",
      error: "Could not read the tokenization fee (rpc down).",
    })
  })
})

describe("trade adapter #1 — sell YT: the pool's flash-redeem", () => {
  const YT_100 = 1_000_000_000n
  /** swap_yt_for_sy (market_pool lib.rs:342-380): recombine, less the exact-out PT cost. */
  const curve = buyExactPt(A, YT_100)
  const payout = previewSellYt(YT_100, ORACLE, curve.amountIn)

  it("an SY receiver gets the recombined SY less the PT's cost, and the fixed APY falls (R2-15)", () => {
    const q = quoted(quote(sellYt("sy")))
    expect(payout).toBeGreaterThan(0n)
    expect(q).toMatchObject({ kind: "sell_yt", out: payout, outToken: "sy", fee: curve.feeShares, feeToken: "sy", exactness: "indicative" })
    expect(q.minOut).toBe(minAfterSlippage(payout, 50n))
    expect(q.apyAfter).toBe(apy(impliedRate(curve.next)))
    expect(q.apyAfter).toBeLessThan(q.apyBefore)
    expect(q.capital).toBeUndefined()
  })

  it("a USDY receiver sells, then withdraws: the floor shown is step 1's SY", () => {
    const rate = 10_200_000n
    const req = sellYt("underlying")
    const ms = market({ exchangeRate: live(rate) })
    expect(plansFor(req, ms).map((p) => p.action)).toEqual(["sell_yt", "withdraw"])
    const q = quoted(quote(req, { ms }))
    expect(q).toMatchObject({ out: previewWithdraw(payout, rate), outToken: "underlying", exactness: "indicative", minOut: minAfterSlippage(payout, 50n), minOutToken: "sy" })
    expect(q.swapOut).toEqual({ amount: payout, token: "sy", exactness: "indicative", step: 1 })
  })

  it("a simulated sale is exact", () => {
    const q = quoted(quote(sellYt("sy"), { firstStep: { action: "sell_yt", output: { kind: "amount", value: payout - 10n } } }))
    expect(q).toMatchObject({ out: payout - 10n, exactness: "simulated" })
  })

  it("a YT the pool would pay nothing for is not quoted", () => {
    // A curve exponent of 1 prices PT at par: the PT bought back costs all a YT recombines into, plus the fee.
    const late = { ...A, exponent: 10n ** 18n }
    const r = quote(sellYt("sy"), { ms: market({ poolState: live(late) }) })
    expect(r.status).toBe("unavailable")
  })
})

describe("maxSpend — Max is the balance divided by the moved ratio (spec §4)", () => {
  const quoteAt = (req: TradeRequest, ms = market()) => (amount: bigint) => quote({ ...req, amount }, { ms, plans: plansFor({ ...req, amount }, ms) })
  const BALANCE = 100_000_000_000n // 10,000

  it("with the field empty: from a reference solve, floored, and what it moves fits the balance", () => {
    const at = quoteAt(buyYt("underlying"))
    const ref = BALANCE / 100n
    const refCapital = quoted(at(ref)).capital!
    const r = maxSpend(at, BALANCE)
    expect(r).toEqual({ ok: true, amount: (BALANCE * ref) / refCapital.moved })
    if (!r.ok) return
    expect(quoted(at(r.amount)).capital!.moved).toBeLessThanOrEqual(BALANCE)
  })

  it("from a typed spend larger than Max, it still never moves more than the balance", () => {
    const at = quoteAt(buyYt("sy"))
    const r = maxSpend(at, BALANCE, 5_000_000_000n)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(quoted(at(r.amount)).capital!.moved).toBeLessThanOrEqual(BALANCE)
    expect(r.amount).toBeLessThan(5_000_000_000n)
  })

  /** A stand-in trade: it moves `multiple` × the spend, and cannot be priced above `limit`. */
  const stubTrade = (multiple: bigint, limit: bigint) => (amount: bigint): Live<TradeQuote> =>
    amount > limit
      ? { status: "unavailable", error: "The pool cannot absorb the PT this purchase would sell." }
      : ({ status: "live", value: { capital: { moved: amount * multiple, spent: amount, back: 0n, backStep: 1 } }, ledger: 1 } as unknown as Live<TradeQuote>)

  it("a candidate the trade cannot price backs off to a smaller spend, as one that moves too much does", () => {
    // Moving 10x, 1000 would allow 100; above 50 the pool refuses: Max is 100 / 4.
    expect(maxSpend(stubTrade(10n, 50n), 1000n)).toEqual({ ok: true, amount: 25n })
  })

  it("a trade that reports nothing moved has its own reason", () => {
    const r = maxSpend(stubTrade(0n, 10_000n), 1000n)
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/reports nothing moved/) })
    expect(!r.ok && r.reason).not.toMatch(/has not loaded/)
  })

  it("a trade with no capital disclosure may spend the whole balance", () => {
    expect(maxSpend(quoteAt(sellYt("sy")), BALANCE)).toEqual({ ok: true, amount: BALANCE })
  })
})
