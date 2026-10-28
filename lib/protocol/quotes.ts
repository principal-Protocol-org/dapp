/**
 * The pool's quote views (`market_pool/src/lib.rs:667-689`), read through a `ContractReader`.
 *
 * Ported from `dapp-old/src/lib/quotes.ts` (`fetchMarketQuote`): the read and its normalization.
 * Its min-out and quote-age logic is not ported: floors come only from the exact simulation
 * (`guards.ts`). A quote is indicative: these views check neither oracle freshness nor maturity, so
 * a quote can succeed where the swap reverts (spec, "On-chain quotes and views").
 */
import { toBigint, type ContractReader } from "./reader"

/** `Quote` (`market_pool:195-204`): `amountOut` received (exact-out: the amount asked), `amountIn` paid (sells: 0), fee in SY shares. */
export type PoolQuote = { amountOut: bigint; amountIn: bigint; feeShares: bigint; ledger: number }

type QuoteView = "quote_sy_for_pt" | "quote_pt_for_sy" | "quote_buy_exact_pt"

function positive(amount: bigint): void {
  // Every quote panics ZeroAmount on a non-positive amount (calc_buy_pt, calc_sell_pt, calc_buy_exact_pt).
  if (amount <= 0n) throw new Error("A quote needs an amount greater than zero.")
}

async function readQuote(reader: ContractReader, pool: string, functionName: QuoteView, amount: bigint): Promise<PoolQuote> {
  positive(amount)
  const result = await reader<unknown>({ contractId: pool, functionName, args: [{ type: "i128", value: amount }] })
  const raw = result.value
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${functionName} did not return a quote.`)
  const q = raw as Record<string, unknown>
  return {
    amountOut: toBigint(q.amount_out),
    amountIn: toBigint(q.amount_in),
    feeShares: toBigint(q.fee_shares),
    ledger: result.latestLedger,
  }
}

/** PT bought with `syIn` SY (`amountOut`), fee included. */
export const quoteSyForPt = (reader: ContractReader, pool: string, syIn: bigint) => readQuote(reader, pool, "quote_sy_for_pt", syIn)

/** SY after the fee for selling `ptIn` PT (`amountOut`). */
export const quotePtForSy = (reader: ContractReader, pool: string, ptIn: bigint) => readQuote(reader, pool, "quote_pt_for_sy", ptIn)

/** SY needed, fee included, to buy exactly `ptOut` PT (`amountIn`). */
export const quoteBuyExactPt = (reader: ContractReader, pool: string, ptOut: bigint) => readQuote(reader, pool, "quote_buy_exact_pt", ptOut)
