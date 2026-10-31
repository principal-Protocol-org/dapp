import { screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionInput } from "@/lib/protocol/actions"
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
  openTab,
  renderUi,
  reviewButton,
  section,
  simulateReturns,
  teardown,
  valueIn,
} from "./panel-harness"
import { ActionTabs } from "../actions/action-tabs"
import { buyPtPanel, buyYtPanel, sellPtPanel, sellYtPanel, TradeTab } from "../actions/trade-tab"

const SY_1000 = 10_000_000_000n
const i128 = (value: bigint) => [{ type: "i128", value }]

/** Pool at pt_price 0.98 and oracle rate 1.05, swap fee 0.3%. */
function tradeMarket(over: Parameters<typeof marketState>[0] = {}) {
  const base = marketState()
  const pool = base.poolState.status === "live" ? base.poolState.value : undefined
  return marketState({ poolState: live({ ...pool!, rate: 10_500_000n }), swapFeeRate: live(3_000_000_000n), ...over })
}

const holder = () => accountState({ permYt: live(true), sy: live(SY_1000), pt: live(SY_1000), yt: live(SY_1000) })

function input(action: ActionInput["action"], amount: bigint): ActionInput {
  return { action, marketId: "m1", source: A, amount, guards: {}, deadline: 0n }
}

beforeEach(() => {
  installDefaults(mocks)
  mocks.accounts[A] = holder()
  mocks.fetchMarketState.mockResolvedValue(tradeMarket())
})
afterEach(teardown)

describe("ActionTabs — Trade is registered", () => {
  it("enables the Trade tab, which shows the four trade panels", async () => {
    await renderUi(<ActionTabs marketId="m1" />)
    await openTab("Trade")
    expect(screen.getByRole("tablist", { name: "Trade actions" })).toBeTruthy()
    expect(within(screen.getByRole("tablist", { name: "Trade actions" })).getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "Buy PT",
      "Sell PT",
      "Buy YT",
      "Sell YT",
    ])
  })
})

describe("Trade tab — buy PT", () => {
  it("shows the price, the price impact against pt_price, the swap fee from swapFeeRate and the minimum PT", async () => {
    simulateReturns(mocks, 1_066_000_000n)
    mocks.reads.quote_sy_for_pt = { amount_out: 1_066_000_000n, amount_in: 1_000_000_000n, fee_shares: 3_000_000n }
    await renderUi(<TradeTab marketId="m1" />)
    await enter("SY to spend", "100")
    // Spot: 0.98 notional per PT at 1.05 notional per SY = 0.9333 SY per PT.
    expect(valueIn("Market (indicative)", "PT price (pool spot)")).toBe("0.9333 SY per PT")
    // 100 SY · 1.05 / (106.6 PT · 0.98) − 1 = 0.509%
    expect(valueIn("Market (indicative)", "Price impact")).toBe("0.50%")
    // ceil(100 SY · 0.3%), the fee calc_buy_pt takes
    expect(valueIn("Market (indicative)", "Swap fee")).toBe("0.3000 SY")
    expect(valueIn("Market (indicative)", "Swap fee rate")).toBe("0.3000%")
    expect(valueIn("Exact (simulated)", "PT received")).toBe("106.6000 PT")
    expect(valueIn("Exact (simulated)", "Effective price")).toBe("0.9380 SY per PT")
    // floor(1_066_000_000 · 9950 / 10000)
    expect(valueIn("Exact (simulated)", "Minimum PT received")).toBe("106.067 PT")
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation.functionName).toBe("swap_sy_for_pt")
    expect(reviewButton("Buy PT").disabled).toBe(false)
  })

  it("without a wallet, is quoted with quote_sy_for_pt read through the ContractReader", async () => {
    disconnect(mocks)
    mocks.reads.quote_sy_for_pt = { amount_out: 1_066_000_000n, amount_in: 1_000_000_000n, fee_shares: 3_000_000n }
    await renderUi(<TradeTab marketId="m1" />)
    await enter("SY to spend", "100")
    expect(mocks.read).toHaveBeenCalledWith({ contractId: "CPOOL", functionName: "quote_sy_for_pt", args: i128(1_000_000_000n) })
    expect(valueIn("Indicative", "PT received")).toBe("106.6000 PT")
    expect(valueIn("Indicative", "Price impact")).toBe("0.50%")
    // One swap fee line, from swapFeeRate (fix round 1: the quote's own fee line was a duplicate).
    expect(screen.getAllByText("Swap fee")).toHaveLength(1)
    expect(valueIn("Market (indicative)", "Swap fee")).toBe("0.3000 SY")
    // The exact price impact needs the exact quote.
    expect(within(section("Market (indicative)")).queryByText("Price impact")).toBeNull()
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
  })

  it("a quote that fails says so, and is never a number", async () => {
    disconnect(mocks)
    mocks.reads.quote_sy_for_pt = new Error("HostError: Error(Contract, #12)")
    await renderUi(<TradeTab marketId="m1" />)
    await enter("SY to spend", "100")
    expect(valueIn("Indicative", "Quote unavailable")).toMatch(/Error\(Contract, #12\)/)
  })
})

describe("Trade tab — sell PT", () => {
  it("is quoted with quote_pt_for_sy, and floors the SY from the exact quote", async () => {
    simulateReturns(mocks, 930_000_000n)
    mocks.reads.quote_pt_for_sy = { amount_out: 930_000_000n, amount_in: 0n, fee_shares: 2_800_000n }
    await renderUi(<TradeTab marketId="m1" />)
    await openTab("Sell PT")
    await enter("PT to sell", "100")
    expect(mocks.read).toHaveBeenCalledWith({ contractId: "CPOOL", functionName: "quote_pt_for_sy", args: i128(1_000_000_000n) })
    expect(valueIn("Exact (simulated)", "SY received")).toBe("93.0000 SY")
    expect(valueIn("Exact (simulated)", "Minimum SY received")).toBe("92.535 SY")
    // 1 − 93 SY / (100 PT · 0.98 / 1.05) = 0.357%
    expect(valueIn("Market (indicative)", "Price impact")).toBe("0.35%")
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation.functionName).toBe("swap_pt_for_sy")
  })
})

describe("Trade tab — buy YT", () => {
  it("shows the YT received, the SY returned, the net cost, and both guards (min YT, max net cost)", async () => {
    mocks.reads.quote_pt_for_sy = { amount_out: 979_000_000n, amount_in: 0n, fee_shares: 1n }
    simulateReturns(mocks, [1_050_000_000n, 979_000_000n])
    await renderUi(<TradeTab marketId="m1" />)
    await openTab("Buy YT")
    await enter("SY to spend", "100")
    expect(valueIn("Exact (simulated)", "YT received")).toBe("105.0000 YT")
    expect(valueIn("Exact (simulated)", "SY returned")).toBe("97.9000 SY")
    expect(valueIn("Exact (simulated)", "Net cost")).toBe("2.1000 SY")
    // min_yt_out = floor(105 · 0.995); max_net_cost = ceil(2.1 · 1.005)
    expect(valueIn("Exact (simulated)", "Minimum YT received")).toBe("104.475 YT")
    expect(valueIn("Exact (simulated)", "Maximum net cost")).toBe("2.1105 SY")
    // YT spot: (1 − 0.98) / 1.05 SY; 2.1 SY for 105 YT is 5% above it.
    expect(valueIn("Market (indicative)", "YT price (pool spot)")).toBe("0.0190 SY per YT")
    expect(valueIn("Market (indicative)", "Price impact")).toBe("5.00%")
    const call = mocks.simulateInvocation.mock.calls.at(-1)![0].invocation
    expect(call.functionName).toBe("swap_sy_for_yt")
    expect(reviewButton("Buy YT").disabled).toBe(false)
  })

  it("without a wallet, is previewed as a mint and then quote_pt_for_sy of the PT minted", async () => {
    disconnect(mocks)
    mocks.reads.quote_pt_for_sy = (args: { value: unknown }[]) =>
      args[0].value === 1_050_000_000n ? { amount_out: 979_000_000n, amount_in: 0n, fee_shares: 1n } : new Error("not the PT minted")
    await renderUi(<TradeTab marketId="m1" />)
    await openTab("Buy YT")
    await enter("SY to spend", "100")
    // 100 SY at oracle 1.05, no tokenization fee: 105 PT + 105 YT; the 105 PT sold back.
    expect(valueIn("Indicative", "YT received")).toBe("105.0000 YT")
    expect(valueIn("Indicative", "SY returned")).toBe("97.9000 SY")
    expect(valueIn("Indicative", "Net cost")).toBe("2.1000 SY")
  })

  it("a non-positive net cost is refused: YT is not offered at that price", async () => {
    simulateReturns(mocks, [1_050_000_000n, 1_000_000_000n])
    mocks.reads.quote_pt_for_sy = { amount_out: 1_000_000_000n, amount_in: 0n, fee_shares: 1n }
    await renderUi(<TradeTab marketId="m1" />)
    await openTab("Buy YT")
    await enter("SY to spend", "100")
    expect(within(gateList()).getByText(/YT price is not positive/)).toBeTruthy()
    expect(reviewButton("Buy YT").disabled).toBe(true)
  })
})

describe("Trade tab — sell YT", () => {
  it("shows the SY received and its minimum", async () => {
    simulateReturns(mocks, 45_000_000n)
    mocks.reads.quote_buy_exact_pt = { amount_out: 100_000_000n, amount_in: 90_000_000n, fee_shares: 1n }
    await renderUi(<TradeTab marketId="m1" />)
    await openTab("Sell YT")
    await enter("YT to sell", "10")
    expect(valueIn("Exact (simulated)", "SY received")).toBe("4.5000 SY")
    expect(valueIn("Exact (simulated)", "Minimum SY received")).toBe("4.4775 SY")
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation.functionName).toBe("swap_yt_for_sy")
  })

  it("without a wallet, is floor(yt·1e7/rate) − quote_buy_exact_pt(yt).amount_in", async () => {
    disconnect(mocks)
    mocks.reads.quote_buy_exact_pt = (args: { value: unknown }[]) =>
      args[0].value === 100_000_000n ? { amount_out: 100_000_000n, amount_in: 90_000_000n, fee_shares: 1n } : new Error("not the YT sold")
    await renderUi(<TradeTab marketId="m1" />)
    await openTab("Sell YT")
    await enter("YT to sell", "10")
    // floor(10 YT · 1e7 / 1.05e7) = 9.5238095 SY recombined, minus 9 SY for the PT.
    expect(valueIn("Indicative", "SY received")).toBe("0.5238095 SY")
  })
})

describe("Trade tab — after maturity", () => {
  it.each([
    ["Buy PT", "SY to spend"],
    ["Sell PT", "PT to sell"],
    ["Buy YT", "SY to spend"],
    ["Sell YT", "YT to sell"],
  ])("%s is blocked with \"Trading closed at maturity\"", async (panel, field) => {
    mocks.getLedgerClock.mockImplementation(async () => ({ sequence: 1, closeTime: Number(MATURITY) + 60, readAtMs: Date.now() }))
    simulateReturns(mocks, 1_000_000n)
    await renderUi(<TradeTab marketId="m1" />)
    await openTab(panel)
    await enter(field, "1")
    expect(within(gateList()).getByText(/^Trading closed at maturity: this market has matured/)).toBeTruthy()
    expect(reviewButton(panel).disabled).toBe(true)
  })
})

describe("Trade tab — result messages", () => {
  it("say what happened, in plain words", () => {
    expect(buyPtPanel(MARKET, () => mocks.read).result!({ kind: "amount", value: 1_066_000_000n }, { input: input("buy_pt", 1_000_000_000n) })).toBe(
      "You bought 106.6 PT for 100 SY.",
    )
    expect(sellPtPanel(MARKET, () => mocks.read).result!({ kind: "amount", value: 930_000_000n }, { input: input("sell_pt", 1_000_000_000n) })).toBe(
      "You sold 100 PT for 93 SY.",
    )
    expect(
      buyYtPanel(MARKET, () => mocks.read).result!({ kind: "buy_yt", yt_out: 1_050_000_000n, sy_back: 979_000_000n }, { input: input("buy_yt", 1_000_000_000n) }),
    ).toBe("You bought 105 YT for a net 2.1 SY (100 SY in, 97.9 SY returned).")
    expect(sellYtPanel(MARKET, () => mocks.read).result!({ kind: "amount", value: 45_000_000n }, { input: input("sell_yt", 100_000_000n) })).toBe(
      "You sold 10 YT for 4.5 SY.",
    )
  })
})
