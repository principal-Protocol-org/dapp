import { describe, expect, it } from "vitest"
import { WAD, impliedRate, isqrt, spotPrice, type CurveState } from "@/lib/protocol/curve"
import { aprToApy, BPS, ceilDiv, SCALE, YEAR_SECONDS } from "@/lib/protocol/math"
import { previewDeposit, previewMint } from "@/lib/protocol/previews"
import { firstDepositCheck, firstDepositGate, MINIMUM_LIQUIDITY, seedAmounts, seedPair, seedResume } from "@/lib/protocol/seed"
import { liveValue, unavailable } from "@/lib/protocol/reader"

/**
 * The seed of a new market's pool (spec 0002 §5 step 6, R5-10): from a starting fixed APY and an
 * amount of the underlying, the PT and SY the first deposit takes, within the pool's first-deposit
 * rules (`market_pool` `add_liquidity`, total_lp == 0): `ceil(sy·rate/1e7) ≤ pt` (else
 * `InvalidInitialRatio`), `isqrt(pt·sy) > 1000` (else `MinimumLiquidity`), and a fresh oracle.
 * Checked against the curve port: the seeded pool's `implied_rate()`, compounded as the market list
 * shows it (`aprToApy`), is the APY typed.
 */

const DAY = 86_400n
/** The curve exponent `a = 1 − τ/stretch` at WAD, as `math::exponent` computes it. */
const exponentFor = (tau: bigint, stretch: bigint) => WAD - (tau * WAD) / stretch
const state = (tau: bigint, stretchYears = 3n) => ({ secondsToMaturity: tau, exponent: exponentFor(tau, stretchYears * YEAR_SECONDS) })

const BASE = {
  apy: 500_000n, // 5 %
  amountUnderlying: 10_000_000_000n, // 1000 USDY
  s: state(90n * DAY),
  oracleRate: 10_500_000n,
  exchangeRate: 10_200_000n,
  feeBps: 7n,
}

/** The pool right after the seed: the curve port reads what the contract's views would. */
function seeded(pt: bigint, sy: bigint, s: { secondsToMaturity: bigint; exponent: bigint }, rate: bigint): CurveState {
  return { ptReserve: pt, syReserve: sy, totalLp: isqrt(pt * sy), rate, exponent: s.exponent, feeRate: 0n, secondsToMaturity: s.secondsToMaturity }
}

function ok<T extends object>(r: T | { error: string }): T {
  if ("error" in r) throw new Error(`refused: ${r.error}`)
  return r
}

describe("seedAmounts: seed computes PT and SY from a starting APY", () => {
  it("within the first-deposit rules, and the seeded pool's fixed APY is the APY typed", () => {
    const r = ok(seedAmounts(BASE))
    const { oracleRate: rate, exchangeRate: xr, feeBps } = BASE

    // The whole amount is used: one part minted into PT + YT, the rest deposited as SY.
    expect(r.mintUnderlying + r.depositUnderlying).toBe(BASE.amountUnderlying)
    expect(r.mintUnderlying).toBeGreaterThan(0n)
    expect(r.depositUnderlying).toBeGreaterThan(0n)
    // The pool is offered no more than the mint and the deposit make (the dust stays in the wallet).
    const minted = previewMint(previewDeposit(r.mintUnderlying, xr), rate, feeBps).pt
    const deposited = previewDeposit(r.depositUnderlying, xr)
    expect(r.pt).toBeLessThanOrEqual(minted)
    expect(r.sy).toBeLessThanOrEqual(deposited)
    expect(minted - r.pt + (deposited - r.sy)).toBeLessThan(10n)

    // The pool's own rules (market_pool add_liquidity, first deposit).
    expect(ceilDiv(r.sy * rate, SCALE)).toBeLessThanOrEqual(r.pt)
    expect(isqrt(r.pt * r.sy)).toBeGreaterThan(MINIMUM_LIQUIDITY)
    expect(r.lp).toBe(isqrt(r.pt * r.sy) - MINIMUM_LIQUIDITY)

    // What the pool's views will read: PT below par, and the implied rate the list compounds to 5 %.
    const pool = seeded(r.pt, r.sy, BASE.s, rate)
    expect(spotPrice(pool)).toBeLessThan(SCALE)
    expect(r.ptPrice).toBe(spotPrice(pool))
    expect(r.impliedRate).toBe(impliedRate(pool))
    expect(Math.abs(aprToApy(r.impliedRate, BASE.s.secondsToMaturity) - 0.05)).toBeLessThan(1e-5)
  })

  it.each([
    ["one day left", 500_000n, state(DAY)],
    ["two years of a three-year stretch", 500_000n, state(2n * 365n * DAY)],
    ["a low APY", 5_000n, state(90n * DAY)],
    ["a high APY on a long stretch", 2_000_000n, state(180n * DAY, 10n)],
  ])("holds for %s", (_name, apy, s) => {
    const r = ok(seedAmounts({ ...BASE, apy, s }))
    expect(ceilDiv(r.sy * BASE.oracleRate, SCALE)).toBeLessThanOrEqual(r.pt)
    expect(isqrt(r.pt * r.sy)).toBeGreaterThan(MINIMUM_LIQUIDITY)
    const implied = impliedRate(seeded(r.pt, r.sy, s, BASE.oracleRate))
    expect(r.impliedRate).toBe(implied)
    // Within 0.001 percentage points: the price is read at 1e-7, the APY compounds over what is left.
    expect(Math.abs(aprToApy(implied, s.secondsToMaturity) - Number(apy) / Number(SCALE))).toBeLessThan(1e-5)
  })

  it("the tokenization fee is withheld before the mint: more of the amount goes to the mint than without it", () => {
    const free = ok(seedAmounts({ ...BASE, feeBps: 0n }))
    const fee = ok(seedAmounts({ ...BASE, feeBps: 100n }))
    expect(fee.mintUnderlying).toBeGreaterThan(free.mintUnderlying)
    expect(Math.abs(aprToApy(fee.impliedRate, BASE.s.secondsToMaturity) - 0.05)).toBeLessThan(1e-5)
  })
})

describe("seedAmounts: refusals (R5-10, Review Focus 5)", () => {
  it("a starting APY of zero or less is refused: PT must be priced below par, or YT cannot be bought", () => {
    for (const apy of [0n, -1n, -500_000n]) {
      const r = seedAmounts({ ...BASE, apy })
      expect(r).toEqual({ error: expect.stringMatching(/above 0/) })
      expect((r as { error: string }).error).toMatch(/YT/)
    }
  })

  it("an amount too small for the pool's minimum liquidity is refused", () => {
    expect(seedAmounts({ ...BASE, amountUnderlying: 1_500n })).toEqual({ error: expect.stringMatching(/too small/) })
  })

  it("a matured market, a missing rate or a non-positive amount is refused, never guessed", () => {
    expect(seedAmounts({ ...BASE, s: { secondsToMaturity: 0n, exponent: WAD } })).toEqual({ error: expect.stringMatching(/matur/) })
    expect(seedAmounts({ ...BASE, oracleRate: 0n })).toEqual({ error: expect.stringMatching(/oracle rate/) })
    expect(seedAmounts({ ...BASE, exchangeRate: 0n })).toEqual({ error: expect.stringMatching(/exchange rate/) })
    expect(seedAmounts({ ...BASE, amountUnderlying: 0n })).toEqual({ error: expect.stringMatching(/amount/) })
    expect(seedAmounts({ ...BASE, feeBps: BPS })).toEqual({ error: expect.stringMatching(/fee/) })
  })
})

describe("firstDepositCheck: the pool's rules on a given PT and SY", () => {
  const s = BASE.s
  const rate = BASE.oracleRate

  it("a ratio that prices PT at par is refused, as is one above par (InvalidInitialRatio)", () => {
    // sy·rate/1e7 == pt: the pool accepts it, but PT is then at par and YT cannot be bought (R5-10).
    const pt = 10_500_000_000n
    const atPar = firstDepositCheck({ pt, sy: 10_000_000_000n, s, oracleRate: rate })
    expect(atPar).toEqual({ ok: false, reason: expect.stringMatching(/at or above par/) })
    const above = firstDepositCheck({ pt: pt - 1n, sy: 10_000_000_000n, s, oracleRate: rate })
    expect(above).toEqual({ ok: false, reason: expect.stringMatching(/at or above par/) })
  })

  it("isqrt(pt·sy) of 1000 or less is refused (MinimumLiquidity)", () => {
    expect(firstDepositCheck({ pt: 1_000n, sy: 900n, s, oracleRate: rate })).toEqual({ ok: false, reason: expect.stringMatching(/too small/) })
  })

  it("a ratio below par passes, with the rate and LP the pool will report", () => {
    const r = firstDepositCheck({ pt: 10_000_000_000n, sy: 8_000_000_000n, s, oracleRate: rate })
    expect(r).toMatchObject({ ok: true, lp: isqrt(10_000_000_000n * 8_000_000_000n) - MINIMUM_LIQUIDITY })
  })
})

describe("seedPair: the largest PT and SY within what the wallet holds, at the starting APY", () => {
  it("never offers more than either cap, and keeps the APY", () => {
    const a = ok(seedPair({ apy: 500_000n, maxPt: 5_000_000_000n, maxSy: 100_000_000_000n, s: BASE.s, oracleRate: BASE.oracleRate }))
    expect(a.pt).toBe(5_000_000_000n)
    expect(a.sy).toBeLessThan(100_000_000_000n)
    const b = ok(seedPair({ apy: 500_000n, maxPt: 100_000_000_000n, maxSy: 2_000_000_000n, s: BASE.s, oracleRate: BASE.oracleRate }))
    expect(b.sy).toBe(2_000_000_000n)
    expect(b.pt).toBeLessThan(100_000_000_000n)
    for (const r of [a, b]) expect(Math.abs(aprToApy(r.impliedRate, BASE.s.secondsToMaturity) - 0.05)).toBeLessThan(1e-5)
  })
})

describe("seedResume: a seed started before (the wallet holds this market's PT) finishes with it", () => {
  const input = { apy: 500_000n, s: BASE.s, oracleRate: BASE.oracleRate, exchangeRate: BASE.exchangeRate }

  it("the PT held, and SY in the ratio: what is missing is deposited first, rounded up so the deposit covers it", () => {
    const r = ok(seedResume({ ...input, heldPt: 5_000_000_000n, heldSy: 1_000_000_000n }))
    expect(r.pt).toBe(5_000_000_000n)
    expect(r.depositUnderlying).toBeGreaterThan(0n)
    expect(1_000_000_000n + previewDeposit(r.depositUnderlying, BASE.exchangeRate)).toBeGreaterThanOrEqual(r.sy)
    expect(Math.abs(aprToApy(r.impliedRate, BASE.s.secondsToMaturity) - 0.05)).toBeLessThan(1e-5)
  })

  it("no deposit when the SY held already covers it", () => {
    const r = ok(seedResume({ ...input, heldPt: 5_000_000_000n, heldSy: 50_000_000_000n }))
    expect(r.depositUnderlying).toBe(0n)
    expect(r.pt).toBe(5_000_000_000n)
  })

  it("refuses an APY of zero or less, like a fresh seed", () => {
    expect(seedResume({ ...input, apy: 0n, heldPt: 5_000_000_000n, heldSy: 0n })).toEqual({ error: expect.stringMatching(/above 0/) })
  })
})

describe("firstDepositGate: in place of poolGate for the seed", () => {
  const amounts = ok(seedAmounts(BASE))
  const live = <T,>(v: T) => liveValue(v, 1)

  it("passes for an unseeded pool, a fresh oracle and amounts within the rules", () => {
    expect(firstDepositGate({ totalLp: live(0n), oracleFresh: live(true), amounts })).toEqual([])
  })

  it("refuses a pool that already holds liquidity: the first deposit is someone else's", () => {
    expect(firstDepositGate({ totalLp: live(1_000n), oracleFresh: live(true), amounts })).toEqual([
      { code: "pool", message: expect.stringMatching(/already seeded/) },
    ])
  })

  it("refuses a stale oracle, and an unreadable one", () => {
    expect(firstDepositGate({ totalLp: live(0n), oracleFresh: live(false), amounts })[0]).toMatchObject({ code: "oracle" })
    expect(firstDepositGate({ totalLp: live(0n), oracleFresh: unavailable("rpc 429"), amounts })[0]).toMatchObject({ code: "unavailable" })
  })

  it("refuses amounts the pool would refuse, with the reason", () => {
    expect(firstDepositGate({ totalLp: live(0n), oracleFresh: live(true), amounts: { error: "Enter a starting APY above 0 %." } })).toEqual([
      { code: "amount", message: "Enter a starting APY above 0 %." },
    ])
  })
})
