/**
 * Spot prices and price impact for the trade panels (display only, ruling R38).
 *
 * The pool values SY shares at the oracle rate, `value_of(shares, rate) = shares·rate/SCALE`
 * notional (`market_pool:772-774`), and quotes `pt_price` in notional value per PT
 * (`market_pool:637-642`). So one PT costs `pt_price / rate` SY, and one YT — the rest of the
 * notional unit PT + YT recombine into — costs `(SCALE − pt_price) / rate` SY. Prices are kept as
 * fractions so the impact is computed without an intermediate rounding.
 */
import { SCALE } from "./math"

/** Price of one token in SY: `num / den`. */
export type Spot = { num: bigint; den: bigint }

function assertPositive(value: bigint, what: string): void {
  if (value <= 0n) throw new RangeError(`${what} must be greater than zero`)
}

/** One PT in SY at the pool's spot price. Throws on a non-positive rate. */
export function ptSpot(ptPrice: bigint, rate: bigint): Spot {
  assertPositive(rate, "oracle rate")
  return { num: ptPrice, den: rate }
}

/** One YT in SY implied by the PT spot price: PT + YT recombine into one notional unit. */
export function ytSpot(ptPrice: bigint, rate: bigint): Spot {
  assertPositive(rate, "oracle rate")
  return { num: SCALE - ptPrice, den: rate }
}

/** A spot price at SCALE, floored. */
export const spotAtScale = (s: Spot) => (s.num * SCALE) / s.den

/** SY paid (or received) per token, at SCALE, floored. Throws on a non-positive token amount. */
export function effectivePrice(sy: bigint, tokenAmount: bigint): bigint {
  assertPositive(tokenAmount, "token amount")
  return (sy * SCALE) / tokenAmount
}

/**
 * How much worse than spot a trade is, in parts per million, truncated toward zero; negative when
 * it is better (the spot read may be older than the quote). `buy`: `sy` paid for `tokenAmount`
 * tokens. `sell`: `tokenAmount` tokens sold for `sy`. Swap fee included. Throws on a non-positive
 * token amount or spot price.
 */
export function priceImpactPpm(side: "buy" | "sell", sy: bigint, tokenAmount: bigint, spot: Spot): bigint {
  assertPositive(tokenAmount, "token amount")
  assertPositive(spot.num, "spot price")
  assertPositive(spot.den, "spot price denominator")
  const atSpot = tokenAmount * spot.num // SY at spot, times `den`
  const actual = sy * spot.den
  return ((side === "buy" ? actual - atSpot : atSpot - actual) * 1_000_000n) / atSpot
}

/** Parts per million as a percent with 2 decimals, truncated toward zero: 5092n -> "0.50%". */
export function formatImpact(ppm: bigint): string {
  const hundredths = ppm / 100n // 0.01% units
  const negative = hundredths < 0n
  const abs = negative ? -hundredths : hundredths
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}%`
}
