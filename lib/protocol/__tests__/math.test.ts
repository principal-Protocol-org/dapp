// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BPS,
  FEE_RATE_SCALE,
  INDEX_SCALE,
  SCALE,
  aprToApy,
  ceilDiv,
  formatBps,
  mulDivFloor,
} from "../math";

describe("math", () => {
  it("exposes the scales", () => {
    expect(SCALE).toBe(10_000_000n);
    expect(INDEX_SCALE).toBe(1_000_000_000_000n);
    expect(FEE_RATE_SCALE).toBe(1_000_000_000_000n);
    expect(BPS).toBe(10_000n);
  });

  it("ceilDiv rounds up", () => {
    expect(ceilDiv(5n, 2n)).toBe(3n);
    expect(ceilDiv(4n, 2n)).toBe(2n);
    expect(ceilDiv(0n, 3n)).toBe(0n);
  });

  it("mulDivFloor floors", () => {
    expect(mulDivFloor(10n, 3n, 4n)).toBe(7n);
  });

  it("formatBps renders percent", () => {
    expect(formatBps(50n)).toBe("0.50%");
    expect(formatBps(12_345n)).toBe("123.45%");
  });

  it("aprToApy compounds", () => {
    const days = 180;
    const expected = Math.pow(1 + (0.01274 * days) / 365, 365 / days) - 1;
    const got = aprToApy(127_400n, BigInt(days * 86_400));
    expect(Math.abs(got - expected)).toBeLessThan(1e-4);
  });

  it("aprToApy is the APR when maturity is not in the future", () => {
    expect(aprToApy(127_400n, 0n)).toBeCloseTo(0.01274, 10);
  });
});
