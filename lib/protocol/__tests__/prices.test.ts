// @vitest-environment node
import { describe, expect, it } from "vitest"
import { effectivePrice, formatImpact, priceImpactPpm, ptSpot, spotAtScale, ytSpot } from "../prices"

// pt_price 0.98 (notional value per PT), oracle rate 1.05 (notional per SY share).
const PT = ptSpot(9_800_000n, 10_500_000n)
const YT = ytSpot(9_800_000n, 10_500_000n)

describe("spot prices in SY", () => {
  it("PT costs pt_price / rate SY", () => {
    expect(spotAtScale(PT)).toBe(9_333_333n) // 0.98 / 1.05 = 0.9333…
  })
  it("YT costs (1 − pt_price) / rate SY: PT + YT is one notional unit", () => {
    expect(spotAtScale(YT)).toBe(190_476n) // 0.02 / 1.05 = 0.0190…
  })
  it("a non-positive rate has no spot price", () => {
    expect(() => ptSpot(9_800_000n, 0n)).toThrow(RangeError)
  })
})

describe("priceImpactPpm (positive = worse than spot)", () => {
  it("buy: 100 SY for 106.6 PT pays 0.509% above spot", () => {
    // 100 · 1.05 / (106.6 · 0.98) − 1 = 0.0050925…
    expect(priceImpactPpm("buy", 1_000_000_000n, 1_066_000_000n, PT)).toBe(5092n)
  })
  it("sell: 100 PT for 93 SY gets 0.357% below the 93.33 SY spot", () => {
    expect(priceImpactPpm("sell", 930_000_000n, 1_000_000_000n, PT)).toBe(3571n)
  })
  it("a trade better than spot is a negative impact, shown truthfully", () => {
    expect(priceImpactPpm("buy", 1_000_000_000n, 1_080_000_000n, PT)).toBeLessThan(0n)
  })
  it("refuses a zero spot or amount instead of dividing by zero", () => {
    expect(() => priceImpactPpm("buy", 1n, 0n, PT)).toThrow(RangeError)
    expect(() => priceImpactPpm("buy", 1n, 1n, ytSpot(10_000_000n, 10_500_000n))).toThrow(RangeError)
  })
})

describe("effectivePrice and formatImpact", () => {
  it("effective price is SY paid per token, at SCALE, floored", () => {
    expect(effectivePrice(1_000_000_000n, 1_066_000_000n)).toBe(9_380_863n)
  })
  it("formats parts per million as a percent with 2 decimals, truncated toward zero", () => {
    expect(formatImpact(5092n)).toBe("0.50%")
    expect(formatImpact(3571n)).toBe("0.35%")
    expect(formatImpact(-1234n)).toBe("-0.12%")
    expect(formatImpact(-12n)).toBe("0.00%")
    expect(formatImpact(0n)).toBe("0.00%")
    expect(formatImpact(123_456n)).toBe("12.34%")
  })
})
