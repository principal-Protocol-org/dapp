// @vitest-environment node
/**
 * The curve port (`lib/protocol/curve.ts`, `previews.ts`) against the live pool's own quote views
 * (Task 3's live check, carried to Task 24 and plan 0004 Task 8), at 1, 100 and 10,000 SY or PT,
 * within 1 raw unit:
 * - `buyPt`, `sellPt` and `buyExactPt` give what `quote_sy_for_pt`, `quote_pt_for_sy` and
 *   `quote_buy_exact_pt` return;
 * - `zapSplit` gives what `zap_swap_amount` returns (the split LP only's zap swaps, R4-7);
 * - `buyExactPt` + `previewSellYt` give what `quote_yt_for_sy` returns (a YT sale's SY), at 1, 100,
 *   1,000 and 10,000 YT; where the PT costs more than the recombined SY (a large sale near maturity,
 *   at a low implied rate), both refuse: the view panics `InsufficientLiquidity`, the preview gives 0;
 * - `previewMint` + `sellPt` give what `quote_sy_for_yt` returns (the flash-mint behind Buy YT).
 *
 * The state and the quote are separate simulations, and the curve's exponent and swap fee move with
 * the ledger time, so a pair counts only when both report the same latest ledger; otherwise it is
 * read again. Read-only: nothing is signed. Skipped unless `config/manifests/local.json` is a local
 * manifest whose RPC answers.
 */
import { describe, expect, it, vi } from "vitest"

// local-stack imports the faucet, which is `server-only`; that guard throws outside a react-server bundle.
vi.mock("server-only", () => ({}))

import { buyExactPt, buyPt, sellPt, zapSplit, type CurveQuote, type CurveState } from "@/lib/protocol/curve"
import { previewMint, previewSellYt } from "@/lib/protocol/previews"
import { quoteBuyExactPt, quotePtForSy, quoteSyForPt, quoteSyForYt, quoteYtForSy, type PoolQuote } from "@/lib/protocol/quotes"
import { createRpcReader, toBigint, type ContractReader } from "@/lib/protocol/reader"
import { createLog, readManifest, skipReason, U } from "./local-stack"

const skip = await skipReason()
if (skip) console.info(`[curve] skipped: ${skip}. Start it with scripts/dev-stack/up.sh.`)

const SIZES = [1n * U, 100n * U, 10_000n * U]
/** YT sales: near maturity a large one can cost more PT than it recombines into, and both sides refuse. */
const YT_SIZES = [1n * U, 100n * U, 1_000n * U, 10_000n * U]
const MAX_ATTEMPTS = 12
const out = createLog("curve")

/** `pool_state()` as the curve port takes it (`PoolStateView`). */
function curveState(raw: unknown): CurveState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pool_state did not return a struct")
  const s = raw as Record<string, unknown>
  return {
    ptReserve: toBigint(s.pt_reserve),
    syReserve: toBigint(s.sy_reserve),
    totalLp: toBigint(s.total_lp),
    rate: toBigint(s.rate),
    exponent: toBigint(s.exponent),
    feeRate: toBigint(s.fee_rate),
    secondsToMaturity: toBigint(s.seconds_to_maturity),
  }
}

type View = "quote_sy_for_pt" | "quote_pt_for_sy" | "quote_buy_exact_pt"

const VIEWS: Record<View, { read: (r: ContractReader, pool: string, amount: bigint) => Promise<PoolQuote>; port: (s: CurveState, amount: bigint) => CurveQuote; what: string }> = {
  quote_sy_for_pt: { read: quoteSyForPt, port: buyPt, what: "SY in" },
  quote_pt_for_sy: { read: quotePtForSy, port: sellPt, what: "PT in" },
  quote_buy_exact_pt: { read: quoteBuyExactPt, port: buyExactPt, what: "PT out" },
}

/** `read` and `pool_state()` at one ledger, read again until both report the same one. */
async function sameLedger<Q extends { ledger: number }>(reader: ContractReader, pool: string, what: string, read: () => Promise<Q>) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const [state, quote] = await Promise.all([reader({ contractId: pool, functionName: "pool_state" }), read()])
    if (state.latestLedger === quote.ledger) return { state: curveState(state.value), quote, ledger: quote.ledger, attempt }
  }
  throw new Error(`${what}: the state and the quote never landed on the same ledger in ${MAX_ATTEMPTS} attempts`)
}

/** `zap_swap_amount` with the ledger it was read at (the dApp's `zapSwapAmount` returns the split only). */
async function zapAt(reader: ContractReader, pool: string, syIn: bigint) {
  const result = await reader<unknown>({ contractId: pool, functionName: "zap_swap_amount", args: [{ type: "i128", value: syIn }] })
  return { split: toBigint(result.value), ledger: result.latestLedger }
}

const abs = (v: bigint) => (v < 0n ? -v : v)

/** Each field's port − pool difference, logged and held within 1 raw unit. */
function expectClose(label: string, pairs: Record<string, [bigint, bigint]>): string {
  const deltas = Object.entries(pairs).map(([field, [port, pool]]) => {
    expect(abs(port - pool), `${label} ${field}: port ${port} vs pool ${pool}`).toBeLessThanOrEqual(1n)
    return `Δ${field} ${port - pool}`
  })
  return deltas.join(" ")
}

describe.skipIf(skip !== null)("curve port vs the live pool's quote views", () => {
  const manifest = skip === null ? readManifest() : undefined
  const pool = manifest?.markets[0].contracts.pool ?? ""
  const reader = () => createRpcReader(manifest!)

  for (const view of Object.keys(VIEWS) as View[]) {
    it(`${view} at 1, 100 and 10,000`, async () => {
      for (const amount of SIZES) {
        const { state, quote, ledger, attempt } = await sameLedger(reader(), pool, view, () => VIEWS[view].read(reader(), pool, amount))
        const port = VIEWS[view].port(state, amount)
        const d = expectClose(view, { amount_out: [port.amountOut, quote.amountOut], amount_in: [port.amountIn, quote.amountIn], fee_shares: [port.feeShares, quote.feeShares] })
        out.log(
          `${view}(${amount / U} ${VIEWS[view].what}) at ledger ${ledger} (τ ${state.secondsToMaturity} s, attempt ${attempt}): ` +
            `pool out ${quote.amountOut} in ${quote.amountIn} fee ${quote.feeShares} | port ${d}`,
        )
      }
    }, 60_000)
  }

  it("zap_swap_amount = zapSplit at 1, 100 and 10,000 SY", async () => {
    for (const amount of SIZES) {
      const { state, quote, ledger, attempt } = await sameLedger(reader(), pool, "zap_swap_amount", () => zapAt(reader(), pool, amount))
      const port = zapSplit(state, amount)
      const d = expectClose("zap_swap_amount", { split: [port, quote.split] })
      out.log(`zap_swap_amount(${amount / U} SY) at ledger ${ledger} (τ ${state.secondsToMaturity} s, attempt ${attempt}): pool ${quote.split} | port ${d}`)
    }
  }, 60_000)

  it("quote_yt_for_sy = buyExactPt + previewSellYt at 1, 100, 1,000 and 10,000 YT, or both refuse", async () => {
    const answered: bigint[] = []
    for (const amount of YT_SIZES) {
      // The view panics InsufficientLiquidity (#9) when the PT bought exactly costs more than the YT
      // and that PT recombine into (a YT is worth little two days from maturity); the preview gives 0.
      const read = () =>
        quoteYtForSy(reader(), pool, amount).catch(async (e: unknown) => {
          const message = e instanceof Error ? e.message : String(e)
          if (!/Error\(Contract, #9\)/.test(message)) throw e
          return { refused: message, ledger: (await reader()({ contractId: pool, functionName: "pool_state" })).latestLedger }
        })
      const { state, quote, ledger, attempt } = await sameLedger(reader(), pool, "quote_yt_for_sy", read)
      const cost = buyExactPt(state, amount)
      const payout = previewSellYt(amount, state.rate, cost.amountIn)
      if ("refused" in quote) {
        expect(payout, `quote_yt_for_sy(${amount / U} YT): the pool refuses, so the port must give 0`).toBe(0n)
        out.log(`quote_yt_for_sy(${amount / U} YT) at ledger ${ledger} (τ ${state.secondsToMaturity} s, attempt ${attempt}): pool refuses (Error(Contract, #9), InsufficientLiquidity) | port previewSellYt 0`)
        continue
      }
      answered.push(amount)
      // A sale reports no amount in (the view's own Quote), whatever the PT cost.
      expect(quote.amountIn).toBe(0n)
      const d = expectClose("quote_yt_for_sy", { amount_out: [payout, quote.amountOut], fee_shares: [cost.feeShares, quote.feeShares] })
      out.log(`quote_yt_for_sy(${amount / U} YT) at ledger ${ledger} (τ ${state.secondsToMaturity} s, attempt ${attempt}): pool out ${quote.amountOut} fee ${quote.feeShares} | port ${d}`)
    }
    // The small sales always price: the check never passes on refusals alone.
    expect(answered.slice(0, 2)).toEqual([1n * U, 100n * U])
  }, 60_000)

  it("quote_sy_for_yt = previewMint + sellPt at 1, 100 and 10,000 SY", async () => {
    const config = manifest!.markets[0].contracts.config
    const feeBps = toBigint((await reader()({ contractId: config, functionName: "tokenization_fee_bps" })).value)
    for (const amount of SIZES) {
      const { state, quote, ledger, attempt } = await sameLedger(reader(), pool, "quote_sy_for_yt", () => quoteSyForYt(reader(), pool, amount))
      const minted = previewMint(amount, state.rate, feeBps)
      const sale = sellPt(state, minted.yt)
      const d = expectClose("quote_sy_for_yt", {
        yt_out: [minted.yt, quote.ytOut],
        sy_back: [sale.amountOut, quote.syBack],
        mint_fee_shares: [minted.feeShares, quote.mintFeeShares],
        swap_fee_shares: [sale.feeShares, quote.swapFeeShares],
      })
      out.log(
        `quote_sy_for_yt(${amount / U} SY) at ledger ${ledger} (τ ${state.secondsToMaturity} s, attempt ${attempt}, fee ${feeBps} bps): ` +
          `pool yt ${quote.ytOut} sy_back ${quote.syBack} fees ${quote.mintFeeShares}/${quote.swapFeeShares} | port ${d}`,
      )
    }
  }, 60_000)

  it("prints the deltas", () => {
    out.summary()
  })
})
