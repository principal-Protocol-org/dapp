import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountState } from "@/lib/protocol/account-state"
import type { ActionInput } from "@/lib/protocol/actions"
import { formatAmount, formatRate } from "@/lib/protocol/format"
import type { Review, RestoreReview } from "@/lib/protocol/review"
import type { Finding, WalletState } from "@/lib/protocol/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { showLive } from "@/components/app/live"
import { accountState, down, LEDGER_TIME, live, marketState } from "./fixtures"

const PASSPHRASE = "Test SDF Network ; September 2015"
const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const HASH = "ab".repeat(32)
const RESTORE_HASH = "cd".repeat(32)
const SY_100 = 1_000_000_000n

const mocks = vi.hoisted(() => ({
  manifest: {
    schemaVersion: 1,
    network: "testnet",
    networkPassphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://rpc.example",
    horizonUrl: "https://horizon.example",
    generatedAt: "2026-10-01T00:00:00Z",
    sourceCommit: "6cf257a",
    shared: { riskControl: "CRISK", permissioning: "CPERM" },
    markets: [
      {
        marketId: "m1",
        displayName: "STA · test",
        underlying: { code: "STA", issuer: "GISSUER", sac: "CSAC", decimals: 7 },
        maturity: 1_800_000_000,
        contracts: {
          router: "CROUTER",
          oracle: "CORACLE",
          sy: "CSY",
          pt: "CPT",
          yt: "CYT",
          config: "CCONFIG",
          manager: "CMANAGER",
          pool: "CPOOL",
          recoveryEscrow: "CESCROW",
        },
      },
    ],
  },
  findings: [] as Finding[],
  /** Finding 1: an (artificial) state with no gate context and no blocker listed. */
  forceBaseNull: false,
  accounts: {} as Record<string, AccountState | "pending">,
  adapter: { restore: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), sign: vi.fn(), watch: vi.fn() },
  fetchMarketState: vi.fn(),
  fetchAccountState: vi.fn(),
  fetchMarketCompliance: vi.fn(),
  getLedgerClock: vi.fn(),
  simulateInvocation: vi.fn(),
  prepareReview: vi.fn(),
  executeReview: vi.fn(),
  prepareRestore: vi.fn(),
  executeRestore: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}))

vi.mock("sonner", () => ({ toast: mocks.toast, Toaster: () => null }))
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("@/hooks/use-manifest-findings", () => ({ useManifestFindings: () => mocks.findings }))
vi.mock("@/lib/protocol/wallet", () => ({ freighterAdapter: mocks.adapter }))
vi.mock("@/lib/protocol/horizon", () => ({ createHorizon: () => ({}) }))
vi.mock("@/lib/protocol/reader", async (orig) => ({ ...(await orig<object>()), createRpcReader: () => ({}) }))
vi.mock("@/lib/protocol/market-state", () => ({ fetchMarketState: mocks.fetchMarketState }))
vi.mock("@/lib/protocol/account-state", () => ({ fetchAccountState: mocks.fetchAccountState }))
vi.mock("@/lib/protocol/compliance", async (orig) => ({
  ...(await orig<object>()),
  fetchMarketCompliance: mocks.fetchMarketCompliance,
}))
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
vi.mock("@/hooks/use-gate-context", async (orig) => {
  const real = await orig<typeof import("@/hooks/use-gate-context")>()
  return {
    ...real,
    useGateContext: (marketId: string) => {
      const inputs = real.useGateContext(marketId)
      return mocks.forceBaseNull ? { ...inputs, base: null, unavailable: [] } : inputs
    },
  }
})
vi.mock("@/lib/protocol/gates", async (orig) => {
  const real = await orig<typeof import("@/lib/protocol/gates")>()
  return { ...real, evaluateGates: vi.fn(real.evaluateGates) }
})

import { ActionPanel } from "../actions/action-panel"
import type { PanelConfig } from "../actions/panel-config"
import { WalletContext, useWalletController } from "@/hooks/use-wallet"
import { resetSettingsStoreForTests } from "@/hooks/use-settings"
import { SIMULATION_DEBOUNCE_MS } from "@/hooks/use-simulation"
import { evaluateGates } from "@/lib/protocol/gates"
import { readLog } from "@/lib/app/local-log"

// ---------------------------------------------------------------------------------------------
// Panel configs used by the tests (Tasks 15–18 write the real ones).

const buyPt: PanelConfig = {
  action: "buy_pt",
  fields: [{ id: "amount", label: "SY to spend", unit: "SY" }],
  indicative: (ms, inputs) => (inputs.amount === undefined ? [] : [{ label: "PT price", value: showLive(ms.ptPrice, formatRate) }]),
  exact: (output) => (output.kind === "amount" ? [{ label: "PT received", value: `${formatAmount(output.value, 7, 7)} PT` }] : []),
  floors: { minOut: { label: "Minimum PT received", unit: "PT" } },
}
const buyYt: PanelConfig = {
  action: "buy_yt",
  fields: [{ id: "amount", label: "SY to spend", unit: "SY" }],
  indicative: () => [],
  exact: () => [],
  floors: { minOut: { label: "Minimum YT received", unit: "YT" }, maxNetCost: { label: "Maximum net cost", unit: "SY" } },
}
const claim: PanelConfig = { action: "claim_yield", fields: [], indicative: () => [], exact: () => [] }
const redeem: PanelConfig = {
  action: "redeem",
  fields: [
    { id: "amount", label: "PT to redeem", unit: "PT", optional: true },
    { id: "secondaryAmount", label: "YT to redeem", unit: "YT", optional: true },
  ],
  indicative: () => [],
  exact: () => [],
}

// ---------------------------------------------------------------------------------------------

const connected = (publicKey: string): WalletState => ({ status: "connected", publicKey, networkPassphrase: PASSPHRASE })
let watcher: ((s: { address: string; networkPassphrase: string }) => void) | undefined

function fakeReview(input: ActionInput): Review {
  const now = Date.now()
  return {
    origin: { type: "action", input },
    input,
    invocation: { contractId: "CROUTER", functionName: "swap_sy_for_pt", args: [] },
    unsignedXdr: "AAAA-unsigned",
    unsignedXdrHash: "fe".repeat(32),
    fee: "250000",
    preparedAtMs: now,
    expiresAtMs: now + 60_000,
    summary: {
      give: ["10 SY"],
      getAtLeast: ["99.5 PT (the minimum this transaction accepts)"],
      fees: ["Network fee: up to 0.025 XLM"],
      deadline: Number(input.deadline),
      validUntil: Math.floor(now / 1000) + 300,
    },
    callTree: ["Router.swap_sy_for_pt", "MarketPool.swap_sy_for_pt"],
  }
}

function fakeRestore(): RestoreReview {
  const now = Date.now()
  return { source: A, unsignedXdr: "AAAA-restore", unsignedXdrHash: "aa".repeat(32), fee: "12345", preparedAtMs: now, expiresAtMs: now + 60_000 }
}

function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWalletController()
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

function Harness({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return (
    <QueryClientProvider client={client}>
      <WalletProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </WalletProvider>
    </QueryClientProvider>
  )
}

/**
 * Advances the fake clock by `ms`, then lets promises and React Query notifications settle (its
 * notifications are 0 ms timers queued while ticking, which need the clock to move on to fire).
 */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
  }
}

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

/** The text of the info tip behind "More about <label>" (R2-65): a click opens it, Escape closes it. */
async function tipOf(label: string): Promise<string> {
  await user().click(screen.getByRole("button", { name: `More about ${label}` }))
  const text = (await screen.findByRole("tooltip")).textContent ?? ""
  await user().keyboard("{Escape}")
  return text
}
const reviewButton = (label = "Buy PT") => screen.getByRole("button", { name: `Review ${label}` }) as HTMLButtonElement
const signButton = () => screen.getByRole("button", { name: "Sign transaction" }) as HTMLButtonElement
/** The inline message under a field, or null. */
const inlineError = (label: string) => document.getElementById(`${screen.getByLabelText(label).id}-error`)?.textContent ?? null
/** The panel's "Signing is off" list (scoped to `root`, e.g. the dialog). */
const gateList = (root: HTMLElement = document.body) => within(root).getByText("Signing is off").parentElement!

async function renderPanel(config: PanelConfig = buyPt) {
  render(
    <Harness>
      <ActionPanel config={config} marketId="m1" />
    </Harness>,
  )
  // Wallet restore → ledger clock and market reads → compliance model → account read.
  for (let i = 0; i < 3; i++) await settle()
}

/** Types into a field, then waits past the 400 ms simulation debounce. */
async function enter(label: string, text: string) {
  const input = screen.getByLabelText(label)
  await user().clear(input)
  if (text) await user().type(input, text)
  await settle(400)
  await settle()
}

async function openReview() {
  await enter("SY to spend", "10")
  expect(reviewButton().disabled).toBe(false)
  await user().click(reviewButton())
  await settle()
  expect(screen.getByRole("dialog")).toBeTruthy()
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
  localStorage.clear()
  resetSettingsStoreForTests()
  mocks.findings = []
  mocks.forceBaseNull = false
  mocks.accounts = { [A]: accountState({ sy: live(SY_100), permYt: live(true) }) }
  mocks.adapter.restore.mockResolvedValue(connected(A))
  mocks.adapter.connect.mockResolvedValue(connected(A))
  mocks.adapter.sign.mockImplementation(async (xdr: string) => `${xdr}-signed`)
  mocks.adapter.watch.mockImplementation((cb: typeof watcher) => {
    watcher = cb
    return () => {}
  })
  mocks.fetchMarketState.mockResolvedValue(marketState())
  mocks.fetchAccountState.mockImplementation(async (_r: unknown, _h: unknown, _m: unknown, _id: string, address: string) => {
    const acc = mocks.accounts[address] ?? accountState()
    return acc === "pending" ? new Promise(() => {}) : acc
  })
  mocks.fetchMarketCompliance.mockResolvedValue(
    live({ kind: "sac", authRequired: true, authRevocable: true, clawbackEnabled: false, administrator: "GADMIN" }),
  )
  mocks.getLedgerClock.mockImplementation(async () => ({ sequence: 1, closeTime: LEDGER_TIME, readAtMs: Date.now() }))
  mocks.simulateInvocation.mockResolvedValue({ ok: true, retval: SY_100, latestLedger: 1, minResourceFee: "100" })
  mocks.prepareReview.mockImplementation(async ({ input }: { input: ActionInput }) => fakeReview(input))
  mocks.executeReview.mockResolvedValue({ hash: HASH, status: "SUCCESS", output: { kind: "amount", value: SY_100 } })
  mocks.prepareRestore.mockImplementation(async () => fakeRestore())
  mocks.executeRestore.mockResolvedValue({ hash: RESTORE_HASH, status: "SUCCESS" })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  watcher = undefined
})

// ---------------------------------------------------------------------------------------------

describe("ActionPanel — layout", () => {
  it("stacks the title above the description in a narrow panel (V5)", async () => {
    await renderPanel()
    const header = document.querySelector('[data-slot="card-header"]')
    // The card is a size container: below 32rem the header is a column, beside each other above.
    expect(header?.closest('[data-slot="card"]')?.className).toContain("@container")
    expect(header?.className).toMatch(/(^| )flex-col( |$)/)
    expect(header?.className).toContain("@lg:flex-row")
  })
})

describe("ActionPanel — gates", () => {
  it("sign button disabled while any gate fails: a stale oracle shows its reason", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ oracleFresh: live(false) }))
    await renderPanel()
    await enter("SY to spend", "10")
    expect(mocks.simulateInvocation).toHaveBeenCalled()
    expect(reviewButton().disabled).toBe(true)
    expect(screen.getByText(/The oracle price is stale/)).toBeTruthy()
  })

  it("offers the review once every gate passes and the exact quote is in", async () => {
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText("Every check passes.")).toBeTruthy()
    expect(reviewButton().disabled).toBe(false)
  })

  it("builds the gate context from the manifest findings (an error blocks everything)", async () => {
    mocks.findings = [{ severity: "error", message: "router is not a contract address" }]
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText(/deployment manifest for this network is invalid.*router is not a contract address/)).toBeTruthy()
    expect(reviewButton().disabled).toBe(true)
  })

  it("passes the market's PrincipalManager as managerId: its error #9 reads as a pause", async () => {
    mocks.simulateInvocation.mockResolvedValue({ ok: false, kind: "contract_error", contractId: "CMANAGER", code: 9, message: "Error(Contract, #9)" })
    await renderPanel(claim)
    await settle(400)
    expect(screen.getByText(/PrincipalManager is paused/)).toBeTruthy()
    expect(reviewButton("Claim yield").disabled).toBe(true)
  })
})

describe("ActionPanel — previews", () => {
  it("indicative preview without wallet is labelled Indicative", async () => {
    mocks.adapter.restore.mockResolvedValue({ status: "disconnected" })
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText("Indicative")).toBeTruthy()
    expect(screen.getByText("PT price").closest("dt")?.nextSibling?.textContent).toBe("0.9800")
    expect(screen.getByText(/No wallet is connected/)).toBeTruthy()
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
    expect(reviewButton().disabled).toBe(true)
  })

  it("exact preview from simulation shows the floor computed with 50 bps", async () => {
    const exact = vi.fn(buyPt.exact)
    await renderPanel({ ...buyPt, exact })
    await enter("SY to spend", "10")
    // Exact lines come from the simulation output and the input only, never from market reads.
    expect(Object.keys(exact.mock.calls.at(-1)![1]).sort()).toEqual(["guards", "inputs"])
    expect(screen.getByText("Exact (simulated)")).toBeTruthy()
    expect(screen.queryByText("Indicative")).toBeNull()
    expect(screen.getByText("PT received").closest("dt")?.nextSibling?.textContent).toBe("100 PT")
    // floor(100 PT · (10000 − 50) / 10000) = 99.5 PT
    expect(screen.getByText("Minimum PT received").closest("dt")?.nextSibling?.textContent).toBe("99.5 PT")
    expect(await tipOf("Minimum PT received")).toMatch(/0\.50% slippage tolerance/)
  })

  it("simulates the real call as the user, with open guards (R28: simulated before signing)", async () => {
    await renderPanel()
    await enter("SY to spend", "10")
    const call = mocks.simulateInvocation.mock.calls.at(-1)![0]
    expect(call.source).toBe(A)
    expect(call.invocation.contractId).toBe("CROUTER")
    expect(call.invocation.functionName).toBe("swap_sy_for_pt")
    expect(call.invocation.args.slice(0, 4)).toEqual([
      { type: "address", value: A },
      { type: "address", value: "CPOOL" },
      { type: "i128", value: 100_000_000n },
      { type: "i128", value: 0n },
    ])
  })

  it("R28: claim_yield is simulated too, with no guards", async () => {
    await renderPanel(claim)
    expect(screen.getByText(/Waiting for an exact quote/)).toBeTruthy()
    await settle(400)
    const call = mocks.simulateInvocation.mock.calls.at(-1)![0]
    expect(call.invocation.functionName).toBe("claim_yield")
    expect(call.invocation.args).toEqual([
      { type: "address", value: A },
      { type: "address", value: "CPOOL" },
    ])
  })

  it("debounces the indicative quote: one read once typing stops, none per keystroke (M1)", async () => {
    mocks.adapter.restore.mockResolvedValue({ status: "disconnected" })
    const quote = vi.fn(async () => [{ label: "Quoted PT out", value: "101 PT" }])
    await renderPanel({ ...buyPt, quote })
    await settle(400)
    quote.mockClear()
    await user().type(screen.getByLabelText("SY to spend"), "125")
    await settle(SIMULATION_DEBOUNCE_MS - 100)
    expect(quote).not.toHaveBeenCalled()
    await settle(100)
    expect(quote).toHaveBeenCalledTimes(1)
    expect(quote).toHaveBeenCalledWith(expect.anything(), { amount: 1_250_000_000n }, expect.anything())
    expect(await screen.findByText("Quoted PT out")).toBeTruthy()
  })

  it("never quotes an action that is not offered (M1, R47)", async () => {
    const quote = vi.fn(async () => [{ label: "LP received", value: "1 LP" }])
    await renderPanel({ ...buyPt, action: "add_liquidity_sy", fields: [{ id: "amount", label: "SY to add", unit: "SY" }], quote })
    await enter("SY to add", "10")
    await settle(SIMULATION_DEBOUNCE_MS)
    expect(quote).not.toHaveBeenCalled()
    expect(screen.queryByText("LP received")).toBeNull()
  })

  it("shows async quote lines as indicative", async () => {
    mocks.adapter.restore.mockResolvedValue({ status: "disconnected" })
    const quote = vi.fn(async () => [{ label: "Quoted PT out", value: "101 PT" }])
    await renderPanel({ ...buyPt, quote })
    await enter("SY to spend", "10")
    expect(await screen.findByText("Quoted PT out")).toBeTruthy()
    expect(screen.getByText("Indicative")).toBeTruthy()
    expect(quote).toHaveBeenCalledWith(expect.anything(), { amount: 100_000_000n }, expect.anything())
  })
})

describe("ActionPanel — market section (R38)", () => {
  const spot: NonNullable<PanelConfig["market"]> = (ms, ctx) => [
    { label: "Spot PT price", value: showLive(ms.ptPrice, formatRate) },
    ...(ctx.output?.kind === "amount" ? [{ label: "Exact PT seen", value: formatAmount(ctx.output.value, 7, 7) }] : []),
  ]
  const marketList = () => screen.getByText("Market (indicative)", { selector: "p" }).nextElementSibling as HTMLElement

  it("stays visible next to the exact quote, and gets the exact output for these inputs", async () => {
    const market = vi.fn(spot)
    await renderPanel({ ...buyPt, market })
    await enter("SY to spend", "10")
    expect(screen.getByText("Exact (simulated)")).toBeTruthy()
    expect(within(marketList()).getByText("Spot PT price").closest("dt")?.nextSibling?.textContent).toBe("0.9800")
    expect(within(marketList()).getByText("Exact PT seen").closest("dt")?.nextSibling?.textContent).toBe("100")
    const ctx = market.mock.calls.at(-1)![1]
    expect(ctx.inputs).toEqual({ amount: 100_000_000n })
    expect(ctx.output).toEqual({ kind: "amount", value: SY_100 })
    expect(ctx.account).toBeDefined()
    expect(ctx.ledgerTime).toBeGreaterThanOrEqual(LEDGER_TIME)
  })

  it("shows beside the indicative preview without a wallet, with no exact output", async () => {
    mocks.adapter.restore.mockResolvedValue({ status: "disconnected" })
    const market = vi.fn(spot)
    await renderPanel({ ...buyPt, market })
    await enter("SY to spend", "10")
    expect(screen.getByText("Indicative")).toBeTruthy()
    expect(within(marketList()).getByText("Spot PT price")).toBeTruthy()
    expect(within(marketList()).queryByText("Exact PT seen")).toBeNull()
    expect(market.mock.calls.at(-1)![1].output).toBeUndefined()
  })

  it("an input change drops the exact output from the section at once", async () => {
    await renderPanel({ ...buyPt, market: spot })
    await enter("SY to spend", "10")
    expect(within(marketList()).getByText("Exact PT seen")).toBeTruthy()
    await user().type(screen.getByLabelText("SY to spend"), "5")
    expect(within(marketList()).queryByText("Exact PT seen")).toBeNull()
  })

  it("can carry its own title, and shows Unavailable or the reason instead of a guess", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ ptPrice: down() }))
    const broken: PanelConfig["market"] = () => {
      throw new Error("oracle rate is not positive")
    }
    await renderPanel({ ...buyPt, market: spot, marketLabel: "Your yield (indicative)" })
    expect(screen.queryByText("Market (indicative)")).toBeNull()
    const list = screen.getByText("Your yield (indicative)", { selector: "p" }).nextElementSibling as HTMLElement
    expect(within(list).getByText("Spot PT price").closest("dt")?.nextSibling?.textContent).toBe("Unavailable")
    cleanup()
    await renderPanel({ ...buyPt, market: broken })
    expect(within(marketList()).getByText("Preview unavailable").closest("dt")?.nextSibling?.textContent).toBe("oracle rate is not positive")
  })

  it("is not shown without live market data", async () => {
    mocks.fetchMarketState.mockRejectedValue(new Error("rpc down"))
    await renderPanel({ ...buyPt, market: spot })
    expect(screen.queryByText("Market (indicative)")).toBeNull()
  })
})

describe("ActionPanel — amount input (Review Focus 3)", () => {
  it.each([
    ["more than 7 decimals", "1.12345678", /at most 7 digits after the point/],
    ["an exponent", "1e3", /Exponents like 1e3 are not accepted/],
    ["a negative amount", "-1", /Amounts cannot be negative/],
    ["more than the balance", "100.0000001", /More than your balance: you have 100 SY/],
  ])("amount input matrix: %s is refused inline with signing off", async (_case, text, message) => {
    await renderPanel()
    await enter("SY to spend", text)
    expect(inlineError("SY to spend")).toMatch(message)
    expect(within(gateList()).getByText(message)).toBeTruthy()
    expect(within(gateList()).queryByText(/Waiting for an exact quote/)).toBeNull()
    expect(screen.getByLabelText("SY to spend").getAttribute("aria-invalid")).toBe("true")
    expect(reviewButton().disabled).toBe(true)
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
  })

  it("amount input matrix: an empty field is refused inline with signing off", async () => {
    await renderPanel()
    await enter("SY to spend", "5")
    await enter("SY to spend", "")
    expect(inlineError("SY to spend")).toBe("Enter an amount.")
    expect(within(gateList()).getByText("Enter an amount.")).toBeTruthy()
    expect(reviewButton().disabled).toBe(true)
  })

  it("amount input matrix: MAX with a zero balance is refused inline with signing off", async () => {
    mocks.accounts[A] = accountState({ sy: live(0n) })
    await renderPanel()
    await user().click(screen.getByRole("button", { name: "Max SY to spend" }))
    await settle(400)
    expect((screen.getByLabelText("SY to spend") as HTMLInputElement).value).toBe("0")
    expect(inlineError("SY to spend")).toBe("You have no SY to use.")
    expect(within(gateList()).getByText("You have no SY to use.")).toBeTruthy()
    expect(reviewButton().disabled).toBe(true)
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
  })

  it("an untouched empty field names the amount as the reason, not the quote", async () => {
    await renderPanel()
    expect(inlineError("SY to spend")).toBeNull()
    expect(within(gateList()).getByText("Enter an amount.")).toBeTruthy()
    expect(within(gateList()).queryByText(/Waiting for an exact quote/)).toBeNull()
    expect(reviewButton().disabled).toBe(true)
  })

  it("incomplete amounts name the amount as the reason, not the quote (redeem with both sides empty)", async () => {
    await renderPanel(redeem)
    expect(within(gateList()).getByText("Enter an amount of PT or YT to redeem, greater than zero.")).toBeTruthy()
    expect(within(gateList()).queryByText(/Waiting for an exact quote/)).toBeNull()
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
  })

  it("MAX fills the balance this action spends (R24), formatted exactly", async () => {
    mocks.accounts[A] = accountState({ sy: live(123_456_789n), underlying: live(999n) })
    await renderPanel()
    expect(screen.getByText("Balance: 12.3456789 SY")).toBeTruthy()
    await user().click(screen.getByRole("button", { name: "Max SY to spend" }))
    expect((screen.getByLabelText("SY to spend") as HTMLInputElement).value).toBe("12.3456789")
  })
})

describe("ActionPanel — owner binding (Review Focus 2)", () => {
  it("discards review on account change: the dialog closes without signing", async () => {
    await renderPanel()
    await openReview()
    mocks.adapter.restore.mockResolvedValue(connected(B))
    act(() => watcher!({ address: B, networkPassphrase: PASSPHRASE }))
    await settle()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(mocks.executeReview).not.toHaveBeenCalled()
    expect(mocks.adapter.sign).not.toHaveBeenCalled()
  })

  it("discards the review on a network change", async () => {
    await renderPanel()
    await openReview()
    mocks.adapter.restore.mockResolvedValue({ status: "wrong_network", publicKey: A, actualPassphrase: "Public", expectedPassphrase: PASSPHRASE })
    act(() => watcher!({ address: A, networkPassphrase: "Public" }))
    await settle()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it("discards the review when the slippage setting changes (here from another tab)", async () => {
    await renderPanel()
    await openReview()
    act(() => {
      localStorage.setItem("pp-settings", JSON.stringify({ slippageBps: 100, deadlineSeconds: 300 }))
      window.dispatchEvent(new StorageEvent("storage", { key: "pp-settings" }))
    })
    await settle()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(mocks.executeReview).not.toHaveBeenCalled()
    // The floor is re-derived at the new tolerance: floor(100 PT · 9900 / 10000).
    expect(screen.getByText("Minimum PT received").closest("dt")?.nextSibling?.textContent).toBe("99 PT")
  })

  it("the signer is refused before Freighter opens if it is not the connected account", async () => {
    mocks.executeReview.mockImplementation(async ({ sign }: { sign: (x: string, p: string, s: string) => Promise<string> }) => {
      await sign("AAAA-unsigned", PASSPHRASE, B)
      return { hash: HASH, status: "SUCCESS" }
    })
    await renderPanel()
    await openReview()
    await user().click(signButton())
    await settle()
    expect(mocks.adapter.sign).not.toHaveBeenCalled()
    expect(screen.getByText(/not the one this was prepared for. Nothing was signed/)).toBeTruthy()
    expect(readLog(A)).toEqual([])
  })

  it("never uses account data read for another address", async () => {
    mocks.accounts[B] = "pending"
    await renderPanel()
    expect(screen.getByText("Balance: 100 SY")).toBeTruthy()
    mocks.adapter.restore.mockResolvedValue(connected(B))
    act(() => watcher!({ address: B, networkPassphrase: PASSPHRASE }))
    await settle()
    expect(screen.queryByText("Balance: 100 SY")).toBeNull()
    expect((screen.getByRole("button", { name: "Max SY to spend" }) as HTMLButtonElement).disabled).toBe(true)
    await enter("SY to spend", "10")
    expect(screen.getByText(/Your account \(balances and deposit cap\) has not been read yet/)).toBeTruthy()
    expect(reviewButton().disabled).toBe(true)
  })

  it("an input change discards the simulation at once", async () => {
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText("Exact (simulated)")).toBeTruthy()
    await user().type(screen.getByLabelText("SY to spend"), "0")
    // Before the debounce fires: the quote for 10 SY is not shown for 100 SY.
    expect(screen.queryByText("Exact (simulated)")).toBeNull()
    expect(reviewButton().disabled).toBe(true)
    await settle(400)
    expect(mocks.simulateInvocation.mock.calls.at(-1)![0].invocation.args[2]).toEqual({ type: "i128", value: SY_100 })
  })
})

describe("ActionPanel — review lifecycle", () => {
  it("prepares with the derived floor and a ledger-time deadline, and shows the review", async () => {
    await renderPanel()
    await openReview()
    const { input } = mocks.prepareReview.mock.calls[0][0] as { input: ActionInput }
    expect(input.guards).toEqual({ minOut: 995_000_000n })
    expect(input.source).toBe(A)
    expect(input.amount).toBe(100_000_000n)
    const base = BigInt(LEDGER_TIME + 300)
    expect(input.deadline >= base && input.deadline <= base + 5n).toBe(true)

    const dialog = within(screen.getByRole("dialog"))
    expect(dialog.getByText("10 SY")).toBeTruthy()
    expect(dialog.getByText(/99\.5 PT \(the minimum/)).toBeTruthy()
    expect(dialog.getByText("Network fee: up to 0.025 XLM")).toBeTruthy()
    expect(dialog.getByText("Deadline")).toBeTruthy()
    const details = dialog.getByText("Technical details").closest("details")!
    expect(details.open).toBe(false)
    expect(within(details).getByText("Router.swap_sy_for_pt")).toBeTruthy()
    expect(within(details).getByText("fe".repeat(32))).toBeTruthy()
  })

  it("R31: executes the exact object prepareReview returned", async () => {
    await renderPanel()
    await openReview()
    const prepared = await mocks.prepareReview.mock.results[0].value
    await user().click(signButton())
    await settle()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
    expect(mocks.executeReview.mock.calls[0][0].review).toBe(prepared)
  })

  it("expired review re-prepares after 60 s", async () => {
    await renderPanel()
    await openReview()
    const first = await mocks.prepareReview.mock.results[0].value
    await settle(60_000)
    expect(mocks.prepareReview).toHaveBeenCalledTimes(2)
    const second = await mocks.prepareReview.mock.results[1].value
    expect(second).not.toBe(first)
    await user().click(signButton())
    await settle()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
    expect(mocks.executeReview.mock.calls[0][0].review).toBe(second)
  })

  it("signing with under 20 s left prepares again instead of opening Freighter", async () => {
    await renderPanel()
    await openReview()
    const first = await mocks.prepareReview.mock.results[0].value
    await settle(45_000)
    expect(mocks.prepareReview).toHaveBeenCalledTimes(1)
    await user().click(signButton())
    await settle()
    expect(mocks.prepareReview).toHaveBeenCalledTimes(2)
    expect(mocks.executeReview).not.toHaveBeenCalled()
    expect(mocks.adapter.sign).not.toHaveBeenCalled()
    const second = await mocks.prepareReview.mock.results[1].value
    expect(second).not.toBe(first)
    await user().click(signButton())
    await settle()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
    expect(mocks.executeReview.mock.calls[0][0].review).toBe(second)
  })

  it("sign stays off without a gate context, even when no blocker is listed", async () => {
    await renderPanel()
    await openReview()
    expect(signButton().disabled).toBe(false)
    mocks.forceBaseNull = true
    await settle(1_000)
    expect(within(screen.getByRole("dialog")).queryByText("Signing is off")).toBeNull()
    expect(signButton().disabled).toBe(true)
    act(() => signButton().click())
    await settle()
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it("a balance that drops under the amount while the review is open is the reason shown", async () => {
    await renderPanel()
    await openReview()
    mocks.accounts[A] = accountState({ sy: live(50_000_000n), permYt: live(true) })
    await settle(6_000)
    const dialog = screen.getByRole("dialog")
    expect(within(gateList(dialog)).getByText("More than your balance: you have 5 SY.")).toBeTruthy()
    expect(within(gateList(dialog)).queryByText(/Waiting for an exact quote/)).toBeNull()
    expect(signButton().disabled).toBe(true)
  })

  it("double submit is impossible: the sign button is disabled while pending", async () => {
    let finish: (v: unknown) => void = () => {}
    mocks.executeReview.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    await renderPanel()
    await openReview()
    // Two clicks in one batch, before React re-renders the button as disabled.
    const button = signButton()
    act(() => {
      button.click()
      button.click()
    })
    fireEvent.click(signButton())
    await settle()
    expect(signButton().disabled).toBe(true)
    fireEvent.click(signButton())
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
    finish({ hash: HASH, status: "SUCCESS" })
    await settle()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
  })

  it("a failed attempt discards the review: it is never executed twice", async () => {
    mocks.executeReview.mockRejectedValue(new Error("User declined the request"))
    await renderPanel()
    await openReview()
    await user().click(signButton())
    await settle()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByText("Buy PT was not sent.")).toBeTruthy()
    expect(screen.getByText("User declined the request")).toBeTruthy()
    await user().click(reviewButton())
    await settle()
    expect(mocks.prepareReview).toHaveBeenCalledTimes(2)
    expect(mocks.executeReview).toHaveBeenCalledTimes(1)
  })

  it("closing the dialog discards the review", async () => {
    await renderPanel()
    await openReview()
    await user().click(screen.getByRole("button", { name: "Cancel" }))
    await settle()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(mocks.executeReview).not.toHaveBeenCalled()
  })

  it("a gate that fails while the review is open turns signing off", async () => {
    await renderPanel()
    await openReview()
    mocks.fetchMarketState.mockResolvedValue(marketState({ poolPaused: live(true) }))
    await settle(6_000)
    expect(within(screen.getByRole("dialog")).getByText(/The pool is paused/)).toBeTruthy()
    expect(signButton().disabled).toBe(true)
  })

  it("guards that refuse are a blocker, never passed to prepare (buy_yt net cost ≤ 0)", async () => {
    mocks.simulateInvocation.mockResolvedValue({ ok: true, retval: [500_000_000n, 100_000_000n], latestLedger: 1, minResourceFee: "1" })
    await renderPanel(buyYt)
    await enter("SY to spend", "10")
    expect(screen.getByText("YT price is not positive — buying YT is not offered")).toBeTruthy()
    expect(reviewButton("Buy YT").disabled).toBe(true)
    expect(mocks.prepareReview).not.toHaveBeenCalled()
  })
})

describe("ActionPanel — results", () => {
  it("toasts success with a stellar.expert link, logs it per account and refreshes the data", async () => {
    await renderPanel()
    await openReview()
    const marketReads = mocks.fetchMarketState.mock.calls.length
    const accountReads = mocks.fetchAccountState.mock.calls.length
    await user().click(signButton())
    await settle()
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    const [title, options] = mocks.toast.success.mock.calls[0]
    expect(title).toBe("Buy PT confirmed.")
    const { container } = render(<>{options.description}</>)
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/tx/${HASH}`)
    expect(screen.getAllByText(HASH).length).toBeGreaterThan(0)
    expect(readLog(A)).toEqual([expect.objectContaining({ hash: HASH, action: "buy_pt", marketId: "m1", account: A, status: "SUCCESS" })])
    expect(readLog(B)).toEqual([])
    expect(mocks.fetchMarketState.mock.calls.length).toBeGreaterThan(marketReads)
    expect(mocks.fetchAccountState.mock.calls.length).toBeGreaterThan(accountReads)
  })

  it("the success notice says what happened, from the config's result message", async () => {
    const result = vi.fn((output: { kind: string; value?: bigint }, ctx: { input: ActionInput }) =>
      output.kind === "amount" && output.value !== undefined
        ? `You bought ${formatAmount(output.value, 7, 7)} PT for ${formatAmount(ctx.input.amount, 7, 7)} SY.`
        : "",
    )
    await renderPanel({ ...buyPt, result } as PanelConfig)
    await openReview()
    await user().click(signButton())
    await settle()
    expect(mocks.toast.success.mock.calls[0][0]).toBe("You bought 100 PT for 10 SY.")
    expect(screen.getByText("You bought 100 PT for 10 SY.")).toBeTruthy()
  })

  it("falls back to \"confirmed\" when the result message cannot be worked out", async () => {
    const result = () => {
      throw new Error("bad output")
    }
    await renderPanel({ ...buyPt, result })
    await openReview()
    await user().click(signButton())
    await settle()
    expect(mocks.toast.success.mock.calls[0][0]).toBe("Buy PT confirmed.")
  })

  it("a failed transaction keeps and shows its hash", async () => {
    mocks.executeReview.mockResolvedValue({ hash: HASH, status: "FAILED" })
    await renderPanel()
    await openReview()
    await user().click(signButton())
    await settle()
    expect(mocks.toast.error).toHaveBeenCalled()
    expect(screen.getByText("Buy PT failed on-chain.")).toBeTruthy()
    expect(screen.getByText(/look it up by its hash/)).toBeTruthy()
    expect(screen.getByText(HASH)).toBeTruthy()
    expect(readLog(A)[0]).toEqual(expect.objectContaining({ hash: HASH, status: "FAILED" }))
  })

  it("a confirmed transaction clears the form, as on first load: no amount, no inline error", async () => {
    await renderPanel()
    await openReview()
    await user().click(signButton())
    await settle()
    expect(screen.getByText("Buy PT confirmed.")).toBeTruthy()
    expect((screen.getByLabelText("SY to spend") as HTMLInputElement).value).toBe("")
    expect(inlineError("SY to spend")).toBeNull()
    expect(screen.getByLabelText("SY to spend").getAttribute("aria-invalid")).toBeNull()
  })

  it("a submitted transaction whose result is not known yet clears the form too, so it is not sent twice", async () => {
    mocks.executeReview.mockResolvedValue({ hash: HASH, status: "NOT_FOUND" })
    await renderPanel()
    await openReview()
    await user().click(signButton())
    await settle()
    expect(screen.getByText("Buy PT: result not known yet.")).toBeTruthy()
    expect((screen.getByLabelText("SY to spend") as HTMLInputElement).value).toBe("")
  })

  it("a failed transaction keeps the amounts, so they can be corrected and sent again", async () => {
    mocks.executeReview.mockResolvedValue({ hash: HASH, status: "FAILED" })
    await renderPanel()
    await openReview()
    await user().click(signButton())
    await settle()
    expect(screen.getByText("Buy PT failed on-chain.")).toBeTruthy()
    expect((screen.getByLabelText("SY to spend") as HTMLInputElement).value).toBe("10")
  })

  it("a failed transaction shows its cause, and logs it (R49)", async () => {
    const reason = "Cause: the contract call failed. Nothing was taken except the network fee."
    mocks.executeReview.mockResolvedValue({ hash: HASH, status: "FAILED", reason })
    await renderPanel()
    await openReview()
    await user().click(signButton())
    await settle()
    expect(screen.getByText("Buy PT failed on-chain.")).toBeTruthy()
    expect(screen.getByText(`${reason} Look it up by its hash for the details.`)).toBeTruthy()
    expect(readLog(A)[0]).toEqual(expect.objectContaining({ hash: HASH, status: "FAILED", reason }))
  })
})

describe("ActionPanel — archived data (Review Focus 5)", () => {
  it("restore-required offers a restore first, then simulates and prepares again", async () => {
    mocks.simulateInvocation.mockResolvedValueOnce({ ok: false, kind: "restore_required" })
    mocks.executeRestore.mockImplementation(async ({ sign }: { sign: (x: string, p: string, s: string) => Promise<string> }) => {
      await sign("AAAA-restore", PASSPHRASE, A)
      return { hash: RESTORE_HASH, status: "SUCCESS" }
    })
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText("Some contract data has expired — restore it first (one extra signature)")).toBeTruthy()
    expect(reviewButton().disabled).toBe(true)

    await user().click(screen.getByRole("button", { name: "Restore contract data" }))
    await settle()
    expect(mocks.prepareRestore).toHaveBeenCalledTimes(1)
    const restoreArgs = mocks.prepareRestore.mock.calls[0][0]
    expect(restoreArgs.source).toBe(A)
    expect(restoreArgs.invocation.functionName).toBe("swap_sy_for_pt")
    expect(screen.getByText("Network fee: up to 0.0012345 XLM")).toBeTruthy()

    const simulationsBefore = mocks.simulateInvocation.mock.calls.length
    await user().click(screen.getByRole("button", { name: "Sign restore" }))
    await settle()
    await settle()
    const prepared = await mocks.prepareRestore.mock.results[0].value
    expect(mocks.executeRestore.mock.calls[0][0].restore).toBe(prepared)
    expect(mocks.adapter.sign).toHaveBeenCalledWith("AAAA-restore", PASSPHRASE, A)
    expect(mocks.simulateInvocation.mock.calls.length).toBeGreaterThan(simulationsBefore)
    expect(mocks.prepareReview).toHaveBeenCalledTimes(1)
    expect(signButton().disabled).toBe(false)
  })
})

describe("ActionPanel — unavailable data (Review Focus 1)", () => {
  it("unavailable values show unavailable: a stale market read hides old values and blocks", async () => {
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText("100 PT")).toBeTruthy()
    mocks.fetchMarketState.mockRejectedValue(new Error("429 Too Many Requests"))
    await settle(6_000)
    expect(screen.getAllByText(/Unavailable — last update failed/).length).toBeGreaterThan(0)
    expect(screen.queryByText("100 PT")).toBeNull()
    expect(reviewButton().disabled).toBe(true)
  })

  it("unavailable values show unavailable: a needed read that failed names itself", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ oracleFresh: down("rpc down") }))
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText(/Could not read the oracle's freshness \(rpc down\)/)).toBeTruthy()
    expect(reviewButton().disabled).toBe(true)
  })

  it("unavailable values show unavailable in the indicative preview", async () => {
    mocks.adapter.restore.mockResolvedValue({ status: "disconnected" })
    mocks.fetchMarketState.mockResolvedValue(marketState({ ptPrice: down() }))
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText("PT price").closest("dt")?.nextSibling?.textContent).toBe("Unavailable")
  })

  it("R32: waits for the network clock without evaluating the gates", async () => {
    mocks.getLedgerClock.mockImplementation(() => new Promise(() => {}))
    await renderPanel()
    await enter("SY to spend", "10")
    expect(screen.getByText(/Waiting for the network clock/)).toBeTruthy()
    expect(evaluateGates).not.toHaveBeenCalled()
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
    expect(reviewButton().disabled).toBe(true)
  })

  it("R35: a stale account read is unavailable for gating, and shown as such", async () => {
    await renderPanel()
    await enter("SY to spend", "10")
    expect(reviewButton().disabled).toBe(false)
    mocks.fetchAccountState.mockRejectedValue(new Error("429"))
    await settle(6_000)
    expect(screen.getByText(/your account data could not be refreshed/)).toBeTruthy()
    expect(reviewButton().disabled).toBe(true)
  })
})
