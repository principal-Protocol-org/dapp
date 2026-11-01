// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  formatAmount,
  formatBps,
  formatFeeRate,
  formatGainLoss,
  formatPercent,
  formatRate,
  formatTokenAmount,
  formatUsdCents,
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
  it("groups thousands", () => {
    expect(formatAmount(1_948_989_917_000n, 7, 4, { group: true })).toBe("194,898.9917");
    expect(formatAmount(-1_948_989_917_000n, 7, 4, { group: true })).toBe("-194,898.9917");
    expect(formatAmount(10_000_000_000_000n, 7, 4, { group: true })).toBe("1,000,000");
    expect(formatAmount(1_948_989_917_000n, 7)).toBe("194898.9917");
  });
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

describe("formatTokenAmount (preview amounts)", () => {
  it("shows at least 4 decimals", () => {
    expect(formatTokenAmount(1_000_000_000n, 7)).toBe("100.0000");
    expect(formatTokenAmount(500_000n, 7)).toBe("0.0500");
    expect(formatTokenAmount(0n, 7)).toBe("0.0000");
    expect(formatTokenAmount(1_049_475_000n, 7)).toBe("104.9475");
  });
  it("keeps every further non-zero digit, so an exact amount is never cut or rounded", () => {
    expect(formatTokenAmount(45_431_818n, 7)).toBe("4.5431818");
    expect(formatTokenAmount(4_543_182n, 7)).toBe("0.4543182");
    expect(formatTokenAmount(1n, 7)).toBe("0.0000001");
    expect(formatTokenAmount(995_000_000n, 7)).toBe("99.5000");
  });
  it("handles negatives, other decimals and tokens with fewer than 4 decimals", () => {
    expect(formatTokenAmount(-500_000n, 7)).toBe("-0.0500");
    expect(formatTokenAmount(150n, 2)).toBe("1.50");
    expect(formatTokenAmount(7n, 0)).toBe("7");
    expect(formatTokenAmount(123_456_789_012n, 9)).toBe("123.456789012");
  });
});

describe("formatUsdCents (a USD gain or loss, against the reader)", () => {
  it("floors a gain to the cent, with a plus sign", () => {
    expect(formatUsdCents(55_263_157n, 7)).toBe("+$5.52");
    expect(formatUsdCents(55_300_000n, 7)).toBe("+$5.53");
    expect(formatUsdCents(0n, 7)).toBe("+$0.00");
    expect(formatUsdCents(99_999n, 7)).toBe("+$0.00");
  });

  it("rounds a loss's magnitude up, with the ASCII minus of formatAmount", () => {
    expect(formatUsdCents(-1_230_001n, 7)).toBe("-$0.13");
    expect(formatUsdCents(-1n, 7)).toBe("-$0.01");
    expect(formatUsdCents(-1_300_000n, 7)).toBe("-$0.13");
  });

  it("groups thousands", () => {
    expect(formatUsdCents(12_345_678_900_000n, 7)).toBe("+$1,234,567.89");
  });
});

describe("formatGainLoss (an amount gained or lost, against the reader)", () => {
  it("truncates a gain like formatAmount", () => {
    expect(formatGainLoss(52_666_666n, 7)).toBe("5.2666");
    expect(formatGainLoss(52_666_666n, 7)).toBe(formatAmount(52_666_666n, 7));
  });

  it("rounds a loss's magnitude up, so it is never understated or shown as 0", () => {
    expect(formatGainLoss(-47_619_048n, 7)).toBe("-4.762");
    expect(formatGainLoss(-1n, 7)).toBe("-0.0001");
    expect(formatGainLoss(-12_345_678_900_000n, 7, 2, { group: true })).toBe("-1,234,567.89");
  });
});
