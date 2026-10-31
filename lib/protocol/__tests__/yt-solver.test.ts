// @vitest-environment node
import { describe, expect, it } from "vitest"
import { aprToApy } from "../math"
import { impliedRate, sellPt, spotPrice, type CurveState } from "../curve"
import { previewMint } from "../previews"
import { leverage } from "../rates"
import { solveBuyYt } from "../yt-solver"

// Curve test state A: 150 days left, oracle 1.05, fee 0.3 % x 150/365 (Rust-produced vector).
const A: CurveState = {
  ptReserve: 1000000000000n, syReserve: 580000000000n, totalLp: 760000000000n, rate: 10500000n,
  exponent: 958904109589041096n, feeRate: 1232876712n, secondsToMaturity: 12960000n,
}
const FEE_BPS = 10n

function params(spendSy: bigint) {
  return { spendSy, oracleRate: A.rate, tokenizationFeeBps: FEE_BPS }
}
function netCostOf(syIn: bigint): bigint {
  const { pt } = previewMint(syIn, A.rate, FEE_BPS)
  return syIn - sellPt(A, pt).amountOut
}

describe("solveBuyYt", () => {
  const spends = Array.from({ length: 20 }, (_, i) => BigInt(Math.max(1, Math.round(10 ** ((i * 12) / 19)))))

  it("net cost never exceeds the spend", () => {
    expect(spends[0]).toBe(1n)
    expect(spends[19]).toBe(10n ** 12n)
    let solved = 0
    for (const spend of spends) {
      const r = solveBuyYt(A, params(spend))
      if ("error" in r) continue // dust spends mint no PT
      solved++
      expect(r.netCost).toBeLessThanOrEqual(spend)
      expect(r.netCost).toBe(r.syIn - r.syBack)
      expect(netCostOf(r.syIn)).toBe(r.netCost)
      expect(r.ytOut).toBe(previewMint(r.syIn, A.rate, FEE_BPS).yt)
    }
    expect(solved).toBeGreaterThanOrEqual(15)
  })

  it("net cost within 1 raw unit of the spend when the pool is deep enough", () => {
    for (const spend of [1_000_000n, 50_000_000n, 1_000_000_000n, 10_000_000_000n]) {
      const r = solveBuyYt(A, params(spend))
      if ("error" in r) throw new Error(`unexpected error at ${spend}`)
      expect(r.netCost).toBeLessThanOrEqual(spend)
      // One more SY in would overspend (the largest sy_in), so the cost is within one step.
      expect(netCostOf(r.syIn + 1n)).toBeGreaterThan(spend)
      expect(spend - r.netCost).toBeLessThanOrEqual(1n)
    }
  })

  it("syIn is about leverage x spend, within 2 %, at 150 days and 5.6 %", () => {
    // A pool at ~5.6 % APY with 150 days left: state A with a lighter SY reserve.
    // Swap fee 0: the pool fee is charged on the whole PT sale, so against a ~2 % YT price it
    // adds several percent to the cost and is not part of the leverage figure.
    let s: CurveState = { ...A, syReserve: 579_000_000_000n, feeRate: 0n }
    let apy = aprToApy(impliedRate(s), s.secondsToMaturity)
    for (let i = 0; i < 60 && Math.abs(apy - 0.056) > 0.0005; i++) {
      s = { ...s, syReserve: s.syReserve + (apy > 0.056 ? 1_000_000_000n : -1_000_000_000n) }
      apy = aprToApy(impliedRate(s), s.secondsToMaturity)
    }
    expect(apy).toBeGreaterThan(0.055)
    expect(apy).toBeLessThan(0.057)
    const lev = leverage(spotPrice(s))!
    const spend = 1_000_000n // negligible price impact on a 1e12-unit pool
    const r = solveBuyYt(s, { spendSy: spend, oracleRate: s.rate, tokenizationFeeBps: 0n })
    if ("error" in r) throw new Error(r.error)
    const ratio = Number(r.syIn) / (lev * Number(spend))
    expect(ratio).toBeGreaterThan(0.98)
    expect(ratio).toBeLessThan(1.02)
  })

  it("error when the pool cannot absorb the PT, naming the pool", () => {
    const tiny: CurveState = { ...A, ptReserve: 2_000n, syReserve: 1_500n }
    const r = solveBuyYt(tiny, params(1_000_000n))
    expect("error" in r).toBe(true)
    if ("error" in r) expect(r.error).toMatch(/pool cannot absorb the PT/)
  })

  it("rejects a zero spend", () => {
    expect("error" in solveBuyYt(A, params(0n))).toBe(true)
  })
})
