// @vitest-environment node
/**
 * The pool curve port (`curve.ts`) against the contract, bit for bit.
 *
 * Every expected value below was printed by the Rust contract, not derived by hand. A throwaway
 * test (`vectors_test.rs`) was added to a scratch `git archive` of `org/principal`
 * `origin/feat/tranche-1-mvp` (be2a1a5, the ABI pin) and run with
 * `cargo test --offline -p principal_market_pool --lib vectors_test -- --nocapture`. Nothing was
 * written in `org/principal`. It called `math::{ln, exp, pow, solve, exponent, isqrt}` and the
 * pool's private `calc_buy_pt`, `calc_sell_pt`, `calc_buy_exact_pt`, `zap_split` and `spot_price`
 * on the states below, catching panics:
 * - `{ pool: X }`: the call panics with the contract error `Error::X` (`panic_with_error!`);
 * - `{ math: X }`: `math::MathError::X`; for `Overflow` also an arithmetic-overflow panic (the
 *   workspace release profile sets `overflow-checks = true`); `DivideByZero` is Rust's
 *   division-by-zero panic.
 * The implied rate after a trade is `implied_rate`'s formula (lib.rs:646-657) on the reserves the
 * matching `swap_*` writes (lib.rs:296, :326, :358).
 *
 * The states (`exponent` is `math::exponent(seconds_to_maturity, stretch)`, stretch in the
 * trailing comment):
 * - A: 150 days left, 10-year stretch, oracle 1.05, fee 0.3 % × 150/365;
 * - B: 1 year left, 20-year stretch, oracle 1.0, no fee;
 * - C: 1 day left, 5-year stretch, oracle 1.2;
 * - D: a 1e17-unit pool (the `PAD_DIVISOR` pad dominates), a = 0.75, 0.1 % fee;
 * - E: a = `MIN_EXPONENT` (0.25), oracle 1.0123456, 0.2 % fee.
 * The odd states are A with one field changed (`ODD_STATES`).
 */
import { describe, expect, it } from "vitest"
import {
  MIN_EXPONENT,
  MathError,
  PAD_DIVISOR,
  WAD,
  buyExactPt,
  buyPt,
  curveStateFrom,
  exp,
  exponent,
  impliedRate,
  impliedRateAfter,
  isqrt,
  ln,
  pow,
  sellPt,
  solve,
  spotPrice,
  zapSplit,
  type CurveQuote,
  type CurveState,
  type MathErrorKind,
} from "../curve"
import { FEE_RATE_SCALE, SCALE } from "../math"
import type { MarketState, PoolStateView } from "../market-state"
import type { Live } from "../types"

/** What the Rust call returned an error or panicked with (see the header). */
type Failure =
  | { math: "Domain" | "Overflow" | "Insufficient" | "DivideByZero" }
  | { pool: "ZeroAmount" | "InsufficientLiquidity" | "MathError" }
type Outcome = bigint | Failure
type RustQuote = { amountOut: bigint; amountIn: bigint; feeShares: bigint }
type QuoteOutcome = RustQuote | Failure
type StateName = "A" | "B" | "C" | "D" | "E"
type OddRow = { buy: QuoteOutcome; sell: QuoteOutcome; buyExact: QuoteOutcome; zap: Outcome; spot: Outcome }

const I128_MAX = (1n << 127n) - 1n

// ---------------------------------------------------------------------------------------------
// Vectors printed by the contract (see the header). Do not edit by hand.
// ---------------------------------------------------------------------------------------------

const LN: [bigint, Outcome][] = [
  [1n, -41446531673892822292n],
  [1000n, -34538776394910685246n],
  [1000000n, -27631021115928548198n],
  [1000000000000000n, -6907755278982137054n],
  [250000000000000000n, -1386294361119890618n],
  [500000000000000000n, -693147180559945309n],
  [900000000000000000n, -105360515657826315n],
  [999999999999999999n, -21n],
  [1000000000000000000n, 0n],
  [1000000000000000001n, 0n],
  [1000100000000000000n, 99995000333306n],
  [1500000000000000000n, 405465108108164370n],
  [2000000000000000000n, 693147180559945309n],
  [7000000000000000000n, 1945910149055313290n],
  [1234500000000000000000n, 7118421308785234182n],
  [1000000000000000000000000000n, 20723265836946411129n],
  [170141183460469231731687303715884105727n, 46583160257220231949n],
  [0n, { math: "Domain" }],
  [-5n, { math: "Domain" }],
]

const EXP: [bigint, Outcome][] = [
  [-43000000000000000000n, 0n],
  [-42000000000000000001n, 0n],
  [-42000000000000000000n, 0n],
  [-30000000000000000000n, 93576n],
  [-10000000000000000000n, 45399929762484n],
  [-1000000000000000000n, 367879441171442320n],
  [-300000000000000000n, 740818220681717866n],
  [-1n, 999999999999999999n],
  [0n, 1000000000000000000n],
  [1n, 1000000000000000001n],
  [1000000000n, 1000000001000000000n],
  [300000000000000000n, 1349858807576003100n],
  [1000000000000000000n, 2718281828459045222n],
  [5000000000000000000n, 148413159102576603392n],
  [20000000000000000000n, 485165195409790284645531648n],
  [39000000000000000000n, 86593400423993748563637992521990144n],
  [40000000000000000000n, 235385266837019991000902882807513088n],
  [40000000000000000001n, { math: "Overflow" }],
  [41000000000000000000n, { math: "Overflow" }],
]

const POW: [bigint, bigint, Outcome][] = [
  [500000000000000000n, 750000000000000000n, 594603557501360531n],
  [900000000000000000n, 900000000000000000n, 909532576082962178n],
  [10000000000000000n, 300000000000000000n, 251188643150958010n],
  [2000000000000000000n, 500000000000000000n, 1414213562373095042n],
  [990000000000000000n, 250000000000000000n, 997490569933681101n],
  [958904109589041096n, 1042857142857142857n, 957181103309928484n],
  [3000000000000000000n, 4000000000000000000n, 80999999999999995712n],
  [500000000000000000n, 4000000000000000000n, 62500000000000000n],
  [1000000000000000000n, 0n, 1000000000000000000n],
  [0n, 1000000000000000000n, { math: "Domain" }],
  [-1n, 1000000000000000000n, { math: "Domain" }],
  [1000000000000000000000000000n, 5000000000000000000n, { math: "Overflow" }],
  [2000000000000000000n, 85070591730234615865843651857942052863n, { math: "Overflow" }],
]

const SOLVE: [bigint, bigint, bigint, bigint, Outcome][] = [
  [1000000000n, 1000000000n, 1100000000n, 900000000000000000n, 900991487n],
  [950000000000n, 1000000000000n, 960000000000n, 750000000000000000n, 989897023432n],
  [5000000000000000n, 5200000000000000n, 5250000000000000n, 980000000000000000n, 4950049000868566n],
  [10000000n, 12000000n, 11000000n, 300000000000000000n, 10936292n],
  [1000000000n, 900000000n, 500000000n, 999000000000000000n, 1400219411n],
  [400000000n, 600000000n, 450000000n, 1000000000000000000n, 550000000n],
  [100000000000000000n, 95000000000000000n, 100000000000000001n, 750000000000000000n, 95000000000000994n],
  [0n, 1n, 1n, 1000000000000000000n, { math: "Domain" }],
  [1n, 0n, 1n, 1000000000000000000n, { math: "Domain" }],
  [1n, 1n, 0n, 1000000000000000000n, { math: "Domain" }],
  [10n, 10n, 10n, 249999999999999999n, { math: "Domain" }],
  [10n, 10n, 10n, 1000000000000000001n, { math: "Domain" }],
  [1000000n, 1000000n, 1000000000000n, 1000000000000000000n, { math: "Insufficient" }],
  [200000000000000000000n, 1n, 1n, 1000000000000000000n, { math: "Overflow" }],
]

const EXPONENT: [bigint, bigint, Outcome][] = [
  [0n, 126144000n, 1000000000000000000n],
  [31536000n, 126144000n, 750000000000000000n],
  [94608000n, 126144000n, 250000000000000000n],
  [126144000n, 126144000n, { math: "Domain" }],
  [1n, 0n, { math: "Domain" }],
  [12960000n, 315360000n, 958904109589041096n],
  [1n, 3n, 666666666666666667n],
  [86400n, 157680000n, 999452054794520548n],
  [18446744073709551615n, 18446744073709551615n, { math: "Domain" }],
  [18446744073709551614n, 18446744073709551615n, 1n],
]

const ISQRT: [bigint, Outcome][] = [
  [0n, 0n],
  [-4n, 0n],
  [1n, 1n],
  [2n, 1n],
  [3n, 1n],
  [15n, 3n],
  [16n, 4n],
  [1000000000000000000000000n, 1000000000000n],
  [170141183460469231731687303715884105726n, 13043817825332782212n],
  [170141183460469231731687303715884105727n, { math: "Overflow" }],
]

const STATES = {
  A: { ptReserve: 1000000000000n, syReserve: 580000000000n, totalLp: 760000000000n, rate: 10500000n, exponent: 958904109589041096n, feeRate: 1232876712n, secondsToMaturity: 12960000n }, // stretch 315360000
  B: { ptReserve: 50000000000n, syReserve: 40000000000n, totalLp: 44000000000n, rate: 10000000n, exponent: 950000000000000000n, feeRate: 0n, secondsToMaturity: 31536000n }, // stretch 630720000
  C: { ptReserve: 100000000000n, syReserve: 80000000000n, totalLp: 89000000000n, rate: 12000000n, exponent: 999452054794520548n, feeRate: 8219178n, secondsToMaturity: 86400n }, // stretch 157680000
  D: { ptReserve: 100000000000000000n, syReserve: 95000000000000000n, totalLp: 97000000000000000n, rate: 10000000n, exponent: 750000000000000000n, feeRate: 1000000000n, secondsToMaturity: 31536000n }, // stretch 126144000
  E: { ptReserve: 2000000000000n, syReserve: 1000000000000n, totalLp: 1400000000000n, rate: 10123456n, exponent: 250000000000000000n, feeRate: 2000000000n, secondsToMaturity: 94608000n }, // stretch 126144000
} satisfies Record<string, CurveState>

const SPOT: Record<StateName, { ptPrice: bigint; impliedRate: bigint }> = {
  A: { ptPrice: 9798253n, impliedRate: 501023n },
  B: { ptPrice: 9889048n, impliedRate: 112196n },
  C: { ptPrice: 9999776n, impliedRate: 81760n },
  D: { ptPrice: 9872585n, impliedRate: 129059n },
  E: { ptPrice: 6001006n, impliedRate: 2221290n },
}

const BUY_PT: [StateName, bigint, QuoteOutcome][] = [
  ["A", 0n, { pool: "ZeroAmount" }],
  ["A", 1n, { pool: "ZeroAmount" }],
  ["A", 2n, { amountOut: 1n, amountIn: 2n, feeShares: 1n }],
  ["A", 100n, { amountOut: 105n, amountIn: 100n, feeShares: 1n }],
  ["A", 10000n, { amountOut: 10701n, amountIn: 10000n, feeShares: 13n }],
  ["A", 10000000n, { amountOut: 10702977n, amountIn: 10000000n, feeShares: 12329n }],
  ["A", 1000000000n, { amountOut: 1070237019n, amountIn: 1000000000n, feeShares: 1232877n }],
  ["A", 100000000000n, { amountOut: 106430108334n, amountIn: 100000000000n, feeShares: 123287672n }],
  ["A", 290000000000n, { amountOut: 305485015384n, amountIn: 290000000000n, feeShares: 357534247n }],
  ["A", 29000000000000n, { pool: "InsufficientLiquidity" }],
  ["A", 85070591730234615865843651857942052863n, { math: "Overflow" }],
  ["B", 0n, { pool: "ZeroAmount" }],
  ["B", 1n, { amountOut: 1n, amountIn: 1n, feeShares: 0n }],
  ["B", 2n, { amountOut: 2n, amountIn: 2n, feeShares: 0n }],
  ["B", 100n, { amountOut: 101n, amountIn: 100n, feeShares: 0n }],
  ["B", 10000n, { amountOut: 10112n, amountIn: 10000n, feeShares: 0n }],
  ["B", 10000000n, { amountOut: 10112082n, amountIn: 10000000n, feeShares: 0n }],
  ["B", 1000000000n, { amountOut: 1010079324n, amountIn: 1000000000n, feeShares: 0n }],
  ["B", 100000000000n, { pool: "InsufficientLiquidity" }],
  ["B", 20000000000n, { amountOut: 19777136298n, amountIn: 20000000000n, feeShares: 0n }],
  ["B", 2000000000000n, { pool: "InsufficientLiquidity" }],
  ["B", 85070591730234615865843651857942052863n, { math: "Overflow" }],
  ["C", 0n, { pool: "ZeroAmount" }],
  ["C", 1n, { pool: "ZeroAmount" }],
  ["C", 2n, { amountOut: 1n, amountIn: 2n, feeShares: 1n }],
  ["C", 100n, { amountOut: 118n, amountIn: 100n, feeShares: 1n }],
  ["C", 10000n, { amountOut: 11998n, amountIn: 10000n, feeShares: 1n }],
  ["C", 10000000n, { amountOut: 12000167n, amountIn: 10000000n, feeShares: 83n }],
  ["C", 1000000000n, { amountOut: 1200008924n, amountIn: 1000000000n, feeShares: 8220n }],
  ["C", 100000000000n, { pool: "InsufficientLiquidity" }],
  ["C", 40000000000n, { amountOut: 47987322791n, amountIn: 40000000000n, feeShares: 328768n }],
  ["C", 4000000000000n, { pool: "InsufficientLiquidity" }],
  ["C", 85070591730234615865843651857942052863n, { math: "Overflow" }],
  ["D", 0n, { pool: "ZeroAmount" }],
  ["D", 1n, { pool: "ZeroAmount" }],
  ["D", 2n, { pool: "InsufficientLiquidity" }],
  ["D", 100n, { pool: "InsufficientLiquidity" }],
  ["D", 10000n, { amountOut: 9121n, amountIn: 10000n, feeShares: 10n }],
  ["D", 10000000n, { amountOut: 10117931n, amountIn: 10000000n, feeShares: 10000n }],
  ["D", 1000000000n, { amountOut: 1011891989n, amountIn: 1000000000n, feeShares: 1000000n }],
  ["D", 100000000000n, { amountOut: 101189271811n, amountIn: 100000000000n, feeShares: 100000000n }],
  ["D", 47500000000000000n, { amountOut: 42729637206751547n, amountIn: 47500000000000000n, feeShares: 47500000000000n }],
  ["D", 4750000000000000000n, { pool: "InsufficientLiquidity" }],
  ["D", 85070591730234615865843651857942052863n, { math: "Overflow" }],
  ["E", 0n, { pool: "ZeroAmount" }],
  ["E", 1n, { pool: "ZeroAmount" }],
  ["E", 2n, { amountOut: 1n, amountIn: 2n, feeShares: 1n }],
  ["E", 100n, { amountOut: 166n, amountIn: 100n, feeShares: 1n }],
  ["E", 10000n, { amountOut: 16835n, amountIn: 10000n, feeShares: 20n }],
  ["E", 10000000n, { amountOut: 16835741n, amountIn: 10000000n, feeShares: 20000n }],
  ["E", 1000000000n, { amountOut: 1682425031n, amountIn: 1000000000n, feeShares: 2000000n }],
  ["E", 100000000000n, { amountOut: 157522580580n, amountIn: 100000000000n, feeShares: 200000000n }],
  ["E", 500000000000n, { amountOut: 627466172643n, amountIn: 500000000000n, feeShares: 1000000000n }],
  ["E", 50000000000000n, { pool: "InsufficientLiquidity" }],
  ["E", 85070591730234615865843651857942052863n, { math: "Overflow" }],
]

const SELL_PT: [StateName, bigint, QuoteOutcome, bigint?][] = [
  ["A", 0n, { pool: "ZeroAmount" }],
  ["A", 1n, { pool: "InsufficientLiquidity" }],
  ["A", 2n, { pool: "InsufficientLiquidity" }],
  ["A", 100n, { amountOut: 91n, amountIn: 0n, feeShares: 1n }, 92n],
  ["A", 10000n, { amountOut: 9319n, amountIn: 0n, feeShares: 12n }, 9331n],
  ["A", 10000000n, { amountOut: 9320158n, amountIn: 0n, feeShares: 11505n }, 9331663n],
  ["A", 1000000000n, { amountOut: 931966515n, amountIn: 0n, feeShares: 1150419n }, 933116934n],
  ["A", 100000000000n, { amountOut: 92693238132n, amountIn: 0n, feeShares: 114420401n }, 92807658533n],
  ["A", 500000000000n, { amountOut: 451103044608n, amountIn: 0n, feeShares: 556840955n }, 451659885563n],
  ["A", 50000000000000n, { pool: "InsufficientLiquidity" }],
  ["A", 85070591730234615865843651857942052863n, { pool: "MathError" }],
  ["B", 0n, { pool: "ZeroAmount" }],
  ["B", 1n, { pool: "InsufficientLiquidity" }],
  ["B", 2n, { amountOut: 1n, amountIn: 0n, feeShares: 0n }, 1n],
  ["B", 100n, { amountOut: 98n, amountIn: 0n, feeShares: 0n }, 98n],
  ["B", 10000n, { amountOut: 9889n, amountIn: 0n, feeShares: 0n }, 9889n],
  ["B", 10000000n, { amountOut: 9888937n, amountIn: 0n, feeShares: 0n }, 9888937n],
  ["B", 1000000000n, { amountOut: 987798626n, amountIn: 0n, feeShares: 0n }, 987798626n],
  ["B", 100000000000n, { pool: "InsufficientLiquidity" }],
  ["B", 25000000000n, { amountOut: 23984132674n, amountIn: 0n, feeShares: 0n }, 23984132674n],
  ["B", 2500000000000n, { pool: "InsufficientLiquidity" }],
  ["B", 85070591730234615865843651857942052863n, { pool: "MathError" }],
  ["C", 0n, { pool: "ZeroAmount" }],
  ["C", 1n, { pool: "InsufficientLiquidity" }],
  ["C", 2n, { pool: "InsufficientLiquidity" }],
  ["C", 100n, { amountOut: 81n, amountIn: 0n, feeShares: 1n }, 82n],
  ["C", 10000n, { amountOut: 8331n, amountIn: 0n, feeShares: 1n }, 8332n],
  ["C", 10000000n, { amountOut: 8333076n, amountIn: 0n, feeShares: 69n }, 8333145n],
  ["C", 1000000000n, { amountOut: 833303180n, amountIn: 0n, feeShares: 6850n }, 833310030n],
  ["C", 100000000000n, { pool: "InsufficientLiquidity" }],
  ["C", 50000000000n, { amountOut: 41653078829n, amountIn: 0n, feeShares: 342357n }, 41653421186n],
  ["C", 5000000000000n, { pool: "InsufficientLiquidity" }],
  ["C", 85070591730234615865843651857942052863n, { pool: "MathError" }],
  ["D", 0n, { pool: "ZeroAmount" }],
  ["D", 1n, { pool: "InsufficientLiquidity" }],
  ["D", 2n, { pool: "InsufficientLiquidity" }],
  ["D", 100n, { pool: "InsufficientLiquidity" }],
  ["D", 10000n, { amountOut: 8868n, amountIn: 0n, feeShares: 9n }, 8877n],
  ["D", 10000000n, { amountOut: 9861718n, amountIn: 0n, feeShares: 9872n }, 9871590n],
  ["D", 1000000000n, { amountOut: 986270289n, amountIn: 0n, feeShares: 987258n }, 987257547n],
  ["D", 100000000000n, { amountOut: 98627102500n, amountIn: 0n, feeShares: 98725829n }, 98725828329n],
  ["D", 50000000000000000n, { amountOut: 43577764117976049n, amountIn: 0n, feeShares: 43621385503480n }, 43621385503479529n],
  ["D", 5000000000000000000n, { pool: "InsufficientLiquidity" }],
  ["D", 85070591730234615865843651857942052863n, { pool: "MathError" }],
  ["E", 0n, { pool: "ZeroAmount" }],
  ["E", 1n, { pool: "InsufficientLiquidity" }],
  ["E", 2n, { pool: "InsufficientLiquidity" }],
  ["E", 100n, { amountOut: 58n, amountIn: 0n, feeShares: 1n }, 59n],
  ["E", 10000n, { amountOut: 5915n, amountIn: 0n, feeShares: 12n }, 5927n],
  ["E", 10000000n, { amountOut: 5915942n, amountIn: 0n, feeShares: 11856n }, 5927798n],
  ["E", 1000000000n, { amountOut: 591354499n, amountIn: 0n, feeShares: 1185080n }, 592539579n],
  ["E", 100000000000n, { amountOut: 56826378725n, amountIn: 0n, feeShares: 113880519n }, 56940259244n],
  ["E", 1000000000000n, { amountOut: 416934252863n, amountIn: 0n, feeShares: 835539585n }, 417769792448n],
  ["E", 100000000000000n, { pool: "InsufficientLiquidity" }],
  ["E", 85070591730234615865843651857942052863n, { pool: "MathError" }],
]

const BUY_EXACT_PT: [StateName, bigint, QuoteOutcome][] = [
  ["A", 0n, { pool: "ZeroAmount" }],
  ["A", 1n, { amountOut: 1n, amountIn: 3n, feeShares: 1n }],
  ["A", 2n, { amountOut: 2n, amountIn: 4n, feeShares: 1n }],
  ["A", 100n, { amountOut: 100n, amountIn: 96n, feeShares: 1n }],
  ["A", 10000n, { amountOut: 10000n, amountIn: 9346n, feeShares: 12n }],
  ["A", 10000000n, { amountOut: 10000000n, amountIn: 9343197n, feeShares: 11520n }],
  ["A", 1000000000n, { amountOut: 1000000000n, amountIn: 934368948n, feeShares: 1151962n }],
  ["A", 500000000000n, { amountOut: 500000000000n, amountIn: 479571660429n, feeShares: 591252732n }],
  ["A", 999999999000n, { amountOut: 999999999000n, amountIn: 997879510350n, feeShares: 1230262410n }],
  ["A", 999999999001n, { pool: "InsufficientLiquidity" }],
  ["B", 0n, { pool: "ZeroAmount" }],
  ["B", 1n, { amountOut: 1n, amountIn: 2n, feeShares: 0n }],
  ["B", 2n, { amountOut: 2n, amountIn: 3n, feeShares: 0n }],
  ["B", 100n, { amountOut: 100n, amountIn: 100n, feeShares: 0n }],
  ["B", 10000n, { amountOut: 10000n, amountIn: 9891n, feeShares: 0n }],
  ["B", 10000000n, { amountOut: 10000000n, amountIn: 9889160n, feeShares: 0n }],
  ["B", 1000000000n, { amountOut: 1000000000n, amountIn: 990010119n, feeShares: 0n }],
  ["B", 25000000000n, { amountOut: 25000000000n, amountIn: 25441915702n, feeShares: 0n }],
  ["B", 49999999000n, { amountOut: 49999999000n, amountIn: 53315077602n, feeShares: 0n }],
  ["B", 49999999001n, { pool: "InsufficientLiquidity" }],
  ["C", 0n, { pool: "ZeroAmount" }],
  ["C", 1n, { amountOut: 1n, amountIn: 3n, feeShares: 1n }],
  ["C", 2n, { amountOut: 2n, amountIn: 4n, feeShares: 1n }],
  ["C", 100n, { amountOut: 100n, amountIn: 86n, feeShares: 1n }],
  ["C", 10000n, { amountOut: 10000n, amountIn: 8336n, feeShares: 1n }],
  ["C", 10000000n, { amountOut: 10000000n, amountIn: 8333218n, feeShares: 69n }],
  ["C", 1000000000n, { amountOut: 1000000000n, amountIn: 833326205n, feeShares: 6850n }],
  ["C", 50000000000n, { amountOut: 50000000000n, amountIn: 41678205358n, feeShares: 342561n }],
  ["C", 99999999000n, { amountOut: 99999999000n, amountIn: 83396080190n, feeShares: 685448n }],
  ["C", 99999999001n, { pool: "InsufficientLiquidity" }],
  ["D", 0n, { pool: "ZeroAmount" }],
  ["D", 1n, { amountOut: 1n, amountIn: 1003n, feeShares: 2n }],
  ["D", 2n, { amountOut: 2n, amountIn: 1004n, feeShares: 2n }],
  ["D", 100n, { amountOut: 100n, amountIn: 1100n, feeShares: 2n }],
  ["D", 10000n, { amountOut: 10000n, amountIn: 10883n, feeShares: 11n }],
  ["D", 10000000n, { amountOut: 10000000n, amountIn: 9883469n, feeShares: 9884n }],
  ["D", 1000000000n, { amountOut: 1000000000n, amountIn: 988247795n, feeShares: 988248n }],
  ["D", 50000000000000000n, { amountOut: 50000000000000000n, amountIn: 56867763099313780n, feeShares: 56867763099314n }],
  ["D", 99999999999999000n, { amountOut: 99999999999999000n, amountIn: 150815226003011152n, feeShares: 150815226003012n }],
  ["D", 99999999999999001n, { pool: "InsufficientLiquidity" }],
  ["E", 0n, { pool: "ZeroAmount" }],
  ["E", 1n, { amountOut: 1n, amountIn: 3n, feeShares: 1n }],
  ["E", 2n, { amountOut: 2n, amountIn: 4n, feeShares: 1n }],
  ["E", 100n, { amountOut: 100n, amountIn: 63n, feeShares: 1n }],
  ["E", 10000n, { amountOut: 10000n, amountIn: 5942n, feeShares: 12n }],
  ["E", 10000000n, { amountOut: 10000000n, amountIn: 5939731n, feeShares: 11880n }],
  ["E", 1000000000n, { amountOut: 1000000000n, amountIn: 594213847n, feeShares: 1188428n }],
  ["E", 1000000000000n, { amountOut: 1000000000000n, amountIn: 998100625575n, feeShares: 1996201252n }],
  ["E", 1999999999000n, { amountOut: 1999999999000n, amountIn: 21626844559008n, feeShares: 43253689119n }],
  ["E", 1999999999001n, { pool: "InsufficientLiquidity" }],
]

const ZAP_SPLIT: [StateName, bigint, Outcome][] = [
  ["A", 0n, { pool: "ZeroAmount" }],
  ["A", 1n, { pool: "ZeroAmount" }],
  ["A", 2n, 1n],
  ["A", 3n, 2n],
  ["A", 100n, 62n],
  ["A", 10000000n, 6169852n],
  ["A", 1000000000n, 616588590n],
  ["A", 100000000000n, 57959365844n],
  ["A", 1740000000000n, 509646148681n],
  ["B", 0n, { pool: "ZeroAmount" }],
  ["B", 1n, { pool: "ZeroAmount" }],
  ["B", 2n, 1n],
  ["B", 3n, 1n],
  ["B", 100n, 55n],
  ["B", 10000000n, 5527381n],
  ["B", 1000000000n, 546836852n],
  ["B", 100000000000n, 26685714720n],
  ["B", 120000000000n, 29050140379n],
  ["C", 0n, { pool: "ZeroAmount" }],
  ["C", 1n, { pool: "ZeroAmount" }],
  ["C", 2n, 1n],
  ["C", 3n, 2n],
  ["C", 100n, 51n],
  ["C", 10000000n, 5101660n],
  ["C", 1000000000n, 507095335n],
  ["C", 100000000000n, 31649780273n],
  ["C", 240000000000n, 49599609375n],
  ["D", 0n, { pool: "ZeroAmount" }],
  ["D", 1n, { pool: "ZeroAmount" }],
  ["D", 2n, 1n],
  ["D", 3n, 2n],
  ["D", 100n, 99n],
  ["D", 10000000n, 5099142n],
  ["D", 1000000000n, 509864806n],
  ["D", 100000000000n, 50986480712n],
  ["D", 285000000000000000n, 66918640136718750n],
  ["E", 0n, { pool: "ZeroAmount" }],
  ["E", 1n, { pool: "ZeroAmount" }],
  ["E", 2n, 1n],
  ["E", 3n, 2n],
  ["E", 100n, 55n],
  ["E", 10000000n, 5429457n],
  ["E", 1000000000n, 542793273n],
  ["E", 100000000000n, 52815246581n],
  ["E", 3000000000000n, 999412536620n],
]

const IMPLIED_AFTER: [StateName, "buy" | "sell" | "buyExact", bigint, bigint][] = [
  ["A", "buy", 1000000000n, 498176n],
  ["A", "sell", 1000000000n, 503687n],
  ["A", "buyExact", 1000000000n, 498363n],
  ["A", "buy", 100000000000n, 225562n],
  ["A", "sell", 100000000000n, 777788n],
  ["A", "buyExact", 100000000000n, 241849n],
  ["B", "buy", 1000000000n, 89419n],
  ["B", "sell", 1000000000n, 134877n],
  ["B", "buyExact", 1000000000n, 89645n],
  ["C", "buy", 1000000000n, 32850n],
  ["C", "sell", 1000000000n, 122640n],
  ["C", "buyExact", 1000000000n, 40880n],
  ["D", "buy", 1000000000n, 129059n],
  ["D", "sell", 1000000000n, 129059n],
  ["D", "buyExact", 1000000000n, 129059n],
  ["D", "buy", 100000000000n, 129054n],
  ["D", "sell", 100000000000n, 129064n],
  ["D", "buyExact", 100000000000n, 129054n],
  ["E", "buy", 1000000000n, 2213634n],
  ["E", "sell", 1000000000n, 2225844n],
  ["E", "buyExact", 1000000000n, 2216739n],
  ["E", "buy", 100000000000n, 1530162n],
  ["E", "sell", 100000000000n, 2687301n],
  ["E", "buyExact", 100000000000n, 1776579n],
]

const ODD = {
  noLp: { buy: { pool: "InsufficientLiquidity" }, sell: { pool: "InsufficientLiquidity" }, buyExact: { pool: "InsufficientLiquidity" }, zap: { pool: "InsufficientLiquidity" }, spot: 9798253n },
  noPt: { buy: { pool: "InsufficientLiquidity" }, sell: { pool: "InsufficientLiquidity" }, buyExact: { pool: "InsufficientLiquidity" }, zap: { pool: "InsufficientLiquidity" }, spot: { pool: "InsufficientLiquidity" } },
  noSy: { buy: { pool: "InsufficientLiquidity" }, sell: { pool: "InsufficientLiquidity" }, buyExact: { pool: "InsufficientLiquidity" }, zap: { pool: "InsufficientLiquidity" }, spot: { pool: "InsufficientLiquidity" } },
  zeroRate: { buy: { pool: "ZeroAmount" }, sell: { pool: "MathError" }, buyExact: { pool: "MathError" }, zap: 999996185n, spot: { pool: "InsufficientLiquidity" } },
  feeAll: { buy: { pool: "ZeroAmount" }, sell: { amountOut: 0n, amountIn: 0n, feeShares: 933116934n }, buyExact: { math: "DivideByZero" }, zap: 999996185n, spot: 9798253n },
  matured: { buy: { amountOut: 1050000000n, amountIn: 1000000000n, feeShares: 0n }, sell: { amountOut: 952380952n, amountIn: 0n, feeShares: 0n }, buyExact: { amountOut: 1000000000n, amountIn: 952380955n, feeShares: 0n }, zap: 621097564n, spot: 10000000n },
} satisfies Record<string, OddRow>

// ---------------------------------------------------------------------------------------------

const A = STATES.A

/** The odd states of `ODD`: state A with one field changed, as the Rust printer built them. */
const ODD_STATES: Record<keyof typeof ODD, CurveState> = {
  noLp: { ...A, totalLp: 0n },
  noPt: { ...A, ptReserve: 0n },
  noSy: { ...A, syReserve: 0n },
  zeroRate: { ...A, rate: 0n },
  feeAll: { ...A, feeRate: FEE_RATE_SCALE },
  matured: { ...A, exponent: WAD, secondsToMaturity: 0n, feeRate: 0n },
}

const NAMES = Object.keys(STATES) as StateName[]

function isFailure(outcome: unknown): outcome is Failure {
  return typeof outcome === "object" && outcome !== null && ("math" in outcome || "pool" in outcome)
}

/** The `MathError` kinds the port may throw where Rust failed with `f`. */
function kindsFor(f: Failure): MathErrorKind[] {
  if ("pool" in f) {
    // `math_err` (lib.rs:780-788) turns `Insufficient` into `InsufficientLiquidity` and any other
    // math error into contract error 16 (`MathError`), which the port keeps as Domain or Overflow.
    return f.pool === "MathError" ? ["Domain", "Overflow"] : [f.pool]
  }
  // Rust panics on a division by zero; the port throws `Domain`.
  return f.math === "DivideByZero" ? ["Domain"] : [f.math]
}

function thrown(run: () => unknown, label: string): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error(`${label}: expected a throw, got a value`)
}

function expectFailure(run: () => unknown, f: Failure, label: string): void {
  const error = thrown(run, label)
  expect(error, label).toBeInstanceOf(MathError)
  expect(kindsFor(f), `${label}: kind ${(error as MathError).kind}`).toContain((error as MathError).kind)
}

function expectOutcome(run: () => bigint, outcome: Outcome, label: string): void {
  if (isFailure(outcome)) expectFailure(run, outcome, label)
  else expect(run(), label).toBe(outcome)
}

function amounts(q: CurveQuote): RustQuote {
  return { amountOut: q.amountOut, amountIn: q.amountIn, feeShares: q.feeShares }
}

describe("math.rs port", () => {
  it("has the contract's constants", () => {
    expect(WAD).toBe(1_000_000_000_000_000_000n)
    expect(MIN_EXPONENT).toBe(WAD / 4n)
    expect(PAD_DIVISOR).toBe(100_000_000_000_000n)
  })

  it("ln matches math::ln exactly", () => {
    for (const [x, out] of LN) expectOutcome(() => ln(x), out, `ln(${x})`)
  })

  it("exp matches math::exp exactly", () => {
    for (const [x, out] of EXP) expectOutcome(() => exp(x), out, `exp(${x})`)
  })

  it("pow matches math::pow exactly", () => {
    for (const [b, e, out] of POW) expectOutcome(() => pow(b, e), out, `pow(${b}, ${e})`)
  })

  it("solve matches math::solve exactly, pad included", () => {
    for (const [p, q, pn, a, out] of SOLVE) {
      expectOutcome(() => solve(p, q, pn, a), out, `solve(${p}, ${q}, ${pn}, ${a})`)
    }
  })

  it("exponent matches math::exponent exactly", () => {
    for (const [s, st, out] of EXPONENT) expectOutcome(() => exponent(s, st), out, `exponent(${s}, ${st})`)
  })

  it("exponent refuses a value that is not a u64, which Rust cannot pass", () => {
    expect(() => exponent(-1n, 10n)).toThrow(RangeError)
    expect(() => exponent(1n, 1n << 64n)).toThrow(RangeError)
  })

  it("isqrt matches math::isqrt exactly", () => {
    for (const [n, out] of ISQRT) expectOutcome(() => isqrt(n), out, `isqrt(${n})`)
  })
})

describe("pool calc_* port", () => {
  it("spotPrice and impliedRate match spot_price and implied_rate on every state", () => {
    for (const name of NAMES) {
      expect(spotPrice(STATES[name]), `spot ${name}`).toBe(SPOT[name].ptPrice)
      expect(impliedRate(STATES[name]), `implied ${name}`).toBe(SPOT[name].impliedRate)
    }
  })

  it("buyPt matches calc_buy_pt, and next holds the reserves swap_sy_for_pt writes", () => {
    for (const [name, syIn, out] of BUY_PT) {
      const s = STATES[name]
      const label = `buyPt ${name} ${syIn}`
      if (isFailure(out)) {
        expectFailure(() => buyPt(s, syIn), out, label)
        continue
      }
      // lib.rs:295-296: pt − amount_out, sy + (sy_in − fee).
      const next = { ...s, ptReserve: s.ptReserve - out.amountOut, syReserve: s.syReserve + (syIn - out.feeShares) }
      expect(buyPt(s, syIn), label).toEqual({ ...out, next })
    }
  })

  it("sellPt matches calc_sell_pt (amountIn 0 as in the contract's Quote), and next holds the reserves swap_pt_for_sy writes", () => {
    for (const [name, ptIn, out, printedGross] of SELL_PT) {
      const s = STATES[name]
      const label = `sellPt ${name} ${ptIn}`
      if (isFailure(out)) {
        expectFailure(() => sellPt(s, ptIn), out, label)
        continue
      }
      // lib.rs:326: pt + pt_in, sy − gross; gross = amount_out + fee (lib.rs:838).
      const gross = out.amountOut + out.feeShares
      expect(printedGross, label).toBe(gross)
      const next = { ...s, ptReserve: s.ptReserve + ptIn, syReserve: s.syReserve - gross }
      expect(sellPt(s, ptIn), label).toEqual({ ...out, next })
    }
  })

  it("buyExactPt matches calc_buy_exact_pt, and next holds the reserves swap_yt_for_sy writes", () => {
    for (const [name, ptOut, out] of BUY_EXACT_PT) {
      const s = STATES[name]
      const label = `buyExactPt ${name} ${ptOut}`
      if (isFailure(out)) {
        expectFailure(() => buyExactPt(s, ptOut), out, label)
        continue
      }
      // lib.rs:354-358: pt − pt_out, sy + (amount_in − fee).
      const next = { ...s, ptReserve: s.ptReserve - ptOut, syReserve: s.syReserve + (out.amountIn - out.feeShares) }
      expect(buyExactPt(s, ptOut), label).toEqual({ ...out, next })
    }
  })

  it("zapSplit matches zap_split exactly", () => {
    for (const [name, syIn, out] of ZAP_SPLIT) {
      expectOutcome(() => zapSplit(STATES[name], syIn), out, `zapSplit ${name} ${syIn}`)
    }
  })

  it("impliedRateAfter matches implied_rate on the post-trade reserves", () => {
    for (const [name, kind, amount, after] of IMPLIED_AFTER) {
      const s = STATES[name]
      const q = kind === "buy" ? buyPt(s, amount) : kind === "sell" ? sellPt(s, amount) : buyExactPt(s, amount)
      expect(impliedRateAfter(s, q), `${kind} ${name} ${amount}`).toBe(after)
    }
  })

  // The brief says the buy moves the rate up and the sell down. The contract says the opposite,
  // as the economics do: buying PT raises its price, so the fixed rate falls (state A: 501023
  // before, 498176 after buying with 100 SY, 503687 after selling 100 PT; Rust vectors above).
  // Spec 0002 §3 agrees: the fixed APY "rises when buying YT", which sells PT.
  it("buying PT lowers the implied rate and selling PT raises it", () => {
    for (const name of NAMES) {
      const s = STATES[name]
      const before = impliedRate(s)
      expect(impliedRateAfter(s, buyPt(s, s.syReserve / 10n)), `buy ${name}`).toBeLessThan(before)
      expect(impliedRateAfter(s, buyExactPt(s, s.ptReserve / 10n)), `buyExact ${name}`).toBeLessThan(before)
      expect(impliedRateAfter(s, sellPt(s, s.ptReserve / 10n)), `sell ${name}`).toBeGreaterThan(before)
    }
  })

  it("matches the contract on unseeded, zero-rate, all-fee and matured states", () => {
    for (const name of Object.keys(ODD) as (keyof typeof ODD)[]) {
      const out: OddRow = ODD[name]
      const s = ODD_STATES[name]
      const amount = 1_000_000_000n
      const quotes: [string, () => CurveQuote, QuoteOutcome][] = [
        ["buy", () => buyPt(s, amount), out.buy],
        ["sell", () => sellPt(s, amount), out.sell],
        ["buyExact", () => buyExactPt(s, amount), out.buyExact],
      ]
      for (const [op, run, expected] of quotes) {
        if (isFailure(expected)) expectFailure(run, expected, `${op} ${name}`)
        else expect(amounts(run()), `${op} ${name}`).toEqual(expected)
      }
      expectOutcome(() => zapSplit(s, amount), out.zap, `zap ${name}`)
      expectOutcome(() => spotPrice(s), out.spot, `spot ${name}`)
    }
    // implied_rate is 0 at maturity (lib.rs:648).
    expect(impliedRate(ODD_STATES.matured)).toBe(0n)
  })

  it("overflow throws MathError, as Rust does", () => {
    const overflow = (run: () => unknown, label: string) => expectFailure(run, { math: "Overflow" }, label)
    overflow(() => buyPt(A, I128_MAX / 2n), "sy_in * fee_rate (lib.rs:796)")
    overflow(() => isqrt(I128_MAX), "x + 1 (math.rs:187)")
    overflow(() => solve(200_000_000_000_000_000_000n, 1n, 1n, WAD), "p * WAD in div (math.rs:50)")
    overflow(() => exp(40n * WAD + 1n), "above e^40 (math.rs:89)")
    // An amount outside i128 cannot reach the contract at all.
    overflow(() => buyPt(A, I128_MAX + 1n), "sy_in above i128")
    overflow(() => sellPt(A, -(I128_MAX + 2n)), "pt_in below i128")
    const error = thrown(() => isqrt(I128_MAX), "isqrt")
    expect(error).toBeInstanceOf(Error)
    expect((error as MathError).name).toBe("MathError")
  })

  it("a drained reserve is InsufficientLiquidity, not a math error", () => {
    const error = thrown(() => buyPt(STATES.B, 100_000_000_000n), "drain")
    expect(error).toBeInstanceOf(MathError)
    expect((error as MathError).kind).toBe("InsufficientLiquidity")
  })

  it("does not change the state it prices", () => {
    const s = { ...A }
    const q = buyPt(s, 1_000_000_000n)
    expect(s).toEqual(A)
    expect(q.next).not.toBe(s)
    expect(q.next.rate).toBe(A.rate)
    expect(q.next.exponent).toBe(A.exponent)
    expect(q.next.feeRate).toBe(A.feeRate)
    expect(q.next.secondsToMaturity).toBe(A.secondsToMaturity)
    expect(q.next.totalLp).toBe(A.totalLp)
    expect(SCALE).toBe(10_000_000n)
  })
})

describe("curveStateFrom", () => {
  const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 7 })
  const withPool = (poolState: Live<PoolStateView>) => ({ poolState }) as Pick<MarketState, "poolState">

  it("is the pool_state() read, as the calc_* functions take it", () => {
    const view: PoolStateView = { ...A }
    const s = curveStateFrom(withPool(live(view)))
    expect(s).toEqual(A)
    expect(s).not.toBe(view)
    expect(buyPt(s!, 1_000_000_000n).amountOut).toBe(1_070_237_019n)
  })

  it("is undefined while pool_state() is unavailable", () => {
    expect(curveStateFrom(withPool({ status: "unavailable", error: "rpc down" }))).toBeUndefined()
  })

  it("keeps an unseeded pool; pricing it throws as the contract does", () => {
    const s = curveStateFrom(withPool(live({ ...A, totalLp: 0n })))
    expect(s).toBeDefined()
    expect((thrown(() => buyPt(s!, 1n), "unseeded") as MathError).kind).toBe("InsufficientLiquidity")
  })
})
