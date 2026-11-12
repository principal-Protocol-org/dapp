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
 * - `previewMint` + `sellPt` give what `quote_sy_for_yt` returns (the flash-mint behind Buy YT);
 * - the Router's LP quotes in USDY at principal 665bb67 (plan 0005 Task 5), at 1, 100 and 10,000:
 *   `previewDeposit` + `zapSplit` + `buyPt` + `previewAddLiquiditySingleSy` give what
 *   `quote_add_liquidity_underlying` returns (LP only from USDY, R5-5), and `previewRemoveLiquidity`
 *   + `sellPt` on the reserves the removal leaves + `previewWithdraw` give what
 *   `quote_lp_to_underlying` returns (LP withdraw to USDY, R5-6);
 * - the trade adapter's own quotes of those trades (`currentContractsAdapter`, on the route it
 *   plans) give the same LP, refund and USDY, and the flash Buy YT's quoted cost at the `sy_in` it
 *   plans is `sy_in − sy_back` of `quote_sy_for_yt` (R5-2).
 *
 * The state and the quote are separate simulations, and the curve's exponent and swap fee move with
 * the ledger time, so a pair counts only when both report the same latest ledger; otherwise it is
 * read again. The Router's quotes read the SY exchange rate too, so that read joins the pair. Read-only:
 * nothing is signed. Skipped unless `config/manifests/local.json` is a local manifest whose RPC answers.
 */
import { describe, expect, it, vi } from "vitest"

// local-stack imports the faucet, which is `server-only`; that guard throws outside a react-server bundle.
vi.mock("server-only", () => ({}))

import { buyExactPt, buyPt, sellPt, zapSplit, type CurveQuote, type CurveState } from "@/lib/protocol/curve"
import { fetchMarketState, type MarketState } from "@/lib/protocol/market-state"
import { previewAddLiquiditySingleSy, previewDeposit, previewMint, previewRemoveLiquidity, previewSellYt, previewWithdraw } from "@/lib/protocol/previews"
import {
  quoteAddLiquidityUnderlying,
  quoteBuyExactPt,
  quoteLpToUnderlying,
  quotePtForSy,
  quoteSyForPt,
  quoteSyForYt,
  quoteYtForSy,
  type PoolQuote,
} from "@/lib/protocol/quotes"
import { createRpcReader, toBigint, type ContractReader } from "@/lib/protocol/reader"
import { currentContractsAdapter, type PlanContext, type TradeQuote, type TradeRequest } from "@/lib/protocol/trade-adapter"
import type { Manifest } from "@/lib/protocol/types"
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

/**
 * `read` and `pool_state()` at one ledger, read again until both report the same one. With `sy`, the SY
 * exchange rate is read with them and must report that ledger too (the Router's quotes read it).
 */
async function sameLedger<Q extends { ledger: number }>(reader: ContractReader, pool: string, what: string, read: () => Promise<Q>, sy?: string) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const [state, quote, xr] = await Promise.all([
      reader({ contractId: pool, functionName: "pool_state" }),
      read(),
      sy === undefined ? undefined : reader({ contractId: sy, functionName: "exchange_rate" }),
    ])
    if (state.latestLedger !== quote.ledger || (xr !== undefined && xr.latestLedger !== quote.ledger)) continue
    return { state: curveState(state.value), quote, ledger: quote.ledger, attempt, exchangeRate: xr === undefined ? undefined : toBigint(xr.value) }
  }
  throw new Error(`${what}: the state and the quote never landed on the same ledger in ${MAX_ATTEMPTS} attempts`)
}

/** The exchange rate `sameLedger` read with `sy`. */
function rateOf(x: { exchangeRate?: bigint }): bigint {
  if (x.exchangeRate === undefined || x.exchangeRate <= 0n) throw new Error("the SY exchange rate was not read")
  return x.exchangeRate
}

/** Any account: the plan only carries it. */
const SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7"
const SLIPPAGE_BPS = 50n

/**
 * The market's reads with the pool and the SY exchange rate replaced by ones read at a quote's ledger,
 * so the trade adapter prices on exactly the state the contract's quote saw.
 */
function atLedger(ms: MarketState, state: CurveState, exchangeRate: bigint, ledger: number): MarketState {
  return { ...ms, poolState: { status: "live", value: state, ledger }, exchangeRate: { status: "live", value: exchangeRate, ledger } }
}

/** The trade adapter's route and quote for `req` on `ms`, as the Trade and LP tabs make them. */
function adapterQuote(manifest: Manifest, ms: MarketState, req: TradeRequest, expectAction: string): TradeQuote {
  const ctx: PlanContext = {
    marketId: manifest.markets[0].marketId,
    source: SOURCE,
    matured: false,
    routerFunctions: manifest.routerFunctions ?? [],
    slippageBps: SLIPPAGE_BPS,
    ms,
  }
  const plans = currentContractsAdapter.plan(req, ctx)
  if (!Array.isArray(plans)) throw new Error(`${req.kind}: not offered: ${plans.disabled}`)
  expect(plans.map((p) => p.action)).toEqual([expectAction])
  const quoted = currentContractsAdapter.quote(req, { ms, slippageBps: SLIPPAGE_BPS, plans })
  if (quoted.status !== "live") throw new Error(`${req.kind}: quote unavailable: ${quoted.error}`)
  return quoted.value
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

  // --- The Router's LP quotes in USDY (principal 665bb67, plan 0005 Task 5) ---

  const router = manifest?.markets[0].contracts.router ?? ""
  const sy = manifest?.markets[0].contracts.sy ?? ""
  const marketReads = () => fetchMarketState(reader(), manifest!, manifest!.markets[0].marketId)

  it("quote_add_liquidity_underlying = previewDeposit + zapSplit + buyPt + previewAddLiquiditySingleSy at 1, 100 and 10,000 USDY; the adapter quotes the same LP", async () => {
    const ms = await marketReads()
    for (const amount of SIZES) {
      const read = () => quoteAddLiquidityUnderlying(reader(), router, pool, amount)
      const at = await sameLedger(reader(), pool, "quote_add_liquidity_underlying", read, sy)
      const { state, quote, ledger, attempt } = at
      const xr = rateOf(at)
      // R5-5: the SY the deposit gives, the literal the one call signs; then the zap of add_liquidity_single_sy.
      const syIn = previewDeposit(amount, xr)
      const split = zapSplit(state, syIn)
      const buy = buyPt(state, split)
      const add = previewAddLiquiditySingleSy(syIn, split, { ptOut: buy.amountOut, feeShares: buy.feeShares }, { pt: state.ptReserve, sy: state.syReserve }, state.totalLp)
      const d = expectClose("quote_add_liquidity_underlying", {
        sy_in: [syIn, quote.syIn],
        pt_used: [add.ptUsed, quote.ptUsed],
        sy_used: [add.syUsed, quote.syUsed],
        lp_minted: [add.lp, quote.lpMinted],
      })
      // The adapter on its own route (one add_liquidity_underlying), on this ledger's state.
      const q = adapterQuote(manifest!, atLedger(ms, state, xr, ledger), { kind: "lp_only", amount, pay: "underlying", receive: "underlying" }, "add_liquidity_underlying")
      const refund = q.leftover?.find((l) => l.token === "sy")?.amount ?? 0n
      const a = expectClose("adapter lp_only", { lp: [q.out, quote.lpMinted], sy_refund: [refund, quote.syIn - quote.syUsed] })
      out.log(
        `quote_add_liquidity_underlying(${amount / U} USDY) at ledger ${ledger} (τ ${state.secondsToMaturity} s, xr ${xr}, attempt ${attempt}): ` +
          `router sy_in ${quote.syIn} pt_used ${quote.ptUsed} sy_used ${quote.syUsed} lp ${quote.lpMinted} | port ${d} | adapter ${a}`,
      )
    }
  }, 60_000)

  it("quote_lp_to_underlying = previewRemoveLiquidity + sellPt on the reserves the removal leaves + previewWithdraw at 1, 100 and 10,000 LP; the adapter quotes the same USDY", async () => {
    const ms = await marketReads()
    for (const lp of SIZES) {
      const read = () => quoteLpToUnderlying(reader(), router, pool, lp)
      const at = await sameLedger(reader(), pool, "quote_lp_to_underlying", read, sy)
      const { state, quote, ledger, attempt } = at
      const xr = rateOf(at)
      const removed = previewRemoveLiquidity(lp, { pt: state.ptReserve, sy: state.syReserve }, state.totalLp)
      // R5-6: the PT is sold after the removal, on the reserves it leaves (MarketPool.quote_lp_exit).
      const after: CurveState = { ...state, ptReserve: state.ptReserve - removed.pt, syReserve: state.syReserve - removed.sy, totalLp: state.totalLp - lp }
      const sale = sellPt(after, removed.pt)
      const usdy = previewWithdraw(removed.sy + sale.amountOut, xr)
      const d = expectClose("quote_lp_to_underlying", {
        pt_out: [removed.pt, quote.ptOut],
        sy_out: [removed.sy, quote.syOut],
        swap_fee_shares: [sale.feeShares, quote.swapFeeShares],
        underlying_out: [usdy, quote.underlyingOut],
      })
      const q = adapterQuote(manifest!, atLedger(ms, state, xr, ledger), { kind: "lp_withdraw", amount: lp, pay: "underlying", receive: "underlying" }, "remove_liquidity_underlying")
      const a = expectClose("adapter lp_withdraw", { usdy: [q.out, quote.underlyingOut] })
      out.log(
        `quote_lp_to_underlying(${lp / U} LP) at ledger ${ledger} (τ ${state.secondsToMaturity} s, xr ${xr}, attempt ${attempt}): ` +
          `router pt ${quote.ptOut} sy ${quote.syOut} fee ${quote.swapFeeShares} usdy ${quote.underlyingOut} | port ${d} | adapter ${a}`,
      )
    }
  }, 60_000)

  it("the flash Buy YT's quoted cost is sy_in − sy_back of quote_sy_for_yt at the sy_in the adapter plans, for both payers", async () => {
    const ms = await marketReads()
    // Budgets the solver can fill on this pool: a YT costs well under a thousandth of an SY two days out.
    for (const [pay, budget] of [["sy", 5_000_000n], ["underlying", 5_000_000n], ["sy", 50_000n]] as const) {
      const req: TradeRequest = { kind: "buy_yt", amount: budget, pay, receive: "underlying" }
      const ctx: PlanContext = { marketId: manifest!.markets[0].marketId, source: SOURCE, matured: false, routerFunctions: manifest!.routerFunctions ?? [], slippageBps: SLIPPAGE_BPS, ms }
      const plans = currentContractsAdapter.plan(req, ctx)
      if (!Array.isArray(plans)) throw new Error(`buy_yt (${pay}): not offered: ${plans.disabled}`)
      expect(plans.map((p) => p.action)).toEqual([pay === "sy" ? "buy_yt_flash" : "buy_yt_flash_underlying"])
      const signed = plans[0].secondaryAmount
      if (signed?.from !== "value") throw new Error(`buy_yt (${pay}): sy_in is not a sized value`)
      const syIn = signed.value
      const at = await sameLedger(reader(), pool, "quote_sy_for_yt", () => quoteSyForYt(reader(), pool, syIn), sy)
      const xr = rateOf(at)
      const quoted = currentContractsAdapter.quote(req, { ms: atLedger(ms, at.state, xr, at.ledger), slippageBps: SLIPPAGE_BPS, plans })
      if (quoted.status !== "live") throw new Error(`buy_yt (${pay}): quote unavailable: ${quoted.error}`)
      const q = quoted.value
      const cost = syIn - at.quote.syBack
      const back = pay === "sy" ? budget - cost : previewWithdraw(previewDeposit(budget, xr) - cost, xr)
      const d = expectClose(`adapter buy_yt (${pay})`, { yt_out: [q.out, at.quote.ytOut], back: [q.flash?.expectedBack ?? -1n, back] })
      expect(q.capital, "a flash discloses no capital").toBeUndefined()
      expect(q.maxCost).toBe(budget)
      out.log(
        `flash buy_yt (${pay}) budget ${budget} at ledger ${at.ledger} (attempt ${at.attempt}): sy_in ${syIn}, pool yt ${at.quote.ytOut} sy_back ${at.quote.syBack} ` +
          `(cost ${cost}) | adapter ${d}, expected cost ${q.flash?.expectedCost}`,
      )
    }
  }, 60_000)

  it("prints the deltas", () => {
    out.summary()
  })
})
