/**
 * The pool's quote views (`market_pool/src/lib.rs:705-773` at principal 97ac23e), read through a
 * `ContractReader`.
 *
 * Ported from `dapp-old/src/lib/quotes.ts` (`fetchMarketQuote`): the read and its normalization.
 * Its min-out and quote-age logic is not ported: floors come only from the exact simulation
 * (`guards.ts`). A quote is indicative: these views check neither oracle freshness nor maturity, so
 * a quote can succeed where the swap reverts (spec, "On-chain quotes and views").
 */
import { toBigint, type ContractReader } from "./reader"

/** `Quote` (`market_pool:197-207`): `amountOut` received (exact-out: the amount asked), `amountIn` paid (sells: 0), fee in SY shares. */
export type PoolQuote = { amountOut: bigint; amountIn: bigint; feeShares: bigint; ledger: number }

/**
 * `FlashMintQuote` (`market_pool:209-222`): the YT (and PT) the mint leg produces, the SY the PT
 * sale pays back, and each leg's fee in SY shares.
 */
export type FlashMintQuote = { ytOut: bigint; syBack: bigint; mintFeeShares: bigint; swapFeeShares: bigint; ledger: number }

type QuoteView = "quote_sy_for_pt" | "quote_pt_for_sy" | "quote_buy_exact_pt" | "quote_yt_for_sy"

function positive(amount: bigint): void {
  // Every quote panics ZeroAmount on a non-positive amount (calc_buy_pt, calc_sell_pt, calc_buy_exact_pt, quote_sy_for_yt).
  if (amount <= 0n) throw new Error("A quote needs an amount greater than zero.")
}

/** One view of the pool, called with a single `i128` amount: its struct and the ledger it was read at. */
async function readStruct(reader: ContractReader, pool: string, functionName: QuoteView | "quote_sy_for_yt", amount: bigint) {
  positive(amount)
  const result = await reader<unknown>({ contractId: pool, functionName, args: [{ type: "i128", value: amount }] })
  const raw = result.value
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${functionName} did not return a quote.`)
  return { q: raw as Record<string, unknown>, ledger: result.latestLedger }
}

async function readQuote(reader: ContractReader, pool: string, functionName: QuoteView, amount: bigint): Promise<PoolQuote> {
  const { q, ledger } = await readStruct(reader, pool, functionName, amount)
  return {
    amountOut: toBigint(q.amount_out),
    amountIn: toBigint(q.amount_in),
    feeShares: toBigint(q.fee_shares),
    ledger,
  }
}

/** PT bought with `syIn` SY (`amountOut`), fee included. */
export const quoteSyForPt = (reader: ContractReader, pool: string, syIn: bigint) => readQuote(reader, pool, "quote_sy_for_pt", syIn)

/** SY after the fee for selling `ptIn` PT (`amountOut`). */
export const quotePtForSy = (reader: ContractReader, pool: string, ptIn: bigint) => readQuote(reader, pool, "quote_pt_for_sy", ptIn)

/** SY needed, fee included, to buy exactly `ptOut` PT (`amountIn`). */
export const quoteBuyExactPt = (reader: ContractReader, pool: string, ptOut: bigint) => readQuote(reader, pool, "quote_buy_exact_pt", ptOut)

/**
 * SY paid for selling `ytIn` YT (`amountOut`; `amountIn` is 0): the flash-redeem behind
 * `swap_yt_for_sy`, the YT recombined with PT bought exactly from the pool, less that PT's cost.
 * `feeShares` is the PT purchase's fee. The view panics `InsufficientLiquidity` when the PT costs
 * more than the recombined SY (near maturity a YT is worth almost nothing).
 */
export const quoteYtForSy = (reader: ContractReader, pool: string, ytIn: bigint) => readQuote(reader, pool, "quote_yt_for_sy", ytIn)

/**
 * The flash-mint behind `swap_sy_for_yt` for `syIn` SY: the YT minted at the oracle rate and the
 * tokenization fee, and the SY its PT fetches when sold back into the pool.
 */
export async function quoteSyForYt(reader: ContractReader, pool: string, syIn: bigint): Promise<FlashMintQuote> {
  const { q, ledger } = await readStruct(reader, pool, "quote_sy_for_yt", syIn)
  return {
    ytOut: toBigint(q.yt_out),
    syBack: toBigint(q.sy_back),
    mintFeeShares: toBigint(q.mint_fee_shares),
    swapFeeShares: toBigint(q.swap_fee_shares),
    ledger,
  }
}

/** How much of `syIn` SY a single-sided deposit swaps into PT (`zap_swap_amount`, `market_pool:719-723`). */
export async function zapSwapAmount(reader: ContractReader, pool: string, syIn: bigint): Promise<bigint> {
  positive(syIn)
  const result = await reader<unknown>({ contractId: pool, functionName: "zap_swap_amount", args: [{ type: "i128", value: syIn }] })
  return toBigint(result.value)
}
