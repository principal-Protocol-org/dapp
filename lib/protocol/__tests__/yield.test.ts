// @vitest-environment node
import { describe, expect, it } from "vitest";
import { INDEX_SCALE, SCALE, aprToApy, ceilDiv } from "../math";
import {
  accruingSinceRate,
  impliedApy,
  impliedRateFromPrice,
  poolValueInUnderlying,
  indexFor,
  pendingYield,
  ptFixedReturn,
  type PendingYieldInput,
} from "../yield";

/** Raw 7-decimal amount rounded half-up to 4 decimals, as a string. Test-only. */
function round4(raw: bigint): string {
  const tenThousandths = (raw + 500n) / 1_000n;
  const whole = tenThousandths / 10_000n;
  const frac = (tenThousandths % 10_000n).toString().padStart(4, "0");
  return `${whole}.${frac}`;
}

const DAY = 86_400n;

function input(overrides: Partial<PendingYieldInput>): PendingYieldInput {
  return {
    balance: 0n,
    lastClaimedIndex: indexFor(SCALE),
    pendingClaim: 0n,
    liveOracleRate: SCALE,
    ytFrozen: false,
    accruedYieldIndex: indexFor(SCALE),
    ytFeeBps: 0n,
    exchangeRate: SCALE,
    ...overrides,
  };
}

describe("indexFor", () => {
  it("indexFor mirrors the contract", () => {
    for (const r of [1n, 7n, SCALE, 10_500_000n, 11_000_000n, 12_345_678n]) {
      expect(indexFor(r)).toBe(ceilDiv(INDEX_SCALE * SCALE, r));
    }
    expect(indexFor(10_500_000n)).toBe(952_380_952_381n);
    expect(indexFor(11_000_000n)).toBe(909_090_909_091n);
  });

  it("refuses a non-positive rate", () => {
    expect(() => indexFor(0n)).toThrow(/rate/);
  });
});

describe("pendingYield", () => {
  it("example 3 claim with 10% fee", () => {
    const r = pendingYield(
      input({
        balance: 1_049_475_000n, // 104.9475 YT
        lastClaimedIndex: indexFor(10_500_000n),
        accruedYieldIndex: indexFor(10_500_000n),
        liveOracleRate: 11_000_000n,
        ytFeeBps: 1000n,
      }),
    );
    expect(round4(r.gross)).toBe("4.5432");
    expect(round4(r.fee)).toBe("0.4543");
    expect(round4(r.net)).toBe("4.0889");
    // Raw values: net is what doc_examples.rs:69 asserts the contract pays.
    expect(r.gross).toBe(45_431_818n);
    expect(r.fee).toBe(4_543_182n);
    expect(r.net).toBe(40_888_636n);
  });

  it("example 2 YT leg, frozen at 1.10, fee-free", () => {
    const r = pendingYield(
      input({
        balance: 1_050_000_000n,
        lastClaimedIndex: indexFor(10_500_000n),
        ytFrozen: true,
        accruedYieldIndex: indexFor(11_000_000n),
        liveOracleRate: 11_000_000n,
      }),
    );
    const diff = r.gross - 45_454_545n;
    expect(diff >= -1n && diff <= 1n).toBe(true);
    expect(r.net).toBe(r.gross);
    expect(r.fee).toBe(0n);
  });

  it("late holder earns nothing before entry", () => {
    const liveRate = 11_000_000n;
    const r = pendingYield(
      input({
        balance: 1_049_475_000n,
        lastClaimedIndex: indexFor(liveRate),
        accruedYieldIndex: indexFor(10_500_000n),
        liveOracleRate: liveRate,
        ytFeeBps: 1000n,
      }),
    );
    expect(r.gross).toBe(0n);
    expect(r.net).toBe(0n);
  });

  it("frozen index ignores later oracle moves", () => {
    const base = {
      balance: 1_049_475_000n,
      lastClaimedIndex: indexFor(10_500_000n),
      ytFeeBps: 1000n,
    };
    const frozen = pendingYield(
      input({
        ...base,
        ytFrozen: true,
        accruedYieldIndex: indexFor(11_000_000n),
        liveOracleRate: 12_000_000n,
      }),
    );
    const unfrozen = pendingYield(
      input({
        ...base,
        ytFrozen: false,
        accruedYieldIndex: indexFor(10_500_000n),
        liveOracleRate: 11_000_000n,
      }),
    );
    expect(frozen).toEqual(unfrozen);
  });

  it("never moves the index back below its high-water mark (yt_token:641)", () => {
    // A live read older than the stored index: the contract keeps the stored index.
    const base = { balance: 1_049_475_000n, lastClaimedIndex: indexFor(10_500_000n) };
    const stale = pendingYield(
      input({ ...base, accruedYieldIndex: indexFor(11_000_000n), liveOracleRate: 10_800_000n }),
    );
    const current = pendingYield(
      input({ ...base, accruedYieldIndex: indexFor(11_000_000n), liveOracleRate: 11_000_000n }),
    );
    expect(stale).toEqual(current);
  });

  it("subtracts one index unit before settling (yt_token:708-709)", () => {
    // last - index == 1: the guard leaves nothing to settle, even on a huge balance.
    const last = indexFor(11_000_000n) + 1n;
    const r = pendingYield(
      input({
        balance: 10n ** 18n,
        lastClaimedIndex: last,
        accruedYieldIndex: last,
        liveOracleRate: 11_000_000n,
      }),
    );
    expect(r.gross).toBe(0n);
    // last - index == 2: exactly one index unit is settled.
    const r2 = pendingYield(
      input({
        balance: INDEX_SCALE,
        lastClaimedIndex: indexFor(11_000_000n) + 2n,
        accruedYieldIndex: indexFor(11_000_000n) + 2n,
        liveOracleRate: 11_000_000n,
      }),
    );
    expect(r2.gross).toBe(1n);
  });

  it("adds the already settled pending claim", () => {
    const r = pendingYield(input({ pendingClaim: 1_000n, ytFeeBps: 1000n }));
    expect(r).toEqual({ gross: 1_000n, fee: 100n, net: 900n });
  });

  it("rounds the YT fee up, in SY shares (principal_manager:775)", () => {
    // ceil(1 share * 10%) = 1 share: everything is withheld.
    expect(pendingYield(input({ pendingClaim: 1n, ytFeeBps: 1000n }))).toEqual({
      gross: 1n,
      fee: 1n,
      net: 0n,
    });
  });

  it("converts through SY shares at the exchange rate (principal_manager:773-781)", () => {
    // gross 45_431_818 -> shares floor(gross * 1e7 / 10_000_003) = 45_431_804
    // fee shares ceil(45_431_804 * 1000 / 10_000) = 4_543_181; net shares 40_888_623
    // net = floor(40_888_623 * 10_000_003 / 1e7) = 40_888_635; fee = gross - net = 4_543_183
    const r = pendingYield(
      input({
        balance: 1_049_475_000n,
        lastClaimedIndex: indexFor(10_500_000n),
        accruedYieldIndex: indexFor(10_500_000n),
        liveOracleRate: 11_000_000n,
        ytFeeBps: 1000n,
        exchangeRate: 10_000_003n,
      }),
    );
    expect(r).toEqual({ gross: 45_431_818n, fee: 4_543_183n, net: 40_888_635n });
  });

  it("refuses a non-positive exchange rate, or oracle rate while unfrozen", () => {
    expect(() => pendingYield(input({ exchangeRate: 0n }))).toThrow(/exchange rate/);
    expect(() => pendingYield(input({ liveOracleRate: 0n }))).toThrow(/rate/);
    // Once frozen the live rate is not read.
    expect(() => pendingYield(input({ ytFrozen: true, liveOracleRate: 0n }))).not.toThrow();
  });
});

describe("accruingSinceRate", () => {
  it("recovers the rate an index was computed from", () => {
    for (const r of [SCALE, 10_500_000n, 11_000_000n, 12_345_678n, 99_999_999n]) {
      expect(accruingSinceRate(indexFor(r))).toBe(r);
    }
    // A floor inversion would give 10_499_999 here.
    expect(accruingSinceRate(952_380_952_381n)).toBe(10_500_000n);
  });

  it("refuses a non-positive index", () => {
    expect(() => accruingSinceRate(0n)).toThrow(/index/);
  });
});

describe("impliedApy", () => {
  it("compounds the on-chain APR", () => {
    const tau = 180n * DAY;
    expect(impliedApy(127_382n, tau)).toBe(aprToApy(127_382n, tau));
    expect(impliedApy(127_382n, tau)).toBeGreaterThan(0.01274);
    expect(impliedApy(127_382n, tau)).toBeLessThan(0.0129);
  });
});

describe("impliedRateFromPrice", () => {
  it("mirrors market_pool implied_rate (example 5 opening price -> 1.27%)", () => {
    expect(impliedRateFromPrice(9_937_573n, 180n * DAY)).toBe(127_382n);
  });

  it("is zero at maturity and for a non-positive price", () => {
    expect(impliedRateFromPrice(9_937_573n, 0n)).toBe(0n);
    expect(impliedRateFromPrice(0n, 180n * DAY)).toBe(0n);
  });

  it("is negative above par, as the contract reports", () => {
    expect(impliedRateFromPrice(10_100_000n, 180n * DAY)).toBe(-200_770n);
  });
});

describe("ptFixedReturn", () => {
  it("prices 100 PT in the example 5 pool", () => {
    const tau = 180n * DAY;
    const r = ptFixedReturn({ pt: 1_000_000_000n, ptPrice: 9_937_573n, secondsToMaturity: tau });
    expect(r.faceAtMaturity).toBe(1_000_000_000n);
    expect(r.valueNow).toBe(993_757_300n);
    expect(r.apy).toBe(aprToApy(127_382n, tau));
  });

  it("floors the current value", () => {
    // 3 * 9_937_573 / 1e7 = 2.98 -> 2
    expect(ptFixedReturn({ pt: 3n, ptPrice: 9_937_573n, secondsToMaturity: DAY }).valueNow).toBe(
      2n,
    );
  });

  it("matured: apy 0", () => {
    const r = ptFixedReturn({ pt: 1_000_000_000n, ptPrice: SCALE, secondsToMaturity: 0n });
    expect(r).toEqual({ faceAtMaturity: 1_000_000_000n, valueNow: 1_000_000_000n, apy: 0 });
    // A discount left at maturity still yields 0, never the raw APR.
    expect(ptFixedReturn({ pt: 1n, ptPrice: 9_000_000n, secondsToMaturity: 0n }).apy).toBe(0);
  });

  it("at par: apy 0; above par: negative and finite", () => {
    expect(ptFixedReturn({ pt: 1n, ptPrice: SCALE, secondsToMaturity: 180n * DAY }).apy).toBe(0);
    const above = ptFixedReturn({ pt: 1n, ptPrice: 10_100_000n, secondsToMaturity: 180n * DAY });
    expect(above.apy).toBeLessThan(0);
    expect(Number.isFinite(above.apy)).toBe(true);
  });

  it("a zero price gives zero value and apy 0, as implied_rate does", () => {
    expect(ptFixedReturn({ pt: 1_000n, ptPrice: 0n, secondsToMaturity: DAY })).toEqual({
      faceAtMaturity: 1_000n,
      valueNow: 0n,
      apy: 0,
    });
  });
});

describe("poolValueInUnderlying", () => {
  const base = { syReserve: 34_000_000_000n, ptReserve: 12_000_000_000n, exchangeRate: 10_500_000n, ptPrice: 9_800_000n, oracleRate: 10_500_000n };
  it("adds SY at the exchange rate and PT at spot price over the oracle rate, flooring each term", () => {
    // 34e9 * 1.05 = 35.7e9 ; 12e9 * 0.98 / 1.05 = 11_200_000_000
    expect(poolValueInUnderlying(base)).toBe(35_700_000_000n + 11_200_000_000n);
    expect(poolValueInUnderlying({ ...base, syReserve: 3n, ptReserve: 3n, ptPrice: 9_999_999n, exchangeRate: 10_000_001n, oracleRate: 10_000_000n })).toBe(3n + 2n);
  });
  it("is null for a non-positive rate or price", () => {
    expect(poolValueInUnderlying({ ...base, oracleRate: 0n })).toBeNull();
    expect(poolValueInUnderlying({ ...base, ptPrice: 0n })).toBeNull();
    expect(poolValueInUnderlying({ ...base, exchangeRate: -1n })).toBeNull();
  });
});
