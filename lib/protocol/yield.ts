/**
 * YT yield and PT fixed-return figures, mirrored from the contracts.
 *
 * Integer math follows the contract's order of operations and rounding exactly (line references
 * are to `principal` `origin/feat/tranche-1-mvp`, ABI pin `6cf257a`). bigint `/` truncates toward
 * zero like Rust `i128` `/`. Only the APY outputs are `number`, for display.
 */
import { BPS, INDEX_SCALE, SCALE, YEAR_SECONDS, aprToApy, ceilDiv } from "./math";

function assertPositive(value: bigint, what: string): void {
  if (value <= 0n) throw new RangeError(`${what} must be greater than zero`);
}

/**
 * The YT yield index for oracle rate `rate`: `INDEX_SCALE * SCALE / rate`, rounded up.
 * Mirrors `yt_token/src/lib.rs:729-731` (`index_for`). Throws on a non-positive rate.
 */
export function indexFor(rate: bigint): bigint {
  assertPositive(rate, "oracle rate");
  return ceilDiv(INDEX_SCALE * SCALE, rate);
}

export type PendingYieldInput = {
  /** YT balance (notional units). */
  balance: bigint;
  /** `YTToken.last_claimed_index(account)` (`yt_token:548`). */
  lastClaimedIndex: bigint;
  /** `YTToken.pending_claim(account)`, already settled, underlying units (`yt_token:555`). */
  pendingClaim: bigint;
  /** `Oracle.get_reference_value()`; not read once `ytFrozen`. */
  liveOracleRate: bigint;
  /** `YTToken.is_frozen()` (`yt_token:503`). */
  ytFrozen: boolean;
  /** `YTToken.accrued_yield_index()` (`yt_token:541`). */
  accruedYieldIndex: bigint;
  /** `MarketConfig.yt_fee_bps()`. */
  ytFeeBps: bigint;
  /** `SYWrapper.exchange_rate()` (`sy_wrapper:345`): the fee is taken in SY shares. */
  exchangeRate: bigint;
};

/** All three in underlying units; `gross = fee + net`. */
export type PendingYield = { gross: bigint; fee: bigint; net: bigint };

/**
 * What `PrincipalManager.claim_yield` (`principal_manager/src/lib.rs:534-551`) would pay now.
 *
 * 1. Index: `claim_yield` first calls `update_yield_index` -> `advance`
 *    (`yt_token/src/lib.rs:616-664`). Once frozen the index never moves: `accruedYieldIndex`.
 *    Before, it moves to `index_for(now_rate)` only when the rate rose above the high-water mark
 *    (:641), so the index is `min(accruedYieldIndex, indexFor(liveOracleRate))`; with the
 *    monotonic oracle that is `indexFor(liveOracleRate)`, the brief's formula, and it also stays
 *    right when the live read is older than the index read.
 * 2. Settle (`yt_token/src/lib.rs:693-726`): when `index < last` and `last - index > 1`,
 *    `pending = balance * (last - index - 1) / INDEX_SCALE` (floor; the `- 1` absorbs the two
 *    round-ups). `gross = pendingClaim + pending` (`claim_yield`, :523-536).
 * 3. Fee (`pay_yield`, `principal_manager/src/lib.rs:768-782`): `gross_shares = gross * SCALE /
 *    exchange_rate` (`underlying_to_shares`, :907-909, floor), `fee_shares = ceil(gross_shares *
 *    yt_fee_bps / BPS)`, `net_shares = gross_shares - fee_shares`, paid through
 *    `SYWrapper.withdraw`: `net = net_shares * exchange_rate / SCALE` (`sy_wrapper:532`, floor).
 *    Nothing is paid when `gross <= 0` or `net_shares <= 0`.
 *
 * Units: `gross`, `fee` and `net` are underlying units. `fee` is `gross - net`: the YT fee
 * (withheld in SY shares, rounded up) plus the share-conversion rounding, so the three always add
 * up; at the release's exchange rate of 1.0 it is exactly the fee shares.
 *
 * Deviation from the brief's input: `exchangeRate` is required, because the contract converts
 * through SY shares (pass `MarketState.exchangeRate`). Throws on a non-positive exchange rate,
 * or a non-positive oracle rate while unfrozen.
 */
export function pendingYield(p: PendingYieldInput): PendingYield {
  assertPositive(p.exchangeRate, "exchange rate");
  let index = p.accruedYieldIndex;
  if (!p.ytFrozen) {
    const live = indexFor(p.liveOracleRate);
    if (live < index) index = live;
  }

  let settled = 0n;
  const last = p.lastClaimedIndex;
  if (index < last && p.balance > 0n && last - index > 1n) {
    const pending = (p.balance * (last - index - 1n)) / INDEX_SCALE;
    if (pending > 0n) settled = pending;
  }
  const gross = p.pendingClaim + settled;
  if (gross <= 0n) return { gross, fee: 0n, net: 0n };

  const grossShares = (gross * SCALE) / p.exchangeRate;
  const feeShares = ceilDiv(grossShares * p.ytFeeBps, BPS);
  const netShares = grossShares - feeShares;
  const net = netShares > 0n ? (netShares * p.exchangeRate) / SCALE : 0n;
  return { gross, fee: gross - net, net };
}

/**
 * The oracle rate an account's yield is accruing from: the rate whose index is
 * `lastClaimedIndex`.
 *
 * Deviation from the shorthand `INDEX_SCALE * SCALE / lastClaimedIndex`: this rounds up. The index
 * is `ceil(K / r)` (`yt_token:729-731`, `K = INDEX_SCALE * SCALE`), so `K / index <= r` and the
 * floor is one raw unit low for almost every rate; `ceil(K / index)` is exactly `r` whenever
 * `r * (r - 1) < K` (any rate below ~316.2). It inverts a ceil, so for an index not produced by
 * `index_for` it may be off by one raw unit. Throws on a non-positive index.
 */
export function accruingSinceRate(lastClaimedIndex: bigint): bigint {
  assertPositive(lastClaimedIndex, "yield index");
  return ceilDiv(INDEX_SCALE * SCALE, lastClaimedIndex);
}

/** The pool's `implied_rate` (an APR at SCALE) compounded to an APY: `aprToApy`. */
export function impliedApy(impliedRateApr: bigint, secondsToMaturity: bigint): number {
  return aprToApy(impliedRateApr, secondsToMaturity);
}

/**
 * The simple annualized rate a PT bought at `ptPrice` locks in, at SCALE.
 * Mirrors `implied_rate`, `market_pool/src/lib.rs:646-657`:
 * `(SCALE * SCALE / price - SCALE) * SECONDS_PER_YEAR / seconds_to_maturity`, each step floored
 * (truncated toward zero). Returns 0 at maturity (`τ <= 0`) and for a non-positive price, as the
 * contract does; above par the rate is negative, as the contract reports it.
 */
export function impliedRateFromPrice(ptPrice: bigint, secondsToMaturity: bigint): bigint {
  if (secondsToMaturity <= 0n || ptPrice <= 0n) return 0n;
  return ((SCALE * SCALE) / ptPrice - SCALE) * YEAR_SECONDS / secondsToMaturity;
}

/**
 * "Fixed return if held to maturity" for `pt` PT at the pool's spot `ptPrice`.
 * - `faceAtMaturity`: the PT notional, `pt`.
 * - `valueNow`: `pt * ptPrice / SCALE`, floored (`pt_price` is SY value per PT at SCALE,
 *   `market_pool:637-642`).
 * - `apy`: `aprToApy` of `impliedRateFromPrice` (the contract's `implied_rate` math). Matured
 *   (`τ <= 0`) gives 0 — never `aprToApy`'s τ <= 0 fallback to the APR. At par it is 0; above par
 *   it is negative; a non-positive price gives 0, as `implied_rate` does.
 */
export function ptFixedReturn(p: { pt: bigint; ptPrice: bigint; secondsToMaturity: bigint }): {
  faceAtMaturity: bigint;
  valueNow: bigint;
  apy: number;
} {
  const valueNow = (p.pt * p.ptPrice) / SCALE;
  const apr = impliedRateFromPrice(p.ptPrice, p.secondsToMaturity);
  const apy = p.secondsToMaturity <= 0n ? 0 : aprToApy(apr, p.secondsToMaturity);
  return { faceAtMaturity: p.pt, valueNow, apy };
}

/**
 * Estimated value of the pool's reserves in underlying units (display only, ruling R34):
 * `syReserve * exchangeRate / SCALE + ptReserve * ptPrice / oracleRate`, each term floored.
 * PT is priced at the pool's spot price (SY value per PT notional) and converted at the oracle
 * rate. Returns null when any input is not positive, so callers show "Unavailable".
 */
export function poolValueInUnderlying(p: {
  syReserve: bigint;
  ptReserve: bigint;
  exchangeRate: bigint;
  ptPrice: bigint;
  oracleRate: bigint;
}): bigint | null {
  if (p.exchangeRate <= 0n || p.ptPrice <= 0n || p.oracleRate <= 0n) return null;
  if (p.syReserve < 0n || p.ptReserve < 0n) return null;
  return (p.syReserve * p.exchangeRate) / SCALE + (p.ptReserve * p.ptPrice) / p.oracleRate;
}
