import { screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionInput } from "@/lib/protocol/actions"
import { accountState, down, live, marketState } from "./fixtures"

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

import { A, MANIFEST, MARKET } from "./panel-mocks"
import { disconnect, enter, gateList, installDefaults, renderUi, reviewButton, settle, simulateReturns, teardown, tipOf, user, valueIn } from "./panel-harness"
import { ActionPanel } from "../actions/action-panel"
import { depositPanel, mintPanel, withdrawPanel } from "../actions/mint-tab"

/**
 * The 0001 deposit, withdraw and split (mint) panels, mounted as the Quick actions dialogs mount
 * them: one `ActionPanel` per config, each config built once (panel-config rule 1). The tab group
 * that once held them was mounted nowhere and is gone (M12).
 */
const DEPOSIT = depositPanel(MARKET)
const WITHDRAW = withdrawPanel(MARKET)
const MINT = mintPanel(MARKET)

const STA_100 = 1_000_000_000n
const STA_5000 = 50_000_000_000n

/** Ten days before maturity, permitted, with STA to spend. */
const funded = (over: Parameters<typeof accountState>[0] = {}) => accountState({ permYt: live(true), underlying: live(STA_5000), ...over })

function input(action: ActionInput["action"], amount: bigint): ActionInput {
  return { action, marketId: "m1", source: A, amount, guards: {}, deadline: 0n }
}

beforeEach(() => {
  installDefaults(mocks)
  mocks.manifest = MANIFEST
})
afterEach(teardown)

describe("Deposit panel", () => {
  it("deposit of 100 at exchange_rate 1e7 shows 100.0000 SY (indicative, without a wallet)", async () => {
    disconnect(mocks)
    await renderUi(<ActionPanel config={DEPOSIT} marketId="m1" />)
    await enter("STA to deposit", "100")
    expect(valueIn("Indicative", "SY received")).toBe("100.0000 SY")
    expect(valueIn("Market (indicative)", "SY exchange rate")).toBe("1.0000 STA per SY")
    expect(valueIn("Market (indicative)", "Your deposit cap left")).toBe("Connect a wallet to see it")
  })

  it("says the deposit cap is loading, not to connect a wallet, while the account loads (V6)", async () => {
    mocks.accounts[A] = "pending"
    await renderUi(<ActionPanel config={DEPOSIT} marketId="m1" />)
    await enter("STA to deposit", "100")
    expect(valueIn("Market (indicative)", "Your deposit cap left")).toBe("Loading…")
  })

  it("deposit follows the exchange rate: amount·1e7/exchange_rate, floored", async () => {
    disconnect(mocks)
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: live(12_500_000n) }))
    await renderUi(<ActionPanel config={DEPOSIT} marketId="m1" />)
    await enter("STA to deposit", "100")
    expect(valueIn("Indicative", "SY received")).toBe("80.0000 SY")
  })

  it("deposit shows the cap left (depositCap − netDeposited) next to the exact quote", async () => {
    mocks.accounts[A] = funded()
    simulateReturns(mocks, STA_100)
    await renderUi(<ActionPanel config={DEPOSIT} marketId="m1" />)
    await enter("STA to deposit", "100")
    expect(valueIn("Exact (simulated)", "SY received")).toBe("100.0000 SY")
    expect(valueIn("Exact (simulated)", "Minimum SY received")).toBe("99.5 SY")
    // 10000 STA cap − 4000 STA already deposited
    expect(valueIn("Market (indicative)", "Your deposit cap left")).toBe("6000.0000 STA")
    expect(reviewButton("Deposit").disabled).toBe(false)
    const call = mocks.simulateInvocation.mock.calls.at(-1)![0]
    expect(call.invocation).toMatchObject({ contractId: "CSY", functionName: "deposit" })
  })

  it("a cap of 0 is shown as no cap", async () => {
    mocks.accounts[A] = funded({ depositCap: live(0n) })
    simulateReturns(mocks, STA_100)
    await renderUi(<ActionPanel config={DEPOSIT} marketId="m1" />)
    await enter("STA to deposit", "100")
    expect(valueIn("Market (indicative)", "Your deposit cap left")).toBe("No cap")
  })

  it("an unreadable exchange rate shows Unavailable, never a guess", async () => {
    disconnect(mocks)
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: { status: "unavailable", error: "rpc down" } }))
    await renderUi(<ActionPanel config={DEPOSIT} marketId="m1" />)
    await enter("STA to deposit", "100")
    expect(valueIn("Indicative", "SY received")).toBe("Unavailable")
    expect(valueIn("Market (indicative)", "SY exchange rate")).toBe("Unavailable")
  })
})

describe("Withdraw panel", () => {
  it("withdraw shows shares·exchange_rate/1e7 in the underlying", async () => {
    disconnect(mocks)
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: live(10_500_000n) }))
    await renderUi(<ActionPanel config={WITHDRAW} marketId="m1" />)
    await enter("SY to withdraw", "100")
    expect(valueIn("Indicative", "STA received")).toBe("105.0000 STA")
  })

  it("withdraw's exact quote and floor are in the underlying, through Router.unwrap", async () => {
    mocks.accounts[A] = funded({ sy: live(STA_100) })
    simulateReturns(mocks, STA_100)
    await renderUi(<ActionPanel config={WITHDRAW} marketId="m1" />)
    await enter("SY to withdraw", "100")
    expect(valueIn("Exact (simulated)", "STA received")).toBe("100.0000 STA")
    expect(valueIn("Exact (simulated)", "Minimum STA received")).toBe("99.5 STA")
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation).toMatchObject({ contractId: "CROUTER", functionName: "unwrap" })
  })
})

describe("Split panel (mint PT + YT from the underlying)", () => {
  const fees5bps = { tokenizationBps: live(5n), ytBps: live(0n), swapTierBps: live(0n), protocolShareBps: live(0n) }

  it("mint of 100 at oracle 1.05 with 5 bps shows 104.9475 PT + 104.9475 YT and a fee of 0.05 SY", async () => {
    disconnect(mocks)
    mocks.fetchMarketState.mockResolvedValue(marketState({ fees: fees5bps }))
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    await enter("STA to mint with", "100")
    expect(valueIn("Indicative", "You receive")).toBe("104.9475 PT + 104.9475 YT")
    expect(valueIn("Indicative", "Tokenization fee")).toBe("0.0500 SY")
    expect(valueIn("Indicative", "Deposited as SY first")).toBe("100.0000 SY")
    expect(valueIn("Market (indicative)", "Oracle rate")).toBe("1.0500 notional per SY share")
    expect(valueIn("Market (indicative)", "Tokenization fee rate")).toBe("0.05%")
  })

  it("mint's exact quote comes from wrap_and_mint, with the PT floor", async () => {
    mocks.accounts[A] = funded()
    mocks.fetchMarketState.mockResolvedValue(marketState({ fees: fees5bps }))
    simulateReturns(mocks, { pt_minted: 1_049_475_000n, yt_minted: 1_049_475_000n, fee_shares: 500_000n })
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    await enter("STA to mint with", "100")
    expect(valueIn("Exact (simulated)", "You receive")).toBe("104.9475 PT + 104.9475 YT")
    expect(valueIn("Exact (simulated)", "Tokenization fee")).toBe("0.0500 SY")
    // floor(1_049_475_000 · 9950 / 10000) = 1_044_227_625
    expect(valueIn("Exact (simulated)", "Minimum PT received (and as much YT)")).toBe("104.4227625 PT")
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation).toMatchObject({ contractId: "CROUTER", functionName: "wrap_and_mint" })
    expect(reviewButton("Mint PT + YT").disabled).toBe(false)
  })

  it("an SY balance shows the note: use SY to buy PT or YT, add liquidity, or withdraw it", async () => {
    mocks.accounts[A] = funded({ sy: live(STA_100) })
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    expect(screen.getByText(/You hold 100 SY\. Minting starts from STA\. Use SY to buy PT or YT, add liquidity, or withdraw it\./)).toBeTruthy()
  })

  it("no SY balance, no SY note", async () => {
    mocks.accounts[A] = funded({ sy: live(0n) })
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    expect(screen.queryByText(/Use SY to buy PT or YT/)).toBeNull()
  })

  it("the circuit-breaker capacity is consumed once for a deposit", async () => {
    disconnect(mocks)
    await renderUi(<ActionPanel config={DEPOSIT} marketId="m1" />)
    await enter("STA to deposit", "100")
    // limit 100000 STA − volume 25000 STA = 75000 STA left; the per-asset limit is off (0).
    expect(valueIn("Market (indicative)", "Circuit breaker, protocol-wide")).toBe("100.0000 STA of 75000.0000 STA left")
    expect(screen.queryByText(/Circuit breaker, STA/)).toBeNull()
  })

  it("the circuit-breaker capacity is shown as consumed twice for mint (once for the deposit, once for the mint)", async () => {
    disconnect(mocks)
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    await enter("STA to mint with", "100")
    expect(valueIn("Market (indicative)", "Circuit breaker, protocol-wide")).toBe("200.0000 STA of 75000.0000 STA left")
    // The explanation sits behind the row's info tip (R2-65), not under it.
    expect(await tipOf("Circuit breaker, protocol-wide")).toMatch(/Minting from STA counts twice: once for the deposit, once for the mint\./)
  })

  it("a mint that fits once but not twice is refused by the breaker, as the preview says", async () => {
    mocks.accounts[A] = funded()
    // 150 STA of room: a 100 STA deposit fits, a 100 STA mint (200 counted) does not.
    const cb = { limit: live(10_000_000_000n), volume: live(8_500_000_000n), assetLimit: live(0n), assetVolume: live(0n) }
    mocks.fetchMarketState.mockResolvedValue(marketState({ cb }))
    simulateReturns(mocks, { pt_minted: 1_050_000_000n, yt_minted: 1_050_000_000n, fee_shares: 0n })
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    await enter("STA to mint with", "100")
    expect(valueIn("Market (indicative)", "Circuit breaker, protocol-wide")).toBe("200.0000 STA of 150.0000 STA left")
    expect(within(gateList()).getByText(/circuit breaker.*counts twice/)).toBeTruthy()
    expect(reviewButton("Mint PT + YT").disabled).toBe(true)
  })
})

describe("Split panel on protocolAbi 2 (principal 3af9388): wrap_and_mint signs sy_in", () => {
  const fees5bps = { tokenizationBps: live(5n), ytBps: live(0n), swapTierBps: live(0n), protocolShareBps: live(0n) }
  const minted = { pt_minted: 839_580_000n, yt_minted: 839_580_000n, fee_shares: 400_000n }
  const abi2 = () => {
    mocks.manifest = { ...MANIFEST, protocolAbi: 2 } as typeof mocks.manifest
  }

  it("simulates and signs the SY the deposit gives, worked out from the exchange rate (previewDeposit)", async () => {
    abi2()
    mocks.accounts[A] = funded()
    mocks.fetchMarketState.mockResolvedValue(marketState({ fees: fees5bps, exchangeRate: live(12_500_000n) }))
    simulateReturns(mocks, minted)
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    await enter("STA to mint with", "100")
    const { invocation } = mocks.simulateInvocation.mock.calls.at(-1)![0]
    expect(invocation.functionName).toBe("wrap_and_mint")
    // (from, pool, amount, sy_in, min_pt_out, deadline): 100 STA at 1.25 STA per SY is 80 SY.
    expect(invocation.args).toHaveLength(6)
    expect(invocation.args[2]).toEqual({ type: "i128", value: STA_100 })
    expect(invocation.args[3]).toEqual({ type: "i128", value: 800_000_000n })
    expect(reviewButton("Mint PT + YT").disabled).toBe(false)
    await user().click(reviewButton("Mint PT + YT"))
    await settle()
    const { input } = mocks.prepareReview.mock.calls[0][0] as { input: ActionInput }
    expect(input).toMatchObject({ action: "mint", amount: STA_100, secondaryAmount: 800_000_000n })
    // The preview the user reads is unchanged: the same give and get lines as on version 1.
    expect(valueIn("Exact (simulated)", "You receive")).toBe("83.9580 PT + 83.9580 YT")
  })

  it("without a read the sy_in needs, nothing is simulated and signing stays off, with the reason", async () => {
    abi2()
    mocks.accounts[A] = funded()
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: down() }))
    simulateReturns(mocks, minted)
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    await enter("STA to mint with", "100")
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
    expect(within(gateList()).getByText(/Could not read the SY exchange rate \(rpc down\)/)).toBeTruthy()
    expect(reviewButton("Mint PT + YT").disabled).toBe(true)
  })

  it("on version 1 the split signs as before, and an unread exchange rate does not stop its simulation", async () => {
    mocks.accounts[A] = funded()
    mocks.fetchMarketState.mockResolvedValue(marketState({ fees: fees5bps, exchangeRate: down() }))
    simulateReturns(mocks, minted)
    await renderUi(<ActionPanel config={MINT} marketId="m1" />)
    await enter("STA to mint with", "100")
    const { invocation } = mocks.simulateInvocation.mock.calls.at(-1)![0]
    expect(invocation.functionName).toBe("wrap_and_mint")
    expect(invocation.args).toHaveLength(5)
    expect(invocation.args[2]).toEqual({ type: "i128", value: STA_100 })
  })
})

describe("Deposit, withdraw and split — result messages", () => {
  it("say what happened, in plain words", () => {
    expect(depositPanel(MARKET).result!({ kind: "amount", value: STA_100 }, { input: input("deposit", STA_100) })).toBe(
      "You deposited 100 STA and received 100 SY.",
    )
    expect(withdrawPanel(MARKET).result!({ kind: "amount", value: 1_050_000_000n }, { input: input("withdraw", STA_100) })).toBe(
      "You withdrew 100 SY and received 105 STA.",
    )
    expect(
      mintPanel(MARKET).result!(
        { kind: "mint", pt_minted: 1_049_475_000n, yt_minted: 1_049_475_000n, fee_shares: 500_000n },
        { input: input("mint", STA_100) },
      ),
    ).toBe("You minted 104.9475 PT and 104.9475 YT from 100 STA.")
  })
})
