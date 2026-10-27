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

function fixed(raw: bigint, decimals: number, fractionDigits: number, trim: boolean): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, "0");
  // Truncate (never round up) so a displayed value never exceeds the real one.
  fraction = fraction.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  if (trim) fraction = fraction.replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : `${whole}`;
  // Avoid "-0" when the truncated magnitude is zero.
  const isZero = whole === 0n && !/[1-9]/.test(fraction);
  return negative && !isZero ? `-${body}` : body;
}

/**
 * Display-only amount: truncates (does not round) the fraction to `maxFraction` digits and
 * trims trailing zeros. Negative values get a leading "-". Never feeds math.
 */
export function formatAmount(raw: bigint, decimals: number, maxFraction = 4): string {
  return fixed(raw, decimals, Math.min(maxFraction, decimals), true);
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
