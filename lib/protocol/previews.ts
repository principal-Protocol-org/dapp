/**
 * Indicative previews of the dApp's write actions, mirrored from the contracts.
 *
 * Every function repeats the contract's integer math in the same order, flooring where the
 * contract floors and rounding up where it rounds up (the fees). Line references are to
 * `principal` `origin/feat/tranche-1-mvp` (ABI pin `6cf257a`; the contracts are unchanged at
 * the branch tip). JS bigint `/` truncates toward zero exactly like Rust `i128` `/`, so the
 * results agree to the raw unit. Unlike `i128`, bigint never overflows; inputs large enough to
 * make the contract panic are not modelled.
 *
 * These are previews, not guards: the signed transaction's floors come from simulation
 * (`guards.ts`). Where the contract would revert on a zero result (`ZeroAmount`), the preview
 * returns that zero and the gates refuse it. A non-positive rate or empty pool, which would
 * divide by zero, throws a `RangeError`.
 */
import { BPS, SCALE, ceilDiv } from "./math";

function assertPositive(value: bigint, what: string): void {
  if (value <= 0n) throw new RangeError(`${what} must be greater than zero`);
}

/**
 * SY shares minted by depositing `amount` underlying.
 * Mirrors `sy_wrapper/src/lib.rs:517-528` (`underlying_to_shares`, called by `deposit`
 * at :218): `amount * RATE_SCALE / exchange_rate`, floored. The first-deposit 1:1 branch is the
 * same number, since `exchange_rate()` returns `RATE_SCALE` while no shares exist (:351-352).
 * Throws on a non-positive exchange rate.
 */
export function previewDeposit(amount: bigint, exchangeRate: bigint): bigint {
  assertPositive(exchangeRate, "exchange rate");
  return (amount * SCALE) / exchangeRate;
}

/**
 * Underlying returned by withdrawing `shares` SY shares.
 * Mirrors `sy_wrapper/src/lib.rs:530-533` (`shares_to_underlying`, called by `withdraw` at
 * :301): `shares * exchange_rate / RATE_SCALE`, floored. Throws on a non-positive exchange rate.
 */
export function previewWithdraw(shares: bigint, exchangeRate: bigint): bigint {
  assertPositive(exchangeRate, "exchange rate");
  return (shares * exchangeRate) / SCALE;
}

/**
 * PT and YT minted from `syShares` SY shares, and the tokenization fee withheld (in SY shares).
 * Mirrors `principal_manager/src/lib.rs:380-387`:
 * `fee_shares = ceil(sy_shares * fee_bps / BPS)` (written `(a + BPS - 1) / BPS`),
 * `notional = (sy_shares - fee_shares) * rate / SCALE` floored; PT = YT = notional (:406-407).
 */
export function previewMint(
  syShares: bigint,
  oracleRate: bigint,
  tokenizationFeeBps: bigint,
): { feeShares: bigint; pt: bigint; yt: bigint } {
  const feeShares = ceilDiv(syShares * tokenizationFeeBps, BPS);
  const notional = ((syShares - feeShares) * oracleRate) / SCALE;
  return { feeShares, pt: notional, yt: notional };
}

/**
 * SY shares returned by burning `amount` PT and `amount` YT before maturity.
 * Mirrors `principal_manager/src/lib.rs:435`: `amount * SCALE / rate`, floored, at the current
 * oracle rate. Throws on a non-positive rate.
 */
export function previewRecombine(amount: bigint, oracleRate: bigint): bigint {
  assertPositive(oracleRate, "oracle rate");
  return (amount * SCALE) / oracleRate;
}

/**
 * Underlying paid for redeeming `pt` PT at maturity, at settlement rate `rate`.
 * Mirrors the PT leg of `redeem`, `principal_manager/src/lib.rs:494-504`:
 * `desired = pt * SCALE / final_rate` (floor, :499), then `underlying_to_shares` (:500, :907-909:
 * `desired * SCALE / exchange_rate`, floor), then `SYWrapper.withdraw` of those shares
 * (`shares * exchange_rate / SCALE`, floor; `sy_wrapper:532`); nothing is paid when the shares
 * round to zero (:501).
 *
 * Deviation from the brief's `previewRedeemPt(pt, rate)`: an optional `exchangeRate` (default
 * `SCALE`, the release's fixed 1.0) so the share round-trip is mirrored; at 1.0 it is the
 * identity. Pass `MarketState.exchangeRate`. Throws on a non-positive rate or exchange rate.
 */
export function previewRedeemPt(pt: bigint, rate: bigint, exchangeRate: bigint = SCALE): bigint {
  assertPositive(rate, "settlement rate");
  assertPositive(exchangeRate, "exchange rate");
  const desiredUnderlying = (pt * SCALE) / rate;
  const shares = (desiredUnderlying * SCALE) / exchangeRate;
  if (shares <= 0n) return 0n;
  return (shares * exchangeRate) / SCALE;
}

export type PoolReserves = { pt: bigint; sy: bigint };

/**
 * LP minted and the PT/SY actually taken when adding up to `pt` PT and `sy` SY to a seeded pool.
 * Mirrors the proportional branch of `add_liquidity`, `market_pool/src/lib.rs:421-433`:
 * `lp = min(pt * total_lp / pt_res, sy * total_lp / sy_res)` (each floored; the smaller side
 * binds), then `pt_used = ceil(lp * pt_res / total_lp)` and `sy_used = ceil(lp * sy_res /
 * total_lp)`. The surplus of the other side stays with the caller. When `lp` is zero (the
 * contract reverts `ZeroAmount`, :426-428) all three are zero.
 *
 * The pool's opening deposit (`total_lp == 0`, :403-420: `isqrt(pt * sy) - MINIMUM_LIQUIDITY`
 * plus an oracle-rate ratio check) is not previewed: it throws, as do non-positive reserves
 * (the contract reverts `InsufficientLiquidity`, :422-424). The gates block adds on an
 * unseeded pool.
 */
export function previewAddLiquidity(
  pt: bigint,
  sy: bigint,
  reserves: PoolReserves,
  totalLp: bigint,
): { lp: bigint; ptUsed: bigint; syUsed: bigint } {
  if (totalLp <= 0n) {
    throw new RangeError("pool not seeded: the opening deposit is not previewed");
  }
  assertPositive(reserves.pt, "PT reserve");
  assertPositive(reserves.sy, "SY reserve");
  const lpFromPt = (pt * totalLp) / reserves.pt;
  const lpFromSy = (sy * totalLp) / reserves.sy;
  const lp = lpFromPt < lpFromSy ? lpFromPt : lpFromSy;
  if (lp <= 0n) return { lp: 0n, ptUsed: 0n, syUsed: 0n };
  return {
    lp,
    ptUsed: ceilDiv(lp * reserves.pt, totalLp),
    syUsed: ceilDiv(lp * reserves.sy, totalLp),
  };
}

/**
 * PT and SY returned for burning `lp` LP.
 * Mirrors `remove_liquidity_inner`, `market_pool/src/lib.rs:1089-1090`:
 * `pt_out = lp * pt_res / total_lp`, `sy_out = lp * sy_res / total_lp`, both floored.
 * Throws when the pool has no LP supply.
 */
export function previewRemoveLiquidity(
  lp: bigint,
  reserves: PoolReserves,
  totalLp: bigint,
): { pt: bigint; sy: bigint } {
  assertPositive(totalLp, "LP supply");
  return {
    pt: (lp * reserves.pt) / totalLp,
    sy: (lp * reserves.sy) / totalLp,
  };
}

/**
 * SY paid for selling `yt` YT through the pool's flash-redeem.
 * Mirrors `swap_yt_for_sy`, `market_pool/src/lib.rs:353-369`: the pool recombines `yt` YT with
 * `yt` of its own PT into `yt * SCALE / rate` SY (`principal_manager:435`, floor) and keeps the
 * exact-out cost of that PT, `quote_buy_exact_pt(yt).amount_in` (curve input plus fee, :354),
 * which the caller reads and passes as `buyExactPtAmountIn`. Payout = recombined - cost.
 *
 * When the cost exceeds the recombined SY the contract reverts `InsufficientLiquidity` (:366-368;
 * near maturity YT is worth ~0): the preview returns `0n` so the zero floor refuses signing.
 * Throws on a non-positive rate.
 */
export function previewSellYt(yt: bigint, oracleRate: bigint, buyExactPtAmountIn: bigint): bigint {
  const recombined = previewRecombine(yt, oracleRate);
  if (recombined < buyExactPtAmountIn) return 0n;
  return recombined - buyExactPtAmountIn;
}

/**
 * YT received, SY returned and net SY cost for buying YT with `syIn` SY through the Router's
 * flash-mint. Mirrors `Router.swap_sy_for_yt`, `router/src/lib.rs:347-363`: `mint(sy_in)`
 * (sized as `previewMint`), then all the minted PT sold with `swap_pt_for_sy`, whose SY after fee
 * is `quote_pt_for_sy(pt).amount_out` (`market_pool:673-676`) — the caller quotes it with
 * `previewMint(syIn, …).pt` and passes it as `ptForSyAmountOut`. Net cost = `sy_in - sy_back`,
 * the figure the Router's `max_net_cost` guards (:352-356).
 */
export function previewBuyYt(
  syIn: bigint,
  oracleRate: bigint,
  tokenizationFeeBps: bigint,
  ptForSyAmountOut: bigint,
): { yt: bigint; syBack: bigint; netCost: bigint } {
  const { yt } = previewMint(syIn, oracleRate, tokenizationFeeBps);
  return { yt, syBack: ptForSyAmountOut, netCost: syIn - ptForSyAmountOut };
}

/**
 * LP minted by a single-sided deposit of `syIn` SY. Mirrors `add_liquidity_single_sy`,
 * `market_pool/src/lib.rs:462-489`: the pool swaps `split` (`zap_swap_amount(syIn)`) into PT —
 * `buy` is `quote_sy_for_pt(split)`: `ptOut` PT for a `feeShares` fee — so the reserves become
 * `pt1 = pt_res − ptOut`, `sy1 = sy_res + split − feeShares`; then
 * `lp = min(ptOut·total_lp/pt1, (syIn − split)·total_lp/sy1)` (each floored),
 * `pt_used = min(ceil(lp·pt1/total_lp), ptOut)`, `sy_used = min(ceil(lp·sy1/total_lp), syIn − split)`.
 * `syUsed` is `split + sy_used`, the SY the contract takes and returns; `ptRefund = ptOut − pt_used`
 * is sent back to the caller and `syKept = syIn − split − sy_used` never leaves the wallet.
 * Zero LP (the contract reverts `ZeroAmount`) gives all zeros. Throws on an unseeded pool (R18:
 * the contract reverts `InsufficientLiquidity`) or a split larger than the deposit.
 */
export function previewAddLiquiditySingleSy(
  syIn: bigint,
  split: bigint,
  buy: { ptOut: bigint; feeShares: bigint },
  reserves: PoolReserves,
  totalLp: bigint,
): { lp: bigint; ptUsed: bigint; syUsed: bigint; ptRefund: bigint; syKept: bigint } {
  if (totalLp <= 0n) throw new RangeError("pool not seeded: a single-sided deposit needs liquidity");
  if (split < 0n || split > syIn) throw new RangeError("the swap is larger than the deposit");
  const pt1 = reserves.pt - buy.ptOut;
  const sy1 = reserves.sy + (split - buy.feeShares);
  assertPositive(pt1, "PT reserve after the swap");
  assertPositive(sy1, "SY reserve after the swap");
  const remaining = syIn - split;
  const lpFromPt = (buy.ptOut * totalLp) / pt1;
  const lpFromSy = (remaining * totalLp) / sy1;
  const lp = lpFromPt < lpFromSy ? lpFromPt : lpFromSy;
  if (lp <= 0n) return { lp: 0n, ptUsed: 0n, syUsed: 0n, ptRefund: 0n, syKept: 0n };
  const ceilPt = ceilDiv(lp * pt1, totalLp);
  const ceilSy = ceilDiv(lp * sy1, totalLp);
  const ptUsed = ceilPt < buy.ptOut ? ceilPt : buy.ptOut;
  const syAdded = ceilSy < remaining ? ceilSy : remaining;
  return { lp, ptUsed, syUsed: split + syAdded, ptRefund: buy.ptOut - ptUsed, syKept: remaining - syAdded };
}
