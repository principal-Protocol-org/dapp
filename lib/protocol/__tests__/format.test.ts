// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatBps,
  formatFeeRate,
  formatPercent,
  formatRate,
  hashLike,
  parseDecimalToRaw,
  shorten,
} from "../format";

describe("parseDecimalToRaw", () => {
  it("parses decimals into bigint", () => {
    expect(parseDecimalToRaw("1.5", 7)).toBe(15_000_000n);
    expect(parseDecimalToRaw("0", 7)).toBe(0n);
    expect(parseDecimalToRaw("007", 2)).toBe(700n);
  });
  it("rejects lossy or malformed input", () => {
    expect(parseDecimalToRaw("1.12345678", 7)).toBeNull();
    expect(parseDecimalToRaw("1e3", 7)).toBeNull();
    expect(parseDecimalToRaw("-1", 7)).toBeNull();
    expect(parseDecimalToRaw("", 7)).toBeNull();
  });
});

describe("formatAmount", () => {
  it("formats and trims", () => {
    expect(formatAmount(1_049_475_000n, 7)).toBe("104.9475");
    expect(formatAmount(10_000_000n, 7)).toBe("1");
    expect(formatAmount(0n, 7)).toBe("0");
  });
  it("truncates, never rounds up", () => {
    expect(formatAmount(19_999_999n, 7)).toBe("1.9999");
    expect(formatAmount(1n, 7)).toBe("0");
  });
  it("handles negatives", () => {
    expect(formatAmount(-15_000_000n, 7)).toBe("-1.5");
    expect(formatAmount(-1n, 7)).toBe("0");
  });
});

describe("formatRate / formatPercent / helpers", () => {
  it("formats rate", () => {
    expect(formatRate(10_500_000n)).toBe("1.0500");
  });
  it("formats percent", () => {
    expect(formatPercent(0.01274)).toBe("1.27%");
  });
  it("shorten and hashLike", () => {
    expect(shorten("abcdefghijklmnopqrstuvwxyz")).toBe("abcdef...uvwxyz");
    expect(hashLike("a")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("fee formatting", () => {
  it("formats bps exactly", () => {
    expect(formatBps(30n)).toBe("0.30%");
    expect(formatBps(5n)).toBe("0.05%");
    expect(formatBps(100n)).toBe("1.00%");
    expect(formatBps(0n)).toBe("0.00%");
  });
  it("formats a 1e12-scaled swap fee rate", () => {
    expect(formatFeeRate(3_000_000_000n)).toBe("0.3000%");
    expect(formatFeeRate(0n)).toBe("0.0000%");
    expect(formatFeeRate(1_234_567_890n)).toBe("0.1234%");
  });
});
