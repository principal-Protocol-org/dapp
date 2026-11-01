import { screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionInput } from "@/lib/protocol/actions"
import { indexFor } from "@/lib/protocol/yield"
import { accountState, live, MATURITY, marketState } from "./fixtures"

const mocks = await vi.hoisted(async () => (await import("./panel-mocks")).createPanelMocks())

vi.mock("sonner", () => ({ toast: mocks.toast, Toaster: () => null }))
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
}))
vi.mock("@/lib/protocol/review", async (orig) => ({
  ...(await orig<object>()),
  prepareReview: mocks.prepareReview,
  executeReview: mocks.executeReview,
  prepareRestore: mocks.prepareRestore,
  executeRestore: mocks.executeRestore,
}))

import { A, MARKET } from "./panel-mocks"
import {
  disconnect,
  enter,
  gateList,
  installDefaults,
  renderUi,
  reviewButton,
  settle,
  simulateReturns,
  teardown,
  tipOf,
  user,
  valueIn,
} from "./panel-harness"
import { ActionPanel } from "../actions/action-panel"
import { claimPanel, redeemPanel } from "../actions/redeem-tab"

/**
 * The 0001 claim and redeem panels, mounted as their hosts mount them (the Portfolio's Claim dialog,
 * the PT tab after maturity): one `ActionPanel` per config, built once (panel-config rule 1). The tab
 * group that once held them and its single-step recombine panel were mounted nowhere and are gone
 * (M12): Recombine is the Quick action's route (R2-72, recombine-action.test.tsx).
 */
const CLAIM = claimPanel(MARKET)
const REDEEM = redeemPanel(MARKET)

const PT_50 = 500_000_000n
const YT_30 = 300_000_000n
const INDICATIVE_LABEL = "Indicative — settles at the oracle rate of your redemption."
const UNSETTLED_NOTE =
  "Until the market is settled, the PT amount depends on the oracle rate when your transaction lands; it can only be lower than shown."
const i128 = (value: bigint) => ({ type: "i128", value })
const fieldValue = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value

/** Example 3 (principal docs/YIELD_MATH_AND_FEES.md): 104.9475 YT minted at 1.05, 10% YT fee. */
const example3Account = () =>
  accountState({ permYt: live(true), yt: live(1_049_475_000n), ytLastClaimedIndex: live(indexFor(10_500_000n)), ytPendingClaim: live(0n) })
const fees10pct = { tokenizationBps: live(0n), ytBps: live(1000n), swapTierBps: live(0n), protocolShareBps: live(0n) }

/** After maturity, unsettled, the YT index not frozen yet: the oracle (now 1.10) still decides. */
const unsettled = (over: Parameters<typeof marketState>[0] = {}) =>
  marketState({ oracleRate: live(11_000_000n), ytAccruedIndex: live(indexFor(10_500_000n)), fees: fees10pct, ...over })
/** Settled at 1.10. */
const settled = (over: Parameters<typeof marketState>[0] = {}) =>
  marketState({
    settledRate: live<bigint | null>(11_000_000n),
    ytFrozen: live(true),
    ytAccruedIndex: live(indexFor(11_000_000n)),
    oracleRate: live(11_000_000n),
    fees: fees10pct,
    ...over,
  })

const afterMaturity = () =>
  mocks.getLedgerClock.mockImplementation(async () => ({ sequence: 1, closeTime: Number(MATURITY) + 60, readAtMs: Date.now() }))

function input(action: ActionInput["action"], amount: bigint, secondaryAmount?: bigint): ActionInput {
  return { action, marketId: "m1", source: A, amount, secondaryAmount, guards: {}, deadline: 0n }
}

beforeEach(() => {
  installDefaults(mocks)
  mocks.accounts[A] = accountState({ permYt: live(true), pt: live(PT_50), yt: live(YT_30) })
})
afterEach(teardown)

describe("Claim panel", () => {
  it("shows the pending yield gross, the YT fee and the net (Example 3), beside the exact claim", async () => {
    mocks.accounts[A] = example3Account()
    mocks.fetchMarketState.mockResolvedValue(unsettled())
    simulateReturns(mocks, 40_888_636n)
    await renderUi(<ActionPanel config={CLAIM} marketId="m1" />)
    await settle(400) // no field to type: wait out the simulation debounce
    await settle()
    // Example 3: gross ≈ 4.5432, fee ≈ 0.4543, net ≈ 4.0889; exactly 45_431_818 / 4_543_182 / 40_888_636 raw.
    expect(valueIn("Your yield (indicative)", "Pending yield (gross)")).toBe("4.5431818 STA")
    expect(valueIn("Your yield (indicative)", "YT fee")).toBe("0.4543182 STA")
    expect(valueIn("Your yield (indicative)", "You receive (net)")).toBe("4.0888636 STA")
    expect(valueIn("Exact (simulated)", "You receive")).toBe("4.0888636 STA")
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation.functionName).toBe("claim_yield")
    expect(reviewButton("Claim yield").disabled).toBe(false)
  })

  it("without a wallet, asks to connect one", async () => {
    disconnect(mocks)
    await renderUi(<ActionPanel config={CLAIM} marketId="m1" />)
    expect(valueIn("Your yield (indicative)", "Pending yield")).toBe("Connect a wallet to see it")
  })

  it("with a wallet whose account is still loading, says so instead (V6)", async () => {
    mocks.accounts[A] = "pending"
    await renderUi(<ActionPanel config={CLAIM} marketId="m1" />)
    expect(valueIn("Your yield (indicative)", "Pending yield")).toBe("Loading…")
  })

  it("nothing to claim is refused before signing", async () => {
    mocks.accounts[A] = accountState({ permYt: live(true), yt: live(0n) })
    simulateReturns(mocks, 0n)
    await renderUi(<ActionPanel config={CLAIM} marketId="m1" />)
    expect(valueIn("Your yield (indicative)", "You receive (net)")).toBe("0.0000 STA")
    expect(within(gateList()).getByText(/Nothing to claim yet/)).toBeTruthy()
    expect(reviewButton("Claim yield").disabled).toBe(true)
  })
})

describe("Redeem panel (at maturity)", () => {
  beforeEach(afterMaturity)

  it("sets PT and YT independently; MAX for PT is the PT balance, not min(PT, YT)", async () => {
    mocks.fetchMarketState.mockResolvedValue(settled())
    simulateReturns(mocks, { underlying_from_pt: 1n, underlying_from_yt: 0n })
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await user().click(screen.getByRole("button", { name: "Max PT to redeem" }))
    expect(fieldValue("PT to redeem")).toBe("50")
    await user().click(screen.getByRole("button", { name: "Max YT to redeem" }))
    expect(fieldValue("YT to redeem")).toBe("30")

    await enter("YT to redeem", "")
    const ptOnly = mocks.simulateInvocation.mock.calls.at(-1)![0].invocation
    expect(ptOnly.functionName).toBe("redeem_at_maturity")
    expect(ptOnly.args.slice(2)).toEqual([i128(PT_50), i128(0n)])

    await enter("PT to redeem", "")
    await enter("YT to redeem", "30")
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation.args.slice(2)).toEqual([i128(0n), i128(YT_30)])
  })

  it("before settlement, the preview is labelled indicative — settles at the oracle rate of your redemption", async () => {
    disconnect(mocks)
    mocks.fetchMarketState.mockResolvedValue(unsettled())
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("PT to redeem", "105")
    // Example 2's PT leg: 105 PT at 1.10 = 95.4545 STA (floor(105e7 · 1e7 / 1.1e7)).
    expect(valueIn("Indicative", "From PT")).toBe("95.4545454 STA")
    // max(last_oracle_rate 1.05, live oracle 1.10)
    expect(valueIn("Settlement", "Settlement rate")).toBe("1.1000")
    expect(await tipOf("Settlement rate")).toBe(INDICATIVE_LABEL)
    expect(screen.getByText("The first redemption settles the market for everyone, at the oracle rate of that moment.")).toBeTruthy()
  })

  it("once settled, the rate is final and no longer indicative", async () => {
    disconnect(mocks)
    mocks.fetchMarketState.mockResolvedValue(settled({ oracleRate: live(12_000_000n) }))
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("PT to redeem", "105")
    expect(valueIn("Settlement", "Settlement rate")).toBe("1.1000")
    expect(await tipOf("Settlement rate")).toBe("Final: fixed when the market settled.")
    expect(await tipOf("Settlement rate")).not.toBe(INDICATIVE_LABEL)
    expect(valueIn("Indicative", "From PT")).toBe("95.4545454 STA")
  })

  it("frozen but unsettled, the rate is the frozen one, not the live oracle", async () => {
    disconnect(mocks)
    mocks.fetchMarketState.mockResolvedValue(unsettled({ ytFrozen: live(true), ytAccruedIndex: live(indexFor(11_000_000n)), oracleRate: live(12_000_000n) }))
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("PT to redeem", "105")
    expect(valueIn("Settlement", "Settlement rate")).toBe("1.1000")
    expect(valueIn("Indicative", "From PT")).toBe("95.4545454 STA")
  })

  it("previews the YT leg as the account's pending yield, net of the YT fee", async () => {
    mocks.accounts[A] = example3Account()
    mocks.fetchMarketState.mockResolvedValue(settled())
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("YT to redeem", "104.9475")
    expect(valueIn("Indicative", "From YT (net of the YT fee)")).toBe("4.0888636 STA")
  })

  it("previews the YT leg as loading, not connect-a-wallet, while the account loads (V6)", async () => {
    mocks.accounts[A] = "pending"
    mocks.fetchMarketState.mockResolvedValue(settled())
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("YT to redeem", "1")
    expect(valueIn("Indicative", "From YT (net of the YT fee)")).toBe("Loading…")
  })

  it("shows the exact PT and YT legs and their total", async () => {
    mocks.accounts[A] = accountState({ permYt: live(true), pt: live(1_050_000_000n), yt: live(1_049_475_000n) })
    mocks.fetchMarketState.mockResolvedValue(settled())
    simulateReturns(mocks, { underlying_from_pt: 954_545_454n, underlying_from_yt: 40_888_636n })
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("PT to redeem", "105")
    await enter("YT to redeem", "104.9475")
    expect(valueIn("Exact (simulated)", "From PT")).toBe("95.4545454 STA")
    expect(valueIn("Exact (simulated)", "From YT")).toBe("4.0888636 STA")
    expect(valueIn("Exact (simulated)", "Total")).toBe("99.543409 STA")
    expect(reviewButton("Redeem at maturity").disabled).toBe(false)
  })

  it("a stale oracle while unsettled blocks redeem, with the reason", async () => {
    mocks.fetchMarketState.mockResolvedValue(unsettled({ oracleFresh: live(false) }))
    simulateReturns(mocks, { underlying_from_pt: 1n, underlying_from_yt: 0n })
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("PT to redeem", "10")
    expect(
      within(gateList()).getByText(/The oracle price is stale.*The first redemption settles the market at the current oracle price, so that price must be fresh\./),
    ).toBeTruthy()
    expect(reviewButton("Redeem at maturity").disabled).toBe(true)
  })

  it("frozen but unsettled, a stale oracle does not block: the contract records the frozen rate (R40)", async () => {
    mocks.fetchMarketState.mockResolvedValue(unsettled({ ytFrozen: live(true), ytAccruedIndex: live(indexFor(11_000_000n)), oracleFresh: live(false) }))
    simulateReturns(mocks, { underlying_from_pt: 1n, underlying_from_yt: 0n })
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("PT to redeem", "10")
    expect(screen.getByText("Every check passes.")).toBeTruthy()
    expect(await tipOf("Settlement rate")).toMatch(/^Fixed: the YT yield index froze at maturity/)
    expect(screen.queryByText(/stale/)).toBeNull()
    expect(reviewButton("Redeem at maturity").disabled).toBe(false)
  })

  it("before settlement, a connected user is told the exact PT amount can only be lower when it lands", async () => {
    mocks.fetchMarketState.mockResolvedValue(unsettled())
    simulateReturns(mocks, { underlying_from_pt: 47_727_272n, underlying_from_yt: 0n })
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("PT to redeem", "50")
    expect(valueIn("Exact (simulated)", "From PT")).toBe("4.7727272 STA")
    expect(screen.getByText(UNSETTLED_NOTE)).toBeTruthy()
  })

  it("settled, or frozen, the PT amount is fixed: no such note", async () => {
    mocks.fetchMarketState.mockResolvedValue(settled())
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    expect(screen.queryByText(UNSETTLED_NOTE)).toBeNull()
  })

  it("a stale oracle once settled does not block: the rate is already fixed", async () => {
    mocks.fetchMarketState.mockResolvedValue(settled({ oracleFresh: live(false) }))
    simulateReturns(mocks, { underlying_from_pt: 1n, underlying_from_yt: 0n })
    await renderUi(<ActionPanel config={REDEEM} marketId="m1" />)
    await enter("PT to redeem", "10")
    expect(screen.getByText("Every check passes.")).toBeTruthy()
  })
})

describe("Claim and redeem — result messages", () => {
  it("say what happened, in plain words", () => {
    expect(claimPanel(MARKET).result!({ kind: "amount", value: 40_888_636n }, { input: input("claim_yield", 0n) })).toBe(
      "You claimed 4.0888636 STA of yield.",
    )
    expect(
      redeemPanel(MARKET).result!(
        { kind: "redeem", underlying_from_pt: 954_545_454n, underlying_from_yt: 40_888_636n },
        { input: input("redeem", 1_050_000_000n, 1_049_475_000n) },
      ),
    ).toBe("You redeemed 105 PT and 104.9475 YT for 99.543409 STA.")
    expect(
      redeemPanel(MARKET).result!({ kind: "redeem", underlying_from_pt: 954_545_454n, underlying_from_yt: 0n }, { input: input("redeem", 1_050_000_000n, 0n) }),
    ).toBe("You redeemed 105 PT for 95.4545454 STA.")
  })
})
