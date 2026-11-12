// @vitest-environment node
/**
 * Trade adapter #1 (ruling R2-55): quotes from the curve port on a realistic pool, and the routes
 * of today's contracts. The pool is curve.test.ts's state A (150 days left, oracle 1.05, fee
 * 0.3 % x 150/365), whose figures the Rust contract printed: buying with 100 SY gives 107.0237019
 * PT for a 0.1232877 SY fee and moves `implied_rate` 501023 -> 498176; selling 100 PT gives
 * 93.1966515 SY for a 0.1150419 SY fee (gross 93.3116934) and moves it to 503687.
 */
import { describe, expect, it } from "vitest"
import { buyExactPt, buyPt, impliedRate, sellPt, spotPrice, zapSplit, type CurveState } from "../curve"
import { minAfterSlippage, type ActionOutput } from "../guards"
import type { MarketState } from "../market-state"
import { aprToApy, BPS, ceilDiv, FEE_RATE_SCALE, SCALE } from "../math"
import { previewAddLiquidity, previewAddLiquiditySingleSy, previewDeposit, previewMint, previewRedeemPt, previewRemoveLiquidity, previewSellYt, previewWithdraw } from "../previews"
import { priceImpactPpm, ptSpot } from "../prices"
import { effectiveFixedApy, effectiveImpliedApy, fixedPayoffUsd, leverage } from "../rates"
import { planRoute, resolveStep, type RouteRequest, type StepPlan } from "../routes"
import { currentContractsAdapter, maxSpend, sizeKeepYtShares, toRouteRequest, type PlanContext, type TradeQuote, type TradeRequest } from "../trade-adapter"
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

type MarketRead = "poolState" | "oracleRate" | "exchangeRate" | "tokenizationBps" | "settledRate" | "ytFrozen" | "ytAccruedIndex"
function market(over: Partial<Record<MarketRead, Live<unknown>>> = {}): MarketState {
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

/** The five one-step Router functions a 97ac23e manifest lists (R4-3). */
const FIVE = ["swap_underlying_for_pt", "swap_pt_for_underlying", "swap_underlying_for_yt", "swap_yt_for_underlying", "add_liquidity_keep_yt"]

/** A one-step route, as `planRoute` builds it when the manifest lists the kind's Router function. */
function oneStep(req: TradeRequest): StepPlan[] {
  const plans = planRoute(toRouteRequest(req, CTX), { routerFunctions: FIVE })
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
    expect(q.apyAfter).toBeLessThan(q.apyBefore!)
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
    expect(q.apyAfter).toBeGreaterThan(q.apyBefore!)
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
    const q = quoted(quote(req, { plans: oneStep(req), firstStep: { action: "buy_pt_underlying", output: { kind: "amount", value: simulated } } }))
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
    const q = quoted(quote(req, { ms, plans: oneStep(req), firstStep: { action: "sell_pt_underlying", output: { kind: "amount", value: usdy } } }))
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
    expect(q.apyAfter).toBeGreaterThan(q.apyBefore!)
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
    expect(q.apyAfter).toBeLessThan(q.apyBefore!)
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

// ---------------------------------------------------------------------------------------------
// LP (Task 18): Keep YT splits USDY into PT + YT and SY at the pool's ratio; Keep YT off zaps the SY (R4-7);
// a withdraw removes, then sells the PT (or redeems it after maturity, R2-20).
// ---------------------------------------------------------------------------------------------

const USDY_100_LP = 1_000_000_000n
const keepYt = (pay: TradeRequest["pay"] = "underlying", amount = USDY_100_LP): TradeRequest => ({ kind: "lp_keep_yt", amount, pay, receive: pay })
const lpOnly = (amount = USDY_100_LP): TradeRequest => ({ kind: "lp_only", amount, pay: "underlying", receive: "underlying" })
const withdrawLp = (receive: TradeRequest["receive"], amount = 10_000_000_000n): TradeRequest => ({ kind: "lp_withdraw", amount, pay: receive, receive })
const RESERVES = { pt: A.ptReserve, sy: A.syReserve }
const valueOf = (plan: StepPlan) => (plan.amount.from === "value" ? plan.amount.value : undefined)

/** The legs a split gives, through the wrapper's and the manager's own math. */
function legsOf(mintUnderlying: bigint, depositUnderlying: bigint, rate = SCALE) {
  const mint = previewMint(previewDeposit(mintUnderlying, rate), ORACLE, FEE_BPS)
  const sy = previewDeposit(depositUnderlying, rate)
  return { mint, sy, add: previewAddLiquidity(mint.pt, sy, RESERVES, A.totalLp) }
}

describe("trade adapter #1 — LP Keep YT: the split at the pool's ratio", () => {
  it("Keep YT split puts PT and SY in the pool ratio: 100 USDY mints 62.1739366 and deposits 37.8260634, with no dust", () => {
    const plans = plansFor(keepYt())
    expect(plans.map((p) => p.action)).toEqual(["mint", "deposit", "add_liquidity"])
    const mintUnderlying = valueOf(plans[0])!
    const depositUnderlying = valueOf(plans[1])!
    expect(mintUnderlying).toBe(621_739_366n)
    expect(depositUnderlying).toBe(378_260_634n)
    expect(mintUnderlying + depositUnderlying).toBe(USDY_100_LP)
    // The PT minted after the 0.10 % fee and the SY deposited are in the pool's PT : SY ratio.
    const { mint, sy, add } = legsOf(mintUnderlying, depositUnderlying)
    expect(mint.pt).toBe(652_173_507n)
    expect(sy).toBe(378_260_634n)
    expect(Number(mint.pt) / Number(sy)).toBeCloseTo(Number(A.ptReserve) / Number(A.syReserve), 6)
    // add_liquidity takes both legs whole.
    expect(add).toEqual({ lp: 495_651_865n, ptUsed: mint.pt, syUsed: sy })
    // The add step takes what steps 1 and 2 really produced.
    expect(plans[2]).toMatchObject({ amount: { from: "step", index: 0, field: "pt_minted" }, secondaryAmount: { from: "step", index: 1, field: "value" } })
  })

  it("at an SY rate of 1.02 the split leaves at most one raw SY behind, and no split gives more LP", () => {
    const rate = 10_200_000n
    const ms = market({ exchangeRate: live(rate) })
    const plans = plansFor(keepYt(), ms)
    const m = valueOf(plans[0])!
    const d = valueOf(plans[1])!
    expect([m, d]).toEqual([621_739_365n, 378_260_635n])
    const { mint, sy, add } = legsOf(m, d, rate)
    expect(mint.pt - add.ptUsed).toBe(0n)
    expect(sy - add.syUsed).toBe(1n)
    // One raw USDY more on either side gives no more LP.
    for (const k of [-1n, 1n]) expect(legsOf(m + k, d - k, rate).add.lp).toBeLessThanOrEqual(add.lp)
    // The quote names the dust that stays in the wallet.
    expect(quoted(quote(keepYt(), { ms, plans })).leftover).toEqual([{ amount: 1n, token: "sy" }])
  })

  it("output LP and YT; the fixed APY does not move; no price impact; the fee is the tokenization fee on the split part", () => {
    const q = quoted(quote(keepYt()))
    const { mint, add } = legsOf(621_739_366n, 378_260_634n)
    expect(q).toMatchObject({ out: add.lp, outToken: "lp", exactness: "indicative", minOut: minAfterSlippage(add.lp, 50n), minOutToken: "lp" })
    expect(q.alsoOut).toEqual({ amount: mint.yt, token: "yt", exactness: "indicative" })
    expect(q.splitPart).toBe(621_739_366n)
    expect(q.fee).toBe(previewWithdraw(mint.feeShares, SCALE))
    expect(q.feeToken).toBe("underlying")
    expect(q.priceImpactPpm).toBe(0n)
    expect(q.leftover).toEqual([])
    // At the pool's ratio the price, so the fixed APY, stays where it was.
    const after = impliedRate({ ...A, ptReserve: A.ptReserve + add.ptUsed, syReserve: A.syReserve + add.syUsed, totalLp: A.totalLp + add.lp })
    expect(q.apyBefore).toBe(apy(impliedRate(A)))
    expect(q.apyAfter).toBe(apy(after))
    expect(Math.abs(q.apyAfter! - q.apyBefore!)).toBeLessThan(1e-6)
  })

  it("a simulated mint makes the YT kept exact, and the LP is priced from its PT", () => {
    const plans = plansFor(keepYt())
    const sim = { kind: "mint" as const, pt_minted: 652_173_000n, yt_minted: 652_173_000n, fee_shares: 621_740n }
    const q = quoted(quote(keepYt(), { plans, firstStep: { action: "mint", output: sim } }))
    expect(q.alsoOut).toEqual({ amount: sim.yt_minted, token: "yt", exactness: "simulated" })
    expect(q.out).toBe(previewAddLiquidity(sim.pt_minted, 378_260_634n, RESERVES, A.totalLp).lp)
    // The LP still waits for step 3's own simulation.
    expect(q.exactness).toBe("indicative")
  })

  it("pool share before → after, from the LP held; without it, none", () => {
    const held = 7_600_000_000n // 1 % of the supply
    const q = quoted(quote(keepYt(), { heldLp: held }))
    expect(q.poolShare!.before).toBeCloseTo(0.01, 12)
    expect(q.poolShare!.after).toBeCloseTo(Number(held + q.out) / Number(A.totalLp + q.out), 12)
    expect(quoted(quote(keepYt())).poolShare).toBeUndefined()
  })

  it("paying in SY is not offered (R2-22): the split needs Router.wrap_and_mint, which takes USDY", () => {
    const plans = currentContractsAdapter.plan(keepYt("sy"), { ...CTX, ms: market() })
    expect(plans).toEqual({ disabled: expect.stringMatching(/needs USDY/) })
  })

  it("with no amount yet the route keeps its shape and moves nothing; without market data it cannot be sized", () => {
    const empty = currentContractsAdapter.plan(keepYt("underlying", 0n), { ...CTX, ms: market() })
    expect(Array.isArray(empty) && empty.map((p) => [p.action, valueOf(p)])).toEqual([["mint", 0n], ["deposit", 0n], ["add_liquidity", undefined]])
    expect(currentContractsAdapter.plan(keepYt(), CTX)).toEqual({ disabled: expect.stringMatching(/has not loaded yet/) })
  })

  it("an unseeded pool or a missing fee is not sized or quoted, with the reason", () => {
    const unseeded = market({ poolState: live({ ...A, totalLp: 0n, ptReserve: 0n, syReserve: 0n }) })
    expect(currentContractsAdapter.plan(keepYt(), { ...CTX, ms: unseeded })).toEqual({ disabled: expect.stringMatching(/Pool not seeded yet/) })
    expect(quote(keepYt(), { ms: unseeded, plans: [] })).toEqual({ status: "unavailable", error: expect.stringMatching(/Pool not seeded yet/) })
    const noFee = market({ tokenizationBps: down })
    expect(quote(keepYt(), { ms: noFee, plans: [] })).toEqual({ status: "unavailable", error: "Could not read the tokenization fee (rpc down)." })
  })

  it("an amount too small to split, or a pool that would mint no LP for it, is disabled and Unavailable, never a throw", () => {
    const tiny = market({ poolState: live({ ...A, totalLp: 1n }) })
    for (const [req, ms] of [
      [keepYt("underlying", 1n), market()],
      [keepYt("underlying", 2n), market()],
      // One LP for a million PT: 100 USDY's legs mint no LP at all.
      [keepYt(), tiny],
    ] as const) {
      let plans: ReturnType<typeof currentContractsAdapter.plan> | undefined
      expect(() => (plans = currentContractsAdapter.plan(req, { ...CTX, ms }))).not.toThrow()
      expect(plans).toEqual({ disabled: expect.stringMatching(/too small to add any liquidity/) })
      let r: Live<TradeQuote> | undefined
      expect(() => (r = currentContractsAdapter.quote(req, { ms, slippageBps: 50n, plans: [] }))).not.toThrow()
      expect(r).toEqual({ status: "unavailable", error: expect.stringMatching(/too small to add any liquidity/) })
    }
  })

  it("after maturity adding liquidity is closed, and says withdrawing still works", () => {
    const r = quote(keepYt(), { ms: market({ poolState: live({ ...A, secondsToMaturity: 0n }) }), plans: [] })
    expect(r).toEqual({ status: "unavailable", error: expect.stringMatching(/Adding liquidity closed at maturity.*withdraw/) })
  })
})

describe("trade adapter #1 — LP only (Keep YT off, R4-7)", () => {
  const lpSy = (amount = USDY_100_LP): TradeRequest => ({ kind: "lp_only", amount, pay: "sy", receive: "sy" })
  const reserves = { pt: A.ptReserve, sy: A.syReserve }

  /** The curve's figures for `syIn` SY, as the contract works them out. */
  function zap(syIn: bigint) {
    const split = zapSplit(A, syIn)
    const buy = buyPt(A, split)
    return { split, buy, add: previewAddLiquiditySingleSy(syIn, split, { ptOut: buy.amountOut, feeShares: buy.feeShares }, reserves, A.totalLp) }
  }

  it("plans the one add for an SY payer and deposit then add for a USDY payer", () => {
    expect(plansFor(lpSy()).map((p) => p.action)).toEqual(["add_liquidity_sy"])
    expect(plansFor(lpOnly()).map((p) => p.action)).toEqual(["deposit", "add_liquidity_sy"])
  })

  it("an SY payer: the LP, the swap fee, the price impact and the pool after the add, from the zap", () => {
    const { split, buy, add } = zap(USDY_100_LP)
    const q = quoted(quote(lpSy(), { heldLp: 1_000_000_000n }))
    expect(q).toMatchObject({ kind: "lp_only", out: add.lp, outToken: "lp", exactness: "indicative", fee: buy.feeShares, feeToken: "sy" })
    expect(add.lp).toBeGreaterThan(0n)
    expect(q.minOut).toBe(minAfterSlippage(add.lp, 50n))
    expect(q.minOutToken).toBe("lp")
    expect(q.priceImpactPpm).toBe(priceImpactPpm("buy", split, buy.amountOut, ptSpot(spotPrice(A), A.rate)))
    expect(q.priceImpactPpm!).toBeGreaterThan(0n)
    // The pool once the add lands: pt − bought + pt_used, sy − fee + (split + sy_used) − split... = sy − fee + syUsed.
    const after: CurveState = { ...A, ptReserve: A.ptReserve - buy.amountOut + add.ptUsed, syReserve: A.syReserve - buy.feeShares + add.syUsed, totalLp: A.totalLp + add.lp }
    expect(q.apyBefore).toBe(apy(impliedRate(A)))
    expect(q.apyAfter).toBe(apy(impliedRate(after)))
    expect(q.poolShare).toEqual({ before: Number(1_000_000_000n) / Number(A.totalLp), after: Number(1_000_000_000n + add.lp) / Number(A.totalLp + add.lp) })
  })

  it("leftover lists the PT and SY the pool refunds", () => {
    const { buy, add } = zap(USDY_100_LP)
    const q = quoted(quote(lpSy()))
    const ptRefund = buy.amountOut - add.ptUsed
    const syRefund = USDY_100_LP - add.syUsed
    expect(q.leftover).toEqual([...(ptRefund > 0n ? [{ amount: ptRefund, token: "pt" }] : []), ...(syRefund > 0n ? [{ amount: syRefund, token: "sy" }] : [])])
    expect(ptRefund + syRefund).toBeGreaterThanOrEqual(0n)
  })

  it("a USDY payer is priced on the SY its deposit gives, the fee shown in USDY", () => {
    const rate = 10_200_000n
    const syIn = previewDeposit(USDY_100_LP, rate)
    const { buy, add } = zap(syIn)
    const q = quoted(quote(lpOnly(), { ms: market({ exchangeRate: live(rate) }) }))
    expect(q).toMatchObject({ out: add.lp, exactness: "indicative", feeToken: "underlying", fee: previewWithdraw(buy.feeShares, rate) })
  })

  it("a simulated deposit only fixes the SY priced; the LP stays indicative", () => {
    const syIn = 990_000_000n
    const { add } = zap(syIn)
    const q = quoted(quote(lpOnly(), { firstStep: { action: "deposit", output: { kind: "amount", value: syIn } } }))
    expect(q).toMatchObject({ out: add.lp, exactness: "indicative" })
  })

  it("a simulated add makes the LP, the PT used and the SY kept exact", () => {
    const { buy, add } = zap(USDY_100_LP)
    const sim: ActionOutput = { kind: "add_liquidity", pt_used: add.ptUsed - 1n, sy_used: add.syUsed - 2n, lp: add.lp - 3n }
    const q = quoted(quote(lpSy(), { firstStep: { action: "add_liquidity_sy", output: sim } }))
    expect(q).toMatchObject({ out: add.lp - 3n, exactness: "simulated" })
    expect(q.minOut).toBe(minAfterSlippage(add.lp - 3n, 50n))
    expect(q.leftover).toContainEqual({ amount: USDY_100_LP - (add.syUsed - 2n), token: "sy" })
    expect(q.leftover).toContainEqual({ amount: buy.amountOut - (add.ptUsed - 1n), token: "pt" })
  })

  it("an amount too small to add any liquidity is unavailable with the plain reason, never a throw", () => {
    for (const amount of [1n, 2n, 3n]) {
      let r: Live<TradeQuote> | undefined
      expect(() => (r = quote(lpOnly(amount), { plans: [] }))).not.toThrow()
      expect(r?.status).toBe("unavailable")
    }
    const tiny = market({ poolState: live({ ...A, totalLp: 1n }) })
    expect(quote(lpOnly(), { ms: tiny, plans: [] })).toEqual({ status: "unavailable", error: expect.stringMatching(/too small to add any liquidity/) })
  })

  it("an unseeded pool and a matured market are unavailable with the existing reasons", () => {
    const unseeded = market({ poolState: live({ ...A, totalLp: 0n, ptReserve: 0n, syReserve: 0n }) })
    expect(quote(lpOnly(), { ms: unseeded, plans: [] })).toEqual({ status: "unavailable", error: expect.stringMatching(/Pool not seeded yet/) })
    const matured = market({ poolState: live({ ...A, secondsToMaturity: 0n }) })
    expect(quote(lpOnly(), { ms: matured, plans: [] })).toEqual({ status: "unavailable", error: expect.stringMatching(/Adding liquidity closed at maturity/) })
  })
})

describe("trade adapter #1 — LP withdraw: remove, then sell the PT, or redeem it after maturity", () => {
  const LP_IN = 10_000_000_000n // 1000 LP
  const removed = previewRemoveLiquidity(LP_IN, RESERVES, A.totalLp)
  /** The pool once the LP is removed: the sale (step 2) is priced on it, not on the pool before. */
  const afterRemove: CurveState = { ...A, ptReserve: A.ptReserve - removed.pt, syReserve: A.syReserve - removed.sy, totalLp: A.totalLp - LP_IN }
  const sale = sellPt(afterRemove, removed.pt)

  it("to SY: the SY removed plus the PT sold on the pool after the removal, and the fixed APY rises (R2-15)", () => {
    const plans = plansFor(withdrawLp("sy"))
    expect(plans.map((p) => p.action)).toEqual(["remove_liquidity", "sell_pt"])
    const q = quoted(quote(withdrawLp("sy")))
    expect(q).toMatchObject({ out: removed.sy + sale.amountOut, outToken: "sy", exactness: "indicative", fee: sale.feeShares, feeToken: "sy" })
    expect(q.minOut).toBe(minAfterSlippage(q.out, 50n))
    expect(q.apyBefore).toBe(apy(impliedRate(A)))
    expect(q.apyAfter).toBe(apy(impliedRate(sale.next)))
    expect(q.apyAfter!).toBeGreaterThan(q.apyBefore!)
    // Not the sale on the pool before the removal.
    expect(sellPt(A, removed.pt).amountOut).not.toBe(sale.amountOut)
    expect(q.priceImpactPpm).toBeGreaterThan(0n)
  })

  it("to USDY: the SY removed and the sale's SY are withdrawn at the SY rate, in one last step", () => {
    const rate = 10_200_000n
    const ms = market({ exchangeRate: live(rate) })
    const plans = plansFor(withdrawLp("underlying"), ms)
    expect(plans.map((p) => p.action)).toEqual(["remove_liquidity", "sell_pt", "withdraw"])
    const q = quoted(quote(withdrawLp("underlying"), { ms, plans }))
    expect(q).toMatchObject({ out: previewWithdraw(removed.sy + sale.amountOut, rate), outToken: "underlying", fee: previewWithdraw(sale.feeShares, rate), feeToken: "underlying" })
  })

  it("a simulated removal fixes the PT and SY, and the sale is priced on its PT", () => {
    const plans = plansFor(withdrawLp("sy"))
    const sim = { kind: "remove_liquidity" as const, pt: removed.pt - 3n, sy: removed.sy - 2n }
    const q = quoted(quote(withdrawLp("sy"), { plans, firstStep: { action: "remove_liquidity", output: sim } }))
    const exactPool: CurveState = { ...A, ptReserve: A.ptReserve - sim.pt, syReserve: A.syReserve - sim.sy, totalLp: A.totalLp - LP_IN }
    expect(q.out).toBe(sim.sy + sellPt(exactPool, sim.pt).amountOut)
    expect(q.exactness).toBe("indicative")
  })

  it("pool share before → after, from the LP held", () => {
    const held = 76_000_000_000n // 10 % of the supply
    const q = quoted(quote(withdrawLp("sy"), { heldLp: held }))
    expect(q.poolShare!.before).toBeCloseTo(0.1, 12)
    expect(q.poolShare!.after).toBeCloseTo(Number(held - LP_IN) / Number(A.totalLp - LP_IN), 12)
  })

  describe("after maturity (R2-20)", () => {
    const matured = market({ poolState: live({ ...A, secondsToMaturity: 0n }), settledRate: live(ORACLE) })
    const plansAt = (req: TradeRequest) => {
      const p = currentContractsAdapter.plan(req, { ...CTX, matured: true, ms: matured })
      if (!Array.isArray(p)) throw new Error(p.disabled)
      return p
    }
    const redeemed = previewRedeemPt(removed.pt, ORACLE, SCALE)

    it("to USDY: the PT is redeemed, not sold, and only the SY removed is withdrawn", () => {
      const plans = plansAt(withdrawLp("underlying"))
      expect(plans.map((p) => p.action)).toEqual(["remove_liquidity", "redeem", "withdraw"])
      const q = quoted(quote(withdrawLp("underlying"), { ms: matured, plans }))
      expect(q).toMatchObject({ out: redeemed + previewWithdraw(removed.sy, SCALE), outToken: "underlying", fee: 0n })
      expect(q.alsoOut).toBeUndefined()
      // Nothing is sold: the pool's fixed APY is not a figure of this trade.
      expect(q.apyBefore).toBeUndefined()
      expect(q.apyAfter).toBeUndefined()
      expect(q.priceImpactPpm).toBeUndefined()
    })

    it("to SY: the SY removed is received as SY, and the redeemed part arrives in USDY", () => {
      const plans = plansAt(withdrawLp("sy"))
      expect(plans.map((p) => p.action)).toEqual(["remove_liquidity", "redeem"])
      const q = quoted(quote(withdrawLp("sy"), { ms: matured, plans }))
      expect(q).toMatchObject({ out: removed.sy, outToken: "sy" })
      expect(q.alsoOut).toEqual({ amount: redeemed, token: "underlying", exactness: "indicative" })
    })

    it("a settlement rate that cannot be read makes it Unavailable, never a guess", () => {
      const r = quote(withdrawLp("underlying"), { ms: { ...matured, settledRate: down }, plans: plansAt(withdrawLp("underlying")) })
      expect(r).toEqual({ status: "unavailable", error: expect.stringMatching(/settlement rate/) })
    })
  })
})

// ---------------------------------------------------------------------------------------------
// One-step Router functions (0004 Task 5): with the five names listed, the PT, YT and LP tabs plan
// one call (R4-3), sized as R4-4 and R4-5 say, and each quote reads that call's simulation.
// ---------------------------------------------------------------------------------------------

describe("trade adapter #1 — one-step Router functions (R4-3, R4-4, R4-5)", () => {
  const XR = 10_200_000n // 1.02 USDY per SY share
  const LISTED: PlanContext = { ...CTX, routerFunctions: FIVE }
  const planned = (req: TradeRequest, ms = market(), extra: Partial<PlanContext> = {}) => {
    const plans = currentContractsAdapter.plan(req, { ...LISTED, ms, ...extra })
    if (!Array.isArray(plans)) throw new Error(plans.disabled)
    return plans
  }
  const FALLBACK = (sy: string, k: number) =>
    `You hold ${sy} SY, so this takes ${k} signatures: the one-signature trade would withdraw all your SY. Withdraw it first (Quick actions → Withdraw) to trade in one signature.`

  it("each kind paid or received in USDY plans its one step; paid or received in SY, the old route", () => {
    expect(planned(buy("underlying")).map((p) => [p.action, p.amount])).toEqual([["buy_pt_underlying", { from: "input" }]])
    expect(planned(sell("underlying")).map((p) => [p.action, p.amount])).toEqual([["sell_pt_underlying", { from: "input" }]])
    expect(planned(sellYt("underlying")).map((p) => [p.action, p.amount])).toEqual([["sell_yt_underlying", { from: "input" }]])
    // Buy YT in USDY keeps its multi-step route until the flash is routed (R5-2, Task 3).
    expect(planned(buyYt("underlying")).map((p) => p.action)).toEqual(["deposit", "buy_yt", "withdraw"])
    expect(planned(keepYt()).map((p) => p.action)).toEqual(["add_liquidity_keep_yt"])
    expect(planned(buy("sy")).map((p) => p.action)).toEqual(["buy_pt"])
    expect(planned(sell("sy")).map((p) => p.action)).toEqual(["sell_pt"])
    expect(planned(buyYt("sy")).map((p) => p.action)).toEqual(["buy_yt"])
    expect(planned(sellYt("sy")).map((p) => p.action)).toEqual(["sell_yt"])
    expect(currentContractsAdapter.plan(keepYt("sy"), { ...LISTED, ms: market() })).toEqual({ disabled: expect.stringMatching(/needs USDY/) })
  })

  it("R4-3: a wallet holding SY keeps the two sweeping routes, and the first step says why", () => {
    const held = { syBalance: 87n }
    const sale = planned(sell("underlying"), market(), held)
    expect(sale.map((p) => p.action)).toEqual(["sell_pt", "withdraw"])
    expect(sale[0].fallback).toBe(FALLBACK("0.0000087", 2))
    const ytSale = planned(sellYt("underlying"), market(), held)
    expect(ytSale.map((p) => p.action)).toEqual(["sell_yt", "withdraw"])
    expect(ytSale[0].fallback).toBe(FALLBACK("0.0000087", 2))
    // Buy PT and Keep YT never sweep SY: one step whatever the wallet holds.
    expect(planned(buy("underlying"), market(), held).map((p) => [p.action, p.fallback])).toEqual([["buy_pt_underlying", undefined]])
    expect(planned(keepYt(), market(), held).map((p) => [p.action, p.fallback])).toEqual([["add_liquidity_keep_yt", undefined]])
    // A zero balance, or one not read: the one step (the sy_balance gate checks the live balance).
    for (const extra of [{ syBalance: 0n }, {}]) {
      for (const req of [sell("underlying"), sellYt("underlying")]) expect(planned(req, market(), extra)).toHaveLength(1)
    }
  })

  it("final review 2: the fallback reason reads the market's SY rate, so dust too small to withdraw says so", () => {
    const dust = (k: number) =>
      `You hold 0.0000001 SY, so this takes ${k} signatures: the one-signature trade would withdraw all your SY. An amount this small cannot be withdrawn, so this trade keeps its multi-step route.`
    const held = { syBalance: 1n }
    expect(planned(sell("underlying"), market(), held)[0].fallback).toBe(dust(2))
    expect(planned(sellYt("underlying"), market(), held)[0].fallback).toBe(dust(2))
    // The SY rate not read: the withdraw text stays.
    expect(planned(sell("underlying"), market({ exchangeRate: down }), held)[0].fallback).toBe(FALLBACK("0.0000001", 2))
    // A balance that withdraws to 2 raw USDY or more keeps the withdraw text.
    expect(planned(sell("underlying"), market(), { syBalance: 2n })[0].fallback).toBe(FALLBACK("0.0000002", 2))
  })

  it("Buy PT, Sell PT and Sell YT: the one step's simulation is what the user receives, exact", () => {
    const ms = market({ exchangeRate: live(XR) })
    const pt = quoted(quote(buy("underlying"), { ms, plans: planned(buy("underlying"), ms), firstStep: { action: "buy_pt_underlying", output: { kind: "amount", value: 1_060_000_000n } } }))
    expect(pt).toMatchObject({ out: 1_060_000_000n, outToken: "pt", exactness: "simulated", minOut: minAfterSlippage(1_060_000_000n, 50n), minOutToken: "pt" })
    for (const [req, action] of [
      [sell("underlying"), "sell_pt_underlying"],
      [sellYt("underlying"), "sell_yt_underlying"],
    ] as const) {
      const indicative = quoted(quote(req, { ms, plans: planned(req, ms) }))
      expect(indicative).toMatchObject({ outToken: "underlying", exactness: "indicative", minOutToken: "underlying" })
      const usdy = indicative.out - 1_000n
      const q = quoted(quote(req, { ms, plans: planned(req, ms), firstStep: { action, output: { kind: "amount", value: usdy } } }))
      expect(q).toMatchObject({ out: usdy, outToken: "underlying", exactness: "simulated", minOut: minAfterSlippage(usdy, 50n), minOutToken: "underlying" })
      expect(q.swapOut).toBeUndefined()
    }
  })

  it("a simulation of a step not in the route is never used", () => {
    const req = buyYt("underlying")
    const plans = planned(req)
    const q = quoted(quote(req, { plans, firstStep: { action: "buy_yt", output: { kind: "buy_yt", yt_out: 1n, sy_back: 1n } } }))
    expect(q.exactness).toBe("indicative")
  })

  describe("Keep YT: add_liquidity_keep_yt mints SY shares sized by the dApp (R4-4)", () => {
    const sharesOf = (amount: bigint, xr = SCALE) => previewDeposit(amount, xr)
    const mintOf = (plans: StepPlan[]) => {
      const src = plans[0].secondaryAmount
      if (src?.from !== "value") throw new Error("expected a sized mint")
      return src.value
    }
    const legs = (shares: bigint, mint: bigint) => {
      const minted = previewMint(mint, ORACLE, FEE_BPS)
      return { minted, sy: shares - mint, add: previewAddLiquidity(minted.pt, shares - mint, RESERVES, A.totalLp) }
    }

    it("deposits the whole input and mints the split that puts PT and SY in the pool's ratio", () => {
      const plans = planned(keepYt())
      expect(plans[0]).toMatchObject({ action: "add_liquidity_keep_yt", amount: { from: "input" } })
      const shares = sharesOf(USDY_100_LP)
      const mint = mintOf(plans)
      expect(mint).toBe(sizeKeepYtShares(shares, { s: A, oracleRate: ORACLE }, FEE_BPS))
      const { minted, sy, add } = legs(shares, mint)
      expect(Number(minted.pt) / Number(sy)).toBeCloseTo(Number(A.ptReserve) / Number(A.syReserve), 6)
      // One share more or less minted gives no more LP.
      for (const k of [-1n, 1n]) expect(legs(shares, mint + k).add.lp).toBeLessThanOrEqual(add.lp)
    })

    it("R5-7: the one step carries the desired PT and SY, the mint's PT and the rest of the shares, as literals", () => {
      const plans = planned(keepYt())
      const shares = sharesOf(USDY_100_LP)
      const mint = mintOf(plans)
      expect(plans[0].desired).toEqual({ pt: previewMint(mint, ORACLE, FEE_BPS).pt, sy: shares - mint })
      expect(resolveStep(plans[0], { kind: "lp_keep_yt", amount: USDY_100_LP } as RouteRequest, [])).toMatchObject({ desired: plans[0].desired })
    })

    it("Review Focus 5: the mint is at least one share and always below the deposit's shares", () => {
      for (const xr of [SCALE, XR, 9_800_000n, 10_000_001n]) {
        const ms = market({ exchangeRate: live(xr) })
        for (const amount of [2n, 3n, 7n, 100n, 12_345n, 10_000_000n, USDY_100_LP, 10_000_000_000_000n]) {
          const p = currentContractsAdapter.plan(keepYt("underlying", amount), { ...LISTED, ms })
          if (!Array.isArray(p)) {
            expect(p.disabled).toMatch(/too small to add any liquidity/)
            continue
          }
          const mint = mintOf(p)
          expect(mint).toBeGreaterThanOrEqual(1n)
          expect(mint).toBeLessThan(sharesOf(amount, xr))
        }
      }
      const reads = { s: A, oracleRate: ORACLE }
      for (const shares of [0n, 1n, 2n]) expect(() => sizeKeepYtShares(shares, reads, FEE_BPS)).toThrow(/too small to add any liquidity/)
      for (const shares of [3_000n, 10n ** 9n, 10n ** 13n]) {
        const mint = sizeKeepYtShares(shares, reads, FEE_BPS)
        expect(mint >= 1n && mint < shares).toBe(true)
      }
    })

    it("Final review 1: the split leaves no SY behind and no less LP, so Keep YT never makes the next sale multi-step (R4-3)", () => {
      // The sizing before this fix: bisection, then the most LP in lo−1..lo+2, then the least left behind.
      const windowSizing = (shares: bigint, s: CurveState, oracleRate: bigint) => {
        const at = (m: bigint) => {
          const pt = previewMint(m, oracleRate, FEE_BPS).pt
          return { pt, sy: shares - m, fromPt: (pt * s.totalLp) / s.ptReserve, fromSy: ((shares - m) * s.totalLp) / s.syReserve }
        }
        let lo = 0n
        let hi = shares
        while (lo < hi) {
          const mid = (lo + hi + 1n) / 2n
          if (at(mid).fromPt <= at(mid).fromSy) lo = mid
          else hi = mid - 1n
        }
        let best: { lp: bigint; left: bigint; syLeft: bigint } | undefined
        for (let m = lo - 1n; m <= lo + 2n; m++) {
          if (m < 1n || m >= shares) continue
          const x = at(m)
          const add = previewAddLiquidity(x.pt, x.sy, { pt: s.ptReserve, sy: s.syReserve }, s.totalLp)
          const syLeft = x.sy - add.syUsed
          const left = x.pt - add.ptUsed + syLeft
          if (!best || add.lp > best.lp || (add.lp === best.lp && left < best.left)) best = { lp: add.lp, left, syLeft }
        }
        if (!best) throw new Error("no split")
        return best
      }
      const pools: CurveState[] = [
        A,
        { ...A, ptReserve: 3_210_987_654_321n, syReserve: 1_234_567_890_123n, totalLp: 987_654_321_098n },
        { ...A, ptReserve: 1_456_789_012_345n, syReserve: 856_789_012_345n, totalLp: 98_765_432_101n },
        { ...A, ptReserve: 777_777_777_777n, syReserve: 333_333_333_333n, totalLp: 5_555_555_555_555n },
      ]
      const amounts = [1_000_003n, 12_345_678n, 987_654_321n, USDY_100_LP, 31_415_926_535n, 2_718_281_828_459n]
      let cases = 0
      let dustBefore = 0
      for (const [p, s] of pools.entries()) {
        for (const xr of [SCALE, XR, 10_000_001n, 10_734_567n]) {
          for (const oracle of [ORACLE, 10_000_000n, 10_987_654n]) {
            const ms = market({ poolState: live(s), exchangeRate: live(xr), oracleRate: live(oracle) })
            for (const amount of amounts) {
              const at = `pool ${p}, xr ${xr}, oracle ${oracle}, ${amount} USDY`
              const plans = currentContractsAdapter.plan(keepYt("underlying", amount), { ...LISTED, ms })
              if (!Array.isArray(plans)) throw new Error(`${at}: ${plans.disabled}`)
              const shares = sharesOf(amount, xr)
              const mint = mintOf(plans)
              expect(mint >= 1n && mint < shares, at).toBe(true)
              const minted = previewMint(mint, oracle, FEE_BPS)
              const add = previewAddLiquidity(minted.pt, shares - mint, { pt: s.ptReserve, sy: s.syReserve }, s.totalLp)
              expect(shares - mint - add.syUsed, `${at}: SY left`).toBe(0n)
              const before = windowSizing(shares, s, oracle)
              expect(add.lp >= before.lp, `${at}: LP ${add.lp} < ${before.lp}`).toBe(true)
              if (before.syLeft > 0n) dustBefore++
              // The quote prices the same split: nothing it says stays behind is SY.
              const q = quoted(quote(keepYt("underlying", amount), { ms, plans }))
              expect(q.out, at).toBe(add.lp)
              expect(q.leftover?.filter((l) => l.token === "sy"), at).toEqual([])
              cases++
            }
          }
        }
      }
      expect(cases).toBe(pools.length * 4 * 3 * amounts.length)
      // The grid holds states where the old sizing left SY behind.
      expect(dustBefore).toBeGreaterThan(cases / 10)
    })

    it("indicative: LP and YT from the sized split, the tokenization fee on the shares minted, and the rounding left behind", () => {
      const ms = market({ exchangeRate: live(XR) })
      const plans = planned(keepYt(), ms)
      const shares = sharesOf(USDY_100_LP, XR)
      const mint = mintOf(plans)
      const { minted, sy, add } = legs(shares, mint)
      const q = quoted(quote(keepYt(), { ms, plans }))
      expect(q).toMatchObject({ out: add.lp, outToken: "lp", exactness: "indicative", minOut: minAfterSlippage(add.lp, 50n), minOutToken: "lp", priceImpactPpm: 0n })
      expect(q.alsoOut).toEqual({ amount: minted.yt, token: "yt", exactness: "indicative" })
      expect(q).toMatchObject({ fee: previewWithdraw(minted.feeShares, XR), feeToken: "underlying", splitPart: previewWithdraw(mint, XR) })
      expect(q.leftover).toEqual([
        ...(minted.pt > add.ptUsed ? [{ amount: minted.pt - add.ptUsed, token: "pt" }] : []),
        ...(sy > add.syUsed ? [{ amount: sy - add.syUsed, token: "sy" }] : []),
      ])
    })

    it("simulated: out is the call's LP and alsoOut its YT, exact; what stays behind is yt_minted − pt_used PT and shares − mint − sy_used SY", () => {
      const plans = planned(keepYt())
      const shares = sharesOf(USDY_100_LP)
      const mint = mintOf(plans)
      const out = { kind: "keep_yt" as const, pt_used: 652_000_000n, sy_used: 378_000_000n, lp: 495_000_000n, yt_minted: 652_000_003n }
      const q = quoted(quote(keepYt(), { plans, firstStep: { action: "add_liquidity_keep_yt", output: out } }))
      expect(q).toMatchObject({ out: out.lp, outToken: "lp", exactness: "simulated", minOut: minAfterSlippage(out.lp, 50n), minOutToken: "lp" })
      expect(q.alsoOut).toEqual({ amount: out.yt_minted, token: "yt", exactness: "simulated" })
      expect(q.leftover).toEqual([
        { amount: 3n, token: "pt" },
        { amount: shares - mint - out.sy_used, token: "sy" },
      ])
      // The pool once the add lands, from the simulated amounts.
      expect(q.apyAfter).toBe(apy(impliedRate({ ...A, ptReserve: A.ptReserve + out.pt_used, syReserve: A.syReserve + out.sy_used, totalLp: A.totalLp + out.lp })))
      // A mint-step simulation is not this route's.
      const other = quoted(quote(keepYt(), { plans, firstStep: { action: "mint", output: { kind: "mint", pt_minted: 1n, yt_minted: 1n, fee_shares: 0n } } }))
      expect(other.exactness).toBe("indicative")
    })

    it("an amount too small to size, or a market not read, disables the one step with a plain reason", () => {
      expect(currentContractsAdapter.plan(keepYt("underlying", 1n), { ...LISTED, ms: market() })).toEqual({ disabled: expect.stringMatching(/too small to add any liquidity/) })
      expect(currentContractsAdapter.plan(keepYt(), LISTED)).toEqual({ disabled: expect.stringMatching(/has not loaded yet/) })
      // With no amount yet the step keeps its shape and mints nothing.
      expect(planned(keepYt("underlying", 0n)).map((p) => [p.action, p.secondaryAmount])).toEqual([["add_liquidity_keep_yt", { from: "value", value: 0n }]])
    })
  })
})
