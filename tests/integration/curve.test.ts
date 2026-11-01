// @vitest-environment node
/**
 * The curve port (`lib/protocol/curve.ts`) against the live pool's own quote views (Task 3's live
 * check, carried to Task 24): `buyPt`, `sellPt` and `buyExactPt` on the pool's `pool_state()` give
 * what `quote_sy_for_pt`, `quote_pt_for_sy` and `quote_buy_exact_pt` return, within 1 raw unit, at
 * 1, 100 and 10,000 SY or PT.
 *
 * The state and the quote are separate simulations, and the curve's exponent and swap fee move with
 * the ledger time, so a pair counts only when both report the same latest ledger; otherwise it is
 * read again. Read-only: nothing is signed. Skipped unless `config/manifests/local.json` is a local
 * manifest whose RPC answers.
 */
import { describe, expect, it, vi } from "vitest"

// local-stack imports the faucet, which is `server-only`; that guard throws outside a react-server bundle.
vi.mock("server-only", () => ({}))

import { buyExactPt, buyPt, sellPt, type CurveQuote, type CurveState } from "@/lib/protocol/curve"
import { quoteBuyExactPt, quotePtForSy, quoteSyForPt, type PoolQuote } from "@/lib/protocol/quotes"
import { createRpcReader, toBigint, type ContractReader } from "@/lib/protocol/reader"
import { createLog, readManifest, skipReason, U } from "./local-stack"

const skip = await skipReason()
if (skip) console.info(`[curve] skipped: ${skip}. Start it with scripts/dev-stack/up.sh.`)

const SIZES = [1n * U, 100n * U, 10_000n * U]
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

/** The view and `pool_state()` at one ledger, read again until both report the same one. */
async function sameLedger(reader: ContractReader, pool: string, view: View, amount: bigint) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const [state, quote] = await Promise.all([reader({ contractId: pool, functionName: "pool_state" }), VIEWS[view].read(reader, pool, amount)])
    if (state.latestLedger === quote.ledger) return { state: curveState(state.value), quote, ledger: quote.ledger, attempt }
  }
  throw new Error(`${view}: the state and the quote never landed on the same ledger in ${MAX_ATTEMPTS} attempts`)
}

const abs = (v: bigint) => (v < 0n ? -v : v)

describe.skipIf(skip !== null)("curve port vs the live pool's quote views", () => {
  for (const view of Object.keys(VIEWS) as View[]) {
    it(`${view} at 1, 100 and 10,000`, async () => {
      const manifest = readManifest()
      const pool = manifest.markets[0].contracts.pool
      const reader = createRpcReader(manifest)
      for (const amount of SIZES) {
        const { state, quote, ledger, attempt } = await sameLedger(reader, pool, view, amount)
        const port = VIEWS[view].port(state, amount)
        const d = { amountOut: port.amountOut - quote.amountOut, amountIn: port.amountIn - quote.amountIn, feeShares: port.feeShares - quote.feeShares }
        out.log(
          `${view}(${amount / U} ${VIEWS[view].what}) at ledger ${ledger} (τ ${state.secondsToMaturity} s, attempt ${attempt}): ` +
            `pool out ${quote.amountOut} in ${quote.amountIn} fee ${quote.feeShares} | port Δout ${d.amountOut} Δin ${d.amountIn} Δfee ${d.feeShares}`,
        )
        expect(abs(d.amountOut), `${view} amount_out`).toBeLessThanOrEqual(1n)
        expect(abs(d.amountIn), `${view} amount_in`).toBeLessThanOrEqual(1n)
        expect(abs(d.feeShares), `${view} fee_shares`).toBeLessThanOrEqual(1n)
      }
    }, 60_000)
  }

  it("prints the deltas", () => {
    out.summary()
  })
})
