/**
 * Buy-YT solver: from the amount a user wants to SPEND to the Router's `sy_in`.
 *
 * `Router.swap_sy_for_yt(sy_in, ..)` (router lib.rs, `origin/feat/tranche-1-mvp`) mints PT + YT
 * from `sy_in` (`PrincipalManager.mint`) and sells ALL the minted PT back into the pool
 * (`swap_pt_for_sy(minted.pt_minted)`). The YT therefore costs `sy_in - sy_back` SY. This module
 * finds the largest `sy_in` whose net cost does not exceed the spend, with the same integer math
 * the contracts use (`previewMint` for the mint, `sellPt` for the pool leg).
 *
 * All SY figures are raw SY shares; `ytOut` is in YT (oracle units).
 */
import { MathError, sellPt, type CurveState } from "./curve"
import { previewMint } from "./previews"

/** Highest `sy_in` tried, as a multiple of the spend: leverage beyond this is not offered. */
const MAX_LEVERAGE_MULTIPLE = 10_000n
const MAX_ITERATIONS = 128

export type YtSolution = { syIn: bigint; ytOut: bigint; syBack: bigint; netCost: bigint }

type Probe = YtSolution | { infeasible: string }

function probe(
  s: CurveState,
  syIn: bigint,
  oracleRate: bigint,
  tokenizationFeeBps: bigint,
): Probe {
  const { pt, yt } = previewMint(syIn, oracleRate, tokenizationFeeBps)
  if (pt <= 0n) return { infeasible: "mint" }
  try {
    const syBack = sellPt(s, pt).amountOut
    return { syIn, ytOut: yt, syBack, netCost: syIn - syBack }
  } catch (e) {
    if (e instanceof MathError) return { infeasible: e.kind }
    throw e
  }
}

const isSolution = (p: Probe): p is YtSolution => !("infeasible" in p)

/**
 * The largest `syIn` in `[spendSy, spendSy x 10_000]` with `netCost <= spendSy`, by bisection
 * (at most 128 steps). Net cost never decreases as `syIn` grows (more PT sold at a falling
 * price), and a PT sale the pool cannot take stays impossible for larger sales, so
 * "affordable" is a prefix of the range. The result is asserted against both neighbours.
 */
export function solveBuyYt(
  s: CurveState,
  p: { spendSy: bigint; oracleRate: bigint; tokenizationFeeBps: bigint },
): YtSolution | { error: string } {
  const { spendSy, oracleRate, tokenizationFeeBps } = p
  if (spendSy <= 0n) return { error: "Enter an amount greater than zero." }
  const run = (syIn: bigint) => probe(s, syIn, oracleRate, tokenizationFeeBps)
  const affordable = (r: Probe): r is YtSolution => isSolution(r) && r.netCost <= spendSy

  let best = run(spendSy)
  if (!affordable(best)) {
    return {
      error:
        "The pool cannot absorb the PT this purchase would sell; try a smaller amount, or a larger one if this is a very small trade.",
    }
  }
  let lo = spendSy // affordable
  let hi = spendSy * MAX_LEVERAGE_MULTIPLE + 1n // not affordable (or beyond the range)
  for (let i = 0; i < MAX_ITERATIONS && hi - lo > 1n; i++) {
    const mid = lo + (hi - lo) / 2n
    const r = run(mid)
    if (affordable(r)) {
      lo = mid
      best = r
    } else {
      hi = mid
    }
  }
  if (hi - lo > 1n) throw new Error("Buy-YT solver did not converge")
  // Monotonicity: the answer is affordable and its successor is not.
  if (!affordable(best) || best.syIn !== lo) throw new Error("Buy-YT solver: inconsistent result")
  if (lo < spendSy * MAX_LEVERAGE_MULTIPLE && affordable(run(lo + 1n))) {
    throw new Error("Buy-YT solver: net cost is not monotonic in sy_in")
  }
  return best
}
