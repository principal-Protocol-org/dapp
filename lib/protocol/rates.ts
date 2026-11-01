/**
 * Rates in USD terms: the figures the market, trade and position screens show (spec 0002 §2, §3).
 *
 * PT and YT amounts are oracle units (USD for USDY). `mint` gives PT = net SY x oracle rate and a
 * PT redeems one oracle unit at maturity, so a fixed figure is in USD and the underlying paid is
 * valued at today's oracle rate. Amounts stay bigint; `number` is used only for display ratios
 * (APY, leverage, percentages).
 */
import { impliedRateAfter, type CurveQuote, type CurveState } from "./curve"
import type { MarketState } from "./market-state"
import { aprToApy, SCALE, YEAR_SECONDS } from "./math"
import { allLive } from "./reader"
import type { Live } from "./types"

const WEEK_SECONDS = 7 * 86_400

/** YT price = 1 - PT price, in oracle units per token, at `SCALE`. */
export function ytPrice(ptPrice: bigint): bigint {
  return SCALE - ptPrice
}

/** 1 / YT price; undefined when the YT price is not positive (PT at or above par). */
export function leverage(ptPrice: bigint): number | undefined {
  const yt = ytPrice(ptPrice)
  if (yt <= 0n) return undefined
  return Number(SCALE) / Number(yt)
}

function years(secondsToMaturity: bigint): number {
  return Number(secondsToMaturity) / Number(YEAR_SECONDS)
}

/** `paid` underlying valued in USD at the oracle rate (floored), both at their own scales. */
function usdValue(underlying: bigint, oracleRate: bigint): bigint {
  return (underlying * oracleRate) / SCALE
}

/**
 * Effective fixed APY of a PT buy: `(ptOut / (paid x oracleRate))^(1 / years) - 1`. Both sides are
 * in oracle units. Undefined when it cannot be computed (nothing paid or received, no time left):
 * never a zero (spec 0002 §3, ruling R2-18).
 */
export function effectiveFixedApy(p: {
  paidUnderlying: bigint
  oracleRate: bigint
  ptOut: bigint
  secondsToMaturity: bigint
}): number | undefined {
  const paidUsd = usdValue(p.paidUnderlying, p.oracleRate)
  if (paidUsd <= 0n || p.ptOut <= 0n || p.secondsToMaturity <= 0n) return undefined
  return Math.pow(Number(p.ptOut) / Number(paidUsd), 1 / years(p.secondsToMaturity)) - 1
}

/**
 * Effective implied APY of a YT buy (ruling R2-17): the rate r at which the YT's cost is fair.
 * With c = cost in USD per YT = spent x oracleRate / ytOut, the YT price is 1 - (1 + r)^(-years),
 * so r = (1 / (1 - c))^(1 / years) - 1. Undefined when c <= 0 or c >= 1, or no time is left
 * (never a zero, ruling R2-18).
 */
export function effectiveImpliedApy(p: {
  spentUnderlying: bigint
  oracleRate: bigint
  ytOut: bigint
  secondsToMaturity: bigint
}): number | undefined {
  const spentUsd = usdValue(p.spentUnderlying, p.oracleRate)
  if (spentUsd <= 0n || p.ytOut <= 0n || p.secondsToMaturity <= 0n) return undefined
  const c = Number(spentUsd) / Number(p.ytOut)
  if (c >= 1) return undefined
  return Math.pow(1 / (1 - c), 1 / years(p.secondsToMaturity)) - 1
}

/**
 * Fixed payoff at maturity in USD: `ptOut` minus the USD value of what was paid, and as a ratio of
 * it. The ratio is `undefined` when nothing was paid (R2-18: uncomputable, never 0).
 */
export function fixedPayoffUsd(
  ptOut: bigint,
  paidUnderlying: bigint,
  oracleRate: bigint,
): { gainUsd: bigint; pct: number | undefined } {
  const paidUsd = usdValue(paidUnderlying, oracleRate)
  const gainUsd = ptOut - paidUsd
  return { gainUsd, pct: paidUsd > 0n ? Number(gainUsd) / Number(paidUsd) : undefined }
}

/**
 * Annualised (compounded) growth of the oracle rate over the last 7 days of points: from the
 * oldest point within 7 days of the latest to the latest. `windowSeconds` is their distance; a
 * shorter history reports its own window, never an extrapolated one. Undefined with no usable pair.
 */
export function underlyingApy7d(
  points: { at: number; rate: bigint }[],
): { apy: number; windowSeconds: number } | undefined {
  if (points.length < 2) return undefined
  const sorted = [...points].sort((a, b) => a.at - b.at)
  const latest = sorted[sorted.length - 1]
  const oldest = sorted.find((pt) => latest.at - pt.at <= WEEK_SECONDS)
  if (!oldest) return undefined
  const windowSeconds = latest.at - oldest.at
  if (windowSeconds <= 0 || oldest.rate <= 0n || latest.rate <= 0n) return undefined
  const growth = Number(latest.rate) / Number(oldest.rate)
  return { apy: Math.pow(growth, Number(YEAR_SECONDS) / windowSeconds) - 1, windowSeconds }
}

/**
 * TVL in underlying: (SY held by the PrincipalManager + the pool's SY reserve) x exchange rate.
 * The PT reserve is backed by the manager's SY, so it is not counted. Unavailable if any input is.
 */
export function marketTvl(ms: MarketState): Live<bigint> {
  return allLive([ms.managerSy, ms.poolState, ms.exchangeRate] as const, ([managerSy, pool, rate]) =>
    ((managerSy + pool.syReserve) * rate) / SCALE,
  )
}

/** The fixed APY (pool `implied_rate`, compounded) once the quote `q` has landed. */
export function apyAfterTrade(s: CurveState, q: CurveQuote): number {
  return aprToApy(impliedRateAfter(s, q), s.secondsToMaturity)
}
