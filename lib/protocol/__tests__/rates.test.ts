// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { CurveState } from "../curve"
import { buyPt, impliedRateAfter, sellPt } from "../curve"
import type { MarketState } from "../market-state"
import { aprToApy, SCALE } from "../math"
import {
  apyAfterTrade,
  effectiveFixedApy,
  effectiveImpliedApy,
  fixedPayoffUsd,
  leverage,
  tvlOf,
  underlyingApy7d,
  ytPrice,
} from "../rates"
import type { Live } from "../types"

const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 1 })
const DAY = 86_400

describe("ytPrice and leverage", () => {
  it("YT price is one minus the PT price", () => {
    expect(ytPrice(9_500_000n)).toBe(500_000n)
  })

  it("leverage 45x at 5.6 % and 150 days", () => {
    expect(Math.round(leverage(9_778_570n)!)).toBe(45)
  })

  it("leverage undefined at par", () => {
    expect(leverage(SCALE)).toBeUndefined()
    expect(leverage(SCALE + 1n)).toBeUndefined()
  })
})

describe("effective APYs", () => {
  it("spec example 5.26 % not 10.5 %", () => {
    const apy = effectiveFixedApy({
      paidUnderlying: 100_0000000n,
      oracleRate: 1_0500000n,
      ptOut: 110_5263157n,
      secondsToMaturity: 31_536_000n,
    })
    expect(Math.abs(apy! - 0.0526)).toBeLessThan(1e-4)
  })

  it("effective implied APY solves YT price = 1 - (1 + r)^-t (R2-17)", () => {
    // PT price 0.977857 -> YT price 0.022143 = c, over 150 days
    const c = Number(ytPrice(9_778_570n)) / Number(SCALE)
    const years = 150 / 365
    const expected = Math.pow(1 / (1 - c), 1 / years) - 1
    const apy = effectiveImpliedApy({
      spentUnderlying: 221_430_000n,
      oracleRate: SCALE,
      ytOut: 10_000_000_000n,
      secondsToMaturity: 150n * BigInt(DAY),
    })!
    expect(Math.abs(apy - expected)).toBeLessThan(1e-6)
    expect(apy).toBeCloseTo(0.056, 3)
  })

  it("is undefined when c >= 1", () => {
    const p = { spentUnderlying: 100n, oracleRate: SCALE, secondsToMaturity: 1000n }
    expect(effectiveImpliedApy({ ...p, ytOut: 100n })).toBeUndefined()
    expect(effectiveImpliedApy({ ...p, ytOut: 50n })).toBeUndefined()
  })

  it("is undefined, not 0, when it cannot be computed", () => {
    expect(effectiveFixedApy({ paidUnderlying: 0n, oracleRate: SCALE, ptOut: 1n, secondsToMaturity: 1000n })).toBeUndefined()
    expect(effectiveFixedApy({ paidUnderlying: 1n, oracleRate: SCALE, ptOut: 0n, secondsToMaturity: 1000n })).toBeUndefined()
    expect(effectiveImpliedApy({ spentUnderlying: 1n, oracleRate: SCALE, ytOut: 1n, secondsToMaturity: 0n })).toBeUndefined()
  })
})

describe("fixedPayoffUsd", () => {
  it("fixed payoff is in USD", () => {
    const r = fixedPayoffUsd(110_5263157n, 100_0000000n, 1_0500000n)
    expect(r.gainUsd).toBe(5_5263157n)
    expect(r.pct).toBeCloseTo(0.0526, 3)
  })

  it("a loss is negative", () => {
    expect(fixedPayoffUsd(100_0000000n, 100_0000000n, 1_0500000n).gainUsd).toBe(-5_0000000n)
  })

  it("the ratio is undefined, never 0, when nothing was paid (R2-18 pattern)", () => {
    expect(fixedPayoffUsd(100_0000000n, 0n, 1_0500000n)).toEqual({ gainUsd: 100_0000000n, pct: undefined })
    // Paid amounts too small to be worth a USD unit are nothing paid too.
    expect(fixedPayoffUsd(1n, 0n, 1_0500000n).pct).toBeUndefined()
  })
})

describe("underlyingApy7d", () => {
  it("7-day APY of a 5 % oracle", () => {
    const r = underlyingApy7d([
      { at: 0, rate: 1_0000000n },
      { at: 7 * DAY, rate: 1_0009357n },
    ])!
    expect(Math.abs(r.apy - 0.05)).toBeLessThan(0.0005)
    expect(r.windowSeconds).toBe(604_800)
  })

  it("7-day APY with 2 days of data reports a 2-day window", () => {
    const r = underlyingApy7d([
      { at: 5 * DAY, rate: 1_0000000n },
      { at: 7 * DAY, rate: 1_0002671n },
    ])!
    expect(r.windowSeconds).toBe(2 * DAY)
    expect(Math.abs(r.apy - 0.05)).toBeLessThan(0.001)
  })

  it("uses the oldest point within the last 7 days, ignoring older ones, in any order", () => {
    const r = underlyingApy7d([
      { at: 20 * DAY, rate: 1_0009357n },
      { at: 0, rate: 1_0000000n },
      { at: 13 * DAY, rate: 1_0000000n },
    ])!
    expect(r.windowSeconds).toBe(7 * DAY)
  })

  it("a point exactly 7 days old is inside the window", () => {
    const r = underlyingApy7d([{ at: 0, rate: 1_0000000n }, { at: 7 * DAY, rate: 1_0009357n }])
    expect(r?.windowSeconds).toBe(7 * DAY)
    expect(underlyingApy7d([{ at: 0, rate: 1_0000000n }, { at: 7 * DAY + 1, rate: 1_0009357n }])).toBeUndefined()
  })

  it("7-day APY undefined with fewer than 2 points", () => {
    expect(underlyingApy7d([])).toBeUndefined()
    expect(underlyingApy7d([{ at: 1, rate: SCALE }])).toBeUndefined()
  })

  it("undefined when the only recent point is the latest one, or a rate is not positive", () => {
    expect(underlyingApy7d([{ at: 0, rate: SCALE }, { at: 8 * DAY, rate: SCALE }])).toBeUndefined()
    expect(underlyingApy7d([{ at: 0, rate: 0n }, { at: DAY, rate: SCALE }])).toBeUndefined()
  })
})

describe("tvlOf (D-8: one TVL for /app and the dashboard)", () => {
  const src = (fn: string, ledger: number) => ({ contractId: `C${fn}`, fn, args: [], rawXdr: "AAAA", ledger, rpcUrl: "https://rpc.test" })
  const at = <T,>(value: T, fn: string, ledger = 1): Live<T> => ({ status: "live", value, ledger, source: src(fn, ledger) })
  const state = (over: Partial<Record<"syUnderlying" | "escrowUnderlying", Live<bigint>>> = {}) => ({
    syUnderlying: at(2_230_113_029_038n, "total_underlying"),
    escrowUnderlying: at(5_000_000n, "balance"),
    ...over,
  })

  it("is the SY wrapper's total_underlying plus the underlying RecoveryEscrow holds", () => {
    expect(tvlOf(state())).toMatchObject({ status: "live", value: 2_230_113_029_038n + 5_000_000n })
  })

  it("with an empty escrow it is exactly total_underlying", () => {
    expect(tvlOf(state({ escrowUnderlying: at(0n, "balance") }))).toMatchObject({ status: "live", value: 2_230_113_029_038n })
  })

  it("does not count the manager's SY or the pool's SY reserve (the old definition)", () => {
    // A MarketState carrying the old inputs still gives total_underlying + escrow: nothing else is read.
    const ms = { ...state(), poolState: live({ syReserve: 300n }), exchangeRate: live(1_0500000n) } as unknown as MarketState
    expect(tvlOf(ms)).toMatchObject({ status: "live", value: 2_230_113_029_038n + 5_000_000n })
  })

  it("keeps both reads as its provenance, total_underlying first, and labels a ledger spread", () => {
    const t = tvlOf(state({ escrowUnderlying: at(0n, "balance", 2) }))
    expect(t.status === "live" && t.sources?.map((s) => s.fn)).toEqual(["total_underlying", "balance"])
    expect(t.status === "live" && t.ledgerSpread).toEqual({ min: 1, max: 2 })
  })

  it("is unavailable if either input is, never a partial sum", () => {
    for (const k of ["syUnderlying", "escrowUnderlying"] as const) {
      const r = tvlOf(state({ [k]: { status: "unavailable", error: "rpc down" } }))
      expect(r).toMatchObject({ status: "unavailable", error: "rpc down" })
    }
  })
})

describe("apyAfterTrade", () => {
  const s: CurveState = {
    ptReserve: 1_000_000_0000000n,
    syReserve: 1_000_000_0000000n,
    totalLp: 1_000_000_0000000n,
    rate: SCALE,
    exponent: 800_000_000_000_000_000n,
    feeRate: 0n,
    secondsToMaturity: 150n * BigInt(DAY),
  }

  it("buying PT lowers the APY, selling PT raises it (R2-15)", () => {
    const buy = buyPt(s, 10_000_0000000n)
    const sell = sellPt(s, 10_000_0000000n)
    const now = apyAfterTrade(s, { amountIn: 0n, amountOut: 0n, feeShares: 0n, next: s })
    expect(apyAfterTrade(s, buy)).toBeLessThan(now)
    expect(apyAfterTrade(s, sell)).toBeGreaterThan(now)
  })

  it("compounds the post-trade implied rate over the time left", () => {
    const sell = sellPt(s, 10_000_0000000n)
    expect(apyAfterTrade(s, sell)).toBeCloseTo(aprToApy(impliedRateAfter(s, sell), s.secondsToMaturity), 12)
  })
})
