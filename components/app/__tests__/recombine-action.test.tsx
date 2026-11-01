import { screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { writeRoute, type RouteRun } from "@/lib/app/route-log"
import { previewRecombine, previewWithdraw } from "@/lib/protocol/previews"
import { planRoute, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import { accountState, down, live, marketState, MATURITY } from "./fixtures"

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
vi.mock("@/lib/protocol/review", async (orig) => ({
  ...(await orig<object>()),
  prepareReview: mocks.prepareReview,
  executeReview: mocks.executeReview,
  prepareRestore: mocks.prepareRestore,
  executeRestore: mocks.executeRestore,
}))

import { A, MANIFEST, MARKET } from "./panel-mocks"
import { disconnect, enter, HASH, installDefaults, renderUi, settle, simulateReturns, teardown, tipOf, user } from "./panel-harness"
import { RecombineAction } from "../trade/recombine-action"
import { TradePanel } from "../trade/trade-panel"

const UNIT = 10_000_000n
/** Oracle 1.05 USD per USDY (the fixture's); an SY exchange rate of 1.02, so the withdraw step shows. */
const ORACLE = 10_500_000n
const SY_RATE = 10_200_000n

const usdyManifest = {
  ...MANIFEST,
  routerFunctions: [] as string[],
  markets: [{ ...MARKET, underlying: { ...MARKET.underlying, code: "USDY" } }],
}

beforeEach(() => {
  installDefaults(mocks)
  mocks.manifest = usdyManifest as typeof mocks.manifest
  nav.search = ""
  // 1000 PT and 500 YT: Max is the smaller. permYt is off: recombine burns, it needs no PT/YT grant.
  mocks.accounts[A] = accountState({ pt: live(1_000n * UNIT), yt: live(500n * UNIT), sy: live(1_000n * UNIT) })
  mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: live(SY_RATE) }))
})
afterEach(teardown)

const FIELD = "PT and YT to recombine"
/** The value beside a details label. */
const detail = (label: string) => within(screen.getByRole("region", { name: "Recombine details" })).getByText(label).closest("dt")?.nextSibling?.textContent
const picker = () => screen.getByRole("radiogroup", { name: "Receive as" })
const pickSy = async () => {
  await user().click(within(picker()).getByRole("radio", { name: /SY/ }))
  await settle()
}
const review = () => screen.getByRole("button", { name: "Review Recombine" }) as HTMLButtonElement

describe("Recombine quick action — receive USDY (spec §4: recombine → withdraw)", () => {
  it("plans two steps, the withdraw taking step 1's SY; the details show the indicative USDY from the previews; Signatures 2", async () => {
    await renderUi(<RecombineAction marketId="m1" />)
    // USDY is the default.
    expect(within(picker()).getByRole("radio", { name: "USDY" }).getAttribute("aria-checked")).toBe("true")
    await enter(FIELD, "100")
    // No simulation answer yet: everything is indicative, from the previews.
    const sy = previewRecombine(100n * UNIT, ORACLE)
    expect(sy).toBe(952_380_952n)
    expect(screen.getByText("Indicative")).toBeTruthy()
    expect(detail("You receive")).toBe(`≈ 97.1428571 USDY`)
    expect(previewWithdraw(sy, SY_RATE)).toBe(971_428_571n)
    expect(detail("SY from step 1")).toBe("95.2380952 SY")
    expect(detail("Burns")).toBe("100.0000 PT + 100.0000 YT")
    expect(detail("Signatures")).toBe("2")
    expect(await tipOf("Signatures")).toMatch(
      /This takes 2 signatures, one per step: step 1, Recombine PT \+ YT \(you give PT \+ YT, you get SY\); step 2, Withdraw \(you give SY, you get USDY\)\./,
    )
    expect(await tipOf("You receive")).toMatch(/Indicative/)
  })

  it("step 1's simulated SY replaces the indicative one; the USDY stays indicative", async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.simulateInvocation.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(screen.getByText("Indicative")).toBeTruthy()
    answer({ ok: true, retval: 950_000_000n, latestLedger: 1, minResourceFee: "100" })
    await settle()
    expect(screen.getByText("Step 1 exact (simulated)")).toBeTruthy()
    expect(detail("SY from step 1")).toBe("95.0000 SY")
    // 95 SY at 1.02 USDY per SY, floored.
    expect(detail("You receive")).toBe("≈ 96.9000 USDY")
    // Step 1 was simulated as the user: recombine, with the amount typed.
    expect(mocks.simulateInvocation.mock.calls.at(-1)?.[0].invocation.functionName).toBe("recombine")
  })

  it("runs through RouteFlow: step 1 recombines, the form resets on reaching the network (R2-3), step 2 withdraws step 1's SY", async () => {
    simulateReturns(mocks, 950_000_000n)
    mocks.executeReview.mockResolvedValue({ hash: HASH, status: "SUCCESS", output: { kind: "amount", value: 950_000_000n } })
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(review().disabled).toBe(false)
    await user().click(review())
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Recombine" })
    expect(within(within(dialog).getByRole("list", { name: "Route steps" })).getAllByRole("listitem")).toHaveLength(2)
    expect(mocks.prepareReview).toHaveBeenCalledTimes(1)
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "recombine", amount: 100n * UNIT, source: A })
    expect(mocks.executeReview).not.toHaveBeenCalled()

    await user().click(await screen.findByRole("button", { name: "Sign step 1 of 2" }))
    await settle()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText(FIELD) as HTMLInputElement).value).toBe("")
    // Step 2 is prepared from what step 1 produced, not from the preview.
    await settle()
    expect(mocks.prepareReview).toHaveBeenCalledTimes(2)
    expect(mocks.prepareReview.mock.calls[1][0].input).toMatchObject({ action: "withdraw", amount: 950_000_000n })
    expect(await screen.findByRole("button", { name: "Sign step 2 of 2" })).toBeTruthy()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
  })
})

describe("Recombine quick action — receive SY (one step)", () => {
  it("plans one step; its simulation makes the SY exact; Signatures 1", async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.simulateInvocation.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    await renderUi(<RecombineAction marketId="m1" />)
    await pickSy()
    expect(within(picker()).getByRole("radio", { name: /SY/ }).getAttribute("aria-checked")).toBe("true")
    await enter(FIELD, "100")
    expect(screen.getByText("Indicative")).toBeTruthy()
    expect(detail("You receive")).toBe("95.2380952 SY")
    expect(screen.queryByText("SY from step 1")).toBeNull()
    expect(detail("Signatures")).toBe("1")
    expect(await tipOf("Signatures")).toMatch(/This is one step, one signature: Recombine PT \+ YT \(you give PT \+ YT, you get SY\)\./)

    answer({ ok: true, retval: 950_000_000n, latestLedger: 1, minResourceFee: "100" })
    await settle()
    expect(screen.getByText("Exact (simulated)")).toBeTruthy()
    expect(detail("You receive")).toBe("95.0000 SY")
    expect(await tipOf("Exact (simulated)")).toMatch(/The amount you receive is exact: it was simulated as your account\./)

    // The route prepares its step from a fresh simulation of its own.
    simulateReturns(mocks, 950_000_000n)
    await user().click(review())
    await settle()
    const dialog = await screen.findByRole("dialog", { name: "Review route: Recombine" })
    expect(within(within(dialog).getByRole("list", { name: "Route steps" })).getAllByRole("listitem")).toHaveLength(1)
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "recombine", amount: 100n * UNIT })
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })
})

describe("Recombine quick action — the amount", () => {
  it("Max fills the smaller of PT and YT when both are live", async () => {
    await renderUi(<RecombineAction marketId="m1" />)
    expect(screen.getByText("Balance: 500 PT + YT")).toBeTruthy()
    await user().click(screen.getByRole("button", { name: `Max ${FIELD}` }))
    await settle()
    expect((screen.getByLabelText(FIELD) as HTMLInputElement).value).toBe("500")
  })

  it("Max is off, with its reason, while either balance is not live", async () => {
    mocks.accounts[A] = accountState({ pt: live(1_000n * UNIT), yt: down() })
    await renderUi(<RecombineAction marketId="m1" />)
    expect(screen.getByText("Balance: Unavailable")).toBeTruthy()
    const max = screen.getByRole("button", { name: `Max ${FIELD}` }) as HTMLButtonElement
    expect(max.disabled).toBe(true)
    expect(max.title).toBe("Your balance is not available")
  })

  it("Max is off without a wallet", async () => {
    disconnect(mocks)
    await renderUi(<RecombineAction marketId="m1" />)
    expect((screen.getByRole("button", { name: `Max ${FIELD}` }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("keeps 0001's amount refusals", async () => {
    simulateReturns(mocks, 950_000_000n)
    await renderUi(<RecombineAction marketId="m1" />)
    for (const [text, message] of [
      ["1e3", /Exponents like 1e3 are not accepted/],
      ["-1", /cannot be negative/],
      ["1.12345678", /at most 7 digits after the point/],
      ["12,5", /Enter a number using digits and one decimal point/],
      ["0", /Enter an amount greater than zero/],
      // 600 is within the PT but above the YT: the smaller balance binds.
      ["600", /More than your balance: you have 500 PT \+ YT/],
    ] as const) {
      await enter(FIELD, text)
      expect(screen.getAllByText(message).length).toBeGreaterThan(0)
      expect(review().disabled).toBe(true)
    }
    expect(mocks.prepareReview).not.toHaveBeenCalled()
  })
})

describe("Recombine quick action — gates before the first signature", () => {
  it("a missing Principal permissioning grant refuses before step 1", async () => {
    simulateReturns(mocks, 950_000_000n)
    mocks.accounts[A] = accountState({ pt: live(1_000n * UNIT), yt: live(500n * UNIT), permAllowed: live(false) })
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(review().disabled).toBe(true)
    expect(screen.getAllByText(/Principal permissioning/).length).toBeGreaterThan(0)
  })

  it("the per-asset PT and YT grants do not gate a recombine: it only burns them (R22b)", async () => {
    simulateReturns(mocks, 950_000_000n)
    mocks.accounts[A] = accountState({ pt: live(1_000n * UNIT), yt: live(500n * UNIT), sy: live(1_000n * UNIT), permPt: live(false), permYt: live(false) })
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(screen.queryByText(/PT permissioning|YT permissioning/)).toBeNull()
    expect(review().disabled).toBe(false)
  })

  it("an account the underlying's issuer does not authorize (SAC) is refused before step 1 (R2-74)", async () => {
    simulateReturns(mocks, 950_000_000n)
    mocks.accounts[A] = accountState({ pt: live(1_000n * UNIT), yt: live(500n * UNIT), sacAuthorized: live(false), trustline: live("unauthorized") })
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(review().disabled).toBe(true)
    expect(screen.getAllByText(/Blocked by the issuer: your trustline exists but is not authorized/).length).toBeGreaterThan(0)
    expect(mocks.prepareReview).not.toHaveBeenCalled()
  })

  it("a paused PrincipalManager refuses before step 1", async () => {
    mocks.simulateInvocation.mockResolvedValue({ ok: false, kind: "contract_error", contractId: "CMANAGER", code: 9, message: "Error(Contract, #9)" })
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(review().disabled).toBe(true)
    expect(screen.getByText(/PrincipalManager is paused/)).toBeTruthy()
    expect(mocks.prepareReview).not.toHaveBeenCalled()
  })
})

describe("Recombine quick action — figures it cannot work out", () => {
  it("an unreadable oracle rate shows Unavailable with its reason, never a zero", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: live(SY_RATE), oracleRate: down("rpc down") }))
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(screen.getByText("Unavailable: the oracle rate could not be read (rpc down).")).toBeTruthy()
    expect(screen.queryByText(/^≈? ?0(\.0+)? (USDY|SY)$/)).toBeNull()
  })

  it("a dust amount whose SY rounds to nothing is Unavailable, never \"0 SY\" (M2)", async () => {
    mocks.simulateInvocation.mockImplementation(() => new Promise(() => {}))
    await renderUi(<RecombineAction marketId="m1" />)
    // 1 raw unit of PT + YT pays 1 / 1.05 SY: 0 once floored.
    expect(previewRecombine(1n, ORACLE)).toBe(0n)
    await enter(FIELD, "0.0000001")
    expect(screen.getByText("Unavailable: this amount is too small to recombine.")).toBeTruthy()
    expect(screen.queryByText(/^≈? ?0(\.0+)? (USDY|SY)$/)).toBeNull()
    await pickSy()
    expect(screen.getByText("Unavailable: this amount is too small to recombine.")).toBeTruthy()
  })

  it("a simulated step 1 that pays no SY is Unavailable, never a zero (M2)", async () => {
    simulateReturns(mocks, 0n)
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(screen.getByText("Unavailable: this amount is too small to recombine.")).toBeTruthy()
  })

  it("SY that unwraps to no USDY at today's rate is Unavailable, never \"≈ 0 USDY\" (M2)", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: live(1n) }))
    mocks.simulateInvocation.mockImplementation(() => new Promise(() => {}))
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "0.0001")
    expect(previewRecombine(1_000n, ORACLE)).toBe(952n)
    expect(previewWithdraw(952n, 1n)).toBe(0n)
    expect(screen.getByText("Unavailable: this amount is too small to recombine.")).toBeTruthy()
    expect(screen.queryByText(/≈ 0(\.0+)? USDY/)).toBeNull()
  })

  it("an unreadable SY rate leaves the USDY figure Unavailable, never a zero", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: down("rpc down") }))
    await renderUi(<RecombineAction marketId="m1" />)
    await enter(FIELD, "100")
    expect(screen.getByText("Unavailable: the SY exchange rate could not be read (rpc down).")).toBeTruthy()
  })
})

/** A recombine to USDY whose step 1 confirmed: the user holds its SY (History lists it with Continue). */
function interruptedRun(): RouteRun {
  const request: RouteRequest = { kind: "recombine", marketId: "m1", source: A, amount: 100n * UNIT, pay: "underlying", receive: "underlying", matured: false }
  const plans = planRoute(request, { routerFunctions: [] }) as StepPlan[]
  return {
    id: "run-recombine",
    account: A,
    marketId: "m1",
    kind: "recombine",
    request,
    plans,
    outputs: [{ kind: "amount", value: 952_380_952n }],
    steps: [
      { action: "recombine", status: "confirmed", hash: "1".repeat(64) },
      { action: "withdraw", status: "pending" },
    ],
    startedAt: 1,
  }
}

describe("Recombine quick action — a run stopped between its steps", () => {
  it("History's Continue (?quick=recombine) opens the dialog with the form and the run; Continue prepares the withdraw", async () => {
    writeRoute(interruptedRun())
    simulateReturns(mocks, 971_428_571n)
    nav.search = "quick=recombine"
    await renderUi(<TradePanel marketId="m1" />)
    const dialog = await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    expect(within(dialog).getByLabelText(FIELD)).toBeTruthy()
    const progress = within(dialog).getByRole("region", { name: "Route progress" })
    expect(within(progress).getByRole("heading", { name: "Step 2 of 2" })).toBeTruthy()
    expect(within(progress).getByText("You hold 95.2380952 SY")).toBeTruthy()
    // Nothing is prepared on a reload: the user continues.
    expect(mocks.prepareReview).not.toHaveBeenCalled()
    await user().click(within(progress).getByRole("button", { name: "Continue" }))
    await settle()
    expect(await screen.findByRole("dialog", { name: "Review route: Recombine" })).toBeTruthy()
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "withdraw", amount: 952_380_952n })
  })
})

describe("Recombine quick action — ?route= (follow-up)", () => {
  afterEach(() => window.history.replaceState(null, "", "/"))

  it("the dialog opens the run History's Continue names, then drops ?route= and keeps ?quick=", async () => {
    writeRoute(interruptedRun())
    window.history.replaceState(null, "", "/app/markets/m1?quick=recombine&route=run-recombine")
    nav.search = "quick=recombine&route=run-recombine"
    await renderUi(<TradePanel marketId="m1" />)
    const dialog = await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    expect(within(dialog).getByRole("region", { name: "Route progress" })).toBeTruthy()
    expect(window.location.search).toBe("?quick=recombine")
  })
})

describe("Recombine quick action — after maturity", () => {
  const AFTER = async () => ({ sequence: 1, closeTime: Number(MATURITY) + 100, readAtMs: Date.now() })

  it("says recombining has closed and points to Redeem; no form", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER)
    const onRedeem = vi.fn()
    await renderUi(<RecombineAction marketId="m1" onRedeem={onRedeem} />)
    expect(screen.getByText(/This market has matured, so recombining has closed/)).toBeTruthy()
    expect(screen.queryByLabelText(FIELD)).toBeNull()
    expect(screen.queryByRole("radiogroup", { name: "Receive as" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Review Recombine" })).toBeNull()
    await user().click(screen.getByRole("button", { name: "Redeem in the PT tab" }))
    expect(onRedeem).toHaveBeenCalledTimes(1)
  })

  it("without a host callback the pointer is a link to the PT tab", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER)
    await renderUi(<RecombineAction marketId="m1" />)
    expect(screen.getByRole("link", { name: "Redeem in the PT tab" }).getAttribute("href")).toBe("/app/markets/m1?tab=pt")
  })

  it("a run stopped holding SY still shows, so its withdraw can finish (withdraw stays open at maturity)", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER)
    writeRoute(interruptedRun())
    simulateReturns(mocks, 971_428_571n)
    await renderUi(<RecombineAction marketId="m1" />)
    const progress = screen.getByRole("region", { name: "Route progress" })
    expect(within(progress).getByRole("heading", { name: "Step 2 of 2" })).toBeTruthy()
    await user().click(within(progress).getByRole("button", { name: "Continue" }))
    await settle()
    expect(mocks.prepareReview.mock.calls[0][0].input).toMatchObject({ action: "withdraw", amount: 952_380_952n })
  })
})

/** A Buy PT whose deposit confirmed: a PT-tab run, which no Recombine dialog may show (R2-77). */
function buyPtRun(): RouteRun {
  const request: RouteRequest = { kind: "buy_pt", marketId: "m1", source: A, amount: 100n * UNIT, pay: "underlying", receive: "underlying", matured: false }
  return {
    id: "run-buy-pt",
    account: A,
    marketId: "m1",
    kind: "buy_pt",
    request,
    plans: planRoute(request, { routerFunctions: [] }) as StepPlan[],
    outputs: [{ kind: "amount", value: 95n * UNIT }],
    steps: [
      { action: "deposit", status: "confirmed", hash: "2".repeat(64) },
      { action: "buy_pt", status: "pending" },
    ],
    startedAt: 2,
  }
}

describe("Recombine quick action — hosts are disjoint by kind (R2-77)", () => {
  const progressRegions = () => screen.queryAllByRole("region", { name: "Route progress", hidden: true })

  it("the dialog never shows a Buy PT run; the PT tab does", async () => {
    writeRoute(buyPtRun())
    nav.search = "quick=recombine"
    await renderUi(<TradePanel marketId="m1" />)
    const dialog = await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    expect(within(dialog).queryByRole("region", { name: "Route progress" })).toBeNull()
    // The form is free: the PT run does not block a recombine.
    expect(within(dialog).getByLabelText(FIELD)).toBeTruthy()
    // Behind the modal, only the PT tab shows the run.
    expect(progressRegions()).toHaveLength(1)
    await user().keyboard("{Escape}")
    await settle()
    expect(within(screen.getByRole("region", { name: "Route progress" })).getByText("You hold 95 SY")).toBeTruthy()
  })

  it("a recombine run shows in the dialog only, never in the PT tab behind it", async () => {
    writeRoute(interruptedRun())
    nav.search = "quick=recombine"
    await renderUi(<TradePanel marketId="m1" />)
    const dialog = await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    expect(within(dialog).getByRole("region", { name: "Route progress" })).toBeTruthy()
    expect(progressRegions()).toHaveLength(1)
    await user().keyboard("{Escape}")
    await settle()
    expect(screen.queryByRole("region", { name: "Route progress" })).toBeNull()
  })

  it("closing the dialog keeps the amount typed in the tab (no remount)", async () => {
    await renderUi(<TradePanel marketId="m1" />)
    await enter("You pay", "12")
    await user().click(screen.getByRole("button", { name: "Quick actions" }))
    await user().click(screen.getByRole("menuitem", { name: "Recombine PT + YT" }))
    await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    await user().keyboard("{Escape}")
    await settle()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect((screen.getByLabelText("You pay") as HTMLInputElement).value).toBe("12")
  })
})
