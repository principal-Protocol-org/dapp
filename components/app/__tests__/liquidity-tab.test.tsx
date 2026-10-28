import { screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ACTION_META, type ActionInput } from "@/lib/protocol/actions"
import { accountState, live, MATURITY, marketState } from "./fixtures"

const mocks = await vi.hoisted(async () => (await import("./panel-mocks")).createPanelMocks())

vi.mock("sonner", () => ({ toast: mocks.toast, Toaster: () => null }))
vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => mocks.manifest }))
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
import { disconnect, enter, gateList, installDefaults, openTab, renderUi, reviewButton, simulateReturns, teardown, valueIn } from "./panel-harness"
import { ActionTabs } from "../actions/action-tabs"
import { addLiquidityPanel, addLiquiditySyPanel, LiquidityTab, removeLiquidityPanel } from "../actions/liquidity-tab"

const LP_NOTE = "LPs earn PT convergence; swap fees go to the protocol and the market creator."
const UNITS_1000 = 10_000_000_000n
const i128 = (value: bigint) => [{ type: "i128", value }]

/** A seeded pool: 1000 PT, 2000 SY, 1000 LP. */
function poolMarket(over: Parameters<typeof marketState>[0] = {}) {
  const base = marketState()
  const pool = base.poolState.status === "live" ? base.poolState.value : undefined
  return marketState({
    poolState: live({ ...pool!, ptReserve: UNITS_1000, syReserve: 20_000_000_000n, totalLp: UNITS_1000, rate: 10_500_000n }),
    lpTotalSupply: live(UNITS_1000),
    ...over,
  })
}

const AFTER_MATURITY = async () => ({ sequence: 1, closeTime: Number(MATURITY) + 60, readAtMs: Date.now() })

function input(action: ActionInput["action"], amount: bigint, secondaryAmount?: bigint): ActionInput {
  return { action, marketId: "m1", source: A, amount, secondaryAmount, guards: {}, deadline: 0n }
}

beforeEach(() => {
  installDefaults(mocks)
  mocks.accounts[A] = accountState({ pt: live(UNITS_1000), sy: live(UNITS_1000), lp: live(1_000_000_000n) })
  mocks.fetchMarketState.mockResolvedValue(poolMarket())
})
afterEach(teardown)

describe("ActionTabs — Liquidity is registered", () => {
  it("enables the Liquidity tab, with add, single-sided add and remove", async () => {
    await renderUi(<ActionTabs marketId="m1" />)
    await openTab("Liquidity")
    const list = screen.getByRole("tablist", { name: "Liquidity actions" })
    expect(within(list).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Add PT + SY", "Add SY only", "Remove"])
  })
})

describe("Liquidity tab — add (PT + SY)", () => {
  it("shows the LP received, the amounts used and the leftover, in proportion to the reserves", async () => {
    disconnect(mocks)
    await renderUi(<LiquidityTab marketId="m1" />)
    await enter("PT to add", "100")
    await enter("SY to add", "250")
    // min(100·1000/1000, 250·1000/2000) = 100 LP; it takes 100 PT and 200 SY; 50 SY are not taken.
    expect(valueIn("Indicative", "LP received")).toBe("100.0000 LP")
    expect(valueIn("Indicative", "PT used")).toBe("100.0000 PT")
    expect(valueIn("Indicative", "SY used")).toBe("200.0000 SY")
    expect(valueIn("Indicative", "Leftover (stays in your wallet)")).toBe("50.0000 SY")
    expect(valueIn("Market (indicative)", "Pool reserves")).toBe("1000.0000 PT + 2000.0000 SY")
  })

  it("shows the exact LP, amounts used and leftover from the simulation, with the LP floor", async () => {
    simulateReturns(mocks, [1_000_000_000n, 2_000_000_000n, 1_000_000_000n])
    await renderUi(<LiquidityTab marketId="m1" />)
    await enter("PT to add", "100")
    await enter("SY to add", "250")
    expect(valueIn("Exact (simulated)", "LP received")).toBe("100.0000 LP")
    expect(valueIn("Exact (simulated)", "PT used")).toBe("100.0000 PT")
    expect(valueIn("Exact (simulated)", "SY used")).toBe("200.0000 SY")
    expect(valueIn("Exact (simulated)", "Leftover (stays in your wallet)")).toBe("50.0000 SY")
    expect(valueIn("Exact (simulated)", "Minimum LP received")).toBe("99.5 LP")
    const call = mocks.simulateInvocation.mock.calls.at(-1)![0].invocation
    expect(call.functionName).toBe("add_liquidity")
    expect(call.args.slice(2, 4)).toEqual([...i128(1_000_000_000n), ...i128(2_500_000_000n)])
    expect(reviewButton("Add liquidity").disabled).toBe(false)
  })

  it("shows the LP note: no fee share for LPs", async () => {
    await renderUi(<LiquidityTab marketId="m1" />)
    expect(screen.getByText(LP_NOTE)).toBeTruthy()
  })

  it("an unseeded pool has no proportional preview, and the pool gate says why", async () => {
    mocks.fetchMarketState.mockResolvedValue(poolMarket({ poolSeeded: live(false) }))
    simulateReturns(mocks, [1n, 1n, 1n])
    await renderUi(<LiquidityTab marketId="m1" />)
    await enter("PT to add", "1")
    await enter("SY to add", "1")
    expect(within(gateList()).getByText(/Pool not seeded yet/)).toBeTruthy()
    expect(reviewButton("Add liquidity").disabled).toBe(true)
  })
})

describe("Liquidity tab — add (SY only)", () => {
  function zapReads() {
    mocks.reads.zap_swap_amount = (args: { value: unknown }[]) => (args[0].value === 1_000_000_000n ? 500_000_000n : new Error("not the deposit"))
    mocks.reads.quote_sy_for_pt = (args: { value: unknown }[]) =>
      args[0].value === 500_000_000n ? { amount_out: 245_000_000n, amount_in: 500_000_000n, fee_shares: 1_500_000n } : new Error("not the swap")
  }

  it("shows the zap swap amount, then the LP from a quote of that swap", async () => {
    disconnect(mocks)
    zapReads()
    await renderUi(<LiquidityTab marketId="m1" />)
    await openTab("Add SY only")
    await enter("SY to add", "100")
    expect(mocks.read).toHaveBeenCalledWith({ contractId: "CPOOL", functionName: "zap_swap_amount", args: i128(1_000_000_000n) })
    expect(valueIn("Indicative", "SY swapped to PT")).toBe("50.0000 SY")
    // Hand-computed from market_pool:456-508 (see previews.test.ts).
    expect(valueIn("Indicative", "LP received")).toBe("24.3920286 LP")
    expect(valueIn("Indicative", "SY used")).toBe("99.9999999 SY")
    expect(valueIn("Indicative", "PT refunded")).toBe("0.7055761 PT")
    expect(valueIn("Indicative", "SY kept")).toBe("0.0000001 SY")
    expect(screen.getByText(LP_NOTE)).toBeTruthy()
  })

  it("stays visible but is not offered (R47): the reason comes first, nothing is simulated, signing is off", async () => {
    zapReads()
    simulateReturns(mocks, [237_944_239n, 999_999_999n, 243_920_286n])
    await renderUi(<LiquidityTab marketId="m1" />)
    await openTab("Add SY only")
    await enter("SY to add", "100")
    const reasons = within(gateList()).getAllByRole("listitem").map((li) => li.textContent)
    expect(reasons[0]).toBe(ACTION_META.add_liquidity_sy.disabled!.reason)
    // Never simulated, so no "waiting for an exact quote" line and no exact preview.
    expect(reasons.some((r) => /exact quote/.test(r ?? ""))).toBe(false)
    expect(screen.queryByText("Exact (simulated)")).toBeNull()
    expect(mocks.simulateInvocation.mock.calls.some(([p]) => p.invocation.functionName === "add_liquidity_single_sy")).toBe(false)
    expect(reviewButton("Add liquidity (SY only)").disabled).toBe(true)
    // The indicative preview stays.
    expect(valueIn("Indicative", "LP received")).toBe("24.3920286 LP")
  })

  it("would show the exact LP and SY used from a simulated output (kept for when it is offered again)", () => {
    const lines = addLiquiditySyPanel(MARKET).exact(
      { kind: "add_liquidity", pt_used: 237_944_239n, sy_used: 999_999_999n, lp: 243_920_286n },
      { inputs: { amount: 1_000_000_000n } },
    )
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ["LP received", "24.3920286 LP"],
      ["SY used", "99.9999999 SY"],
      ["PT added from the swap", "23.7944239 PT"],
      ["SY kept", "0.0000001 SY"],
    ])
  })
})

describe("Liquidity tab — remove", () => {
  it("shows lp·reserve/total_lp of each side without a wallet", async () => {
    disconnect(mocks)
    await renderUi(<LiquidityTab marketId="m1" />)
    await openTab("Remove")
    await enter("LP to remove", "10")
    expect(valueIn("Indicative", "PT received")).toBe("10.0000 PT")
    expect(valueIn("Indicative", "SY received")).toBe("20.0000 SY")
  })

  it("shows two floors, PT and SY", async () => {
    simulateReturns(mocks, [100_000_000n, 200_000_000n])
    await renderUi(<LiquidityTab marketId="m1" />)
    await openTab("Remove")
    await enter("LP to remove", "10")
    expect(valueIn("Exact (simulated)", "PT received")).toBe("10.0000 PT")
    expect(valueIn("Exact (simulated)", "SY received")).toBe("20.0000 SY")
    expect(valueIn("Exact (simulated)", "Minimum PT received")).toBe("9.95 PT")
    expect(valueIn("Exact (simulated)", "Minimum SY received")).toBe("19.9 SY")
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation.functionName).toBe("remove_liquidity")
  })

  it("stays enabled after maturity", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER_MATURITY)
    simulateReturns(mocks, [100_000_000n, 200_000_000n])
    await renderUi(<LiquidityTab marketId="m1" />)
    await openTab("Remove")
    await enter("LP to remove", "10")
    expect(screen.getByText("Every check passes.")).toBeTruthy()
    expect(reviewButton("Remove liquidity").disabled).toBe(false)
  })

  it("stays enabled when the pool is paused, after maturity", async () => {
    mocks.getLedgerClock.mockImplementation(AFTER_MATURITY)
    mocks.fetchMarketState.mockResolvedValue(poolMarket({ poolPaused: live(true) }))
    simulateReturns(mocks, [100_000_000n, 200_000_000n])
    await renderUi(<LiquidityTab marketId="m1" />)
    await openTab("Remove")
    await enter("LP to remove", "10")
    expect(screen.getByText("Every check passes.")).toBeTruthy()
    expect(reviewButton("Remove liquidity").disabled).toBe(false)
  })

  it("before maturity the pool pause does apply to it, as the contract says", async () => {
    mocks.fetchMarketState.mockResolvedValue(poolMarket({ poolPaused: live(true) }))
    simulateReturns(mocks, [100_000_000n, 200_000_000n])
    await renderUi(<LiquidityTab marketId="m1" />)
    await openTab("Remove")
    await enter("LP to remove", "10")
    expect(within(gateList()).getByText(/The pool is paused: removing liquidity reopens at maturity/)).toBeTruthy()
    expect(reviewButton("Remove liquidity").disabled).toBe(true)
  })
})

describe("Liquidity tab — result messages", () => {
  it("say what happened, in plain words", () => {
    expect(
      addLiquidityPanel().result!(
        { kind: "add_liquidity", pt_used: 1_000_000_000n, sy_used: 2_000_000_000n, lp: 1_000_000_000n },
        { input: input("add_liquidity", 1_000_000_000n, 2_500_000_000n) },
      ),
    ).toBe("You added 100 PT and 200 SY and received 100 LP.")
    expect(
      addLiquiditySyPanel(MARKET).result!(
        { kind: "add_liquidity", pt_used: 237_944_239n, sy_used: 999_999_999n, lp: 243_920_286n },
        { input: input("add_liquidity_sy", 1_000_000_000n) },
      ),
    ).toBe("You added 99.9999999 SY, part of it swapped to PT, and received 24.3920286 LP.")
    expect(
      removeLiquidityPanel().result!({ kind: "remove_liquidity", pt: 100_000_000n, sy: 200_000_000n }, { input: input("remove_liquidity", 100_000_000n) }),
    ).toBe("You removed 10 LP and received 10 PT and 20 SY.")
  })
})
