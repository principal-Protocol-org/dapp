/**
 * Port of the MarketPool curve, for indicative previews (simulation stays the source of truth).
 *
 * Sources, `principal` `origin/feat/tranche-1-mvp` (be2a1a5, the ABI pin); line references are to
 * these files:
 * - `contracts/market_pool/src/math.rs`: `ln`, `exp`, `pow`, `solve`, `exponent`, `isqrt`;
 * - `contracts/market_pool/src/lib.rs`: `calc_buy_pt`, `calc_sell_pt`, `calc_buy_exact_pt`,
 *   `zap_split`, `spot_price` and `implied_rate`.
 *
 * Integer semantics are Rust's `i128`, step for step:
 * - `/` truncates toward zero, as bigint `/` does; `>>` is an arithmetic shift in both.
 * - The workspace release profile sets `overflow-checks = true`, so a `+`, `-` or `*` that leaves
 *   i128 panics. Here it throws `MathError` (`Overflow`), as does an input outside i128, which
 *   cannot reach the contract. A division by zero panics in Rust; here it throws `Domain`.
 *   Sums of values bounded well inside i128 (the `ln`/`exp` series, `solve`'s ratios to the
 *   largest reserve) are left unchecked.
 * - Where the contract panics with an `Error`, this throws `MathError` with that error's name as
 *   `kind` (`ZeroAmount`, `InsufficientLiquidity`). `math_err` (lib.rs:780-788) maps
 *   `math::MathError::Insufficient` to `InsufficientLiquidity` and other math errors to the
 *   contract's error 16 (`MathError`); those keep their math kind (`Domain`, `Overflow`).
 */
import type { MarketState, PoolStateView } from "./market-state"
import { FEE_RATE_SCALE, SCALE } from "./math"
import { impliedRateFromPrice } from "./yield"

// ---------------------------------------------------------------------------------------------
// Errors and i128 arithmetic
// ---------------------------------------------------------------------------------------------

/**
 * `Domain`, `Overflow` and `Insufficient` are `math::MathError` (math.rs:31-38); `ZeroAmount` and
 * `InsufficientLiquidity` are the pool's contract errors 7 and 9 (lib.rs:138, :140).
 */
export type MathErrorKind = "Domain" | "Overflow" | "Insufficient" | "ZeroAmount" | "InsufficientLiquidity"

const MESSAGES: Record<MathErrorKind, string> = {
  Domain: "the pool's math has no result for these values",
  Overflow: "the amount is too large for the pool's math",
  Insufficient: "the trade would drain the pool",
  ZeroAmount: "the amount is too small to trade",
  InsufficientLiquidity: "the pool does not have enough liquidity for this trade",
}

/** A curve computation the contract would reject (see the module comment for the mapping). */
export class MathError extends Error {
  readonly kind: MathErrorKind

  constructor(kind: MathErrorKind, detail?: string) {
    super(detail ? `${MESSAGES[kind]} (${detail})` : MESSAGES[kind])
    this.name = "MathError"
    this.kind = kind
  }
}

const I128_MAX = (1n << 127n) - 1n
const I128_MIN = -(1n << 127n)
const U64_MAX = (1n << 64n) - 1n

/** `v` as an i128: outside the range is Rust's overflow panic. */
function i128(v: bigint): bigint {
  if (v > I128_MAX || v < I128_MIN) throw new MathError("Overflow")
  return v
}

/** Rust `a / b` on i128: truncates toward zero; `b == 0` panics; `MIN / -1` overflows. */
function quot(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new MathError("Domain", "division by zero")
  return i128(a / b)
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

// ---------------------------------------------------------------------------------------------
// math.rs
// ---------------------------------------------------------------------------------------------

/** Fixed-point unit: 1.0 == 1e18 (math.rs:25). */
export const WAD = 1_000_000_000_000_000_000n
/** ln(2) at WAD (math.rs:27). */
const LN2 = 693_147_180_559_945_309n
/** Smallest curve exponent `a` the pool accepts (math.rs:129). */
export const MIN_EXPONENT = WAD / 4n
/** Below this `k - p'^a` is rounding noise: the reserve is drained (math.rs:133). */
const MIN_RESIDUAL = WAD / 1_000_000_000_000n
/** `solve` pads its result up by `1 + u / PAD_DIVISOR` raw units (math.rs:142). */
export const PAD_DIVISOR = 100_000_000_000_000n

/** math.rs:41-43: `a * b / WAD`, the product checked. */
function mul(a: bigint, b: bigint): bigint {
  return i128(a * b) / WAD
}

/** math.rs:46-51: `a * WAD / b`; `b == 0` is `Domain` before the product is checked. */
function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new MathError("Domain")
  return quot(i128(a * WAD), b)
}

/** Natural logarithm of `x / WAD` at WAD (math.rs:54-81). `Domain` for `x <= 0`. */
export function ln(x: bigint): bigint {
  i128(x)
  if (x <= 0n) throw new MathError("Domain")
  // Reduce to m in [1, 2): x = m * 2^k.
  let m = x
  let k = 0n
  while (m >= 2n * WAD) {
    m /= 2n
    k += 1n
  }
  while (m < WAD) {
    m *= 2n
    k -= 1n
  }
  // ln(m) = 2 * atanh(z), z = (m - 1) / (m + 1).
  const z = div(m - WAD, m + WAD)
  const z2 = mul(z, z)
  let term = z
  let sum = z
  let n = 3n
  while (term !== 0n) {
    term = mul(term, z2)
    sum += term / n
    n += 2n
  }
  return k * LN2 + 2n * sum
}

/** `e^x` at WAD (math.rs:84-115): 0 below `-42 WAD`, `Overflow` above `40 WAD`. */
export function exp(x: bigint): bigint {
  i128(x)
  if (x < -42n * WAD) return 0n
  if (x > 40n * WAD) throw new MathError("Overflow")
  // x = k * ln2 + r with r in [-ln2/2, ln2/2].
  const half = LN2 / 2n
  const k = x >= 0n ? (x + half) / LN2 : -((-x + half) / LN2)
  const r = x - k * LN2
  let term = WAD
  let sum = WAD
  let n = 1n
  while (term !== 0n) {
    // math.rs:104: `mul(term, r)? / n`; `term` alternates sign when r < 0, both divisions truncate.
    term = mul(term, r) / n
    sum += term
    n += 1n
  }
  if (k >= 0n) {
    // math.rs:109-111: `checked_shl` fails only for a shift >= 128; the `>> k == sum` filter
    // rejects a shift that wrapped (lost high bits or flipped the sign).
    if (k >= 128n) throw new MathError("Overflow")
    const shifted = BigInt.asIntN(128, sum << k)
    if (shifted >> k !== sum) throw new MathError("Overflow")
    return shifted
  }
  return sum >> -k
}

/** `base^exponent`, both at WAD (math.rs:118-126). `Domain` for `base <= 0`. */
export function pow(base: bigint, exponent: bigint): bigint {
  i128(base)
  i128(exponent)
  if (base <= 0n) throw new MathError("Domain")
  if (exponent === 0n) return WAD
  return exp(mul(exponent, ln(base)))
}

/**
 * Move `p` to `pNew` on `p^a + q^a = k` and return `q`'s new value, rounded up by
 * `1 + u / PAD_DIVISOR` in the pool's favour (math.rs:149-166). The computation works on ratios
 * to the largest reserve `u`. `Domain` for a non-positive reserve or `a` outside
 * `[MIN_EXPONENT, WAD]`, `Insufficient` when the move drains `q`.
 */
export function solve(p: bigint, q: bigint, pNew: bigint, a: bigint): bigint {
  for (const v of [p, q, pNew, a]) i128(v)
  if (p <= 0n || q <= 0n || pNew <= 0n || a < MIN_EXPONENT || a > WAD) throw new MathError("Domain")
  const u = max(max(p, q), pNew)
  const pa = pow(div(p, u), a)
  const qa = pow(div(q, u), a)
  const pna = pow(div(pNew, u), a)
  const resid = pa + qa - pna
  if (resid < MIN_RESIDUAL) throw new MathError("Insufficient")
  // w = resid^(1/a), 1/a in [1, 4].
  const w = pow(resid, div(WAD, a))
  // math.rs:163-165: `u.checked_mul(w)`, then `v / WAD + 1 + u / PAD_DIVISOR`.
  return i128(u * w) / WAD + 1n + u / PAD_DIVISOR
}

/** `u64` arguments: Rust cannot pass anything else, so another value is the caller's bug. */
function u64(v: bigint, what: string): bigint {
  if (v < 0n || v > U64_MAX) throw new RangeError(`${what} must be a u64`)
  return v
}

/**
 * The curve exponent `a = 1 - secondsToMaturity / stretchSecs` at WAD (math.rs:170-179). `Domain`
 * for a zero stretch, or a remaining life of the whole stretch or more.
 */
export function exponent(secondsToMaturity: bigint, stretchSecs: bigint): bigint {
  u64(secondsToMaturity, "seconds to maturity")
  u64(stretchSecs, "stretch")
  if (stretchSecs === 0n) throw new MathError("Domain")
  // A u64 times WAD stays inside i128.
  const frac = (secondsToMaturity * WAD) / stretchSecs
  if (frac >= WAD) throw new MathError("Domain")
  return WAD - frac
}

/** Floor square root; 0 for `n <= 0` (math.rs:182-193). `n = i128::MAX` overflows at `x + 1`. */
export function isqrt(n: bigint): bigint {
  i128(n)
  if (n <= 0n) return 0n
  let x = n
  let y = i128(x + 1n) / 2n
  while (y < x) {
    x = y
    y = i128(x + n / x) / 2n
  }
  return x
}

// ---------------------------------------------------------------------------------------------
// lib.rs pricing
// ---------------------------------------------------------------------------------------------

/**
 * The pool as `pool_state()` reports it (`PoolState`, lib.rs:181-192), which is everything the
 * `calc_*` functions read (ruling R2-1):
 * - `ptReserve`, `syReserve`: raw PT and SY share reserves; `totalLp`: LP supply;
 * - `rate`: oracle rate (notional per underlying unit) at `SCALE`;
 * - `exponent`: the curve exponent `a` at `WAD`, already `math::exponent(τ, stretch)`;
 * - `feeRate`: the swap fee for the current time to maturity at `FEE_RATE_SCALE`;
 * - `secondsToMaturity`: τ, from the ledger clock (u64).
 */
export type CurveState = PoolStateView

/** A priced trade: the contract's `Quote` (lib.rs:197-204) plus the pool once it lands. */
export type CurveQuote = {
  /** SY shares paid in, fee included: `syIn` for `buyPt`, the SY required for `buyExactPt`, and
   * 0 for `sellPt`, as the contract's `quote_pt_for_sy` reports it. */
  amountIn: bigint
  /** PT out (`buyPt`; exactly `ptOut` for `buyExactPt`), or SY shares out after the fee (`sellPt`). */
  amountOut: bigint
  /** The swap fee in SY shares; it leaves the reserves. */
  feeShares: bigint
  /** The state after the trade: the reserves the matching `swap_*` writes, all else unchanged. */
  next: CurveState
}

const FEE_SCALE = FEE_RATE_SCALE // lib.rs:64
/** A swap may never leave a reserve below this (lib.rs:69). */
const MIN_RESERVE = 1_000n
/** Bisection steps of `zap_split` (lib.rs:73). */
const ZAP_ITERATIONS = 18

/** lib.rs:772-774: SY shares to notional value, floor. */
function valueOf(shares: bigint, rate: bigint): bigint {
  return quot(i128(shares * rate), SCALE)
}

/** lib.rs:776-778: `(a + b - 1) / b`, each step checked. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return quot(i128(i128(a + b) - 1n), b)
}

/** lib.rs:780-788 `math_err`: a drained reserve is the pool's `InsufficientLiquidity`. */
function mathErr<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof MathError && error.kind === "Insufficient") throw new MathError("InsufficientLiquidity")
    throw error
  }
}

/** lib.rs:930-934. */
function assertSeeded(s: CurveState): void {
  if (s.totalLp === 0n || s.ptReserve <= 0n || s.syReserve <= 0n) throw new MathError("InsufficientLiquidity")
}

function withReserves(s: CurveState, ptReserve: bigint, syReserve: bigint): CurveState {
  return { ...s, ptReserve: i128(ptReserve), syReserve: i128(syReserve) }
}

/** Buy PT with exactly `syIn` SY shares: `calc_buy_pt` (lib.rs:791-815). */
export function buyPt(s: CurveState, syIn: bigint): CurveQuote {
  i128(syIn)
  if (syIn <= 0n) throw new MathError("ZeroAmount")
  assertSeeded(s)
  const fee = ceilDiv(i128(syIn * s.feeRate), FEE_SCALE)
  const net = i128(syIn - fee)
  const netValue = valueOf(net, s.rate)
  if (netValue <= 0n) throw new MathError("ZeroAmount")
  const x = valueOf(s.syReserve, s.rate)
  const y = s.ptReserve
  const xNew = i128(x + netValue)
  // `solve` already rounds `y_new` up (against the trader).
  const yNew = mathErr(() => solve(x, y, xNew, s.exponent))
  const ptOut = i128(y - yNew)
  if (ptOut <= 0n || i128(y - ptOut) < MIN_RESERVE) throw new MathError("InsufficientLiquidity")
  // swap_sy_for_pt (lib.rs:295-296): pt − pt_out, sy + (sy_in − fee).
  return { amountOut: ptOut, amountIn: syIn, feeShares: fee, next: withReserves(s, y - ptOut, s.syReserve + net) }
}

/** Sell exactly `ptIn` PT for SY: `calc_sell_pt` (lib.rs:819-844). */
export function sellPt(s: CurveState, ptIn: bigint): CurveQuote {
  i128(ptIn)
  if (ptIn <= 0n) throw new MathError("ZeroAmount")
  assertSeeded(s)
  const x = valueOf(s.syReserve, s.rate)
  const y = s.ptReserve
  const yNew = i128(y + ptIn)
  const xNew = mathErr(() => solve(y, x, yNew, s.exponent))
  const valueOut = i128(x - xNew)
  if (valueOut <= 0n) throw new MathError("InsufficientLiquidity")
  const gross = quot(i128(valueOut * SCALE), s.rate)
  if (gross <= 0n || i128(s.syReserve - gross) < MIN_RESERVE) throw new MathError("InsufficientLiquidity")
  const fee = ceilDiv(i128(gross * s.feeRate), FEE_SCALE)
  // swap_pt_for_sy (lib.rs:326): pt + pt_in, sy − gross (the fee leaves the reserves).
  return { amountOut: i128(gross - fee), amountIn: 0n, feeShares: fee, next: withReserves(s, yNew, s.syReserve - gross) }
}

/** Buy exactly `ptOut` PT; `amountIn` is the SY required, fee included: `calc_buy_exact_pt` (lib.rs:847-868). */
export function buyExactPt(s: CurveState, ptOut: bigint): CurveQuote {
  i128(ptOut)
  if (ptOut <= 0n) throw new MathError("ZeroAmount")
  assertSeeded(s)
  if (i128(s.ptReserve - ptOut) < MIN_RESERVE) throw new MathError("InsufficientLiquidity")
  const x = valueOf(s.syReserve, s.rate)
  const y = s.ptReserve
  const xNew = mathErr(() => solve(y, x, y - ptOut, s.exponent))
  // Cost in value (`x_new` is already padded up), then to shares (up), then grossed up for the
  // fee so that `gross - fee(gross) >= net`.
  const costValue = i128(i128(xNew - x) + 1n)
  const netShares = ceilDiv(i128(costValue * SCALE), s.rate)
  const gross = ceilDiv(i128(netShares * FEE_SCALE), i128(FEE_SCALE - s.feeRate))
  // swap_yt_for_sy (lib.rs:354-358): pt − pt_out, sy + (gross − fee) = sy + net_shares.
  return {
    amountOut: ptOut,
    amountIn: gross,
    feeShares: i128(gross - netShares),
    next: withReserves(s, y - ptOut, s.syReserve + netShares),
  }
}

/**
 * How much of a single-sided `syIn` deposit `add_liquidity_single_sy` swaps into PT:
 * `zap_split` (lib.rs:871-909), an 18-step bisection. `ZeroAmount` when no split is found.
 */
export function zapSplit(s: CurveState, syIn: bigint): bigint {
  i128(syIn)
  assertSeeded(s)
  let lo = 0n
  let hi = syIn
  let i = 0
  while (i < ZAP_ITERATIONS && i128(hi - lo) > 1n) {
    const mid = i128(lo + hi) / 2n
    const fee = ceilDiv(i128(mid * s.feeRate), FEE_SCALE)
    const netValue = valueOf(i128(mid - fee), s.rate)
    const x = valueOf(s.syReserve, s.rate)
    let bought = 0n
    if (netValue > 0n) {
      // `x + net_value` is evaluated before the `match`: an overflow there panics, uncaught.
      const xNew = i128(x + netValue)
      let yNew: bigint
      try {
        yNew = solve(x, s.ptReserve, xNew, s.exponent)
      } catch (error) {
        // lib.rs:887-891: any `solve` error is a split too large to price: search lower.
        if (!(error instanceof MathError)) throw error
        hi = mid
        i += 1
        continue
      }
      bought = max(i128(s.ptReserve - yNew), 0n)
    }
    const pt1 = i128(s.ptReserve - bought)
    const sy1 = i128(s.syReserve + i128(mid - fee))
    // Remaining SY vs bought PT, in the post-swap ratio: f > 0 => swap more.
    const f = i128(i128(i128(syIn - mid) * pt1) - i128(bought * sy1))
    if (f > 0n) lo = mid
    else hi = mid
    i += 1
  }
  if (lo <= 0n) throw new MathError("ZeroAmount")
  return lo
}

/**
 * Spot price of one PT in SY value at `SCALE`, `(x / y)^(1 - a)`: `spot_price` (lib.rs:911-928),
 * which `pt_price()` returns.
 */
export function spotPrice(s: CurveState): bigint {
  if (s.ptReserve <= 0n || s.syReserve <= 0n) throw new MathError("InsufficientLiquidity")
  const x = valueOf(s.syReserve, s.rate)
  if (x <= 0n) throw new MathError("InsufficientLiquidity")
  // `x.checked_mul(WAD) / pt_reserve`, through `math_err`.
  const ratio = quot(i128(x * WAD), s.ptReserve)
  const p = mathErr(() => pow(ratio, i128(WAD - s.exponent)))
  return p / (WAD / SCALE)
}

/** The pool's `implied_rate()` (lib.rs:646-657): an APR at `SCALE`; 0 at maturity. */
export function impliedRate(s: CurveState): bigint {
  if (s.secondsToMaturity === 0n) return 0n
  const price = spotPrice(s)
  if (price <= 0n) return 0n
  return impliedRateFromPrice(price, s.secondsToMaturity)
}

/**
 * The pool's `implied_rate` once `q` (priced on `s`) has landed: `implied_rate` on `q.next`'s
 * reserves, at `s`'s time, oracle rate and exponent. An APR at `SCALE`. Buying PT lowers it,
 * selling PT raises it.
 */
export function impliedRateAfter(s: CurveState, q: CurveQuote): bigint {
  return impliedRate({ ...s, ptReserve: q.next.ptReserve, syReserve: q.next.syReserve, totalLp: q.next.totalLp })
}

/**
 * The curve state of a market: its `pool_state()` read, or `undefined` while that read is
 * unavailable. An unseeded pool is returned as read; pricing it throws `InsufficientLiquidity`,
 * as the contract does.
 */
export function curveStateFrom(ms: Pick<MarketState, "poolState">): CurveState | undefined {
  if (ms.poolState.status !== "live") return undefined
  const p = ms.poolState.value
  return {
    ptReserve: p.ptReserve,
    syReserve: p.syReserve,
    totalLp: p.totalLp,
    rate: p.rate,
    exponent: p.exponent,
    feeRate: p.feeRate,
    secondsToMaturity: p.secondsToMaturity,
  }
}
