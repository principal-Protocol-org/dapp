import { screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buyExactPt, impliedRate, sellPt, type CurveState } from "@/lib/protocol/curve"
import { formatAmount, formatPercent, formatTokenAmount, parseDecimalToRaw } from "@/lib/protocol/format"
import { minAfterSlippage } from "@/lib/protocol/guards"
import { aprToApy, BPS, ceilDiv, SCALE } from "@/lib/protocol/math"
import { previewDeposit, previewMint, previewSellYt, previewWithdraw } from "@/lib/protocol/previews"
import { effectiveImpliedApy } from "@/lib/protocol/rates"
import { solveBuyYt, type YtSolution } from "@/lib/protocol/yt-solver"
import { accountState, live, marketState, MATURITY } from "./fixtures"

const mocks = await vi.hoisted(async () => (await import("./panel-mocks")).createPanelMocks())
const nav = vi.hoisted(() => ({ search: "" }))

vi.mock("sonner", () => ({ toast: mocks.toast, Toaster: () => null }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }))
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("@/hooks/use-manifest-findings", () => ({ useManifestFindings: () => mocks.findings }))
vi.mock("@/lib/protocol/wallet", () => ({ freighterAdapter: mocks.adapter }))
vi.mock("@/lib/protocol/horizon", () => ({ createHorizon: () => ({}) }))
vi.mock("@/lib/protocol/reader", async (orig) => ({ ...(await orig<object>()), createRpcReader: () => mocks.read }))
vi.mock("@/lib/protocol/market-state", async (orig) => ({ ...(await orig<object>()), fetchMarketState: mocks.fetchMarketState }))
vi.mock("@/lib/protocol/account-state", async (orig) => ({ ...(await orig<object>()), fetchAccountState: mocks.fetchAccountState }))
vi.mock("@/lib/protocol/compliance", async (orig) => ({ ...(await orig<object>()), fetchMarketCompliance: mocks.fetchMarketCompliance }))
vi.mock("@/lib/protocol/stellar", async (orig) => ({
  ...(await orig<object>()),
  createRpcServer: () => ({}),
  getLedgerClock: mocks.getLedgerClock,
  simulateInvocation: mocks.simulateInvocation,
  // The fake reviews carry no real XDR; the route logs this hash before "signing".
  transactionEnvelopeHash: (xdr: string) => `hash-of-${xdr}`,
}))
// Switches for the edge cases: a break-even rate that cannot be worked out, a solver that throws.
const stub = vi.hoisted(() => ({ noBreakEven: false, solverThrows: false }))
vi.mock("@/lib/protocol/rates", async (orig) => {
  const mod = await orig<typeof import("@/lib/protocol/rates")>()
  return { ...mod, effectiveImpliedApy: (p: Parameters<typeof mod.effectiveImpliedApy>[0]) => (stub.noBreakEven ? undefined : mod.effectiveImpliedApy(p)) }
})
vi.mock("@/lib/protocol/yt-solver", async (orig) => {
  const mod = await orig<typeof import("@/lib/protocol/yt-solver")>()
  return {
    ...mod,
    solveBuyYt: (...args: Parameters<typeof mod.solveBuyYt>) => {
      if (stub.solverThrows) throw new Error("Buy-YT solver did not converge")
      return mod.solveBuyYt(...args)
    },
  }
})
vi.mock("@/lib/protocol/review", async (orig) => ({
  ...(await orig<object>()),
  prepareReview: mocks.prepareReview,
  executeReview: mocks.executeReview,
  prepareRestore: mocks.prepareRestore,
  executeRestore: mocks.executeRestore,
}))

import { A, MANIFEST, MARKET } from "./panel-mocks"
import { enter, installDefaults, renderUi, settle, simulateReturns, teardown, user } from "./panel-harness"
import { YtTab } from "../trade/yt-tab"
import { TradePanel } from "../trade/trade-panel"

/**
 * A realistic pool (R2-16): curve.test.ts's state A, 150 days left, oracle 1.05 USD per USDY, SY
 * rate 1.0. Its fixed APY is about 5.3 %, so 100 USDY spent on YT mint from about 4 216 SY: the
 * figures below come from the solver, never from leverage × spend.
 */
const POOL: CurveState = {
  ptReserve: 1000000000000n,
  syReserve: 580000000000n,
  totalLp: 760000000000n,
  rate: 10500000n,
  exponent: 958904109589041096n,
  feeRate: 1232876712n,
  secondsToMaturity: 12960000n,
}
const ORACLE = 10_500_000n
const FEE_BPS = 10n
const UNIT = 10_000_000n
const apy = (implied: bigint) => formatPercent(aprToApy(implied, POOL.secondsToMaturity))
const amount = (raw: bigint) => formatTokenAmount(raw, 7, true)

const usdyManifest = {
  ...MANIFEST,
  routerFunctions: [] as string[],
  markets: [{ ...MARKET, underlying: { ...MARKET.underlying, code: "USDY" } }],
}

function poolMarket(over: Parameters<typeof marketState>[0] = {}) {
  const base = marketState()
  return marketState({
    poolState: live(POOL),
    ptPrice: live(9798253n),
    impliedRate: live(501023n),
    swapFeeRate: live(POOL.feeRate),
    lpTotalSupply: live(POOL.totalLp),
    fees: { ...base.fees, tokenizationBps: live(FEE_BPS) },
    ...over,
  })
}

/** The solver's answer for spending `spendSy` SY on the pool. */
function solved(spendSy: bigint): YtSolution {
  const r = solveBuyYt(POOL, { spendSy, oracleRate: ORACLE, tokenizationFeeBps: FEE_BPS })
  if ("error" in r) throw new Error(r.error)
  return r
}
/** The USDY a deposit needs to give `syIn` SY at `rate`: rounded up. */
const depositFor = (syIn: bigint, rate = SCALE) => ceilDiv(syIn * rate, SCALE)

beforeEach(() => {
  installDefaults(mocks)
  mocks.manifest = usdyManifest as typeof mocks.manifest
  nav.search = ""
  stub.noBreakEven = false
  stub.solverThrows = false
  mocks.accounts[A] = accountState({
    underlying: live(100_000n * UNIT),
    sy: live(100_000n * UNIT),
    yt: live(1_000n * UNIT),
    permYt: live(true),
    // The deposit cap is off unless a test sets it.
    depositCap: live(0n),
  })
  mocks.fetchMarketState.mockResolvedValue(poolMarket())
})
afterEach(teardown)

/** The value beside a details label. */
const detail = (label: string) => within(screen.getByRole("region", { name: "Trading details" })).getByText(label).nextSibling?.textContent
const received = () => screen.getByLabelText("You receive (preview)").textContent
const picker = (name: string) => screen.getByRole("radiogroup", { name })
const pick = async (group: string, option: RegExp) => {
  await user().click(within(picker(group)).getByRole("radio", { name: option }))
  await settle()
}
const reviewButton = (label: string) => screen.getByRole("button", { name: `Review ${label}` }) as HTMLButtonElement
const payField = () => screen.getByLabelText("You pay") as HTMLInputElement

describe("YT tab — Buy", () => {
  it("input is the USDY spent: the route deposits what the solver needs, not the amount typed", async () => {
    const r = solved(100n * UNIT)
    const dep = depositFor(r.syIn)
    simulateReturns(mocks, dep)
    await renderUi(<YtTab marketId="m1" side="buy" />)
    expect(within(picker("Pay with")).getByRole("radio", { name: "USDY" }).getAttribute("aria-checked")).toBe("true")
    await enter("You pay", "100")
    expect(screen.getByLabelText("You pay").closest("div")?.textContent).toContain("USDY")
    expect(received()).toBe(`${amount(r.ytOut)} YT`)
    // About 42x the spend is deposited; it is the solver's sy_in, in USDY at the SY rate.
    expect(dep).toBeGreaterThan(40n * 100n * UNIT)
    await user().click(reviewButton("Buy YT"))
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Buy YT" })
    expect(within(within(dialog).getByRole("list", { name: "Route steps" })).getAllByRole("listitem")).toHaveLength(3)
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "deposit", amount: dep, source: A })
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it('capital line: "Moves X USDY, spends Y USDY; Z come back in step 3", with numbers from the solver', async () => {
    const r = solved(100n * UNIT)
    const moved = depositFor(r.syIn)
    const back = previewWithdraw(r.syBack, SCALE)
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    expect(screen.getByText(`Moves ${amount(moved)} USDY, spends ${amount(moved - back)} USDY; ${amount(back)} come back in step 3.`)).toBeTruthy()
    // Never leverage × spend: the pool fee makes sy_in well under it.
    expect(screen.queryByText(/Moves 4,500/)).toBeNull()
  })

  it("max divides balance by moved ratio, from a reference solve when the field is empty", async () => {
    const balance = 10_000n * UNIT
    mocks.accounts[A] = accountState({ underlying: live(balance), permYt: live(true), depositCap: live(0n) })
    await renderUi(<YtTab marketId="m1" side="buy" />)
    expect(screen.getByText("Balance: 10000 USDY")).toBeTruthy()
    await user().click(screen.getByRole("button", { name: "Max You pay" }))
    await settle()
    // The reference spend is a hundredth of the balance: 100 USDY, which moves depositFor(sy_in).
    const ref = balance / 100n
    const max = (balance * ref) / depositFor(solved(ref).syIn)
    expect(payField().value).toBe(formatAmount(max, 7, 7))
    // What Max moves fits the balance.
    expect(depositFor(solved(max).syIn)).toBeLessThanOrEqual(balance)
  })

  it("Max never moves more than the balance, even from a typed spend above it", async () => {
    const balance = 10_000n * UNIT
    mocks.accounts[A] = accountState({ underlying: live(balance), permYt: live(true), depositCap: live(0n) })
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "1000")
    await user().click(screen.getByRole("button", { name: "Max You pay" }))
    await settle()
    const max = parseDecimalToRaw(payField().value, 7)!
    expect(max).toBeGreaterThan(0n)
    expect(max).toBeLessThan(1_000n * UNIT)
    expect(depositFor(solved(max).syIn)).toBeLessThanOrEqual(balance)
  })

  it("moved amount checked against cap: a spend that fits the cap, whose deposit step does not, is refused before the route starts", async () => {
    const r = solved(200n * UNIT)
    simulateReturns(mocks, depositFor(r.syIn))
    // 6000 USDY of the deposit cap left: the 200 USDY spend fits, the ~8430 USDY deposit does not.
    mocks.accounts[A] = accountState({
      underlying: live(100_000n * UNIT),
      permYt: live(true),
      depositCap: live(10_000n * UNIT),
      netDeposited: live(4_000n * UNIT),
    })
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "200")
    expect(depositFor(r.syIn)).toBeGreaterThan(6_000n * UNIT)
    expect(screen.getByText(/This would pass your deposit cap/)).toBeTruthy()
    expect(reviewButton("Buy YT").disabled).toBe(true)
    expect(mocks.prepareReview).not.toHaveBeenCalled()
  })

  it("the circuit breaker on the buy_yt step sees its sy_in: a spend that fits is refused before the route starts", async () => {
    const r = solved(100n * UNIT)
    simulateReturns(mocks, [r.ytOut, r.syBack])
    // 200 left in the breaker's window: 100 SY spent fit; the 4216 SY the buy mints from do not.
    mocks.fetchMarketState.mockResolvedValue(poolMarket({ cb: { limit: live(1_000n * UNIT), volume: live(800n * UNIT), assetLimit: live(0n), assetVolume: live(0n) } }))
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    await enter("You pay", "100")
    expect(screen.getByText(new RegExp(`circuit breaker: .* this adds ${formatAmount(r.syIn, 7, 7).replace(".", "\\.")}\\.`))).toBeTruthy()
    expect(reviewButton("Buy YT").disabled).toBe(true)
  })

  it("a USDY payer's buy_yt step is gated on its sy_in before the route starts, not on the spend typed", async () => {
    // At an SY rate of 1.02 the deposit (rounded up) and the buy's report (rounded down) differ, so
    // the two steps' breaker refusals can be told apart.
    const rate = 10_200_000n
    const r = solved(previewDeposit(100n * UNIT, rate))
    const dep = depositFor(r.syIn, rate)
    const reported = (r.syIn * rate) / SCALE
    expect(dep).not.toBe(reported)
    simulateReturns(mocks, dep)
    mocks.fetchMarketState.mockResolvedValue(
      poolMarket({ exchangeRate: live(rate), cb: { limit: live(1_000n * UNIT), volume: live(800n * UNIT), assetLimit: live(0n), assetVolume: live(0n) } }),
    )
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    const fmt = (raw: bigint) => formatAmount(raw, 7, 7).replace(".", "\\.")
    // Step 1, the deposit, against today's window.
    expect(screen.getByText(new RegExp(`^This would trip the protocol-wide circuit breaker: 800 of .* this adds ${fmt(dep)}\\.`))).toBeTruthy()
    // Step 2, the buy, reports its sy_in at the SY rate, with step 1's deposit already counted (R2-61).
    expect(
      screen.getByText(new RegExp(`^Step 2 \\(Buy YT\\), counted after the steps before it: this would trip the protocol-wide circuit breaker: ${fmt(800n * UNIT + dep)} of .* this adds ${fmt(reported)}\\.`)),
    ).toBeTruthy()
    expect(reviewButton("Buy YT").disabled).toBe(true)
  })

  it("the breaker counts the deposit and the buy both: a route that fits step by step but not in total is refused before its first signature (R2-61)", async () => {
    const r = solved(100n * UNIT)
    const moved = depositFor(r.syIn)
    simulateReturns(mocks, moved)
    // Room for 1.5x what is moved: each step alone fits; the deposit and the buy's mint together do not.
    const room = (moved * 3n) / 2n
    mocks.fetchMarketState.mockResolvedValue(
      poolMarket({ cb: { limit: live(100_000n * UNIT), volume: live(100_000n * UNIT - room), assetLimit: live(0n), assetVolume: live(0n) } }),
    )
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    expect(screen.queryByText(/^This would trip/)).toBeNull()
    expect(screen.getByText(/^Step 2 \(Buy YT\), counted after the steps before it: this would trip the protocol-wide circuit breaker/)).toBeTruthy()
    expect(reviewButton("Buy YT").disabled).toBe(true)
    expect(mocks.prepareReview).not.toHaveBeenCalled()
  })

  it("a simulated deposit short of the buy's sy_in is refused before the first signature, naming step 2", async () => {
    const r = solved(100n * UNIT)
    // The deposit, simulated as the user, gives one raw SY less than the buy needs.
    simulateReturns(mocks, r.syIn - 1n)
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    expect(screen.getByText(/^Step 2 \(Buy YT\) needs more than step 1 gives, as simulated now/)).toBeTruthy()
    expect(reviewButton("Buy YT").disabled).toBe(true)
    expect(mocks.prepareReview).not.toHaveBeenCalled()
  })

  it("break-even sentence names the effective implied APY and says the YT is worth 0 at maturity", async () => {
    const r = solved(100n * UNIT)
    const moved = depositFor(r.syIn)
    const spent = moved - previewWithdraw(r.syBack, SCALE)
    const e = effectiveImpliedApy({ spentUnderlying: spent, oracleRate: ORACLE, ytOut: r.ytOut, secondsToMaturity: POOL.secondsToMaturity })!
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    const yieldOn = (r.ytOut * SCALE) / ORACLE
    expect(
      screen.getByText(
        `You receive USDY's variable yield on ${amount(yieldOn)} USDY until maturity, for ${amount(spent)} USDY. You gain if USDY's average APY until then exceeds ${formatPercent(e)}. At maturity the YT is worth 0.`,
      ),
    ).toBeTruthy()
    expect(screen.getByText(`Indicative: ${amount(yieldOn)} USDY is your ${amount(r.ytOut)} YT (USD) at today's USDY oracle rate.`)).toBeTruthy()
    expect(detail("Effective implied APY")).toBe(formatPercent(e))
  })

  it("details: the fixed APY rises, with leverage, fees, the minimum YT and the most it may spend", async () => {
    const r = solved(100n * UNIT)
    const mint = previewMint(r.syIn, ORACLE, FEE_BPS)
    const sale = sellPt(POOL, mint.pt)
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    // Buying YT sells PT into the pool: the fixed APY rises (R2-15).
    const after = impliedRate(sale.next)
    expect(after).toBeGreaterThan(501023n)
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} → ${apy(after)}`)
    expect(detail("Leverage")).toMatch(/^\d+x$/)
    expect(detail("Fees")).toBe(`${amount(mint.feeShares + sale.feeShares)} USDY`)
    expect(detail("Minimum received")).toBe(`${amount(minAfterSlippage(r.ytOut, 50n))} YT`)
    // R2-58: max_net_cost = net cost × (1 + 0.5 %), rounded up, as guards.ts signs it.
    const maxNetCost = ceilDiv(r.netCost * (BPS + 50n), BPS)
    expect(detail("Spends at most")).toBe(`${amount(depositFor(r.syIn) - (r.syIn - maxNetCost))} USDY`)
  })

  it("paying in SY is one step, its refund stays SY, and its simulation makes the figures exact", async () => {
    const r = solved(100n * UNIT)
    let answer: (value: unknown) => void = () => {}
    mocks.simulateInvocation.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    expect(screen.getByText("Balance: 100000 SY")).toBeTruthy()
    await enter("You pay", "100")
    expect(screen.getByText(/This is one step, one signature: Buy YT \(you give SY, you get YT\)\./)).toBeTruthy()
    expect(screen.getByText(`Moves ${amount(r.syIn)} SY, spends ${amount(r.netCost)} SY; ${amount(r.syBack)} come back in step 1.`)).toBeTruthy()
    expect(screen.getByText("Indicative")).toBeTruthy()

    answer({ ok: true, retval: [r.ytOut - 5n, r.syBack - 7n], latestLedger: 1, minResourceFee: "100" })
    await settle()
    expect(screen.getByText("Exact (simulated)")).toBeTruthy()
    expect(received()).toBe(`${amount(r.ytOut - 5n)} YT`)
    expect(screen.getByText(`Moves ${amount(r.syIn)} SY, spends ${amount(r.netCost + 7n)} SY; ${amount(r.syBack - 7n)} come back in step 1.`)).toBeTruthy()
  })

  it("Buy with SY reaches the route review on its one step, sized by the solver", async () => {
    const r = solved(100n * UNIT)
    simulateReturns(mocks, [r.ytOut, r.syBack])
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    await enter("You pay", "100")
    await user().click(reviewButton("Buy YT"))
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Buy YT" })
    expect(within(within(dialog).getByRole("list", { name: "Route steps" })).getAllByRole("listitem")).toHaveLength(1)
    const input = mocks.prepareReview.mock.calls[0][0].input
    expect(input).toMatchObject({ action: "buy_yt", amount: r.syIn })
    // 0001's floors: the YT floor and max_net_cost from the simulated net cost (R2-58).
    expect(input.guards).toEqual({ minOut: minAfterSlippage(r.ytOut, 50n), maxNetCost: ceilDiv(r.netCost * (BPS + 50n), BPS) })
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it("a break-even rate that cannot be worked out reads Unavailable, in the row and the sentence", async () => {
    stub.noBreakEven = true
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    expect(detail("Effective implied APY")).toBe("Unavailable")
    expect(screen.getByText(/The break-even rate is unavailable: this app could not work it out from these amounts\. At maturity the YT is worth 0\./)).toBeTruthy()
    expect(screen.queryByText(/You gain if USDY's average APY until then exceeds/)).toBeNull()
  })

  it("a solver that throws makes the quote Unavailable and the route disabled, never 0 YT", async () => {
    stub.solverThrows = true
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    expect(received()).toBe("Unavailable")
    expect(screen.getByText(/^Unavailable: This app could not size this purchase \(Buy-YT solver did not converge\)/)).toBeTruthy()
    expect(screen.getByText(/^Buy YT is not offered for this amount\. This app could not size this purchase/)).toBeTruthy()
    expect(screen.queryByText(/^0(\.0+)? YT$/)).toBeNull()
    expect(reviewButton("Buy YT").disabled).toBe(true)
  })

  it("the amount resets once the step reaches the network (R2-3)", async () => {
    const r = solved(100n * UNIT)
    simulateReturns(mocks, [r.ytOut, r.syBack])
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    await enter("You pay", "100")
    await user().click(reviewButton("Buy YT"))
    await settle()
    await user().click(await screen.findByRole("button", { name: "Sign step 1 of 1" }))
    await settle()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
    expect(payField().value).toBe("")
  })

  it("a Max refusal is not left standing after the token or the side changes", async () => {
    // Half a raw unit's worth of moving room: nothing this balance can spend is priced.
    mocks.accounts[A] = accountState({ underlying: live(3n), sy: live(3n), yt: live(1_000n * UNIT), permYt: live(true), depositCap: live(0n) })
    nav.search = "tab=yt"
    await renderUi(<TradePanel marketId="m1" />)
    await user().click(screen.getByRole("button", { name: "Max You pay" }))
    await settle()
    expect(screen.getByText(/^Max could not be worked out|^Your balance does not cover/)).toBeTruthy()
    await pick("Pay with", /SY/)
    expect(screen.queryByText(/^Max could not be worked out|^Your balance does not cover/)).toBeNull()
    await pick("Pay with", /^USDY$/)
    await user().click(screen.getByRole("button", { name: "Max You pay" }))
    await settle()
    expect(screen.getByText(/^Max could not be worked out|^Your balance does not cover/)).toBeTruthy()
    await user().click(screen.getByRole("button", { name: "Sell" }))
    await settle()
    await user().click(screen.getByRole("button", { name: "Buy" }))
    await settle()
    expect(screen.queryByText(/^Max could not be worked out|^Your balance does not cover/)).toBeNull()
  })

  it("a spend the pool cannot absorb is Unavailable with the solver's reason, never a zero", async () => {
    mocks.accounts[A] = accountState({ sy: live(10n ** 18n), permYt: live(true), depositCap: live(0n) })
    await renderUi(<YtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    await enter("You pay", "2900000")
    expect(received()).toBe("Unavailable")
    expect(screen.getAllByText(/pool cannot absorb the PT this purchase would sell/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/^0(\.0+)? YT$/)).toBeNull()
    expect(reviewButton("Buy YT").disabled).toBe(true)
  })
})

describe("YT tab — Sell", () => {
  const ytIn = 100n * UNIT
  const payout = previewSellYt(ytIn, ORACLE, buyExactPt(POOL, ytIn).amountIn)

  it("Sell YT routes to USDY or SY, and the fixed APY falls", async () => {
    simulateReturns(mocks, payout)
    await renderUi(<YtTab marketId="m1" side="sell" />)
    expect(screen.getByText("Balance: 1000 YT")).toBeTruthy()
    expect(screen.queryByRole("radiogroup", { name: "Pay with" })).toBeNull()
    expect(within(picker("Receive as")).getByRole("radio", { name: "USDY" }).getAttribute("aria-checked")).toBe("true")
    await enter("You pay", "100")
    expect(received()).toBe(`${amount(previewWithdraw(payout, SCALE))} USDY`)
    expect(
      screen.getByText(/This takes 2 signatures, one per step: step 1, Sell YT \(you give YT, you get SY\); step 2, Withdraw \(you give SY, you get USDY\)\./),
    ).toBeTruthy()
    // Selling YT buys PT from the pool: the fixed APY falls (R2-15).
    const after = impliedRate(buyExactPt(POOL, ytIn).next)
    expect(after).toBeLessThan(501023n)
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} → ${apy(after)}`)
    expect(detail("Minimum received")).toBe(`${amount(minAfterSlippage(payout, 50n))} SY`)
    expect(screen.queryByText(/^Moves /)).toBeNull()
    await user().click(reviewButton("Sell YT"))
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Sell YT" })
    expect(within(within(dialog).getByRole("list", { name: "Route steps" })).getAllByRole("listitem")).toHaveLength(2)
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "sell_yt", amount: ytIn })
    await user().keyboard("{Escape}")
    await settle()

    await pick("Receive as", /SY/)
    expect(received()).toBe(`${amount(payout)} SY`)
    expect(screen.getByText(/This is one step, one signature: Sell YT \(you give YT, you get SY\)\./)).toBeTruthy()
    await user().click(reviewButton("Sell YT"))
    await settle()
    const one = await screen.findByRole("dialog", { name: "Review route: Sell YT" })
    expect(within(within(one).getByRole("list", { name: "Route steps" })).getAllByRole("listitem")).toHaveLength(1)
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })
})

describe("YT tab — after maturity", () => {
  it("offers no Buy/Sell form: YT trading closed and the YT is worth 0 (R2-60)", async () => {
    nav.search = "tab=yt"
    mocks.getLedgerClock.mockImplementation(async () => ({ sequence: 1, closeTime: Number(MATURITY) + 100, readAtMs: Date.now() }))
    await renderUi(<TradePanel marketId="m1" />)
    expect(screen.getByText(/YT trading closed at maturity/)).toBeTruthy()
    expect(screen.getByText(/now worth 0/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Buy" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Sell" })).toBeNull()
    expect(screen.queryByLabelText("You pay")).toBeNull()
    // The yield a YT earned before maturity is paid by Redeem, on the PT tab.
    await user().click(screen.getByRole("button", { name: "Redeem in the PT tab" }))
    await settle()
    expect(screen.getByText("Redeem at maturity")).toBeTruthy()
  })
})
