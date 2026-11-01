/**
 * The trade adapter (plan 0002 amendment of 2026-11-01, ruling R2-55): what the PT, YT and LP tabs
 * ask about a trade, behind one interface, so the contract migration replaces one module.
 *
 * - `quote(req, state)`: the figures the tab shows, pure given the market's reads. A figure that
 *   cannot be worked out makes the quote unavailable with the reason, never a guess.
 * - `plan(req, ctx)`: the route that executes it (spec §4), as `useRoute` runs it.
 *
 * Adapter #1, `currentContractsAdapter`, is today's contracts (`be2a1a5`): the pool curve port
 * (`curve.ts`), the USD-terms rates (`rates.ts`) and the multi-step routes (`routes.ts`). Adapter #2,
 * the Router + RouterStatic of the migration, will implement the same interface; everything
 * contract-specific stays inside its adapter.
 *
 * Exactness (R2-55): the curve port is contract-exact on the state it is given, but the state moves,
 * so a curve figure is "indicative". A figure becomes "simulated" only when the step that produces it
 * was simulated as the user (0001's pipeline, passed in as `firstStep`). The tabs simulate a route's
 * first step before it starts, so:
 * - an SY-paid buy and every sale (the swap is step 1) can show a simulated swap output;
 * - a USDY-paid buy deposits first: the user holds no SY yet, so the swap stays indicative until
 *   the route prepares step 2 with its own simulation (RouteFlow shows that step's exact floor);
 * - a USDY received after a withdraw stays indicative: it is worked out at today's SY rate.
 */
import type { ActionId } from "./actions"
import { buyPt, curveStateFrom, impliedRate, sellPt, spotPrice, type CurveQuote, type CurveState } from "./curve"
import { minAfterSlippage, type ActionOutput } from "./guards"
import type { MarketState } from "./market-state"
import { aprToApy, ceilDiv, FEE_RATE_SCALE, SCALE } from "./math"
import { previewDeposit, previewWithdraw } from "./previews"
import { priceImpactPpm, ptSpot } from "./prices"
import { apyAfterTrade, effectiveFixedApy, fixedPayoffUsd } from "./rates"
import { planRoute, type RouteDisabled, type RouteKind, type RouteRequest, type StepPlan, type Token } from "./routes"
import type { Live } from "./types"

/** The trades the PT, YT and LP tabs make (the Tools menu's split and recombine are not trades). */
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
  /**
   * The route's first step, simulated as the user for this exact request (0001's `useSimulation`).
   * Used only when its action is the route's first step; it is never taken for another step.
   */
  firstStep?: { action: ActionId; output: ActionOutput }
}

export type TradeQuote = {
  kind: TradeKind
  /** What the user ends with, in `outToken`. */
  out: bigint
  outToken: TradeToken
  /** Whether `out` comes from a simulation of the step producing it, or from the curve port. */
  exactness: Exactness
  /** The swap step's own output, when the route converts it after (a sale to USDY: its SY). */
  swapOut?: { amount: bigint; token: TradeToken; exactness: Exactness }
  /**
   * The swap step's output at the slippage tolerance: the floor that step is signed with, in
   * `minOutToken`. A later step's floor does not exist before that step is prepared, so none is shown.
   */
  minOut: bigint
  minOutToken: TradeToken
  /** The swap fee, in `feeToken` (the token the user pays or receives). */
  fee: bigint
  feeToken: "underlying" | "sy"
  /** Price against the pool's spot, fee included, in parts per million; undefined if not priced. */
  priceImpactPpm?: bigint
  /** The fixed APY (`implied_rate`, compounded) before and once the trade has landed. */
  apyBefore: number
  apyAfter: number
  /** Buy PT: the effective fixed APY; Buy YT (Task 17): the effective implied APY. Undefined: Unavailable. */
  effectiveApy?: number
  /** Buy PT: the PT received, valued today at the pool's spot price, in the underlying. */
  valueToday?: bigint
  /**
   * Buy PT: the gain at maturity in USD (oracle units), fixed whatever the underlying's price does,
   * and that gain in the underlying at today's oracle rate (indicative: it falls as the price rises).
   */
  payoff?: { gainUsd: bigint; pct: number; gainUnderlying: bigint }
  /** Buy YT (Task 17): the YT received, and the SY the route moves (more than it spends). */
  ytOut?: bigint
  moved?: bigint
  /** LP (Task 18): the LP tokens received. */
  lpOut?: bigint
}

/** What a route needs beyond the trade: who signs, where, and what the manifest lets it call. */
export type PlanContext = {
  marketId: string
  source: string
  matured: boolean
  routerFunctions: string[]
  /** The market's reads, for adapters that size a step from them (Buy YT's `sy_in`, Task 17). */
  ms?: MarketState
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

/** Reads the swap's simulated `amount` output, when `firstStep` is that action's. */
function simulatedAmount(state: TradeState, action: ActionId): bigint | undefined {
  const step = state.firstStep
  if (!step || step.action !== action || step.output.kind !== "amount") return undefined
  if (step.output.value <= 0n) throw new Error("The simulation returned nothing for this trade, so it is not offered.")
  return step.output.value
}

/** The floor of `out` at the user's slippage; a floor that rounds to zero is not offered (0001). */
function floor(out: bigint, slippageBps: bigint): bigint {
  const min = minAfterSlippage(out, slippageBps)
  if (min <= 0n) throw new Error("The amount is too small for slippage protection: enter a larger amount.")
  return min
}

function payoffOf(ptOut: bigint, paidUnderlying: bigint, oracleRate: bigint): NonNullable<TradeQuote["payoff"]> {
  const { gainUsd, pct } = fixedPayoffUsd(ptOut, paidUnderlying, oracleRate)
  return { gainUsd, pct, gainUnderlying: (gainUsd * SCALE) / oracleRate }
}

type Reads = { s: CurveState; oracleRate: bigint; exchangeRate: bigint; slippageBps: bigint }

const apyOf = (s: CurveState) => aprToApy(impliedRate(s), s.secondsToMaturity)

/** `swap_sy_for_pt` (market_pool lib.rs:280-300), from the curve or the simulated PT out. */
function quoteBuyPt(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s, oracleRate, exchangeRate } = r
  const payUnderlying = req.pay === "underlying"
  // A USDY payer's SY is what step 1's deposit gives: simulated when it ran, else the wrapper's math.
  const deposited = payUnderlying ? simulatedAmount(state, "deposit") : undefined
  const syIn = payUnderlying ? (deposited ?? previewDeposit(req.amount, exchangeRate)) : req.amount
  // What the user hands over, in the underlying: an SY payer's SY at the SY rate.
  const paidUnderlying = payUnderlying ? req.amount : previewWithdraw(req.amount, exchangeRate)

  const curve = buyPt(s, syIn)
  const simulated = payUnderlying ? undefined : simulatedAmount(state, "buy_pt")
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

/** `swap_pt_for_sy` (market_pool lib.rs:305-330), from the curve or the simulated SY out. */
function quoteSellPt(req: TradeRequest, r: Reads, state: TradeState): TradeQuote {
  const { s, exchangeRate } = r
  const ptIn = req.amount
  const curve = sellPt(s, ptIn)
  const simulated = simulatedAmount(state, "sell_pt")
  let q: CurveQuote = curve
  if (simulated !== undefined) {
    // The SY out is `gross − ceil(gross · fee_rate / 1e12)`; the reserves lose `gross`. The smallest
    // gross giving the simulated net is `ceil(net · 1e12 / (1e12 − fee_rate))`.
    if (s.feeRate >= FEE_RATE_SCALE) throw new Error("The pool's swap fee takes the whole sale, so it is not offered.")
    const gross = ceilDiv(simulated * FEE_RATE_SCALE, FEE_RATE_SCALE - s.feeRate)
    q = { amountIn: 0n, amountOut: simulated, feeShares: gross - simulated, next: { ...s, ptReserve: s.ptReserve + ptIn, syReserve: s.syReserve - gross } }
  }
  const syOut = q.amountOut
  const swapExactness: Exactness = simulated === undefined ? "indicative" : "simulated"
  const toUnderlying = req.receive === "underlying"
  return {
    kind: "sell_pt",
    // A USDY receiver's step 2 withdraws the SY at today's SY rate: worked out, not simulated.
    out: toUnderlying ? previewWithdraw(syOut, exchangeRate) : syOut,
    outToken: toUnderlying ? "underlying" : "sy",
    exactness: toUnderlying ? "indicative" : swapExactness,
    ...(toUnderlying ? { swapOut: { amount: syOut, token: "sy" as const, exactness: swapExactness } } : {}),
    minOut: floor(syOut, r.slippageBps),
    minOutToken: "sy",
    fee: toUnderlying ? previewWithdraw(q.feeShares, exchangeRate) : q.feeShares,
    feeToken: toUnderlying ? "underlying" : "sy",
    priceImpactPpm: priceImpactPpm("sell", syOut, ptIn, ptSpot(spotPrice(s), s.rate)),
    apyBefore: apyOf(s),
    apyAfter: apyAfterTrade(s, q),
  }
}

const NOT_YET: Partial<Record<TradeKind, string>> = {
  buy_yt: "Buy YT",
  sell_yt: "Sell YT",
  lp_keep_yt: "Adding liquidity (keep YT)",
  lp_only: "Adding liquidity",
  lp_withdraw: "Withdrawing liquidity",
}

/** A read the quote needs, or the reason naming it. */
function need<T>(value: Live<T>, what: string): T | string {
  return value.status === "live" ? value.value : `Could not read ${what} (${value.error}).`
}

function quote(req: TradeRequest, state: TradeState): Live<TradeQuote> {
  const { ms } = state
  const pool = need(ms.poolState, "the pool")
  if (typeof pool === "string") return unavailable(pool)
  const oracleRate = need(ms.oracleRate, "the oracle rate")
  if (typeof oracleRate === "string") return unavailable(oracleRate)
  const exchangeRate = need(ms.exchangeRate, "the SY exchange rate")
  if (typeof exchangeRate === "string") return unavailable(exchangeRate)
  const s = curveStateFrom(ms)
  if (!s) return unavailable("Could not read the pool.")
  if (s.secondsToMaturity <= 0n) return unavailable("This market has matured: PT and YT can no longer be traded in the pool.")
  if (req.amount <= 0n) return unavailable("Enter an amount greater than zero.")
  const reads: Reads = { s, oracleRate, exchangeRate, slippageBps: state.slippageBps }
  try {
    switch (req.kind) {
      case "buy_pt":
        return { status: "live", value: quoteBuyPt(req, reads, state), ledger: ms.poolState.status === "live" ? ms.poolState.ledger : 0 }
      case "sell_pt":
        return { status: "live", value: quoteSellPt(req, reads, state), ledger: ms.poolState.status === "live" ? ms.poolState.ledger : 0 }
      default:
        return unavailable(`${NOT_YET[req.kind] ?? "This trade"} is not quoted by this app yet.`)
    }
  } catch (error) {
    // A `MathError` is the pool's own refusal, already in plain words.
    return unavailable(errorText(error))
  }
}

export const currentContractsAdapter: TradeAdapter = {
  quote,
  plan: (req, ctx) => planRoute(toRouteRequest(req, ctx), { routerFunctions: ctx.routerFunctions }),
}
