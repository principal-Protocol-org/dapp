import { render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readRoutes, writeRoute, type RouteRun } from "@/lib/app/route-log"
import { ACTION_META } from "@/lib/protocol/actions"
import { impliedRate, sellPt, type CurveState } from "@/lib/protocol/curve"
import { formatPercent, formatTokenAmount } from "@/lib/protocol/format"
import { minAfterSlippage } from "@/lib/protocol/guards"
import { aprToApy, SCALE } from "@/lib/protocol/math"
import { previewAddLiquidity, previewDeposit, previewMint, previewRedeemPt, previewRemoveLiquidity, previewWithdraw } from "@/lib/protocol/previews"
import { planRoute, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import type { TradeAdapter } from "@/lib/protocol/trade-adapter"
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
// Switches for quotes the live adapter does not give today: no APY on a route that sells, or an APY
// after that formats apart from the APY before on a trade the adapter says moves no price.
const stub = vi.hoisted(() => ({ dropApy: false, nudgeApy: false }))
vi.mock("@/lib/protocol/trade-adapter", async (orig) => {
  const mod = await orig<typeof import("@/lib/protocol/trade-adapter")>()
  const real = mod.currentContractsAdapter
  return {
    ...mod,
    currentContractsAdapter: {
      plan: real.plan,
      quote: (...args: Parameters<typeof real.quote>) => {
        const q = real.quote(...args)
        if (q.status !== "live") return q
        if (stub.dropApy) return { ...q, value: { ...q.value, apyBefore: undefined, apyAfter: undefined } }
        if (stub.nudgeApy && q.value.apyBefore !== undefined) return { ...q, value: { ...q.value, apyAfter: q.value.apyBefore + 0.0001 } }
        return q
      },
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

import { useGateContext } from "@/hooks/use-gate-context"
import { checkAmount } from "@/lib/app/amounts"
import { A, MANIFEST, MARKET } from "./panel-mocks"
import { disconnect, enter, gateList, Harness, installDefaults, renderUi, settle, simulateReturns, teardown, user } from "./panel-harness"
import { LpTab } from "../trade/lp-tab"
import { TradePanel } from "../trade/trade-panel"
import { useTradeRoute } from "../trade/use-trade-route"

/**
 * A realistic pool (R2-16): curve.test.ts's state A, 150 days left, oracle 1.05 USD per USDY, SY
 * rate 1.0, tokenization fee 0.10 %. Its PT : SY ratio is 1 : 0.58, so 100 USDY are split into
 * 62.1739366 USDY minted (65.2173507 PT + YT after the fee) and 37.8260634 USDY deposited.
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
const RESERVES = { pt: POOL.ptReserve, sy: POOL.syReserve }
const ORACLE = 10_500_000n
const FEE_BPS = 10n
const UNIT = 10_000_000n
const MINT_USDY = 621_739_366n
const DEPOSIT_USDY = 378_260_634n
const amount = (raw: bigint) => formatTokenAmount(raw, 7, true)
const apy = (implied: bigint) => formatPercent(aprToApy(implied, POOL.secondsToMaturity))
const AFTER_MATURITY = async () => ({ sequence: 1, closeTime: Number(MATURITY) + 600, readAtMs: Date.now() })

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
/** The market at maturity: the pool reads no time left, and the market settled at the oracle rate. */
const maturedMarket = (over: Parameters<typeof marketState>[0] = {}) =>
  poolMarket({ poolState: live({ ...POOL, secondsToMaturity: 0n }), settledRate: live(ORACLE), ytFrozen: live(true), ...over })

/** What the split's mint step mints, as wrap_and_mint returns it. */
const minted = previewMint(previewDeposit(MINT_USDY, SCALE), ORACLE, FEE_BPS)
const mintOutput = { pt_minted: minted.pt, yt_minted: minted.yt, fee_shares: minted.feeShares }
const added = previewAddLiquidity(minted.pt, previewDeposit(DEPOSIT_USDY, SCALE), RESERVES, POOL.totalLp)

beforeEach(() => {
  installDefaults(mocks)
  mocks.manifest = usdyManifest as typeof mocks.manifest
  nav.search = ""
  stub.dropApy = false
  stub.nudgeApy = false
  mocks.accounts[A] = accountState({
    underlying: live(100_000n * UNIT),
    sy: live(100_000n * UNIT),
    lp: live(10_000n * UNIT),
    permYt: live(true),
    // The deposit cap is off unless a test sets it.
    depositCap: live(0n),
  })
  mocks.fetchMarketState.mockResolvedValue(poolMarket())
})
afterEach(teardown)

/** The value beside a details label. */
const detail = (label: string) => within(screen.getByRole("region", { name: "Liquidity details" })).getByText(label).nextSibling?.textContent
const hintOf = (label: string) => within(screen.getByRole("region", { name: "Liquidity details" })).getByText(label).parentElement?.textContent
const received = () => screen.getByLabelText("You receive (preview)").textContent
const picker = (name: string) => screen.getByRole("radiogroup", { name })
const pick = async (group: string, option: RegExp) => {
  await user().click(within(picker(group)).getByRole("radio", { name: option }))
  await settle()
}
const keepYt = () => screen.getByRole("switch", { name: "Keep YT" })
const reviewButton = (label: string) => screen.getByRole("button", { name: `Review ${label}` }) as HTMLButtonElement
const stepsIn = (dialog: HTMLElement) => within(within(dialog).getByRole("list", { name: "Route steps" })).getAllByRole("listitem")

describe("LP tab — Deposit, Keep YT on", () => {
  it("Keep YT on: output LP and YT, APY unchanged, no slippage, tokenization fee on the split part", async () => {
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    expect(within(picker("Pay with")).getByRole("radio", { name: "USDY" }).getAttribute("aria-checked")).toBe("true")
    expect(keepYt().getAttribute("aria-checked")).toBe("true")
    await enter("You pay", "100")
    expect(received()).toBe(`${amount(added.lp)} LP + ${amount(minted.yt)} YT`)
    // Adding at the pool's ratio leaves its price, so its fixed APY, where it was.
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} (unchanged)`)
    // Nothing is swapped: no price impact, and the floors still come from each step's simulation.
    expect(detail("Price impact")).toBe("None")
    expect(hintOf("Price impact")).toMatch(/nothing is swapped.*slippage minimum from its own simulation/i)
    // The only fee is the tokenization fee, on the part split into PT + YT.
    expect(detail("Fees")).toBe(`${amount(previewWithdraw(minted.feeShares, SCALE))} USDY`)
    expect(hintOf("Fees")).toMatch(new RegExp(`tokenization fee on the ${amount(MINT_USDY).replace(".", "\\.")} USDY split into PT \\+ YT`))
    expect(detail("Split into PT + YT")).toBe(`${amount(MINT_USDY)} USDY`)
    expect(detail("YT you keep")).toBe(`${amount(minted.yt)} YT`)
    expect(detail("Minimum received")).toBe(`${amount(minAfterSlippage(added.lp, 50n))} LP`)
    expect(screen.getByText(/This takes 3 signatures, one per step: step 1, Mint PT \+ YT .*; step 2, Deposit .*; step 3, Add liquidity \(you give PT \+ SY, you get LP\)\./)).toBeTruthy()
    // The 0001 LP note stays: LPs earn no fee share.
    expect(screen.getByText("LPs earn PT convergence; swap fees go to the protocol and the market creator.")).toBeTruthy()
  })

  it("Keep YT split puts PT and SY in the pool ratio: the route mints 62.1739366 USDY and deposits 37.8260634 USDY", async () => {
    simulateReturns(mocks, mintOutput)
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "100")
    // The PT minted and the SY deposited are in the pool's PT : SY ratio, so the add takes both whole.
    expect(added).toEqual({ lp: 495_651_865n, ptUsed: minted.pt, syUsed: previewDeposit(DEPOSIT_USDY, SCALE) })
    await user().click(reviewButton("Add liquidity (keep YT)"))
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Add liquidity (keep YT)" })
    expect(stepsIn(dialog)).toHaveLength(3)
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "mint", amount: MINT_USDY, source: A })
    // 0001's floor on the mint: the PT minted, at the slippage tolerance.
    expect(mocks.prepareReview.mock.calls[0][0].input.guards).toEqual({ minOut: minAfterSlippage(minted.pt, 50n) })
    const run = readRoutes(A)[0]
    expect(run.kind).toBe("lp_keep_yt")
    expect(run.plans[1]).toMatchObject({ action: "deposit", amount: { from: "value", value: DEPOSIT_USDY } })
    expect(MINT_USDY + DEPOSIT_USDY).toBe(100n * UNIT)
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it("pool share before → after", async () => {
    // 1 % of the supply held.
    mocks.accounts[A] = accountState({ underlying: live(100_000n * UNIT), lp: live(7_600_000_000n), permYt: live(true), depositCap: live(0n) })
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "1000")
    const lp = previewAddLiquidity(
      previewMint(previewDeposit(6_217_393_656n, SCALE), ORACLE, FEE_BPS).pt,
      previewDeposit(3_782_606_344n, SCALE),
      RESERVES,
      POOL.totalLp,
    ).lp
    const after = Number(7_600_000_000n + lp) / Number(POOL.totalLp + lp)
    expect(detail("Pool share")).toBe(`1.00% → ${formatPercent(after)}`)
  })

  it("without a wallet the pool share is Unavailable, never 0 %", async () => {
    disconnect(mocks)
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "100")
    expect(detail("Pool share")).toBe("Unavailable")
    expect(hintOf("Pool share")).toMatch(/Connect a wallet/)
  })

  it("the deposit cap counts the mint and the deposit both: a route that fits step by step but not in total is refused before its first signature (R2-62)", async () => {
    simulateReturns(mocks, mintOutput)
    // 80 USDY of the cap left: the 62.17 minted fits, the 37.83 deposited fits alone, not after it.
    mocks.accounts[A] = accountState({
      underlying: live(100_000n * UNIT),
      permYt: live(true),
      depositCap: live(1_000n * UNIT),
      netDeposited: live(920n * UNIT),
    })
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "100")
    expect(screen.queryByText(/^This would pass your deposit cap/)).toBeNull()
    // Said for the route, never as if step 1's planned mint were already deposited.
    expect(within(gateList()).getByText("This route deposits 100 in total; your cap has 80 left (net of withdrawals). Lower the amount.")).toBeTruthy()
    expect(screen.queryByText(/counted after the steps before it: this would pass your deposit cap/)).toBeNull()
    expect(reviewButton("Add liquidity (keep YT)").disabled).toBe(true)
    expect(mocks.prepareReview).not.toHaveBeenCalled()
  })

  it("the circuit breaker counts the mint twice and the deposit once (R2-61)", async () => {
    simulateReturns(mocks, mintOutput)
    // 150 USDY left in the window: the mint reports 2 × 62.17, then the deposit 37.83 more.
    mocks.fetchMarketState.mockResolvedValue(
      poolMarket({ cb: { limit: live(1_000n * UNIT), volume: live(850n * UNIT), assetLimit: live(0n), assetVolume: live(0n) } }),
    )
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "100")
    expect(screen.queryByText(/^This would trip/)).toBeNull()
    expect(screen.getByText(/^Step 2 \(Deposit\), counted after the steps before it: this would trip the protocol-wide circuit breaker/)).toBeTruthy()
    expect(reviewButton("Add liquidity (keep YT)").disabled).toBe(true)
  })

  it("an unseeded pool refuses Keep YT before anything is signed, with the pool's reason", async () => {
    mocks.fetchMarketState.mockResolvedValue(poolMarket({ poolSeeded: live(false), poolState: live({ ...POOL, ptReserve: 0n, syReserve: 0n, totalLp: 0n }) }))
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "100")
    expect(within(gateList()).getByText(/Pool not seeded yet/)).toBeTruthy()
    expect(received()).toBe("Unavailable")
    expect(reviewButton("Add liquidity (keep YT)").disabled).toBe(true)
  })

  it("paying in SY turns Keep YT off and says why (R2-22): the split takes USDY", async () => {
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await pick("Pay with", /SY/)
    expect(keepYt().getAttribute("aria-checked")).toBe("false")
    expect((keepYt() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Keep YT needs USDY/)).toBeTruthy()
    expect(screen.getByText("Balance: 100000 SY")).toBeTruthy()
    // The LP-only refusal names the fix an SY payer can take: their Keep YT switch is off.
    await enter("You pay", "100")
    const reason = within(gateList()).getAllByRole("listitem")[0].textContent ?? ""
    expect(reason).toMatch(/^Adding liquidity without keeping YT is unavailable on this release/)
    expect(reason).toMatch(/Pay in USDY and turn on Keep YT/)
    expect(reason).not.toMatch(/^.*\. Turn on Keep YT/)
    expect(screen.queryByText(/Turn on Keep YT to add liquidity from USDY now/)).toBeNull()
  })

  it("keeps 0001's amount refusals, on Deposit and on Withdraw", async () => {
    for (const side of ["deposit", "withdraw"] as const) {
      const { unmount } = render(
        <Harness>
          <LpTab marketId="m1" side={side} />
        </Harness>,
      )
      for (let i = 0; i < 3; i++) await settle()
      const review = side === "deposit" ? "Add liquidity (keep YT)" : "Withdraw liquidity"
      for (const [text, message] of [
        ["1e3", /Exponents like 1e3 are not accepted/],
        ["-1", /cannot be negative/],
        ["1.12345678", /at most 7 digits after the point/],
        ["0x10", /Enter a number using digits/],
        ["200000", /More than your balance/],
      ] as const) {
        await enter("You pay", text)
        expect(screen.getAllByText(message).length).toBeGreaterThan(0)
        expect(reviewButton(review).disabled).toBe(true)
        expect(mocks.simulateInvocation).not.toHaveBeenCalled()
      }
      unmount()
    }
  })

  it("\"(unchanged)\" follows the adapter's word that the price does not move, not two percentages rounding alike", async () => {
    stub.nudgeApy = true
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "100")
    expect(detail("Price impact")).toBe("None")
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} (unchanged)`)
  })

  it("a deposit quote with no APY shows the Fixed APY row as Unavailable, never drops it", async () => {
    stub.dropApy = true
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "100")
    expect(detail("Fixed APY")).toBe("Unavailable")
  })

  it("the amount resets once a step reaches the network (R2-3)", async () => {
    simulateReturns(mocks, mintOutput)
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await enter("You pay", "100")
    await user().click(reviewButton("Add liquidity (keep YT)"))
    await settle()
    await user().click(await screen.findByRole("button", { name: "Sign step 1 of 3" }))
    await settle()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe("")
  })
})

describe("LP tab — Deposit, Keep YT off", () => {
  it("Keep YT off shows the R47 reason and signing stays off", async () => {
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    await user().click(keepYt())
    await settle()
    expect(keepYt().getAttribute("aria-checked")).toBe("false")
    await enter("You pay", "100")
    const reason = ACTION_META.add_liquidity_sy.disabled!.reason
    // The reason comes first among the refusals, and is the whole of the details: no figure for a
    // trade this release does not offer (0001 R51 M1).
    expect(within(gateList()).getAllByRole("listitem")[0].textContent).toBe(reason)
    expect(within(screen.getByRole("region", { name: "Liquidity details" })).getByText(`Unavailable: ${reason}`)).toBeTruthy()
    expect(received()).toBe("Unavailable")
    expect(screen.queryByText("Pool share")).toBeNull()
    expect(screen.queryByText("Fixed APY")).toBeNull()
    // Never simulated nor quoted from the pool, and signing is off.
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(screen.queryByText(/exact quote/)).toBeNull()
    expect(reviewButton("Add liquidity").disabled).toBe(true)
  })
})

describe("LP tab — Withdraw", () => {
  const LP_IN = 1_000n * UNIT
  const removed = previewRemoveLiquidity(LP_IN, RESERVES, POOL.totalLp)
  const afterRemove: CurveState = { ...POOL, ptReserve: POOL.ptReserve - removed.pt, syReserve: POOL.syReserve - removed.sy, totalLp: POOL.totalLp - LP_IN }
  const sale = sellPt(afterRemove, removed.pt)

  it("Withdraw shows the PT sale's APY effect; after maturity it redeems instead", async () => {
    const { unmount } = await renderPanel("tab=lp&side=withdraw")
    expect(screen.getByText("Balance: 10000 LP")).toBeTruthy()
    expect(within(picker("Receive as")).getByRole("radio", { name: "USDY" }).getAttribute("aria-checked")).toBe("true")
    await enter("You pay", "1000")
    expect(received()).toBe(`${amount(previewWithdraw(removed.sy + sale.amountOut, SCALE))} USDY`)
    // Selling the PT into the pool raises its fixed APY (R2-15).
    const after = impliedRate(sale.next)
    expect(after).toBeGreaterThan(501023n)
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} → ${apy(after)}`)
    expect(hintOf("Fixed APY")).toMatch(/sold into the pool, so the fixed APY rises/)
    expect(detail("Fees")).toBe(`${amount(previewWithdraw(sale.feeShares, SCALE))} USDY`)
    expect(
      screen.getByText(/This takes 3 signatures, one per step: step 1, Remove liquidity \(you give LP, you get PT \+ SY\); step 2, Sell PT \(you give PT, you get SY\); step 3, Withdraw/),
    ).toBeTruthy()
    unmount()

    // After maturity: the PT is redeemed, not sold (R2-20), so the fixed APY is not a figure of it.
    mocks.getLedgerClock.mockImplementation(AFTER_MATURITY)
    mocks.fetchMarketState.mockResolvedValue(maturedMarket())
    await renderPanel("tab=lp")
    // A matured market opens LP on Withdraw.
    expect(screen.getByRole("button", { name: "Withdraw" }).getAttribute("aria-pressed")).toBe("true")
    await enter("You pay", "1000")
    const redeemed = previewRedeemPt(removed.pt, ORACLE, SCALE)
    expect(received()).toBe(`${amount(redeemed + previewWithdraw(removed.sy, SCALE))} USDY`)
    expect(screen.queryByText("Fixed APY")).toBeNull()
    expect(detail("Your PT")).toBe("Redeemed, not sold")
    expect(detail("Fees")).toBe("None")
    expect(screen.getByText(/step 2, Redeem at maturity \(you give PT, you get USDY \(paid out as USDY even when you receive SY\)\); step 3, Withdraw/)).toBeTruthy()
  })

  it("Withdraw to USDY reaches the route review on its three steps; to SY it is two", async () => {
    simulateReturns(mocks, [removed.pt, removed.sy])
    await renderUi(<LpTab marketId="m1" side="withdraw" />)
    await enter("You pay", "1000")
    await user().click(reviewButton("Withdraw liquidity"))
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Withdraw liquidity" })
    expect(stepsIn(dialog)).toHaveLength(3)
    const input = mocks.prepareReview.mock.calls[0][0].input
    expect(input).toMatchObject({ action: "remove_liquidity", amount: LP_IN })
    // 0001's two floors on the removal, from its simulation.
    expect(input.guards).toEqual({ minOut: minAfterSlippage(removed.pt, 50n), minOut2: minAfterSlippage(removed.sy, 50n) })
    await user().keyboard("{Escape}")
    await settle()

    await pick("Receive as", /SY/)
    expect(received()).toBe(`${amount(removed.sy + sale.amountOut)} SY`)
    await user().click(reviewButton("Withdraw liquidity"))
    await settle()
    const two = await screen.findByRole("dialog", { name: "Review route: Withdraw liquidity" })
    expect(stepsIn(two)).toHaveLength(2)
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it("a withdraw that sells, quoted with no APY, shows Unavailable and never the redeem story (R2-55)", async () => {
    // Whether the PT is redeemed comes from the planned route (here: sold), never from the quote's
    // optional fields.
    stub.dropApy = true
    await renderUi(<LpTab marketId="m1" side="withdraw" />)
    await pick("Receive as", /SY/)
    await enter("You pay", "1000")
    expect(detail("Fixed APY")).toBe("Unavailable")
    expect(detail("Fees")).toBe(`${amount(sale.feeShares)} SY`)
    expect(screen.queryByText("Your PT")).toBeNull()
    expect(screen.queryByText(/Redeemed, not sold/)).toBeNull()
    expect(screen.queryByText(/redeemed/i)).toBeNull()
  })

  it("pool share before → after", async () => {
    await renderUi(<LpTab marketId="m1" side="withdraw" />)
    await enter("You pay", "1000")
    const held = 10_000n * UNIT
    expect(detail("Pool share")).toBe(`${formatPercent(Number(held) / Number(POOL.totalLp))} → ${formatPercent(Number(held - LP_IN) / Number(POOL.totalLp - LP_IN))}`)
  })

  it("after maturity a withdraw to SY says the redeemed part is paid in USDY, and stays open while the pool is paused", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER_MATURITY)
    mocks.fetchMarketState.mockResolvedValue(maturedMarket({ poolPaused: live(true) }))
    simulateReturns(mocks, [removed.pt, removed.sy])
    await renderUi(<LpTab marketId="m1" side="withdraw" />)
    await pick("Receive as", /SY/)
    await enter("You pay", "1000")
    const redeemed = previewRedeemPt(removed.pt, ORACLE, SCALE)
    expect(received()).toBe(`${amount(removed.sy)} SY + ${amount(redeemed)} USDY`)
    expect(screen.getByText(/The redeemed part, .* USDY, is paid in USDY even when you receive SY/)).toBeTruthy()
    // The pool pause never holds LPs in after maturity (market_pool:522-526).
    expect(reviewButton("Withdraw liquidity").disabled).toBe(false)
  })

  it("before maturity the pool pause stops a withdraw, as the contract does", async () => {
    mocks.fetchMarketState.mockResolvedValue(poolMarket({ poolPaused: live(true) }))
    simulateReturns(mocks, [removed.pt, removed.sy])
    await renderUi(<LpTab marketId="m1" side="withdraw" />)
    await enter("You pay", "1000")
    expect(within(gateList()).getAllByText(/The pool is paused: removing liquidity reopens at maturity/).length).toBeGreaterThan(0)
    expect(reviewButton("Withdraw liquidity").disabled).toBe(true)
  })
})

describe("LP tab — after maturity, Deposit", () => {
  it("says adding liquidity closed and offers no form", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER_MATURITY)
    mocks.fetchMarketState.mockResolvedValue(maturedMarket())
    await renderUi(<LpTab marketId="m1" side="deposit" />)
    expect(screen.getByText(/Adding liquidity closed at maturity/)).toBeTruthy()
    expect(screen.queryByLabelText("You pay")).toBeNull()
    expect(screen.queryByRole("button", { name: /^Review / })).toBeNull()
  })
})

/** Renders the whole trade panel at `search`. */
async function renderPanel(search: string) {
  nav.search = search
  const { unmount } = render(
    <Harness>
      <TradePanel marketId="m1" />
    </Harness>,
  )
  for (let i = 0; i < 3; i++) await settle()
  return { unmount }
}

describe("LP tab — History's Continue resumes an interrupted route", () => {
  const H = "aa".repeat(32)
  const req = (kind: RouteRequest["kind"], amountIn: bigint, matured = false): RouteRequest => ({
    kind,
    marketId: "m1",
    source: A,
    amount: amountIn,
    pay: "underlying",
    receive: "underlying",
    matured,
  })
  const plansOf = (r: RouteRequest): StepPlan[] => {
    const p = planRoute(r, { routerFunctions: [], keepYtSplit: { mintUnderlying: MINT_USDY, depositUnderlying: DEPOSIT_USDY } })
    if (!Array.isArray(p)) throw new Error(p.disabled)
    return p
  }

  it("a Keep YT route stopped after its mint shows Step 2 of 3 and what is held, and Continue prepares the deposit", async () => {
    const request = req("lp_keep_yt", 100n * UNIT)
    const run: RouteRun = {
      id: "run-lp",
      account: A,
      marketId: "m1",
      kind: "lp_keep_yt",
      request,
      plans: plansOf(request),
      outputs: [{ kind: "mint", ...mintOutput }],
      steps: [
        { action: "mint", status: "confirmed", hash: H },
        { action: "deposit", status: "pending" },
        { action: "add_liquidity", status: "pending" },
      ],
      startedAt: 1,
    }
    writeRoute(run)
    simulateReturns(mocks, previewDeposit(DEPOSIT_USDY, SCALE))
    // History's Continue links here (history-table.tsx ROUTE_LINK).
    await renderPanel("tab=lp&side=deposit")
    const progress = screen.getByRole("region", { name: "Route progress" })
    expect(within(progress).getByRole("heading", { name: "Step 2 of 3" })).toBeTruthy()
    expect(within(progress).getByText(`You hold ${formatTokenAmount(minted.pt, 7, true)} PT and ${formatTokenAmount(minted.yt, 7, true)} YT`)).toBeTruthy()
    // Nothing is prepared on a reload: the user continues.
    expect(mocks.prepareReview).not.toHaveBeenCalled()
    await user().click(within(progress).getByRole("button", { name: "Continue" }))
    await settle()
    expect(await screen.findByRole("dialog", { name: "Review route: Add liquidity (keep YT)" })).toBeTruthy()
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "deposit", amount: DEPOSIT_USDY })
  })

  it("a matured withdraw stopped after its removal resumes on Withdraw, and Continue prepares the redeem", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER_MATURITY)
    mocks.fetchMarketState.mockResolvedValue(maturedMarket())
    const request = req("lp_withdraw", 1_000n * UNIT, true)
    const removed = previewRemoveLiquidity(1_000n * UNIT, RESERVES, POOL.totalLp)
    writeRoute({
      id: "run-lp-out",
      account: A,
      marketId: "m1",
      kind: "lp_withdraw",
      request,
      plans: plansOf(request),
      outputs: [{ kind: "remove_liquidity", pt: removed.pt, sy: removed.sy }],
      steps: [
        { action: "remove_liquidity", status: "confirmed", hash: H },
        { action: "redeem", status: "pending" },
        { action: "withdraw", status: "pending" },
      ],
      startedAt: 1,
    })
    // Step 1 left the PT and SY with the account.
    mocks.accounts[A] = accountState({ lp: live(9_000n * UNIT), pt: live(removed.pt), sy: live(removed.sy), permYt: live(true), depositCap: live(0n) })
    simulateReturns(mocks, { underlying_from_pt: previewRedeemPt(removed.pt, ORACLE, SCALE), underlying_from_yt: 0n })
    await renderPanel("tab=lp&side=withdraw")
    const progress = screen.getByRole("region", { name: "Route progress" })
    expect(within(progress).getByRole("heading", { name: "Step 2 of 3" })).toBeTruthy()
    await user().click(within(progress).getByRole("button", { name: "Continue" }))
    await settle()
    expect(await screen.findByRole("dialog", { name: "Review route: Withdraw liquidity" })).toBeTruthy()
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "redeem", amount: removed.pt, secondaryAmount: 0n })
  })
})

describe("pre-start route gating — an earlier deposit whose amount is not known yet (R2-62)", () => {
  /** A stand-in route: its second step deposits what its first produces, its third a fixed amount. */
  const stub: TradeAdapter = {
    quote: () => ({ status: "unavailable", error: "not quoted in this test" }),
    plan: () => [
      { action: "sell_pt", amount: { from: "input" }, gives: "PT", takes: "SY" },
      { action: "deposit", amount: { from: "step", index: 0, field: "value" }, gives: "USDY", takes: "SY" },
      { action: "deposit", amount: { from: "value", value: UNIT }, gives: "USDY", takes: "SY" },
    ],
  }
  function Probe() {
    const gate = useGateContext("m1")
    const check = checkAmount("10", { decimals: 7, unit: "PT", balance: gate.account?.pt })
    const trade = { kind: "sell_pt" as const, amount: check.ok ? check.raw : 0n, pay: "sy" as const, receive: "sy" as const }
    const route = useTradeRoute({ marketId: "m1", gate, trade, check, adapter: stub })
    return (
      <ul aria-label="Refusals">
        {route.blockers.map((b) => (
          <li key={b.message}>{b.message}</li>
        ))}
      </ul>
    )
  }

  it("makes the later step's cap check unverifiable, never a pass", async () => {
    mocks.accounts[A] = accountState({ pt: live(100n * UNIT), underlying: live(100n * UNIT), depositCap: live(1_000_000n * UNIT), netDeposited: live(0n) })
    simulateReturns(mocks, 9n * UNIT)
    await renderUi(<Probe />)
    const refusals = within(screen.getByRole("list", { name: "Refusals" })).getAllByRole("listitem").map((li) => li.textContent)
    expect(refusals).toContainEqual(expect.stringMatching(/your net deposits .*before step 3 of this route/))
  })
})
