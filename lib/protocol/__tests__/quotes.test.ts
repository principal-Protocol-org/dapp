// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { quoteBuyExactPt, quotePtForSy, quoteSyForPt } from "../quotes"
import type { ContractReader } from "../reader"

const POOL = "CPOOL"

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
