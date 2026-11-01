import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "@/lib/protocol/manifest"
import type { AccruedFees, AccountRoles, MarketRoles, SharedRoles } from "@/lib/protocol/roles"
import type { ManagerReview } from "@/lib/protocol/review"
import type { ManagerCall } from "@/lib/protocol/manager-calls"
import type { Live, Market, WalletState } from "@/lib/protocol/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { down, live, LEDGER_TIME, marketState } from "./fixtures"

const contractAt = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
const ME = Keypair.random().publicKey()
const base = parseManifest(structuredClone(testnetJson))
const A: Market = { ...base.markets[0], marketId: "market-a", displayName: "USDY Dec 2026" }
const B: Market = {
  ...A,
  marketId: "market-b",
  displayName: "USDY Mar 2027",
  contracts: { ...A.contracts, pool: contractAt(21), sy: contractAt(22), manager: contractAt(23), config: contractAt(24) },
}
const manifest = { ...base, markets: [A, B] }

const mocks = vi.hoisted(() => ({
  wallet: undefined as unknown as WalletState,
  roles: { markets: new Map(), shared: undefined, testAssetIssuer: undefined } as AccountRoles,
  rolesPending: false,
  fees: {} as Record<string, Live<AccruedFees>>,
  ms: {} as Record<string, unknown>,
  prepareManager: vi.fn(),
  execute: vi.fn(),
  toast: vi.fn(),
}))

vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => manifest }))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))
vi.mock("@/hooks/use-manage", () => ({
  useMyRoles: () => ({ account: mocks.wallet.status === "connected" ? mocks.wallet.publicKey : null, roles: mocks.roles, pending: mocks.rolesPending }),
  useAccruedFees: (id: string) => ({ data: mocks.fees[id] }),
}))
vi.mock("@/hooks/use-market-state", () => ({
  useMarketStates: (ids: string[]) => ids.map((id) => ({ data: mocks.ms[id], isPending: false, stale: false })),
}))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => ({ ledgerTime: LEDGER_TIME, sequence: 1, isError: false }) }))
vi.mock("@/hooks/use-manifest-findings", () => ({ useManifestFindings: () => [] }))
vi.mock("@/hooks/use-execute", () => ({
  useExecute: () => ({ prepareManager: mocks.prepareManager, execute: mocks.execute, pending: false }),
}))
vi.mock("@/components/app/actions/tx-feedback", () => ({ showTxToast: mocks.toast }))
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })

import { MyMarkets } from "../manage/my-markets"

const yes = live(true)
const no = live(false)
function marketRoles(m: Market, over: Partial<{ issuer: Live<boolean>; creator: Live<boolean>; protocolAdmin: Live<boolean>; pool: Live<boolean>; sy: Live<boolean>; manager: Live<boolean> }> = {}): MarketRoles {
  return {
    sac: m.underlying.sac,
    contracts: { pool: m.contracts.pool, sy: m.contracts.sy, manager: m.contracts.manager },
    issuer: over.issuer ?? no,
    creator: over.creator ?? no,
    protocolAdmin: over.protocolAdmin ?? no,
    contractAdmin: { pool: over.pool ?? no, sy: over.sy ?? no, manager: over.manager ?? no },
  }
}
const shared: SharedRoles = { routerAdmin: no, riskControlAdmin: no, permissioningAdmin: no }
const E7 = 10_000_000n
const feesOf = (p: [bigint, bigint], m: [bigint, bigint]): Live<AccruedFees> =>
  live({ protocol: p[0] + m[0], creator: p[1] + m[1], pool: { protocol: p[0], creator: p[1] }, manager: { protocol: m[0], creator: m[1] } })

function setRoles(a: MarketRoles | undefined, b: MarketRoles | undefined) {
  const markets = new Map<string, MarketRoles>()
  if (a) markets.set(A.marketId, a)
  if (b) markets.set(B.marketId, b)
  mocks.roles = { markets, shared }
}
const noInvalid: Parameters<typeof MyMarkets>[0]["invalid"] = { status: "ok", rows: [] }
const show = (invalid: Parameters<typeof MyMarkets>[0]["invalid"] = noInvalid) => render(<TooltipProvider><MyMarkets invalid={invalid} /></TooltipProvider>)

function managerReview(call: ManagerCall): ManagerReview {
  const now = Date.now()
  return {
    origin: { type: "manager", call },
    invocation: call.invocation,
    unsignedXdr: "AAAA",
    unsignedXdrHash: `sha256:${call.invocation.contractId.slice(0, 6)}`,
    fee: "100",
    preparedAtMs: now,
    expiresAtMs: now + 60_000,
    summary: { give: [], getAtLeast: [], fees: ["Network fee: up to 0.00001 XLM"], validUntil: Math.floor(now / 1000) + 300 },
    callTree: [`X.${call.invocation.functionName}`],
  }
}

beforeEach(() => {
  mocks.wallet = { status: "connected", publicKey: ME, networkPassphrase: manifest.networkPassphrase }
  mocks.rolesPending = false
  setRoles(marketRoles(A, { pool: yes }), marketRoles(B))
  mocks.fees = { [A.marketId]: feesOf([0n, 0n], [0n, 0n]), [B.marketId]: feesOf([0n, 0n], [0n, 0n]) }
  mocks.ms = { [A.marketId]: marketState(), [B.marketId]: marketState() }
  mocks.prepareManager.mockReset().mockImplementation(async (call: ManagerCall) => managerReview(call))
  mocks.execute.mockReset().mockResolvedValue({ status: "SUCCESS", hash: "abc" })
  mocks.toast.mockReset()
})

describe("My markets / All", () => {
  it("My markets shows only markets where I hold a role; All shows the rest read-only", async () => {
    show()
    expect(screen.getByText("USDY Dec 2026")).toBeTruthy()
    expect(screen.queryByText("USDY Mar 2027")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: /^All/ }))
    const other = screen.getByText("USDY Mar 2027").closest("article") as HTMLElement
    expect(other).toBeTruthy()
    expect(within(other).queryByRole("button")).toBeNull()
    // The market where I am admin keeps its actions in the All view too.
    expect(screen.getByRole("button", { name: "Pause pool" })).toBeTruthy()
  })

  it("asks to connect a wallet when none is", () => {
    mocks.wallet = { status: "disconnected" }
    show()
    expect(screen.getByText(/Connect your wallet to see the markets you manage/)).toBeTruthy()
  })

  it("says so when no market is managed by this wallet", () => {
    setRoles(marketRoles(A), marketRoles(B))
    show()
    expect(screen.getByText(/does not hold a role on any listed market/)).toBeTruthy()
  })
})

describe("actions per role", () => {
  it("Pause for the contract admin, of the contracts it administers only", () => {
    setRoles(marketRoles(A, { pool: yes, sy: no }), marketRoles(B))
    show()
    expect(screen.getByRole("button", { name: "Pause pool" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Pause SY wrapper" })).toBeNull()
    expect(screen.queryByRole("button", { name: /Claim/ })).toBeNull()
  })

  it("Unpause when the pool is paused", () => {
    mocks.ms[A.marketId] = marketState({ poolPaused: live(true) })
    show()
    expect(screen.getByRole("button", { name: "Unpause pool" })).toBeTruthy()
  })

  it("a flag that cannot be read turns the switch off and says why", () => {
    mocks.ms[A.marketId] = marketState({ poolPaused: down("rpc 429") })
    show()
    const button = screen.getByRole("button", { name: "Pause pool" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getAllByText(/Unavailable/).length).toBeGreaterThan(0)
  })

  it("Claim creator fees for the creator, Claim protocol fees (to treasury) for the protocol admin, each only to its role", () => {
    setRoles(marketRoles(A, { creator: yes }), marketRoles(B, { protocolAdmin: yes }))
    mocks.fees = { [A.marketId]: feesOf([1n * E7, 3n * E7], [2n * E7, 4n * E7]), [B.marketId]: feesOf([5n * E7, 1n * E7], [1n * E7, 1n * E7]) }
    show()
    const a = screen.getByText("USDY Dec 2026").closest("article") as HTMLElement
    expect(within(a).getByRole("button", { name: "Claim creator fees" })).toBeTruthy()
    expect(within(a).queryByRole("button", { name: /protocol fees/ })).toBeNull()
    expect(within(a).getByText(/7 SY/)).toBeTruthy() // 3 + 4: pool plus manager
    const b = screen.getByText("USDY Mar 2027").closest("article") as HTMLElement
    expect(within(b).getByRole("button", { name: "Claim protocol fees (to treasury)" })).toBeTruthy()
    expect(within(b).queryByRole("button", { name: "Claim creator fees" })).toBeNull()
    expect(within(b).getByText(/6 SY/)).toBeTruthy() // 5 + 1
  })

  it("an issuer who is not the creator is offered no fee claim", () => {
    setRoles(marketRoles(A, { issuer: yes }), marketRoles(B))
    show()
    expect(screen.queryByRole("button", { name: /Claim/ })).toBeNull()
  })

  it("accrued fees that cannot be read show Unavailable with the reason and turn the claim off, never a zero", () => {
    setRoles(marketRoles(A, { creator: yes }), marketRoles(B))
    mocks.fees = { [A.marketId]: down("rpc 503"), [B.marketId]: feesOf([0n, 0n], [0n, 0n]) }
    show()
    expect(screen.getByText(/Unavailable \(rpc 503\)/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Claim creator fees" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("nothing accrued: the claim is off and says there is nothing to claim", () => {
    setRoles(marketRoles(A, { creator: yes }), marketRoles(B))
    show()
    expect((screen.getByRole("button", { name: "Claim creator fees" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Nothing to claim/)).toBeTruthy()
  })

  it("roles that could not be read are shown as Unavailable with the reason, not as no role", () => {
    const broken = marketRoles(A, { pool: down("rpc 500") })
    setRoles(broken, marketRoles(B))
    show()
    expect(screen.getByText("USDY Dec 2026")).toBeTruthy()
    expect(screen.getByText(/Unavailable.*pool admin: rpc 500/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Pause pool" })).toBeNull()
  })
})

describe("signing a manager call", () => {
  it("Pause reviews the call, shows its label, and signs the very review that was prepared (R31)", async () => {
    show()
    await userEvent.click(screen.getByRole("button", { name: "Pause pool" }))
    const dialog = await screen.findByRole("dialog")
    await within(dialog).findByText(/Pause the pool of USDY/)
    const call = mocks.prepareManager.mock.calls[0][0] as ManagerCall
    expect(call).toMatchObject({ kind: "set_paused", source: ME })
    expect(call.invocation.contractId).toBe(A.contracts.pool)
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign transaction" }))
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1))
    const prepared = await mocks.prepareManager.mock.results[0].value
    expect(mocks.execute.mock.calls[0][0]).toBe(prepared)
  })

  it("signing is off while a gate refuses: a call needing a role the wallet lacks never reaches the wallet", async () => {
    // The Router admin read says no: nothing in this view needs it, but the pause gate does use the pool read.
    setRoles(marketRoles(A, { pool: yes }), marketRoles(B))
    show()
    await userEvent.click(screen.getByRole("button", { name: "Pause pool" }))
    const dialog = await screen.findByRole("dialog")
    expect((within(dialog).getByRole("button", { name: "Sign transaction" }) as HTMLButtonElement).disabled).toBe(false)
  })

  it("Claim creator fees claims the pool and the manager one after the other, each with its own review", async () => {
    setRoles(marketRoles(A, { creator: yes }), marketRoles(B))
    mocks.fees[A.marketId] = feesOf([0n, 3n * E7], [0n, 4n * E7])
    show()
    await userEvent.click(screen.getByRole("button", { name: "Claim creator fees" }))
    let dialog = await screen.findByRole("dialog")
    await within(dialog).findByText(/Step 1 of 2/)
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign transaction" }))
    await waitFor(() => expect(mocks.prepareManager).toHaveBeenCalledTimes(2))
    dialog = await screen.findByRole("dialog")
    await within(dialog).findByText(/Step 2 of 2/)
    const [first, second] = mocks.prepareManager.mock.calls.map((c) => c[0] as ManagerCall)
    expect(first).toMatchObject({ kind: "claim_creator_fees" })
    expect(first.invocation.contractId).toBe(A.contracts.pool)
    expect(second.invocation.contractId).toBe(A.contracts.manager)
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign transaction" }))
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("a contract with nothing accrued is not claimed (the contract refuses a claim of zero)", async () => {
    setRoles(marketRoles(A, { creator: yes }), marketRoles(B))
    mocks.fees[A.marketId] = feesOf([0n, 0n], [0n, 4n * E7])
    show()
    await userEvent.click(screen.getByRole("button", { name: "Claim creator fees" }))
    await screen.findByRole("dialog")
    expect((mocks.prepareManager.mock.calls[0][0] as ManagerCall).invocation.contractId).toBe(A.contracts.manager)
    expect(screen.queryByText(/Step 1 of 2/)).toBeNull()
  })

  it("a failed claim stops there: the second contract is not prepared", async () => {
    setRoles(marketRoles(A, { creator: yes }), marketRoles(B))
    mocks.fees[A.marketId] = feesOf([0n, 3n * E7], [0n, 4n * E7])
    mocks.execute.mockResolvedValue({ status: "FAILED", hash: "bad", reason: "x" })
    show()
    await userEvent.click(screen.getByRole("button", { name: "Claim creator fees" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(await within(dialog).findByRole("button", { name: "Sign transaction" }))
    await waitFor(() => expect(mocks.toast).toHaveBeenCalled())
    expect(mocks.prepareManager).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("invalid registry rows (R2-38)", () => {
  it("All lists them with their reason", async () => {
    show({ status: "ok", rows: [{ pool: contractAt(40), name: "Old market", reason: "its PT is not wired to the manager" }] })
    await userEvent.click(screen.getByRole("button", { name: /^All/ }))
    const item = screen.getByText("Old market").closest("li") as HTMLElement
    expect(within(item).getByText(/its PT is not wired to the manager/)).toBeTruthy()
    expect(within(item).queryByRole("button")).toBeNull()
  })

  it("says the list is unavailable rather than showing none", async () => {
    show({ status: "unavailable" })
    await userEvent.click(screen.getByRole("button", { name: /^All/ }))
    expect(screen.getByText(/could not be read right now/)).toBeTruthy()
  })
})
