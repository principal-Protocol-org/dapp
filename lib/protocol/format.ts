import { SCALE } from "./math";

export { hashLike } from "./hash";

export function shorten(value: string, left = 6, right = 6) {
  if (value.length <= left + right + 3) return value;
  return `${value.slice(0, left)}...${value.slice(-right)}`;
}

/**
 * Parses a human decimal amount ("1.5") into a raw base-unit bigint at `decimals`.
 * Returns null for anything that isn't a plain non-negative decimal (no exponents, signs, or
 * more fractional digits than `decimals` supports) rather than rounding or truncating silently.
 */
export function parseDecimalToRaw(value: string, decimals: number): bigint | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

function fixed(raw: bigint, decimals: number, fractionDigits: number, trim: boolean, group = false): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, "0");
  // Truncate (never round up) so a displayed value never exceeds the real one.
  fraction = fraction.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  if (trim) fraction = fraction.replace(/0+$/, "");
  const wholeText = group ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",") : `${whole}`;
  const body = fraction ? `${wholeText}.${fraction}` : wholeText;
  // Avoid "-0" when the truncated magnitude is zero.
  const isZero = whole === 0n && !/[1-9]/.test(fraction);
  return negative && !isZero ? `-${body}` : body;
}

/**
 * Display-only amount: truncates (does not round) the fraction to `maxFraction` digits and
 * trims trailing zeros. Negative values get a leading "-". Never feeds math. `group: true` adds
 * English thousands separators ("194,898.9917"); the default is ungrouped.
 */
export function formatAmount(
  raw: bigint,
  decimals: number,
  maxFraction = 4,
  options: { group?: boolean } = {},
): string {
  return fixed(raw, decimals, Math.min(maxFraction, decimals), true, options.group === true);
}

/**
 * A preview amount: at least 4 decimals (all of them for a token with fewer), plus every further
 * digit up to the token's `decimals` while it is not zero. Exact: nothing is cut or rounded, so a
 * previewed amount reads the same as the raw value. 1_000_000_000n (7) -> "100.0000",
 * 45_431_818n -> "4.5431818".
 */
export function formatTokenAmount(raw: bigint, decimals: number, group = false): string {
  const min = Math.min(4, decimals);
  const exact = fixed(raw, decimals, decimals, true, group);
  const [whole, fraction = ""] = exact.split(".");
  const padded = fraction.padEnd(min, "0");
  return padded ? `${whole}.${padded}` : whole;
}

/** Rate at SCALE with 4 fixed decimals: 10_500_000n -> "1.0500". */
export function formatRate(rate: bigint): string {
  return fixed(rate, SCALE.toString().length - 1, 4, false);
}

/** Fraction as percent with 2 decimals: 0.01274 -> "1.27%". Display only. */
export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

export function formatUnixTime(seconds: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(seconds * 1000));
}

function percentFrom(scaled: bigint, digits: number): string {
  const base = 10n ** BigInt(digits);
  return `${scaled / base}.${(scaled % base).toString().padStart(digits, "0")}%`;
}

/** Basis points as a percent, exact: 30n -> "0.30%". */
export function formatBps(bps: bigint): string {
  return percentFrom(bps, 2);
}

/** A `swap_fee_rate` (scale 1e12) as a percent with 4 decimals, truncated: 3_000_000_000n -> "0.3000%". */
export function formatFeeRate(rate: bigint): string {
  return percentFrom((rate * 100n * 10_000n) / 1_000_000_000_000n, 4);
}
