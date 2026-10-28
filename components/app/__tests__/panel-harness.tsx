/**
 * Rendering helpers for the action-tab tests (Tasks 15–18). Import it after the test file's
 * `vi.mock` calls (Vitest hoists those above every import), so the app modules it loads are mocked.
 */
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { vi } from "vitest"
import type { ActionInput } from "@/lib/protocol/actions"
import type { Review } from "@/lib/protocol/review"
import type { WalletState } from "@/lib/protocol/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WalletContext, useWalletController } from "@/hooks/use-wallet"
import { resetSettingsStoreForTests } from "@/hooks/use-settings"
import { accountState, LEDGER_TIME, live, marketState } from "./fixtures"
import { A, PASSPHRASE, type PanelMocks } from "./panel-mocks"

export const HASH = "ab".repeat(32)

export const connected = (publicKey: string): WalletState => ({ status: "connected", publicKey, networkPassphrase: PASSPHRASE })

function WalletProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWalletController()
  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
}

export function Harness({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }))
  return (
    <QueryClientProvider client={client}>
      <WalletProvider>
        <TooltipProvider>{children}</TooltipProvider>
      </WalletProvider>
    </QueryClientProvider>
  )
}

/** Advances the fake clock, then lets promises and React Query's 0 ms notifications settle. */
export async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
  }
}

export const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime })

/** Renders `ui`, then waits for wallet restore, ledger clock, market, compliance and account reads. */
export async function renderUi(ui: React.ReactElement) {
  render(<Harness>{ui}</Harness>)
  for (let i = 0; i < 3; i++) await settle()
}

/** Types into a field, then waits past the 400 ms simulation debounce and the quote reads. */
export async function enter(label: string, text: string) {
  const input = screen.getByLabelText(label)
  await user().clear(input)
  if (text) await user().type(input, text)
  await settle(400)
  await settle()
}

/** Selects a tab (outer or inner) by its name. */
export async function openTab(name: string) {
  await user().click(screen.getByRole("tab", { name }))
  await settle()
}

export const reviewButton = (label: string) => screen.getByRole("button", { name: `Review ${label}` }) as HTMLButtonElement

/** The panel's "Signing is off" list. */
export const gateList = () => screen.getByText("Signing is off").parentElement!

/** The value shown beside a preview label, or the error if the label is missing. */
export const valueOf = (label: string | RegExp) => screen.getByText(label).nextSibling?.textContent ?? null

/** The rows of the preview section headed `heading` ("Indicative", "Exact (simulated)", "Market (indicative)"…). */
export function section(heading: string): HTMLElement {
  const title = screen.getByText(heading, { selector: "p" })
  const list = title.nextElementSibling
  if (!(list instanceof HTMLElement)) throw new Error(`No preview list under "${heading}"`)
  return list
}

export const valueIn = (heading: string, label: string | RegExp) => within(section(heading)).getByText(label).nextSibling?.textContent ?? null

function fakeReview(input: ActionInput): Review {
  const now = Date.now()
  return {
    input,
    invocation: { contractId: "CROUTER", functionName: "x", args: [] },
    unsignedXdr: "AAAA-unsigned",
    unsignedXdrHash: "fe".repeat(32),
    fee: "250000",
    preparedAtMs: now,
    expiresAtMs: now + 60_000,
    summary: {
      give: ["x"],
      getAtLeast: ["y"],
      fees: ["Network fee: up to 0.025 XLM"],
      deadline: Number(input.deadline),
      validUntil: Math.floor(now / 1000) + 300,
    },
    callTree: ["Router.x"],
  }
}

/** Default answers: a connected, permitted account; a healthy market ten days before maturity. */
export function installDefaults(mocks: PanelMocks) {
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
  mocks.reads = {}
  mocks.accounts = { [A]: accountState({ permYt: live(true) }) }
  mocks.adapter.restore.mockResolvedValue(connected(A))
  mocks.adapter.connect.mockResolvedValue(connected(A))
  mocks.adapter.sign.mockImplementation(async (xdr: string) => `${xdr}-signed`)
  mocks.adapter.watch.mockImplementation(() => () => {})
  mocks.fetchMarketState.mockResolvedValue(marketState())
  mocks.fetchAccountState.mockImplementation(async (_r: unknown, _h: unknown, _m: unknown, _id: string, address: string) => {
    const acc = mocks.accounts[address] ?? accountState()
    return acc === "pending" ? new Promise(() => {}) : acc
  })
  mocks.fetchMarketCompliance.mockResolvedValue(
    live({ kind: "sac", authRequired: true, authRevocable: true, clawbackEnabled: false, administrator: "GADMIN" }),
  )
  mocks.getLedgerClock.mockImplementation(async () => ({ sequence: 1, closeTime: LEDGER_TIME, readAtMs: Date.now() }))
  mocks.simulateInvocation.mockResolvedValue({ ok: false, kind: "rpc_error", message: "no simulation answer set in this test" })
  mocks.read.mockImplementation(async ({ functionName, args = [] }: { functionName: string; args?: { type: string; value: unknown }[] }) => {
    if (!(functionName in mocks.reads)) throw new Error(`no read answer for ${functionName}`)
    const answer = mocks.reads[functionName]
    const value = typeof answer === "function" ? (answer as (a: typeof args) => unknown)(args) : answer
    if (value instanceof Error) throw value
    return { value, latestLedger: 100, minResourceFee: "100" }
  })
  mocks.prepareReview.mockImplementation(async ({ input }: { input: ActionInput }) => fakeReview(input))
  mocks.executeReview.mockResolvedValue({ hash: HASH, status: "SUCCESS" })
}

/** The simulation returns `retval` for every call. */
export function simulateReturns(mocks: PanelMocks, retval: unknown) {
  mocks.simulateInvocation.mockResolvedValue({ ok: true, retval, latestLedger: 1, minResourceFee: "100" })
}

/** No wallet: indicative previews only. */
export function disconnect(mocks: PanelMocks) {
  mocks.adapter.restore.mockResolvedValue({ status: "disconnected" })
}

export function teardown() {
  vi.clearAllMocks()
  vi.useRealTimers()
}

export { marketState }
