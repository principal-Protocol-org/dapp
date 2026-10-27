// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SCALE } from "../math";
import {
  previewAddLiquidity,
  previewBuyYt,
  previewDeposit,
  previewMint,
  previewRecombine,
  previewRedeemPt,
  previewRemoveLiquidity,
  previewSellYt,
  previewWithdraw,
} from "../previews";

// Fixtures are the worked examples of `principal` docs/YIELD_MATH_AND_FEES.md, each asserted by
// contracts/integration_tests/tests/doc_examples.rs.

describe("previewDeposit / previewWithdraw", () => {
  it("is 1:1 at the release's exchange rate of 1.0", () => {
    expect(previewDeposit(1_000_000_000n, SCALE)).toBe(1_000_000_000n);
    expect(previewWithdraw(1_000_000_000n, SCALE)).toBe(1_000_000_000n);
  });

  it("floors both directions (sy_wrapper:527, :532)", () => {
    // 1000 * 1e7 / 10_000_003 = 999.9997 -> 999
    expect(previewDeposit(1_000n, 10_000_003n)).toBe(999n);
    // 999 * 10_000_003 / 1e7 = 999.0003 -> 999
    expect(previewWithdraw(999n, 10_000_003n)).toBe(999n);
  });

  it("refuses a non-positive exchange rate", () => {
    expect(() => previewDeposit(1n, 0n)).toThrow(/exchange rate/);
    expect(() => previewWithdraw(1n, -1n)).toThrow(/exchange rate/);
  });
});

describe("previewMint", () => {
  it("example 1 mint preview", () => {
    expect(previewMint(1_000_000_000n, 10_500_000n, 5n)).toEqual({
      feeShares: 500_000n,
      pt: 1_049_475_000n,
      yt: 1_049_475_000n,
    });
  });

  it("example 1 fee-free", () => {
    expect(previewMint(1_000_000_000n, 10_500_000n, 0n)).toEqual({
      feeShares: 0n,
      pt: 1_050_000_000n,
      yt: 1_050_000_000n,
    });
  });

  it("rounds the fee up so it is never zero on a non-zero rate (principal_manager:382)", () => {
    // ceil(3 * 5 / 10_000) = 1
    expect(previewMint(3n, SCALE, 5n).feeShares).toBe(1n);
  });

  it("floors the notional (principal_manager:387)", () => {
    // (10 - 0) * 10_500_001 / 1e7 = 10.500001 -> 10
    expect(previewMint(10n, 10_500_001n, 0n).pt).toBe(10n);
  });
});

describe("previewRecombine", () => {
  it("returns SY at the current rate (doc §8: 100 PT + 100 YT at 1.25 -> 80 SY)", () => {
    expect(previewRecombine(1_000_000_000n, 12_500_000n)).toBe(800_000_000n);
  });

  it("floors (principal_manager:435)", () => {
    // 1e9 * 1e7 / 1.1e7 = 909_090_909.09 -> 909_090_909
    expect(previewRecombine(1_000_000_000n, 11_000_000n)).toBe(909_090_909n);
  });

  it("refuses a non-positive rate", () => {
    expect(() => previewRecombine(1n, 0n)).toThrow(/rate/);
  });
});

describe("previewRedeemPt", () => {
  it("example 2 redeem", () => {
    const out = previewRedeemPt(1_050_000_000n, 11_000_000n);
    const diff = out - 954_545_454n;
    expect(diff >= -1n && diff <= 1n).toBe(true);
  });

  it("goes through SY shares at the exchange rate (principal_manager:499-503)", () => {
    // underlying = 1.05e9 * 1e7 / 1.1e7 = 954_545_454
    // shares     = 954_545_454 * 1e7 / 10_000_003 = 954_545_167
    // withdrawn  = 954_545_167 * 10_000_003 / 1e7 = 954_545_453
    expect(previewRedeemPt(1_050_000_000n, 11_000_000n, 10_000_003n)).toBe(954_545_453n);
  });

  it("refuses a non-positive rate or exchange rate", () => {
    expect(() => previewRedeemPt(1n, 0n)).toThrow(/rate/);
    expect(() => previewRedeemPt(1n, SCALE, 0n)).toThrow(/exchange rate/);
  });
});

describe("previewAddLiquidity", () => {
  it("add liquidity uses the binding side", () => {
    // lp from PT = floor(10 * 577 / 1000) = floor(5.77)  = 5   <- binding
    // lp from SY = floor(10 * 577 / 333)  = floor(17.33) = 17
    // ptUsed = ceil(5 * 1000 / 577) = ceil(8.666) = 9
    // syUsed = ceil(5 * 333 / 577)  = ceil(2.886) = 3
    expect(previewAddLiquidity(10n, 10n, { pt: 1_000n, sy: 333n }, 577n)).toEqual({
      lp: 5n,
      ptUsed: 9n,
      syUsed: 3n,
    });
    // SY binding: lp from PT = floor(100 * 577 / 1000) = 57; from SY = floor(10 * 577 / 333) = 17
    // ptUsed = ceil(17 * 1000 / 577) = ceil(29.46) = 30; syUsed = ceil(17 * 333 / 577) = ceil(9.81) = 10
    expect(previewAddLiquidity(100n, 10n, { pt: 1_000n, sy: 333n }, 577n)).toEqual({
      lp: 17n,
      ptUsed: 30n,
      syUsed: 10n,
    });
  });

  it("adds 100 PT + 100 SY to the Example 5 pool", () => {
    // Pool of doc example 5: 999.5 PT / 950 SY, LP = 9_744_356_341 minted + 1_000 locked.
    const reserves = { pt: 9_995_000_000n, sy: 9_500_000_000n };
    const totalLp = 9_744_357_341n;
    // lp = min(1e9 * T / 9.995e9, 1e9 * T / 9.5e9) = min(974_923_195, 1_025_721_825)
    expect(previewAddLiquidity(1_000_000_000n, 1_000_000_000n, reserves, totalLp)).toEqual({
      lp: 974_923_195n,
      ptUsed: 1_000_000_000n,
      syUsed: 950_475_237n,
    });
  });

  it("previews nothing when one side is zero (the contract reverts ZeroAmount)", () => {
    expect(previewAddLiquidity(0n, 10n, { pt: 1_000n, sy: 333n }, 577n)).toEqual({
      lp: 0n,
      ptUsed: 0n,
      syUsed: 0n,
    });
  });

  it("refuses an unseeded or empty pool", () => {
    expect(() => previewAddLiquidity(10n, 10n, { pt: 0n, sy: 0n }, 0n)).toThrow(/not seeded/);
    expect(() => previewAddLiquidity(10n, 10n, { pt: 0n, sy: 333n }, 577n)).toThrow(/reserve/);
  });
});

describe("previewRemoveLiquidity", () => {
  it("remove liquidity floors", () => {
    // pt = floor(100 * 1000 / 577) = floor(173.31) = 173
    // sy = floor(100 * 333 / 577)  = floor(57.71)  = 57 (not 58)
    expect(previewRemoveLiquidity(100n, { pt: 1_000n, sy: 333n }, 577n)).toEqual({
      pt: 173n,
      sy: 57n,
    });
  });

  it("removes 100 LP from the Example 5 pool", () => {
    const reserves = { pt: 9_995_000_000n, sy: 9_500_000_000n };
    // pt = floor(1e9 * 9.995e9 / T) = 1_025_721_825; sy = floor(1e9 * 9.5e9 / T) = 974_923_195
    expect(previewRemoveLiquidity(1_000_000_000n, reserves, 9_744_357_341n)).toEqual({
      pt: 1_025_721_825n,
      sy: 974_923_195n,
    });
  });

  it("refuses a pool with no LP supply", () => {
    expect(() => previewRemoveLiquidity(1n, { pt: 0n, sy: 0n }, 0n)).toThrow(/LP supply/);
  });
});

describe("previewSellYt", () => {
  it("example 6 flash-redeem: recombined SY minus the PT's exact-out cost", () => {
    // 100 YT at rate 1.0 recombine into 100 SY; quote_buy_exact_pt(100 PT).amount_in = 98.1284454
    expect(previewSellYt(1_000_000_000n, SCALE, 981_284_454n)).toBe(18_715_546n);
  });

  it("recombines at the oracle rate, floored (principal_manager:435)", () => {
    // 1e9 * 1e7 / 1.05e7 = 952_380_952; minus 900_000_000
    expect(previewSellYt(1_000_000_000n, 10_500_000n, 900_000_000n)).toBe(52_380_952n);
  });

  it("is zero when the PT costs more than the recombined SY (the pool reverts)", () => {
    expect(previewSellYt(1_000_000_000n, SCALE, 1_000_000_001n)).toBe(0n);
  });

  it("refuses a non-positive rate", () => {
    expect(() => previewSellYt(1n, 0n, 0n)).toThrow(/rate/);
  });
});

describe("previewBuyYt", () => {
  it("example 6 flash-mint: 100 SY -> 100 YT, PT sells for 98.1284452 SY", () => {
    expect(previewBuyYt(1_000_000_000n, SCALE, 0n, 981_284_452n)).toEqual({
      yt: 1_000_000_000n,
      syBack: 981_284_452n,
      netCost: 18_715_548n,
    });
  });

  it("sizes the YT like mint, tokenization fee included", () => {
    const r = previewBuyYt(1_000_000_000n, 10_500_000n, 5n, 1_000_000_000n);
    expect(r.yt).toBe(1_049_475_000n);
    expect(r.netCost).toBe(0n);
  });
});
