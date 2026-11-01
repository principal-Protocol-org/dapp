import { screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { impliedRate, type CurveState } from "@/lib/protocol/curve"
import { formatPercent } from "@/lib/protocol/format"
import { aprToApy } from "@/lib/protocol/math"
import { writeRoute, type RouteRun } from "@/lib/app/route-log"
import { planRoute, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
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
// A one-step route, as `planRoute` builds one once a single-step Router function ships and the
// manifest lists it (`SINGLE_STEP` is empty today): on for the tests that set `stub.oneStep`.
const stub = vi.hoisted(() => ({ oneStep: false }))
vi.mock("@/lib/protocol/trade-adapter", async (orig) => {
  const mod = await orig<typeof import("@/lib/protocol/trade-adapter")>()
  const { planRoute } = await import("@/lib/protocol/routes")
  return {
    ...mod,
    currentContractsAdapter: {
      quote: mod.currentContractsAdapter.quote,
      plan: (req: Parameters<typeof mod.currentContractsAdapter.plan>[0], ctx: Parameters<typeof mod.currentContractsAdapter.plan>[1]) =>
        stub.oneStep
          ? planRoute(mod.toRouteRequest(req, ctx), {
              routerFunctions: ["swap_one_step"],
              singleStep: { [req.kind]: { fn: "swap_one_step", action: req.kind === "buy_pt" ? "buy_pt" : "sell_pt" } },
            })
          : mod.currentContractsAdapter.plan(req, ctx),
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
import { enter, installDefaults, renderUi, settle, simulateReturns, teardown, tipOf, user } from "./panel-harness"
import { PtTab } from "../trade/pt-tab"
import { TradePanel } from "../trade/trade-panel"

/**
 * A realistic pool (R2-16): curve.test.ts's state A, whose figures the Rust contract printed. 100 SY
 * buy 107.0237019 PT for a 0.1232877 SY fee (implied rate 501023 -> 498176); 100 PT sell for
 * 93.1966515 SY (-> 503687). Oracle 1.05 USD per USDY, SY rate 1.0.
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
const apy = (implied: bigint) => formatPercent(aprToApy(implied, POOL.secondsToMaturity))
const BALANCE = 10_000_000_000n // 1000 of each token

const usdyManifest = {
  ...MANIFEST,
  routerFunctions: [] as string[],
  markets: [{ ...MARKET, underlying: { ...MARKET.underlying, code: "USDY" } }],
}

function poolMarket() {
  return marketState({
    poolState: live(POOL),
    ptPrice: live(9798253n),
    impliedRate: live(501023n),
    swapFeeRate: live(POOL.feeRate),
    lpTotalSupply: live(POOL.totalLp),
  })
}

beforeEach(() => {
  installDefaults(mocks)
  mocks.manifest = usdyManifest as typeof mocks.manifest
  nav.search = ""
  stub.oneStep = false
  mocks.accounts[A] = accountState({ underlying: live(BALANCE), sy: live(BALANCE), pt: live(BALANCE), permYt: live(true) })
  mocks.fetchMarketState.mockResolvedValue(poolMarket())
})
afterEach(teardown)

/** The value beside a details label. */
const detail = (label: string) => within(screen.getByRole("region", { name: "Trading details" })).getByText(label).closest("dt")?.nextSibling?.textContent
const received = () => screen.getByLabelText("You receive (preview)").textContent
const picker = (name: string) => screen.getByRole("radiogroup", { name })
const pick = async (group: string, option: RegExp) => {
  await user().click(within(picker(group)).getByRole("radio", { name: option }))
  await settle()
}

describe("PT tab — Buy", () => {
  it('Buy shows "You pay" in the picked token and "You receive" in PT with today\'s value', async () => {
    await renderUi(<PtTab marketId="m1" side="buy" />)
    // USDY is the default (R2-50), on the "You pay" field.
    expect(within(picker("Pay with")).getByRole("radio", { name: "USDY" }).getAttribute("aria-checked")).toBe("true")
    expect(screen.getByText("Balance: 1000 USDY")).toBeTruthy()
    await enter("You pay", "100")
    // 100 USDY deposit to 100 SY at an SY rate of 1, which buy 107.0237019 PT on the curve.
    expect(received()).toBe("107.0237019 PT")
    // 107.0237019 PT at the pool's 0.9798253 USD each, in USDY at 1.05: 99.8709817 USDY.
    expect(detail("Value today")).toBe("≈ 99.8709817 USDY")
    expect(await tipOf("Value today")).toMatch(/at the pool's price/)
    // The old sentence is no longer inline text.
    expect(screen.queryByText(/Worth about/)).toBeNull()

    await pick("Pay with", /SY/)
    expect(screen.getByText("Balance: 1000 SY")).toBeTruthy()
    expect(screen.getByLabelText("You pay").closest("div")?.textContent).toContain("SY")
    expect(screen.queryByRole("radiogroup", { name: "Receive as" })).toBeNull()
  })

  it("details show fixed APY before → after, effective fixed APY, fees, minimum received", async () => {
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    // Buying PT lowers the fixed APY (R2-15).
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} → ${apy(498176n)}`)
    // (107.0237019 / (100 USDY x 1.05))^(365/150) − 1
    const effective = Math.pow(107.0237019 / 105, 365 / 150) - 1
    expect(detail("Your effective fixed APY")).toBe(formatPercent(effective))
    expect(detail("Fees")).toBe("0.1232877 USDY")
    // 107.0237019 PT less the 0.50 % default slippage, floored.
    expect(detail("Minimum received")).toBe("106.4885833 PT")
    expect(detail("Price impact")).toMatch(/^\d+\.\d\d%$/)
  })

  it("fixed payoff shown in USD, with the USDY equivalent marked indicative", async () => {
    // 100.1 SY (SY rate 1) are 100.1 USDY, $105.105 at 1.05; the simulation returns 110.635 PT.
    simulateReturns(mocks, 1_106_350_000n)
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    await enter("You pay", "100.1")
    expect(detail("At maturity")).toBe("+$5.53 (5.26%)")
    const payoffTip = await tipOf("At maturity")
    expect(payoffTip).toMatch(/Fixed in USD whatever USDY's price does/)
    // $5.53 at 1.05 USD per USDY.
    expect(payoffTip).toMatch(/About 5\.2666 USDY at today's USDY price \(indicative\)/)
  })

  it("simulated output replaces the indicative one and the APY after is recomputed from it", async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.simulateInvocation.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    await enter("You pay", "100")
    expect(screen.getByText("Indicative")).toBeTruthy()
    expect(received()).toBe("107.0237019 PT")
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} → ${apy(498176n)}`)

    answer({ ok: true, retval: 1_060_000_000n, latestLedger: 1, minResourceFee: "100" })
    await settle()
    expect(screen.getByText("Exact (simulated)")).toBeTruthy()
    expect(received()).toBe("106.0000 PT")
    // The pool once the simulated trade lands: pt − 106 PT, sy + (100 SY − fee).
    const after = impliedRate({ ...POOL, ptReserve: POOL.ptReserve - 1_060_000_000n, syReserve: POOL.syReserve + 1_000_000_000n - 1_232_877n })
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} → ${apy(after)}`)
    expect(detail("Minimum received")).toBe("105.4700 PT")
  })

  it("paying in SY is one step; paying in USDY is a deposit then the swap", async () => {
    simulateReturns(mocks, 1_000_000_000n)
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    // The count is the row's value, from the planned steps; the steps are behind its tip.
    expect(detail("Signatures")).toBe("2")
    expect(await tipOf("Signatures")).toMatch(/This takes 2 signatures, one per step: step 1, Deposit \(you give USDY, you get SY\); step 2, Buy PT \(you give SY, you get PT\)\./)

    await pick("Pay with", /SY/)
    await settle(400)
    await settle()
    expect(detail("Signatures")).toBe("1")
    expect(await tipOf("Signatures")).toMatch(/This is one step, one signature: Buy PT \(you give SY, you get PT\)\./)
    await user().click(screen.getByRole("button", { name: "Review Buy PT" }))
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Buy PT" })
    expect(within(dialog).getByText("This takes 1 signature, one per step. Your wallet asks you to sign each step on its own.")).toBeTruthy()
    const steps = within(dialog).getByRole("list", { name: "Route steps" })
    expect(within(steps).getAllByRole("listitem")).toHaveLength(1)
    expect(steps.textContent).toContain("You give: SY")
    expect(steps.textContent).toContain("You get: PT")
    // The step was prepared from its own simulation; nothing is signed until the user clicks.
    expect(mocks.prepareReview).toHaveBeenCalledTimes(1)
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "buy_pt", amount: 1_000_000_000n, source: A })
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it("a USDY route opens on its deposit step, with the swap's minimum left to its own quote", async () => {
    simulateReturns(mocks, 1_000_000_000n)
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    await user().click(screen.getByRole("button", { name: "Review Buy PT" }))
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Buy PT" })
    const steps = within(dialog).getByRole("list", { name: "Route steps" })
    expect(within(steps).getAllByRole("listitem")).toHaveLength(2)
    expect(steps.textContent).toContain("Its minimum is set from a fresh quote once step 1 is confirmed")
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "deposit", amount: 1_000_000_000n })
  })

  it("a USDY payer without the PT grant is refused before the deposit, not after it", async () => {
    simulateReturns(mocks, 1_000_000_000n)
    mocks.accounts[A] = accountState({ underlying: live(BALANCE), permPt: live(false) })
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    expect((screen.getByRole("button", { name: "Review Buy PT" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/PT permissioning/)).toBeTruthy()
  })

  it("a first step stopped only by archived data may start, so the route offers 0001's restore", async () => {
    mocks.simulateInvocation.mockResolvedValue({ ok: false, kind: "restore_required" })
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    await enter("You pay", "100")
    expect(screen.getByText(/restore it first/)).toBeTruthy()
    await user().click(screen.getByRole("button", { name: "Review Buy PT" }))
    await settle()
    // Nothing is prepared or signed: the route stops on step 1 with the restore offered.
    expect(await screen.findByRole("region", { name: "Restore archived data" })).toBeTruthy()
    expect(screen.getByText("Nothing has moved yet: no step of this route has gone through.")).toBeTruthy()
    expect(mocks.prepareReview).not.toHaveBeenCalled()
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it("keeps 0001's amount refusals", async () => {
    await renderUi(<PtTab marketId="m1" side="buy" />)
    for (const [text, message] of [
      ["1e3", /Exponents like 1e3 are not accepted/],
      ["-1", /cannot be negative/],
      ["1.12345678", /at most 7 digits after the point/],
      ["2000", /More than your balance/],
    ] as const) {
      await enter("You pay", text)
      expect(screen.getAllByText(message).length).toBeGreaterThan(0)
      expect((screen.getByRole("button", { name: "Review Buy PT" }) as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it("the amount resets once the step reaches the network (R2-3)", async () => {
    simulateReturns(mocks, 1_000_000_000n)
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await pick("Pay with", /SY/)
    await enter("You pay", "100")
    await user().click(screen.getByRole("button", { name: "Review Buy PT" }))
    await settle()
    await user().click(await screen.findByRole("button", { name: "Sign step 1 of 1" }))
    await settle()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe("")
  })
})

describe("PT tab — Sell", () => {
  it("Sell mirrors Buy and the APY moves up", async () => {
    await renderUi(<PtTab marketId="m1" side="sell" />)
    expect(screen.getByText("Balance: 1000 PT")).toBeTruthy()
    // The picker sits on "You receive" for a sale (R2-21), USDY by default.
    expect(screen.queryByRole("radiogroup", { name: "Pay with" })).toBeNull()
    expect(within(picker("Receive as")).getByRole("radio", { name: "USDY" }).getAttribute("aria-checked")).toBe("true")
    await enter("You pay", "100")
    expect(received()).toBe("93.1966515 USDY")
    // The USDY comes from step 2's withdraw at today's SY rate: never shown as exact.
    expect(await tipOf("Indicative")).toContain("Indicative: the steps after step 1 turn its SY into USDY at today's rate.")
    expect(screen.queryByText(/the steps after step 1 turn/)).toBeNull()
    // Selling PT raises the fixed APY (R2-15).
    expect(detail("Fixed APY")).toBe(`${apy(501023n)} → ${apy(503687n)}`)
    expect(detail("Fees")).toBe("0.1150419 USDY")
    // The floor shown is step 1's, in SY: step 2's does not exist before it is prepared.
    expect(detail("Minimum received")).toBe("92.7306682 SY")
    expect(detail("Signatures")).toBe("2")
    expect(await tipOf("Signatures")).toMatch(/This takes 2 signatures, one per step: step 1, Sell PT \(you give PT, you get SY\); step 2, Withdraw \(you give SY, you get USDY\)\./)

    await pick("Receive as", /SY/)
    expect(received()).toBe("93.1966515 SY")
    expect(detail("Signatures")).toBe("1")
    expect(await tipOf("Signatures")).toMatch(/This is one step, one signature: Sell PT \(you give PT, you get SY\)\./)
    expect(screen.queryByText(/At maturity/)).toBeNull()
  })
})

describe("PT tab — whatever the route's shape", () => {
  it("a one-step USDY buy reads as one step, and its simulation makes the output exact", async () => {
    stub.oneStep = true
    let answer: (value: unknown) => void = () => {}
    mocks.simulateInvocation.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    // The copy comes from the plan: one step, never "step 1 …, step 2 …".
    expect(detail("Signatures")).toBe("1")
    expect(await tipOf("Signatures")).toMatch(/This is one step, one signature: Buy PT \(you give USDY, you get PT\)\./)
    expect(screen.queryByText(/step 2/i)).toBeNull()
    expect(screen.getByText("Indicative")).toBeTruthy()
    expect(received()).toBe("107.0237019 PT")

    answer({ ok: true, retval: 1_060_000_000n, latestLedger: 1, minResourceFee: "100" })
    await settle()
    expect(screen.getByText("Exact (simulated)")).toBeTruthy()
    expect(received()).toBe("106.0000 PT")
    expect(await tipOf("Exact (simulated)")).toMatch(/The amount you receive is exact: it was simulated as your account\./)
    // The one step was simulated with the USDY typed.
    expect(mocks.simulateInvocation.mock.calls.at(-1)?.[0].invocation.functionName).toBe("swap_sy_for_pt")
  })
})

describe("PT tab — a quote it cannot work out", () => {
  it("a failed read shows Unavailable with its reason, never a zero", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ ...poolMarket(), oracleRate: { status: "unavailable", error: "rpc down" } }))
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await enter("You pay", "100")
    expect(received()).toBe("Unavailable")
    expect(screen.getByText("Unavailable: Could not read the oracle rate (rpc down).")).toBeTruthy()
    expect(screen.queryByText(/^0(\.0+)? PT$/)).toBeNull()
  })

  it("a trade the pool cannot take shows the pool's reason", async () => {
    mocks.accounts[A] = accountState({ underlying: live(10n ** 18n), permYt: live(true) })
    await renderUi(<PtTab marketId="m1" side="buy" />)
    await enter("You pay", "2900000")
    expect(received()).toBe("Unavailable")
    expect(screen.getByText("Unavailable: the pool does not have enough liquidity for this trade")).toBeTruthy()
  })
})

/** A Buy PT paid in USDY whose deposit confirmed: the user holds its SY between the steps. */
function buyPtRun(id: string, startedAt: number, sy: bigint): RouteRun {
  const request: RouteRequest = { kind: "buy_pt", marketId: "m1", source: A, amount: 100n * 10_000_000n, pay: "underlying", receive: "underlying", matured: false }
  return {
    id,
    account: A,
    marketId: "m1",
    kind: "buy_pt",
    request,
    plans: planRoute(request, { routerFunctions: [] }) as StepPlan[],
    outputs: [{ kind: "amount", value: sy }],
    steps: [
      { action: "deposit", status: "confirmed", hash: "1".repeat(64) },
      { action: "buy_pt", status: "pending" },
    ],
    startedAt,
  }
}

describe("PT tab — a Buy PT interrupted between its steps (R2-77)", () => {
  const AFTER = async () => ({ sequence: 1, closeTime: Number(MATURITY) + 100, readAtMs: Date.now() })

  it("after maturity it resumes beside Redeem, with its holdings and Back to USDY (withdraw stays open)", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER)
    writeRoute(buyPtRun("run-pt", 1, 95n * 10_000_000n))
    simulateReturns(mocks, 97n * 10_000_000n)
    nav.search = "tab=pt&side=buy&route=run-pt"
    await renderUi(<TradePanel marketId="m1" />)
    expect(screen.getByText("Redeem at maturity")).toBeTruthy()
    const progress = screen.getByRole("region", { name: "Route progress" })
    expect(within(progress).getByRole("heading", { name: "Step 2 of 2" })).toBeTruthy()
    expect(within(progress).getByText("You hold 95 SY")).toBeTruthy()
    // Nothing is prepared on landing: the user chooses.
    expect(mocks.prepareReview).not.toHaveBeenCalled()
    await user().click(within(progress).getByRole("button", { name: "Back to USDY" }))
    await settle()
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "withdraw", amount: 95n * 10_000_000n })
  })

  it("History's Continue (route=<id>) opens the run it names, not the newest", async () => {
    writeRoute(buyPtRun("older", 1, 95n * 10_000_000n))
    writeRoute(buyPtRun("newer", 2, 42n * 10_000_000n))
    nav.search = "tab=pt&side=buy&route=older"
    await renderUi(<TradePanel marketId="m1" />)
    expect(within(screen.getByRole("region", { name: "Route progress" })).getByText("You hold 95 SY")).toBeTruthy()
  })
})

describe("PT tab — after maturity", () => {
  it("after maturity the tab offers Redeem only", async () => {
    mocks.getLedgerClock.mockImplementation(async () => ({ sequence: 1, closeTime: Number(MATURITY) + 100, readAtMs: Date.now() }))
    await renderUi(<TradePanel marketId="m1" />)
    expect(screen.getByText("This market has matured: redeem your PT.")).toBeTruthy()
    expect(screen.getByText("Redeem at maturity")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Buy" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Sell" })).toBeNull()
    expect(screen.queryByLabelText("You pay")).toBeNull()
  })
})
