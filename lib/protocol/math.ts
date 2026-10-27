/** Fixed-point scales. Amounts and rates are bigint end to end. */
export const SCALE = 10_000_000n; // rates, exchange_rate, pt_price, implied_rate
export const INDEX_SCALE = 1_000_000_000_000n; // YT index
export const FEE_RATE_SCALE = 1_000_000_000_000n; // swap_fee_rate
export const BPS = 10_000n; // basis points

export const YEAR_SECONDS = 31_536_000n; // 365 days

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

/** Basis points as a percent string: 50n -> "0.50%". */
export function formatBps(bps: bigint): string {
  const negative = bps < 0n;
  const abs = negative ? -bps : bps;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}%`;
}

/**
 * Converts a simple APR (scaled by SCALE) to a compounded APY fraction.
 * The only function allowed to use `number`: the result feeds display only.
 * With no time left the APR itself is returned.
 */
export function aprToApy(aprScaled: bigint, secondsToMaturity: bigint): number {
  const apr = Number(aprScaled) / Number(SCALE);
  const seconds = Number(secondsToMaturity);
  if (seconds <= 0) return apr;
  const year = Number(YEAR_SECONDS);
  const periods = year / seconds;
  return Math.pow(1 + (apr * seconds) / year, periods) - 1;
}
