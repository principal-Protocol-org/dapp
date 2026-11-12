// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { quoteAddLiquidityUnderlying, quoteBuyExactPt, quoteLpToUnderlying, quotePtForSy, quoteSyForPt, quoteSyForYt, quoteYtForSy, zapSwapAmount } from "../quotes"
import type { ContractReader } from "../reader"

const POOL = "CPOOL"
const ROUTER = "CROUTER"

function reader(value: unknown) {
  return vi.fn(async () => ({ value, latestLedger: 777, minResourceFee: "100" })) as unknown as ContractReader & ReturnType<typeof vi.fn>
}

// Ported from dapp-old src/lib/__tests__/quotes.test.ts ("fetches and normalizes a pool quote",
// "rejects non-integer quote inputs before simulation"). Its min-out and quote-age checks are not
// ported: floors now come only from the exact simulation (guards.ts), never from a quote.
describe("pool quotes", () => {
  it("fetches and normalizes a pool quote", async () => {
    const read = reader({ amount_out: 9_500_000n, amount_in: 10_000_000n, fee_shares: 1_000n })
    await expect(quoteSyForPt(read, POOL, 10_000_000n)).resolves.toEqual({
      amountOut: 9_500_000n,
      amountIn: 10_000_000n,
      feeShares: 1_000n,
      ledger: 777,
    })
    expect(read).toHaveBeenCalledWith({ contractId: POOL, functionName: "quote_sy_for_pt", args: [{ type: "i128", value: 10_000_000n }] })
  })

  it("reads the PT sale and the exact-out PT purchase with their own views", async () => {
    const sell = reader({ amount_out: 93n, amount_in: 0n, fee_shares: 1n })
    await quotePtForSy(sell, POOL, 100n)
    expect(sell).toHaveBeenCalledWith({ contractId: POOL, functionName: "quote_pt_for_sy", args: [{ type: "i128", value: 100n }] })
    const exactOut = reader({ amount_out: 100n, amount_in: 95n, fee_shares: 1n })
    await expect(quoteBuyExactPt(exactOut, POOL, 100n)).resolves.toMatchObject({ amountIn: 95n })
    expect(exactOut).toHaveBeenCalledWith({ contractId: POOL, functionName: "quote_buy_exact_pt", args: [{ type: "i128", value: 100n }] })
  })

  it("rejects a non-positive input before reading: the pool panics ZeroAmount on it", async () => {
    const read = reader({ amount_out: 1n, amount_in: 1n, fee_shares: 0n })
    await expect(quoteSyForPt(read, POOL, 0n)).rejects.toThrow("A quote needs an amount greater than zero.")
    await expect(quotePtForSy(read, POOL, -1n)).rejects.toThrow("A quote needs an amount greater than zero.")
    expect(read).not.toHaveBeenCalled()
  })

  it("rejects a malformed quote rather than guessing a number", async () => {
    await expect(quoteSyForPt(reader({ amount_out: "9500000", amount_in: 1n, fee_shares: 0n }), POOL, 1n)).rejects.toThrow(/expected an integer/)
    await expect(quoteSyForPt(reader(null), POOL, 1n)).rejects.toThrow("quote_sy_for_pt did not return a quote.")
  })
})

describe("zap_swap_amount (T17)", () => {
  it("reads how much of a single-sided deposit the pool swaps into PT", async () => {
    const read = reader(500_000_000n)
    await expect(zapSwapAmount(read, POOL, 1_000_000_000n)).resolves.toBe(500_000_000n)
    expect(read).toHaveBeenCalledWith({ contractId: POOL, functionName: "zap_swap_amount", args: [{ type: "i128", value: 1_000_000_000n }] })
  })

  it("rejects a non-positive deposit before reading, and a non-integer answer", async () => {
    const read = reader(1n)
    await expect(zapSwapAmount(read, POOL, 0n)).rejects.toThrow("A quote needs an amount greater than zero.")
    expect(read).not.toHaveBeenCalled()
    await expect(zapSwapAmount(reader("5"), POOL, 1n)).rejects.toThrow(/expected an integer/)
  })
})

describe("YT quote views (0004 Task 8)", () => {
  it("quote_yt_for_sy: the SY a YT sale pays, read as a pool quote", async () => {
    const read = reader({ amount_out: 61_508n, amount_in: 0n, fee_shares: 5_311n })
    await expect(quoteYtForSy(read, POOL, 1_000_000_000n)).resolves.toEqual({ amountOut: 61_508n, amountIn: 0n, feeShares: 5_311n, ledger: 777 })
    expect(read).toHaveBeenCalledWith({ contractId: POOL, functionName: "quote_yt_for_sy", args: [{ type: "i128", value: 1_000_000_000n }] })
  })

  it("quote_sy_for_yt: the flash-mint's two legs, read as a FlashMintQuote", async () => {
    const read = reader({ yt_out: 999_507_096n, sy_back: 999_425_179n, mint_fee_shares: 500_000n, swap_fee_shares: 5_308n })
    await expect(quoteSyForYt(read, POOL, 1_000_000_000n)).resolves.toEqual({
      ytOut: 999_507_096n,
      syBack: 999_425_179n,
      mintFeeShares: 500_000n,
      swapFeeShares: 5_308n,
      ledger: 777,
    })
    expect(read).toHaveBeenCalledWith({ contractId: POOL, functionName: "quote_sy_for_yt", args: [{ type: "i128", value: 1_000_000_000n }] })
  })

  it("rejects a non-positive amount before reading, and a malformed answer", async () => {
    const read = reader({ amount_out: 1n, amount_in: 0n, fee_shares: 0n })
    await expect(quoteYtForSy(read, POOL, 0n)).rejects.toThrow("A quote needs an amount greater than zero.")
    await expect(quoteSyForYt(read, POOL, -1n)).rejects.toThrow("A quote needs an amount greater than zero.")
    expect(read).not.toHaveBeenCalled()
    await expect(quoteSyForYt(reader(null), POOL, 1n)).rejects.toThrow("quote_sy_for_yt did not return a quote.")
    await expect(quoteSyForYt(reader({ yt_out: 1n, sy_back: "2", mint_fee_shares: 0n, swap_fee_shares: 0n }), POOL, 1n)).rejects.toThrow(/expected an integer/)
  })
})

describe("the Router's LP quotes in USDY (0005 Task 5)", () => {
  const args = (amount: bigint) => [
    { type: "address", value: POOL },
    { type: "i128", value: amount },
  ]

  it("quote_add_liquidity_underlying: the SY the deposit gives and the zap's own return, read from the Router with the pool", async () => {
    const read = reader({ sy_in: 1_000_000_000n, pt_used: 512_000_000n, sy_used: 998_000_000n, lp_minted: 497_000_000n })
    await expect(quoteAddLiquidityUnderlying(read, ROUTER, POOL, 1_000_000_000n)).resolves.toEqual({
      syIn: 1_000_000_000n,
      ptUsed: 512_000_000n,
      syUsed: 998_000_000n,
      lpMinted: 497_000_000n,
      ledger: 777,
    })
    expect(read).toHaveBeenCalledWith({ contractId: ROUTER, functionName: "quote_add_liquidity_underlying", args: args(1_000_000_000n) })
  })

  it("quote_lp_to_underlying: the removal's split, the sale's fee and the USDY out, read from the Router with the pool", async () => {
    const read = reader({ pt_out: 10_260_000n, sy_out: 9_740_000n, swap_fee_shares: 56n, underlying_out: 19_990_000n })
    await expect(quoteLpToUnderlying(read, ROUTER, POOL, 10_000_000n)).resolves.toEqual({
      ptOut: 10_260_000n,
      syOut: 9_740_000n,
      swapFeeShares: 56n,
      underlyingOut: 19_990_000n,
      ledger: 777,
    })
    expect(read).toHaveBeenCalledWith({ contractId: ROUTER, functionName: "quote_lp_to_underlying", args: args(10_000_000n) })
  })

  it("rejects a non-positive amount before reading (the views panic ZeroAmount), and a malformed answer", async () => {
    const read = reader({ sy_in: 1n, pt_used: 1n, sy_used: 1n, lp_minted: 1n })
    await expect(quoteAddLiquidityUnderlying(read, ROUTER, POOL, 0n)).rejects.toThrow("A quote needs an amount greater than zero.")
    await expect(quoteLpToUnderlying(read, ROUTER, POOL, -1n)).rejects.toThrow("A quote needs an amount greater than zero.")
    expect(read).not.toHaveBeenCalled()
    await expect(quoteAddLiquidityUnderlying(reader(null), ROUTER, POOL, 1n)).rejects.toThrow("quote_add_liquidity_underlying did not return a quote.")
    await expect(quoteLpToUnderlying(reader([1n, 2n]), ROUTER, POOL, 1n)).rejects.toThrow("quote_lp_to_underlying did not return a quote.")
    await expect(quoteLpToUnderlying(reader({ pt_out: 1n, sy_out: 1n, swap_fee_shares: 0n, underlying_out: "2" }), ROUTER, POOL, 1n)).rejects.toThrow(/expected an integer/)
  })
})
