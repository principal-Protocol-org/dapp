/**
 * The trade adapter (plan 0002 amendment of 2026-11-01, ruling R2-55): what the PT, YT and LP tabs
 * ask about a trade, behind one interface, so the contract migration replaces one module.
 *
 * - `quote(req, state)`: the figures the tab shows, pure given the market's reads. A figure that
 *   cannot be worked out makes the quote unavailable with the reason, never a guess.
 * - `plan(req, ctx)`: the route that executes it (spec §4), as `useRoute` runs it.
 *
 * Adapter #1, `currentContractsAdapter`, is the contracts at principal 97ac23e (R4-1): the pool curve
 * port (`curve.ts`), the USD-terms rates (`rates.ts`) and the routes (`routes.ts`), one Router call
 * when the manifest lists the USDY-denominated function (R4-3), else the existing actions in a row.
 * Adapter #2, the Router + RouterStatic of the migration, will implement the same interface;
 * everything contract-specific stays inside its adapter.
 *
 * Exactness (R2-55): the curve port is contract-exact on the state it is given, but the state moves,
 * so a curve figure is "indicative". A figure becomes "simulated" only when the step that produces it
 * was simulated as the user (0001's pipeline, passed in as `firstStep`). The tabs simulate a route's
 * first step before it starts, and the quote reads what that step is from the route itself (`plans`),
 * never from an assumed route shape:
 * - a one-step route (a Router function paid or received in USDY, or a trade in SY): the step's
 *   simulated output is what the user receives;
 * - a route whose first step is the swap (a sale to USDY without its one-step function): its output is
 *   simulated, and what later steps make of it (a withdraw to USDY) is worked out at today's rates, so
 *   it stays indicative;
 * - a route whose first step is a deposit (a USDY-paid buy without its one-step function): the user
 *   holds no SY yet, so the swap stays indicative until the route prepares it with its own simulation
 *   (RouteFlow shows that step's exact floor); the simulated deposit only fixes the SY the curve prices.
 *
 * Buy YT (Task 17) is sized here, in `plan` and `quote` alike: `swap_sy_for_yt` mints PT + YT from
 * `sy_in` SY the user must hold and sells the PT back, so the solver (`yt-solver.ts`) finds the
 * `sy_in` whose net cost is the spend, and the quote discloses that capital (`capital`, R2-59). The
 * one-step `swap_underlying_for_yt` is no flash swap either: it tokenizes the whole deposit the solver
 * sized, so its capital is disclosed the same way, coming back in its one step (R4-5).
 *
 * The LP tab (Task 18) is sized here too. Keep YT splits the USDY paid between `wrap_and_mint` (PT +
 * YT) and a deposit (SY) so that the PT and SY match the pool's ratio, and adds them (`sizeKeepYt`);
 * the one-step `add_liquidity_keep_yt` deposits it all and mints the SY shares this app sizes the same
 * way (`sizeKeepYtShares`, R4-4). Keep YT off (LP only, R4-7) is a zap: the pool swaps part of the SY into PT, adds both and refunds what it does not use. A withdraw
 * removes, then sells the PT, or redeems it after maturity (R2-20), and the quote reads which from
 * the route.
 */
import type { ActionId } from "./actions"
import { buyExactPt, buyPt, curveStateFrom, impliedRate, sellPt, spotPrice, zapSplit, type CurveQuote, type CurveState } from "./curve"
import { minAfterSlippage, type ActionOutput } from "./guards"
import type { MarketState } from "./market-state"
import { aprToApy, BPS, ceilDiv, FEE_RATE_SCALE, SCALE } from "./math"
import { settlementOf } from "./position"
import { previewAddLiquidity, previewAddLiquiditySingleSy, previewDeposit, previewMint, previewRecombine, previewRedeemPt, previewRemoveLiquidity, previewSellYt, previewWithdraw } from "./previews"
import { priceImpactPpm, ptSpot, ytSpot, type Spot } from "./prices"
import { apyAfterTrade, effectiveFixedApy, effectiveImpliedApy, fixedPayoffUsd, leverage } from "./rates"
import { planRoute, singleStepFor, type RouteContext, type RouteDisabled, type RouteKind, type RouteRequest, type StepPlan, type Token } from "./routes"
import type { Live } from "./types"
import { solveBuyYt, type YtSolution } from "./yt-solver"

/** The trades the PT, YT and LP tabs make (Quick actions' split and recombine are not trades). */
export type TradeKind = Exclude<RouteKind, "split" | "recombine">

/** A token a trade hands over or receives; `underlying` is the market's asset (USDY). */
export type TradeToken = "underlying" | "sy" | "pt" | "yt" | "lp"

export type Exactness = "indicative" | "simulated"

/**
 * What the user asked for. `amount` is in `pay` for a buy or a deposit, else in the token sold or
 * withdrawn (PT, YT, LP). As in `planRoute` (R2-21), a buy ignores `receive` and a sale ignores `pay`.
 */
export type TradeRequest = { kind: TradeKind; amount: bigint; pay: Token; receive: Token }

export type TradeState = {
  /** The market's reads: pool state, oracle rate, SY exchange rate, fees. */
  ms: MarketState
  /** The user's slippage tolerance, for the minimum received. */
  slippageBps: bigint
  /** The route this quote is for, as `plan` returned it: which step a simulation belongs to. */
  plans: StepPlan[]
  /**
   * The route's first step, simulated as the user for this exact request (0001's `useSimulation`).
   * Used only when its action is the route's first step; it is never taken for another step.
   */
  firstStep?: { action: ActionId; output: ActionOutput }
  /** The connected account's LP balance, for the pool share; absent without an account. */
  heldLp?: bigint
}

export type TradeQuote = {
  kind: TradeKind
  /** What the user ends with, in `outToken`. */
  out: bigint
  outToken: TradeToken
  /** Whether `out` comes from a simulation of the step producing it, or from the curve port. */
  exactness: Exactness
  /** The swap step's own output, when later steps convert it (a sale to USDY: its SY); `step` is 1-based. */
  swapOut?: { amount: bigint; token: TradeToken; exactness: Exactness; step: number }
  /**
   * A minimum at the user's slippage tolerance, in `minOutToken`. Two cases, and the tab says which:
   * - with `swapOut` (a sale converted by later steps) or a one-step route: the floor the swap's step
   *   is signed with, on this quote;
   * - otherwise, on a multi-step route (Buy YT paid in USDY without its one-step function, an LP
   *   withdraw, Keep YT without its one-step function): the floor of `out`
   *   itself on this preview, the final LP or USDY. No step is signed with it: each step gets its own
   *   floor from its own simulation once the step before it is confirmed, and a later step's floor does
   *   not exist before then.
   */
  minOut: bigint
  minOutToken: TradeToken
  /** The swap fee, in `feeToken` (the token the user pays or receives). */
  fee: bigint
  feeToken: "underlying" | "sy"
  /** Price against the pool's spot, fee included, in parts per million; undefined if not priced. */
  priceImpactPpm?: bigint
  /**
   * The fixed APY (`implied_rate`, compounded) before and once the trade has landed. Absent when the
   * trade prices nothing on the curve: a withdraw after maturity redeems its PT, it sells none.
   */
  apyBefore?: number
  apyAfter?: number
  /**
   * Buy PT: the effective fixed APY. Buy YT: the effective implied APY, the fixed rate at which the
   * YT's cost is fair (R2-17): the break-even rate. Undefined: Unavailable.
   */
  effectiveApy?: number
  /** Buy PT: the PT received, valued today at the pool's spot price, in the underlying. */
  valueToday?: bigint
  /**
   * Buy PT: the gain at maturity in USD (oracle units), fixed whatever the underlying's price does,
   * and that gain in the underlying at today's oracle rate (indicative: it falls as the price rises).
   */
  payoff?: { gainUsd: bigint; pct: number | undefined; gainUnderlying: bigint }
  /**
   * Capital the route moves beyond what it spends (Buy YT today, R2-59), in the token paid: `moved`
   * leaves the user, `back` comes back in step `backStep` (1-based, from the plan), `spent` is the
   * difference. Absent when the trade moves only what it spends (a flash swap).
   */
  capital?: { moved: bigint; spent: bigint; back: bigint; backStep: number }
  /**
   * Buy YT: the most the trade may spend at the slippage tolerance (R2-58), in the token paid, on
   * this preview. The buy step is signed with its own bound, from that step's simulation (guards.ts).
   */
  maxCost?: bigint
  /**
   * Buy YT: the underlying whose variable yield the YT earns until maturity, its YT amount (USD) at
   * today's oracle rate, floored. Indicative: it moves with the underlying's price.
   */
  yieldOn?: bigint
  /**
   * Buy YT leverage, 1 / YT price (spec §2): `trade`, the YT received per USD spent (the price this
   * trade pays); `spot`, at the pool's price before it. Undefined: Unavailable.
   */
  leverage?: { trade?: number; spot?: number }
  /**
   * What the user also ends with beside `out`, with its own exactness: Keep YT's YT (exact once the
   * mint is simulated); a withdraw to SY after maturity's redeemed PT, paid in the underlying.
   */
  alsoOut?: { amount: bigint; token: TradeToken; exactness: Exactness }
  /** The LP tab: the account's share of the LP supply before and once the trade lands; absent without its LP balance. */
  poolShare?: { before: number; after: number }
  /**
   * Keep YT: the part of the payment split into PT + YT, in the token paid; the tokenization fee is on
   * it. On the one-step route, the SY shares minted, valued in the token paid at the SY rate.
   */
  splitPart?: bigint
  /** What the trade leaves in the wallet because the pool does not take it (a two-sided add's rounding). */
  leftover?: { amount: bigint; token: TradeToken }[]
}

/** What a route needs beyond the trade: who signs, where, and what the manifest lets it call. */
export type PlanContext = {
  marketId: string
  source: string
  matured: boolean
  routerFunctions: string[]
  /** The market's reads, for adapters that size a step from them (Buy YT's `sy_in`, Task 17). */
  ms?: MarketState
  /**
   * The connected account's live SY balance; absent while it is not read. Above zero, a trade whose
   * one-step function would sweep it is planned the old way, with the reason (R4-3).
   */
  syBalance?: bigint
}

export type TradeAdapter = {
  quote(req: TradeRequest, state: TradeState): Live<TradeQuote>
  plan(req: TradeRequest, ctx: PlanContext): StepPlan[] | RouteDisabled
}

/** The route runner's request for a trade. */
export function toRouteRequest(req: TradeRequest, ctx: PlanContext): RouteRequest {
  return { kind: req.kind, marketId: ctx.marketId, source: ctx.source, amount: req.amount, pay: req.pay, receive: req.receive, matured: ctx.matured }
}

// ---------------------------------------------------------------------------------------------
// Adapter #1: today's contracts
// ---------------------------------------------------------------------------------------------

const unavailable = (error: string): Live<never> => ({ status: "unavailable", error })
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The pool swap each trade makes, in today's contracts. */
const SWAP_ACTION: Partial<Record<TradeKind, ActionId>> = { buy_pt: "buy_pt", sell_pt: "sell_pt", buy_yt: "buy_yt", sell_yt: "sell_yt" }

/**
 * What the route's simulated first step tells the quote, read from the route (`plans`):
 * - `final`: the route is that one step, so its output is what the user receives;
 * - `swap`: the step is the pool swap and later steps convert its output;
 * - `deposit`: the step deposits the underlying, so its output is the SY the swap is priced with.
 * Undefined when there is no simulation, or it is not of the route's first step.
 */
function firstStepOf(req: TradeRequest, state: TradeState): { role: "final" | "swap" | "deposit"; amount: bigint } | undefined {
  const step = state.firstStep
  const first = state.plans[0]
  if (!step || !first || step.action !== first.action || step.output.kind !== "amount") return undefined
  if (step.output.value <= 0n) throw new Error("The simulation returned nothing for this trade, so it is not offered.")
  const amount = step.output.value
  if (state.plans.length === 1) return { role: "final", amount }
  if (first.action === SWAP_ACTION[req.kind]) return { role: "swap", amount }
  if (first.action === "deposit") return { role: "deposit", amount }
  return undefined
}

/** `a / b` rounded away from zero: a loss in another unit is never understated. */
const awayFromZero = (a: bigint, b: bigint) => (a < 0n ? -ceilDiv(-a, b) : a / b)

/** The floor of `out` at the user's slippage; a floor that rounds to zero is not offered (0001). */
function floor(out: bigint, slippageBps: bigint): bigint {
  const min = minAfterSlippage(out, slippageBps)
  if (min <= 0n) throw new Error("The amount is too small for slippage protection: enter a larger amount.")
  return min
}

function payoffOf(ptOut: bigint, paidUnderlying: bigint, oracleRate: bigint): NonNullable<TradeQuote["payoff"]> {
  const { gainUsd, pct } = fixedPayoffUsd(ptOut, paidUnderlying, oracleRate)
  // A gain is floored, a loss's magnitude rounded up: the USDY figure never flatters the trade.
  return { gainUsd, pct, gainUnderlying: awayFromZero(gainUsd * SCALE, oracleRate) }
}

type Reads = { s: CurveState; oracleRate: bigint; exchangeRate: bigint; slippageBps: bigint }

const apyOf = (s: CurveState) => aprToApy(impliedRate(s), s.secondsToMaturity)

/** `swap_sy_for_pt` (market_pool lib.rs:280-300), from the curve or the simulated PT out. */
function quoteBuyPt(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s, oracleRate, exchangeRate } = r
  const payUnderlying = req.pay === "underlying"
  const first = firstStepOf(req, state)
  // A USDY payer's SY: what a simulated deposit step gave, else the wrapper's math.
  const syIn = first?.role === "deposit" ? first.amount : payUnderlying ? previewDeposit(req.amount, exchangeRate) : req.amount
  // What the user hands over, in the underlying: an SY payer's SY at the SY rate.
  const paidUnderlying = payUnderlying ? req.amount : previewWithdraw(req.amount, exchangeRate)

  const curve = buyPt(s, syIn)
  // Nothing follows a PT buy's swap: a simulated swap, or a one-step route, gives the PT out.
  const simulated = first && first.role !== "deposit" ? first.amount : undefined
  // The pool once the simulated trade lands: pt − pt_out, sy + (sy_in − fee), as the swap writes it.
  // The fee depends on `sy_in` alone, so the curve's is the contract's.
  const q: CurveQuote =
    simulated === undefined
      ? curve
      : { ...curve, amountOut: simulated, next: { ...s, ptReserve: s.ptReserve - simulated, syReserve: s.syReserve + syIn - curve.feeShares } }
  const ptOut = q.amountOut
  const spot = spotPrice(s)
  return {
    kind: "buy_pt",
    out: ptOut,
    outToken: "pt",
    exactness: simulated === undefined ? "indicative" : "simulated",
    minOut: floor(ptOut, r.slippageBps),
    minOutToken: "pt",
    fee: payUnderlying ? previewWithdraw(q.feeShares, exchangeRate) : q.feeShares,
    feeToken: payUnderlying ? "underlying" : "sy",
    priceImpactPpm: priceImpactPpm("buy", syIn, ptOut, ptSpot(spot, s.rate)),
    apyBefore: apyOf(s),
    apyAfter: apyAfterTrade(s, q),
    effectiveApy: effectiveFixedApy({ paidUnderlying, oracleRate, ptOut, secondsToMaturity: s.secondsToMaturity }),
    // PT is worth `spot` USD each; one underlying is worth `oracleRate` USD.
    valueToday: (ptOut * spot) / oracleRate,
    payoff: payoffOf(ptOut, paidUnderlying, oracleRate),
  }
}

/**
 * The pool once a PT sale whose net SY `syOut` was simulated lands. The SY out is
 * `gross − ceil(gross · fee_rate / 1e12)` and the reserves lose `gross`; the smallest gross giving
 * the simulated net is `ceil(net · 1e12 / (1e12 − fee_rate))`.
 */
function simulatedPtSale(s: CurveState, ptIn: bigint, syOut: bigint): CurveQuote {
  if (s.feeRate >= FEE_RATE_SCALE) throw new Error("The pool's swap fee takes the whole sale, so it is not offered.")
  const gross = ceilDiv(syOut * FEE_RATE_SCALE, FEE_RATE_SCALE - s.feeRate)
  return { amountIn: 0n, amountOut: syOut, feeShares: gross - syOut, next: { ...s, ptReserve: s.ptReserve + ptIn, syReserve: s.syReserve - gross } }
}

/**
 * A sale (Sell PT, Sell YT): the swap pays SY, which later steps withdraw for a USDY receiver.
 * `price(simulatedSy)` prices the swap from the curve, or from its simulated SY out when there is one;
 * `spot` is the price of the token sold, in SY, for the price impact.
 */
function saleQuote(req: TradeRequest, r: Reads, state: TradeState, price: (simulatedSy?: bigint) => CurveQuote, spot: Spot): TradeQuote {
  const { s, exchangeRate } = r
  const toUnderlying = req.receive === "underlying"
  const first = firstStepOf(req, state)
  // Later steps turn the swap's SY into USDY (a withdraw today), unless the route is one step.
  const converted = toUnderlying && state.plans.length > 1
  // The swap's simulated SY: the swap step's own output, or, for a one-step route paying USDY, the
  // smallest SY that withdraws to the simulated USDY.
  const simulated =
    first?.role === "swap" ? first.amount : first?.role === "final" ? (toUnderlying ? ceilDiv(first.amount * SCALE, exchangeRate) : first.amount) : undefined
  const q = price(simulated)
  const syOut = q.amountOut
  const swapExactness: Exactness = simulated === undefined ? "indicative" : "simulated"
  // What the user ends with: the one step's simulated output, else the swap's SY (withdrawn at
  // today's SY rate for a USDY receiver: worked out, not simulated).
  const out = first?.role === "final" ? first.amount : toUnderlying ? previewWithdraw(syOut, exchangeRate) : syOut
  const outExact: Exactness = first?.role === "final" || (!toUnderlying && simulated !== undefined) ? "simulated" : "indicative"
  const swapStep = state.plans.findIndex((p) => p.action === SWAP_ACTION[req.kind]) + 1
  return {
    kind: req.kind,
    out,
    outToken: toUnderlying ? "underlying" : "sy",
    exactness: outExact,
    ...(converted ? { swapOut: { amount: syOut, token: "sy" as const, exactness: swapExactness, step: Math.max(swapStep, 1) } } : {}),
    minOut: converted ? floor(syOut, r.slippageBps) : floor(out, r.slippageBps),
    minOutToken: converted ? "sy" : toUnderlying ? "underlying" : "sy",
    fee: toUnderlying ? previewWithdraw(q.feeShares, exchangeRate) : q.feeShares,
    feeToken: toUnderlying ? "underlying" : "sy",
    priceImpactPpm: priceImpactPpm("sell", syOut, req.amount, spot),
    apyBefore: apyOf(s),
    apyAfter: apyAfterTrade(s, q),
  }
}

/** `swap_pt_for_sy` (market_pool lib.rs:305-330), from the curve or the simulated SY out. */
function quoteSellPt(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s } = r
  const ptIn = req.amount
  const price = (simulatedSy?: bigint) => (simulatedSy === undefined ? sellPt(s, ptIn) : simulatedPtSale(s, ptIn, simulatedSy))
  return saleQuote(req, r, state, price, ptSpot(spotPrice(s), s.rate))
}

/**
 * `swap_yt_for_sy` (market_pool lib.rs:342-380), the pool's flash-redeem: it buys `yt_in` PT from its
 * own reserve at the curve's exact-out price (`buyExactPt`), recombines them with the YT and pays the
 * rest of the SY. The pool's PT reserve falls, so the fixed APY falls (R2-15).
 */
function quoteSellYt(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s, oracleRate } = r
  const ytIn = req.amount
  const price = (simulatedSy?: bigint): CurveQuote => {
    const curve = buyExactPt(s, ytIn)
    const payout = previewSellYt(ytIn, oracleRate, curve.amountIn)
    if (payout <= 0n) {
      throw new Error("Selling this YT pays nothing now: the PT the pool must buy back costs at least what the YT recombines into, so the pool refuses the sale.")
    }
    if (simulatedSy === undefined) return { ...curve, amountOut: payout }
    // The pool keeps the recombined SY less the payout: its gross cost, fee included; the reserves
    // gain that cost net of the fee (`gross · (1e12 − fee_rate) / 1e12`, floored).
    const gross = previewRecombine(ytIn, oracleRate) - simulatedSy
    if (gross <= 0n) return { ...curve, amountOut: simulatedSy }
    const net = (gross * (FEE_RATE_SCALE - s.feeRate)) / FEE_RATE_SCALE
    return { amountIn: gross, amountOut: simulatedSy, feeShares: gross - net, next: { ...s, ptReserve: s.ptReserve - ytIn, syReserve: s.syReserve + net } }
  }
  return saleQuote(req, r, state, price, ytSpot(spotPrice(s), s.rate))
}

/** Buy YT's sizes: the spend in SY, the solver's answer for it, and a USDY payer's deposit. */
type BuyYtSize = { feeBps: bigint; solution: YtSolution; depositUnderlying?: bigint }

/**
 * Sizes a Buy YT (spec §4) from the market's reads, as `plan` and `quote` both do:
 * - the spend is in the token paid; a USDY spend is converted to SY at the SY rate before solving;
 * - the solver finds the `sy_in` whose net cost (`sy_in − sy_back`) is the spend, at most;
 * - a USDY payer deposits the smallest amount whose SY is at least `sy_in`: rounded up, then checked
 *   with the wrapper's own math (the route's `requires` check is only the backstop).
 * Throws the plain-words reason when it cannot (the solver can throw on its own guards).
 */
function sizeBuyYt(req: TradeRequest, m: MarketReads, ms: MarketState): BuyYtSize {
  const { s, oracleRate, exchangeRate } = m
  if (s.secondsToMaturity <= 0n) throw new Error(MATURED)
  const feeBps = need(ms.fees.tokenizationBps, "the tokenization fee")
  if (typeof feeBps === "string") throw new Error(feeBps)
  const payUnderlying = req.pay === "underlying"
  const spendSy = payUnderlying ? previewDeposit(req.amount, exchangeRate) : req.amount
  if (spendSy <= 0n) throw new Error("This amount is too small to buy any SY with: enter a larger amount.")
  let solved: YtSolution | { error: string }
  try {
    solved = solveBuyYt(s, { spendSy, oracleRate, tokenizationFeeBps: feeBps })
  } catch (error) {
    throw new Error(`This app could not size this purchase (${errorText(error)}), so it is not offered. Try another amount.`)
  }
  if ("error" in solved) throw new Error(solved.error)
  if (!payUnderlying) return { feeBps, solution: solved }
  const depositUnderlying = ceilDiv(solved.syIn * exchangeRate, SCALE)
  if (previewDeposit(depositUnderlying, exchangeRate) < solved.syIn) {
    throw new Error("This app could not size the deposit this purchase needs, so it is not offered. Try another amount.")
  }
  return { feeBps, solution: solved, depositUnderlying }
}

/**
 * What a simulated buy tells the quote, when the route's first step is the buy:
 * - `swap_sy_for_yt` (an SY payer): the exact YT and SY back;
 * - `swap_underlying_for_yt` (one step, R4-5): the exact YT and USDY back (`back`), with the SY of
 *   its deposit (`syIn`, the wrapper's own math on the amount signed) and the least SY the PT sale
 *   returned to pay that USDY, rounded up, as guards.ts works out its bound (R4-6).
 */
function buyYtSimulation(state: TradeState, exchangeRate: bigint): { yt_out: bigint; sy_back: bigint; syIn?: bigint; back?: bigint } | undefined {
  const step = state.firstStep
  const first = state.plans[0]
  if (!step || !first || step.action !== first.action) return undefined
  const noYt = "The simulation returned no YT for this trade, so it is not offered."
  if (first.action === "buy_yt" && step.output.kind === "buy_yt") {
    if (step.output.yt_out <= 0n) throw new Error(noYt)
    return step.output
  }
  if (first.action !== "buy_yt_underlying" || step.output.kind !== "buy_yt_underlying") return undefined
  if (step.output.yt_out <= 0n) throw new Error(noYt)
  if (first.amount.from !== "value") throw new Error("This app could not read the USDY this purchase deposits, so it is not offered.")
  return {
    yt_out: step.output.yt_out,
    sy_back: ceilDiv(step.output.underlying_back * SCALE, exchangeRate),
    syIn: previewDeposit(first.amount.value, exchangeRate),
    back: step.output.underlying_back,
  }
}

/**
 * `Router.swap_sy_for_yt` (router lib.rs:335-363): mint PT + YT from `sy_in`, sell the PT back
 * (`swap_pt_for_sy`), keep the YT and the SY the sale returns. The PT sold raises the fixed APY
 * (R2-15). Every figure is in the token paid; the capital moved is the solver's `sy_in`, never
 * leverage × spend (R2-59).
 */
function quoteBuyYt(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s, oracleRate, exchangeRate, slippageBps } = r
  const payUnderlying = req.pay === "underlying"
  const { feeBps, solution, depositUnderlying } = sizeBuyYt(req, r, state.ms)
  const sim = buyYtSimulation(state, exchangeRate)
  // One-step Buy YT (R4-5) mints from all its deposit's SY: simulated, that is the SY netted below.
  const syIn = sim?.syIn ?? solution.syIn
  const ytOut = sim?.yt_out ?? solution.ytOut
  const syBack = sim?.sy_back ?? solution.syBack
  const netCost = syIn - syBack
  if (netCost <= 0n) throw new Error("A YT is priced at zero or less here, so buying YT is not offered.")

  // The mint's fee, and the PT it mints (as many as the YT) sold back to the pool.
  const mint = previewMint(syIn, oracleRate, feeBps)
  const sale = sim ? simulatedPtSale(s, sim.yt_out, syBack) : sellPt(s, mint.pt)

  const toPaid = (sy: bigint) => (payUnderlying ? previewWithdraw(sy, exchangeRate) : sy)
  const moved = payUnderlying && depositUnderlying !== undefined ? depositUnderlying : syIn
  // A simulated one step returns the USDY itself (R4-5): verbatim, never through the SY rate again.
  const back = sim?.back ?? toPaid(syBack)
  // The step that hands the sale's SY back in the token paid: the withdraw of `sy_back`, or the buy,
  // or the one step that does both (R4-5: so Max keeps treating it as a capital trade).
  const backStep =
    state.plans.findIndex((p) =>
      p.action === "buy_yt_underlying" ||
      (payUnderlying ? p.action === "withdraw" && p.amount.from === "step" && p.amount.field === "sy_back" : p.action === "buy_yt"),
    ) + 1
  // guards.ts signs max_net_cost = ceil(net cost × (1 + slippage)): the sale returns at least the rest.
  const maxNetCost = ceilDiv(netCost * (BPS + slippageBps), BPS)
  const minSyBack = maxNetCost >= syIn ? 0n : syIn - maxNetCost
  // What the YT cost, in the underlying; an SY payer's SY at the SY rate, rounded up, so the
  // break-even rate is never understated.
  const spentUnderlying = payUnderlying ? moved - back : ceilDiv(netCost * exchangeRate, SCALE)
  const spentUsd = (spentUnderlying * oracleRate) / SCALE
  const spot = spotPrice(s)
  return {
    kind: "buy_yt",
    out: ytOut,
    outToken: "yt",
    exactness: sim ? "simulated" : "indicative",
    minOut: floor(ytOut, slippageBps),
    minOutToken: "yt",
    fee: toPaid(mint.feeShares + sale.feeShares),
    feeToken: payUnderlying ? "underlying" : "sy",
    // A YT has a price only while the PT is below par.
    priceImpactPpm: spot < SCALE ? priceImpactPpm("buy", netCost, ytOut, ytSpot(spot, s.rate)) : undefined,
    apyBefore: apyOf(s),
    apyAfter: apyAfterTrade(s, sale),
    effectiveApy: effectiveImpliedApy({ spentUnderlying, oracleRate, ytOut, secondsToMaturity: s.secondsToMaturity }),
    ...(backStep > 0 ? { capital: { moved, spent: moved - back, back, backStep } } : {}),
    maxCost: moved - toPaid(minSyBack),
    yieldOn: (ytOut * SCALE) / oracleRate,
    leverage: { trade: spentUsd > 0n ? Number(ytOut) / Number(spentUsd) : undefined, spot: leverage(spot) },
  }
}

// ---------------------------------------------------------------------------------------------
// LP (Task 18)
// ---------------------------------------------------------------------------------------------

const MATURED = "This market has matured: PT and YT can no longer be traded in the pool."
const DEPOSITS_CLOSED = "Adding liquidity closed at maturity: the pool takes no new PT or SY. You can still withdraw your liquidity."
const NOT_SEEDED = "Pool not seeded yet: adding liquidity opens once the pool has its first liquidity. This app does not offer that first deposit."
const KEEP_YT_NEEDS_UNDERLYING = "Keeping YT while adding liquidity needs USDY: pay in USDY."

const seeded = (s: CurveState) => s.totalLp > 0n && s.ptReserve > 0n && s.syReserve > 0n
const reservesOf = (s: CurveState) => ({ pt: s.ptReserve, sy: s.syReserve })

/** `held` of `total` LP as a display ratio; nothing of an empty supply. */
const shareOf = (held: bigint, total: bigint) => (total > 0n ? Number(held > 0n ? held : 0n) / Number(total) : 0)

/** The account's pool share before, and once `delta` LP is minted (or burned, negative); absent without its LP. */
function poolShareOf(state: TradeState, total: bigint, delta: bigint): Pick<TradeQuote, "poolShare"> {
  const held = state.heldLp
  if (held === undefined) return {}
  return { poolShare: { before: shareOf(held, total), after: shareOf(held + delta, total + delta) } }
}

/** The route's first step, when it is `action` and was simulated with an output of `kind`. */
function simulated<K extends ActionOutput["kind"]>(state: TradeState, action: ActionId, kind: K): Extract<ActionOutput, { kind: K }> | undefined {
  const step = state.firstStep
  const first = state.plans[0]
  if (!step || !first || step.action !== first.action || first.action !== action || step.output.kind !== kind) return undefined
  return step.output as Extract<ActionOutput, { kind: K }>
}

/**
 * What a Keep YT split of `mintUnderlying` and `depositUnderlying` gives, through the contracts' own
 * math: `wrap_and_mint` deposits, then mints PT + YT from the SY less the tokenization fee
 * (router:261-273, principal_manager:380-387); the deposit gives SY (sy_wrapper:517-528).
 */
function keepYtLegs(mintUnderlying: bigint, depositUnderlying: bigint, r: MarketReads, feeBps: bigint) {
  return {
    mint: previewMint(previewDeposit(mintUnderlying, r.exchangeRate), r.oracleRate, feeBps),
    sy: previewDeposit(depositUnderlying, r.exchangeRate),
  }
}

type KeepYtSize = { mintUnderlying: bigint; depositUnderlying: bigint; feeBps: bigint }

const KEEP_YT_TOO_SMALL = "This amount is too small to add any liquidity: enter a larger amount."

/** What both Keep YT sizings need: USDY paid, a market open and seeded, and the tokenization fee. */
function keepYtFee(req: TradeRequest, s: CurveState, ms: MarketState): bigint {
  if (req.pay !== "underlying") throw new Error(KEEP_YT_NEEDS_UNDERLYING)
  if (s.secondsToMaturity <= 0n) throw new Error(DEPOSITS_CLOSED)
  if (!seeded(s)) throw new Error(NOT_SEEDED)
  const fee = need(ms.fees.tokenizationBps, "the tokenization fee")
  if (typeof fee === "string") throw new Error(fee)
  return fee
}

/**
 * Splits the USDY paid for Keep YT (spec §3) so the PT minted (after the tokenization fee) and the SY
 * deposited go into the pool at its PT : SY ratio, as plan and quote both do. `add_liquidity` takes
 * `lp = min(pt · L / P, sy · L / S)` and only the matching amounts (market_pool:421-433), so the best
 * split is where the PT side stops binding: the largest `mintUnderlying` whose PT gives no more LP
 * than its SY, found by bisection (the PT side only grows with it, the SY side only shrinks), or the
 * next one. Of those and their neighbours, the one giving the most LP wins, then the one leaving the
 * least behind, then the one minting less (less fee). Whatever the pool does not take stays in the
 * wallet; on a realistic pool it is a raw unit or two. Throws the plain-words reason when it cannot.
 */
function sizeKeepYt(req: TradeRequest, r: MarketReads, ms: MarketState): KeepYtSize {
  const { s } = r
  const fee = keepYtFee(req, s, ms)
  const paid = req.amount
  const tooSmall = KEEP_YT_TOO_SMALL
  if (paid < 2n) throw new Error(tooSmall)
  const at = (m: bigint) => {
    const { mint, sy } = keepYtLegs(m, paid - m, r, fee)
    return { m, pt: mint.pt, sy, fromPt: (mint.pt * s.totalLp) / s.ptReserve, fromSy: (sy * s.totalLp) / s.syReserve }
  }
  let lo = 0n
  let hi = paid
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    const x = at(mid)
    if (x.fromPt <= x.fromSy) lo = mid
    else hi = mid - 1n
  }
  let best: { m: bigint; lp: bigint; left: bigint } | undefined
  for (let m = lo - 1n; m <= lo + 2n; m++) {
    if (m < 1n || m >= paid) continue
    const x = at(m)
    const add = previewAddLiquidity(x.pt, x.sy, reservesOf(s), s.totalLp)
    const left = x.pt - add.ptUsed + (x.sy - add.syUsed)
    if (!best || add.lp > best.lp || (add.lp === best.lp && left < best.left)) best = { m, lp: add.lp, left }
  }
  if (!best || best.lp <= 0n) throw new Error(tooSmall)
  return { mintUnderlying: best.m, depositUnderlying: paid - best.m, feeBps: fee }
}

/**
 * One-step Keep YT's `mint_amount` (R4-4): of the `shares` SY its deposit gives, the shares to mint
 * into PT + YT (`PrincipalManager.mint`, the tokenization fee taken from them) so that the PT and the
 * `shares − mint` SY left go into the pool at its ratio. The same bisection as `sizeKeepYt`, on SY
 * shares instead of USDY, never `zap_swap_amount`, which solves a different split. Review Focus 5:
 * the answer is at least 1 and always below `shares`, since the Router adds `shares − mint` SY and a
 * mint of all of them would revert. Throws the plain-words reason when no split adds any LP.
 *
 * Then the split that leaves no SY behind (final review 1): the pool takes `ceil(lp · S / L)` SY for
 * `lp`, so minting `shares − ceil(best.lp · S / L)` keeps exactly that SY, and its PT, from at least
 * as many shares, still gives `best.lp` or more. It wins on more LP, or the same LP with less SY left.
 * The PT left grows by a raw unit or so instead, which is harmless: SY left in the wallet would send
 * every later one-signature sale and Buy YT to the multi-step route (`withdraw_all`, R4-3).
 */
export function sizeKeepYtShares(shares: bigint, reads: { s: CurveState; oracleRate: bigint }, feeBps: bigint): bigint {
  const { s, oracleRate } = reads
  if (!seeded(s)) throw new Error(NOT_SEEDED)
  if (shares < 2n) throw new Error(KEEP_YT_TOO_SMALL)
  const at = (m: bigint) => {
    const pt = previewMint(m, oracleRate, feeBps).pt
    const sy = shares - m
    return { pt, sy, fromPt: (pt * s.totalLp) / s.ptReserve, fromSy: (sy * s.totalLp) / s.syReserve }
  }
  let lo = 0n
  let hi = shares
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    const x = at(mid)
    if (x.fromPt <= x.fromSy) lo = mid
    else hi = mid - 1n
  }
  const split = (m: bigint) => {
    const x = at(m)
    const add = previewAddLiquidity(x.pt, x.sy, reservesOf(s), s.totalLp)
    const syLeft = x.sy - add.syUsed
    return { m, lp: add.lp, syLeft, left: x.pt - add.ptUsed + syLeft }
  }
  let best: ReturnType<typeof split> | undefined
  for (let m = lo - 1n; m <= lo + 2n; m++) {
    // 1 ≤ mint < shares: the Router must keep some SY to add (Review Focus 5).
    if (m < 1n || m >= shares) continue
    const x = split(m)
    if (!best || x.lp > best.lp || (x.lp === best.lp && x.left < best.left)) best = x
  }
  if (!best || best.lp <= 0n) throw new Error(KEEP_YT_TOO_SMALL)
  if (best.syLeft > 0n) {
    const m2 = shares - ceilDiv(best.lp * s.syReserve, s.totalLp)
    if (m2 >= 1n && m2 < shares) {
      const x = split(m2)
      if (x.lp > best.lp || (x.lp === best.lp && x.syLeft < best.syLeft)) best = x
    }
  }
  return best.m
}

type KeepYtSharesSize = { shares: bigint; mint: bigint; feeBps: bigint }

/** One-step Keep YT's sizes: the SY its deposit gives (the wrapper's own math), and the shares to mint. */
function sizeKeepYtOneStep(req: TradeRequest, r: MarketReads, ms: MarketState): KeepYtSharesSize {
  const feeBps = keepYtFee(req, r.s, ms)
  const shares = previewDeposit(req.amount, r.exchangeRate)
  return { shares, mint: sizeKeepYtShares(shares, r, feeBps), feeBps }
}

/**
 * Keep YT on (spec §3): mint PT + YT from part of the USDY, deposit the rest, and add the PT and SY at
 * the pool's ratio. Output: LP, and the YT kept. Nothing is swapped, so there is no price impact and
 * the pool's price, so its fixed APY, does not move; the only fee is the tokenization fee on the part
 * split. A simulated mint (the route's first step) makes the PT and YT exact; the LP stays indicative
 * until the add is simulated, when the route prepares it.
 */
function quoteKeepYt(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  if (state.plans[0]?.action === "add_liquidity_keep_yt") return quoteKeepYtOneStep(req, r, state)
  const { s, exchangeRate, slippageBps } = r
  const { mintUnderlying, depositUnderlying, feeBps } = sizeKeepYt(req, r, state.ms)
  const legs = keepYtLegs(mintUnderlying, depositUnderlying, r, feeBps)
  const sim = simulated(state, "mint", "mint")
  const pt = sim?.pt_minted ?? legs.mint.pt
  const yt = sim?.yt_minted ?? legs.mint.yt
  const feeShares = sim?.fee_shares ?? legs.mint.feeShares
  const add = previewAddLiquidity(pt, legs.sy, reservesOf(s), s.totalLp)
  if (add.lp <= 0n) throw new Error("This amount is too small to add any liquidity: enter a larger amount.")
  // The pool once the add lands: pt + pt_used, sy + sy_used, total + lp (market_pool:436-441).
  const after: CurveState = { ...s, ptReserve: s.ptReserve + add.ptUsed, syReserve: s.syReserve + add.syUsed, totalLp: s.totalLp + add.lp }
  const leftover: NonNullable<TradeQuote["leftover"]> = [
    ...(pt > add.ptUsed ? [{ amount: pt - add.ptUsed, token: "pt" as const }] : []),
    ...(legs.sy > add.syUsed ? [{ amount: legs.sy - add.syUsed, token: "sy" as const }] : []),
  ]
  return {
    kind: "lp_keep_yt",
    out: add.lp,
    outToken: "lp",
    exactness: "indicative",
    alsoOut: { amount: yt, token: "yt", exactness: sim ? "simulated" : "indicative" },
    // The floor of the LP on this preview: step 3 is signed with its own, from its own simulation.
    minOut: floor(add.lp, slippageBps),
    minOutToken: "lp",
    fee: previewWithdraw(feeShares, exchangeRate),
    feeToken: "underlying",
    priceImpactPpm: 0n,
    apyBefore: apyOf(s),
    apyAfter: apyOf(after),
    splitPart: mintUnderlying,
    leftover,
    ...poolShareOf(state, s.totalLp, add.lp),
  }
}

/**
 * One-step Keep YT (R4-4): `add_liquidity_keep_yt` deposits the whole payment, mints `mint` of its
 * SY shares into PT + YT and adds the PT and the rest of the SY, in one call. The mint is the one the
 * route signs (`plans`), else sized again from the same reads. Simulated, its LP and YT are exact,
 * and so is what the pool did not take: `yt_minted − pt_used` PT (PT is minted 1:1 with YT) and
 * `shares − mint − sy_used` SY. Nothing is swapped: no price impact, the tokenization fee only.
 */
function quoteKeepYtOneStep(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s, exchangeRate, oracleRate, slippageBps } = r
  const sized = sizeKeepYtOneStep(req, r, state.ms)
  const { shares, feeBps } = sized
  const signed = state.plans[0]?.secondaryAmount
  const mint = signed?.from === "value" ? signed.value : sized.mint
  if (mint < 1n || mint >= shares) throw new Error("This app could not size the split for this amount, so it is not offered. Try another amount.")
  const minted = previewMint(mint, oracleRate, feeBps)
  const syLeg = shares - mint
  const sim = simulated(state, "add_liquidity_keep_yt", "keep_yt")
  if (sim && sim.lp <= 0n) throw new Error("The simulation returned no LP for this amount, so it is not offered.")
  const add = sim ? { lp: sim.lp, ptUsed: sim.pt_used, syUsed: sim.sy_used } : previewAddLiquidity(minted.pt, syLeg, reservesOf(s), s.totalLp)
  if (add.lp <= 0n) throw new Error(KEEP_YT_TOO_SMALL)
  const pt = sim ? sim.yt_minted : minted.pt
  const yt = sim ? sim.yt_minted : minted.yt
  const exactness: Exactness = sim ? "simulated" : "indicative"
  // The pool once the add lands: pt + pt_used, sy + sy_used, total + lp (market_pool:436-441).
  const after: CurveState = { ...s, ptReserve: s.ptReserve + add.ptUsed, syReserve: s.syReserve + add.syUsed, totalLp: s.totalLp + add.lp }
  const leftover: NonNullable<TradeQuote["leftover"]> = [
    ...(pt > add.ptUsed ? [{ amount: pt - add.ptUsed, token: "pt" as const }] : []),
    ...(syLeg > add.syUsed ? [{ amount: syLeg - add.syUsed, token: "sy" as const }] : []),
  ]
  return {
    kind: "lp_keep_yt",
    out: add.lp,
    outToken: "lp",
    exactness,
    alsoOut: { amount: yt, token: "yt", exactness },
    // The one step is signed with this floor, from its own simulation (guards.ts: min_lp_out).
    minOut: floor(add.lp, slippageBps),
    minOutToken: "lp",
    fee: previewWithdraw(minted.feeShares, exchangeRate),
    feeToken: "underlying",
    priceImpactPpm: 0n,
    apyBefore: apyOf(s),
    apyAfter: apyOf(after),
    splitPart: previewWithdraw(mint, exchangeRate),
    leftover,
    ...poolShareOf(state, s.totalLp, add.lp),
  }
}

/**
 * Keep YT off, LP only (R4-7): `add_liquidity_single_sy` takes the whole `sy_in`, swaps `zapSplit` of it
 * into PT (paying the swap fee), adds the PT and the rest of the SY at the post-swap ratio and refunds
 * what it did not use: the PT bought beyond the LP minted and the SY left over. A USDY payer deposits
 * first, so the SY is the wrapper's math on the amount (R4-7 deposit then add), or the simulated
 * deposit's output, which only fixes the SY priced; the add stays indicative until it is simulated.
 * An SY payer's one step, simulated, makes the LP, `pt_used` and `split + sy_used` exact.
 */
function quoteLpOnly(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s, exchangeRate, slippageBps } = r
  if (!seeded(s)) throw new Error(NOT_SEEDED)
  const payUnderlying = req.pay === "underlying"
  const first = firstStepOf(req, state)
  const syIn = first?.role === "deposit" ? first.amount : payUnderlying ? previewDeposit(req.amount, exchangeRate) : req.amount
  if (syIn <= 0n) throw new Error(KEEP_YT_TOO_SMALL)
  const split = zapSplit(s, syIn)
  const buy = buyPt(s, split)
  const add = previewAddLiquiditySingleSy(syIn, split, { ptOut: buy.amountOut, feeShares: buy.feeShares }, reservesOf(s), s.totalLp)
  const sim = simulated(state, "add_liquidity_sy", "add_liquidity")
  const lp = sim ? sim.lp : add.lp
  if (lp <= 0n) throw new Error(KEEP_YT_TOO_SMALL)
  const ptUsed = sim ? sim.pt_used : add.ptUsed
  // The contract returns `split + sy_used`: what it kept of `sy_in`.
  const syUsed = sim ? sim.sy_used : add.syUsed
  // The pool once the add lands: pt − pt_bought + pt_used, sy + (split − fee) + (syUsed − split), total + lp.
  const after: CurveState = {
    ...s,
    ptReserve: s.ptReserve - buy.amountOut + ptUsed,
    syReserve: s.syReserve - buy.feeShares + syUsed,
    totalLp: s.totalLp + lp,
  }
  const ptRefund = buy.amountOut - ptUsed
  const syRefund = syIn - syUsed
  const leftover: NonNullable<TradeQuote["leftover"]> = [
    ...(ptRefund > 0n ? [{ amount: ptRefund, token: "pt" as const }] : []),
    ...(syRefund > 0n ? [{ amount: syRefund, token: "sy" as const }] : []),
  ]
  return {
    kind: "lp_only",
    out: lp,
    outToken: "lp",
    exactness: sim ? "simulated" : "indicative",
    // The one step is signed with this floor when it is the route's only step (guards.ts: min_lp_out).
    minOut: floor(lp, slippageBps),
    minOutToken: "lp",
    fee: payUnderlying ? previewWithdraw(buy.feeShares, exchangeRate) : buy.feeShares,
    feeToken: payUnderlying ? "underlying" : "sy",
    priceImpactPpm: priceImpactPpm("buy", split, buy.amountOut, ptSpot(spotPrice(s), s.rate)),
    apyBefore: apyOf(s),
    apyAfter: apyOf(after),
    leftover,
    ...poolShareOf(state, s.totalLp, lp),
  }
}

/**
 * A withdraw (spec §3): `remove_liquidity` (market_pool:1089-1090), then, before maturity, the PT
 * sold (`swap_pt_for_sy`) on the pool as the removal left it, which raises the fixed APY (R2-15); a
 * USDY receiver then withdraws the SY removed and the sale's SY together. After maturity the PT is
 * redeemed at the settlement rate instead (Router.redeem_at_maturity pays the underlying), and only
 * the SY removed is withdrawn (R2-20): with SY received, the redeemed part still arrives in USDY.
 * Which of the two the route does is read from the route (`plans`). A simulated removal makes the PT
 * and SY exact; what the later steps give stays indicative.
 */
function quoteLpWithdraw(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s, exchangeRate, slippageBps } = r
  const lpIn = req.amount
  if (s.totalLp <= 0n) throw new Error("The pool has no liquidity, so there is nothing to withdraw.")
  const sim = simulated(state, "remove_liquidity", "remove_liquidity")
  const removed = sim ? { pt: sim.pt, sy: sim.sy } : previewRemoveLiquidity(lpIn, reservesOf(s), s.totalLp)
  const toUnderlying = req.receive === "underlying"
  const outToken: TradeToken = toUnderlying ? "underlying" : "sy"
  const share = poolShareOf(state, s.totalLp, -lpIn)
  const redeems = state.plans.length > 0 ? state.plans.some((p) => p.action === "redeem") : s.secondsToMaturity <= 0n

  if (redeems) {
    const settlement = settlementOf(state.ms)
    if (settlement.status !== "live") throw new Error(`Could not read the settlement rate (${settlement.error}).`)
    const redeemed = removed.pt > 0n ? previewRedeemPt(removed.pt, settlement.value.rate, exchangeRate) : 0n
    const out = toUnderlying ? redeemed + previewWithdraw(removed.sy, exchangeRate) : removed.sy
    return {
      kind: "lp_withdraw",
      out,
      outToken,
      exactness: "indicative",
      ...(toUnderlying ? {} : { alsoOut: { amount: redeemed, token: "underlying" as const, exactness: "indicative" as const } }),
      // The floor of the final amount on this preview, not a signed step floor (see `minOut`).
      minOut: floor(out, slippageBps),
      minOutToken: outToken,
      // Redeeming PT at maturity takes no fee (principal_manager:494-504), and nothing is swapped.
      fee: 0n,
      feeToken: toUnderlying ? "underlying" : "sy",
      ...share,
    }
  }

  if (s.secondsToMaturity <= 0n) throw new Error(MATURED)
  const pool: CurveState = { ...s, ptReserve: s.ptReserve - removed.pt, syReserve: s.syReserve - removed.sy, totalLp: s.totalLp - lpIn }
  const sale = sellPt(pool, removed.pt)
  const sy = removed.sy + sale.amountOut
  const out = toUnderlying ? previewWithdraw(sy, exchangeRate) : sy
  return {
    kind: "lp_withdraw",
    out,
    outToken,
    exactness: "indicative",
    // The floor of the final amount on this preview, not a signed step floor (see `minOut`).
    minOut: floor(out, slippageBps),
    minOutToken: outToken,
    fee: toUnderlying ? previewWithdraw(sale.feeShares, exchangeRate) : sale.feeShares,
    feeToken: toUnderlying ? "underlying" : "sy",
    priceImpactPpm: priceImpactPpm("sell", sale.amountOut, removed.pt, ptSpot(spotPrice(pool), s.rate)),
    apyBefore: apyOf(s),
    apyAfter: apyOf(sale.next),
    ...share,
  }
}

/** A read the quote needs, or the reason naming it. */
function need<T>(value: Live<T>, what: string): T | string {
  return value.status === "live" ? value.value : `Could not read ${what} (${value.error}).`
}

type MarketReads = Omit<Reads, "slippageBps">

/** The pool, the oracle rate and the SY exchange rate, or the reason naming the read that failed. */
function readsOf(ms: MarketState): MarketReads | string {
  const pool = need(ms.poolState, "the pool")
  if (typeof pool === "string") return pool
  const oracleRate = need(ms.oracleRate, "the oracle rate")
  if (typeof oracleRate === "string") return oracleRate
  const exchangeRate = need(ms.exchangeRate, "the SY exchange rate")
  if (typeof exchangeRate === "string") return exchangeRate
  const s = curveStateFrom(ms)
  if (!s) return "Could not read the pool."
  return { s, oracleRate, exchangeRate }
}

const QUOTES: Partial<Record<TradeKind, (req: TradeRequest, r: Reads, state: TradeState) => TradeQuote>> = {
  buy_pt: quoteBuyPt,
  sell_pt: quoteSellPt,
  buy_yt: quoteBuyYt,
  sell_yt: quoteSellYt,
  lp_keep_yt: quoteKeepYt,
  lp_only: quoteLpOnly,
  lp_withdraw: quoteLpWithdraw,
}

function quote(req: TradeRequest, state: TradeState): Live<TradeQuote> {
  const { ms } = state
  const m = readsOf(ms)
  if (typeof m === "string") return unavailable(m)
  // A withdraw stays open at maturity: it redeems its PT instead of selling it.
  if (m.s.secondsToMaturity <= 0n && req.kind !== "lp_withdraw") return unavailable(req.kind === "lp_keep_yt" || req.kind === "lp_only" ? DEPOSITS_CLOSED : MATURED)
  if (req.amount <= 0n) return unavailable("Enter an amount greater than zero.")
  const run = QUOTES[req.kind]
  if (!run) return unavailable("This trade is not quoted by this app yet.")
  try {
    return { status: "live", value: run(req, { ...m, slippageBps: state.slippageBps }, state), ledger: ms.poolState.status === "live" ? ms.poolState.ledger : 0 }
  } catch (error) {
    // A `MathError` is the pool's own refusal, already in plain words.
    return unavailable(errorText(error))
  }
}

/**
 * The route for a trade (spec §4): the one-step Router function when the manifest lists it, unless
 * the wallet holds SY it would sweep (R4-3), else the existing actions. Buy YT's steps are sized here,
 * from the market's reads: the deposit moves about leverage × the spend and the buy uses the solver's
 * `sy_in`, both as `value` amounts, so the gates checked before the route starts see what each step
 * moves (R2-57); the one step signs that same deposit (R4-5).
 */
function plan(req: TradeRequest, ctx: PlanContext): StepPlan[] | RouteDisabled {
  const route = toRouteRequest(req, ctx)
  const base: RouteContext = { routerFunctions: ctx.routerFunctions, ...(ctx.syBalance !== undefined ? { syBalance: ctx.syBalance } : {}) }
  // Keep YT's split is sized from the market's reads; paid in SY, the planner gives R2-22's reason.
  if (req.kind === "lp_keep_yt" && req.pay === "underlying") return planKeepYt(req, ctx, route, base)
  if (req.kind !== "buy_yt") return planRoute(route, base)
  // With no amount yet, the route keeps its shape and moves nothing: it cannot start (there is no
  // request), its gates see nothing to move, and the amount field's own refusal stands.
  if (req.amount <= 0n) return planRoute(route, { ...base, buyYt: { syIn: 0n, depositUnderlying: 0n } })
  if (!ctx.ms) return { disabled: "Buy YT is sized from this market's data, which has not loaded yet. Try again in a moment." }
  const m = readsOf(ctx.ms)
  if (typeof m === "string") return { disabled: `Buy YT cannot be sized now. ${m}` }
  try {
    const { solution, depositUnderlying } = sizeBuyYt(req, m, ctx.ms)
    return planRoute(route, { ...base, buyYt: { syIn: solution.syIn, ...(depositUnderlying !== undefined ? { depositUnderlying } : {}) } })
  } catch (error) {
    return { disabled: `Buy YT is not offered for this amount. ${errorText(error)}` }
  }
}

/**
 * Keep YT's route (spec §4): `wrap_and_mint` of the split part, a deposit of the rest, then
 * `add_liquidity` of what those two steps really produced. Both amounts are `value`s, so the gates
 * checked before the route starts see what each step moves and charges (R2-61, R2-62). With
 * `add_liquidity_keep_yt` listed, the one call instead, minting the SY shares sized for it (R4-4);
 * only the split the planner will use is sized, so a refusal is always that route's.
 */
function planKeepYt(req: TradeRequest, ctx: PlanContext, route: RouteRequest, base: RouteContext): StepPlan[] | RouteDisabled {
  const oneStep = singleStepFor(route, base) !== undefined
  if (req.amount <= 0n) return planRoute(route, { ...base, keepYtSplit: { mintUnderlying: 0n, depositUnderlying: 0n }, keepYtMintSy: 0n })
  if (!ctx.ms) return { disabled: "Keep YT is sized from this market's data, which has not loaded yet. Try again in a moment." }
  const m = readsOf(ctx.ms)
  if (typeof m === "string") return { disabled: `Keep YT cannot be sized now. ${m}` }
  try {
    if (oneStep) return planRoute(route, { ...base, keepYtMintSy: sizeKeepYtOneStep(req, m, ctx.ms).mint })
    const { mintUnderlying, depositUnderlying } = sizeKeepYt(req, m, ctx.ms)
    return planRoute(route, { ...base, keepYtSplit: { mintUnderlying, depositUnderlying } })
  } catch (error) {
    return { disabled: errorText(error) }
  }
}

export const currentContractsAdapter: TradeAdapter = { quote, plan }

// ---------------------------------------------------------------------------------------------
// Max
// ---------------------------------------------------------------------------------------------

export type MaxSpend = { ok: true; amount: bigint } | { ok: false; reason: string }

/** An empty field's reference spend, as a fraction of the balance. */
const MAX_REFERENCE_DIVISOR = 100n
/** After a candidate that moves too much, the next reference is this much smaller. */
const MAX_BACKOFF = 4n
/** References tried before Max gives up. */
const MAX_TRIES = 8

/**
 * Max for a buy (spec §4: "Max is the balance divided by that ratio"): `balance × spend / moved`,
 * floored, with `spend / moved` from the trade at the typed spend or, with none, at a reference spend
 * (a hundredth of the balance). A smaller buy moves a larger multiple of its spend, so a ratio taken
 * at a spend no larger than the result is the cautious one; one taken at a larger spend (a typed
 * amount above Max, or a reference above it when the multiple passes 100) would move more than the
 * balance. So every candidate is quoted again: one that moves more than the balance is replaced from
 * a reference four times smaller, and one the trade cannot price (the pool cannot take it) caps the
 * next at a quarter of it. The balance gate still checks. A trade whose quote discloses no capital
 * moves only what it spends: it may spend the whole balance.
 */
export function maxSpend(quoteAt: (amount: bigint) => Live<TradeQuote> | null, balance: bigint, typed?: bigint): MaxSpend {
  if (balance <= 0n) return { ok: true, amount: 0n }
  const fallback = balance / MAX_REFERENCE_DIVISOR > 0n ? balance / MAX_REFERENCE_DIVISOR : balance
  const quarter = (amount: bigint) => (amount / MAX_BACKOFF > 0n ? amount / MAX_BACKOFF : 1n)
  const why = (error: string) => `Max could not be worked out: ${error.replace(/\.$/, "")}.`
  let reference = typed !== undefined && typed > 0n && typed <= balance ? typed : fallback
  // The largest spend still worth trying: a spend the trade cannot price lowers it.
  let ceiling = balance
  let reason = "the trade could not be priced"
  for (let i = 0; i < MAX_TRIES; i++) {
    const at = quoteAt(reference)
    if (!at) return { ok: false, reason: why("this market's data has not loaded yet") }
    if (at.status !== "live") {
      // A typed spend the trade cannot price still leaves the reference spend; a reference it cannot
      // price backs off.
      reason = at.error
      reference = reference !== fallback && fallback <= ceiling ? fallback : quarter(reference)
      continue
    }
    const capital = at.value.capital
    if (!capital) return { ok: true, amount: balance }
    if (capital.moved <= 0n) return { ok: false, reason: why("the trade reports nothing moved for this amount") }
    const fit = (balance * reference) / capital.moved
    const candidate = fit < ceiling ? fit : ceiling
    if (candidate <= 0n) return { ok: false, reason: "Your balance does not cover what even the smallest purchase moves." }
    const check = quoteAt(candidate)
    if (!check) return { ok: false, reason: why("this market's data has not loaded yet") }
    if (check.status !== "live") {
      reason = check.error
      ceiling = quarter(candidate)
      if (reference > ceiling) reference = ceiling
      continue
    }
    if (!check.value.capital || check.value.capital.moved <= balance) return { ok: true, amount: candidate }
    reference = quarter(candidate)
  }
  return { ok: false, reason: why(reason) }
}
