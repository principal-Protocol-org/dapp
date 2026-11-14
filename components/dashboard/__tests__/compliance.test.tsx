import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Live, ReadSource } from "@/lib/protocol/types"

const MARKET = "testnet-usdy-1802336344"
const RPC = "https://rpc.test"
const LEDGER_TIME = 1_800_000_000
const ESCROW = "CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q"
const SAC = "CB2YO6BCOTN336RQUAMHOBCNABJG74URBIMNUHXB27K2QOLJKDCDXODZ"
const ISSUER = "GDUGKHAJJPEYRF4T5XG7HJSUY3AGMHKHCSTSLZSGOCK2673N5ZKDFIDT"
const HOLDER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const ADMIN = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const SEIZE_TX = "445a001b1a22259cc9566fadbd9645da017240fb8a31c3b068ca12e437c7e336"
const FINAL_TX = "1ef22da5bd6d6d1b7a3f0e5c4d2b1a09f8e7d6c5b4a39281706f5e4d3c2ba829"
const SEIZE_TX_1 = "84ba9d7f2c90b4528265a70087cc0eba44a1276f863da393a6c568e4fd7608b7"

const src = (fn: string, contractId: string, args: unknown[] = [], ledger = 5_720_087): ReadSource => ({ contractId, fn, args, rawXdr: "AAAA", ledger, rpcUrl: RPC })
const live = <T,>(value: T, source: ReadSource): Live<T> => ({ status: "live", value, ledger: source.ledger, source })
const down = (error = "rpc down"): Live<never> => ({ status: "unavailable", error })

const mocks = vi.hoisted(() => ({
  manifest: {} as Record<string, unknown>,
  clock: { ledgerTime: 0 as number | null, sequence: 5_720_087 as number | null, isError: false },
  fetchEscrowRecords: vi.fn(),
  fetchAssetCompliance: vi.fn(),
  fetch: vi.fn(),
}))

const baseManifest = () => ({
  network: "testnet",
  rpcUrl: RPC,
  horizonUrl: "https://horizon-testnet.stellar.org",
  markets: [
    {
      marketId: MARKET,
      displayName: "USDY",
      underlying: { code: "USDY", decimals: 7, sac: SAC, issuer: ISSUER },
      contracts: { sy: "CSY", pool: "CPOOL", manager: "CMGR", recoveryEscrow: ESCROW },
    },
  ],
  shared: { oracle: "CORACLE", riskControl: "CRISK", permissioning: "CPERM", router: "CROUTER" },
  wasmHashes: {},
})
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("@/lib/protocol/reader", async (importActual) => ({ ...(await importActual<object>()), createRpcReader: () => ({}) }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => mocks.clock }))
vi.mock("@/lib/protocol/dashboard/compliance", async (importActual) => ({
  ...(await importActual<object>()),
  fetchEscrowRecords: mocks.fetchEscrowRecords,
  fetchAssetCompliance: mocks.fetchAssetCompliance,
}))
// No wallet provider anywhere: a view that read the wallet would throw.
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => {
    throw new Error("the dashboard must not read the wallet")
  },
}))

import { CompliancePanel } from "../compliance-panel"

/** A live record as `fetchEscrowRecords` returns it, with its own `get_record --id N` read. */
const record = (id: bigint, over: Record<string, unknown> = {}) => ({
  status: "live",
  id,
  account: HOLDER,
  ledger: 5_720_000,
  timestamp: 1_794_620_000n,
  syShares: 10_000_000_000n,
  underlyingFromSy: 10_000_000_000n,
  lpAmount: 0n,
  lpPt: 0n,
  lpSyShares: 0n,
  underlyingFromLp: 0n,
  ptAmount: 2_500_000_000n,
  ytAmount: 2_500_000_000n,
  ytYieldAtSeize: 12_345n,
  finalized: false,
  underlyingFromPt: 0n,
  underlyingFromYt: 0n,
  source: src("get_record", ESCROW, [{ type: "u64", value: String(id) }]),
  ...over,
})
const archived = (id: bigint) => ({ status: "archived", id })
const records = (value: unknown[]) => [{ escrow: ESCROW, marketIds: [MARKET], records: { status: "live", value, ledger: 5_720_087, sources: [src("record_count", ESCROW)] } }]

const asset = (over: Record<string, unknown> = {}) => [
  {
    sac: SAC,
    code: "USDY",
    issuer: ISSUER,
    marketIds: [MARKET],
    model: { status: "live", value: { kind: "sac", authRequired: true, authRevocable: true, clawbackEnabled: false, administrator: ISSUER }, ledger: 5_720_087 },
    admin: live(ISSUER, src("admin", SAC)),
    flagsUrl: `https://horizon-testnet.stellar.org/accounts/${ISSUER}`,
    ...over,
  },
]

const INDEX = {
  rows: [],
  indexedThrough: 5_719_749,
  indexedThroughCloseTime: new Date((LEDGER_TIME - 125) * 1000).toISOString(),
  lagSeconds: 125,
  gaps: [],
  reconcile: { at: "2026-11-14T02:13:14.633Z", results: [{ escrow: ESCROW, recordCount: 0, indexed: 0, ok: true }] },
}
const escrowEvent = (topic: "recovery" | "finalize", id: string, ledger: number, txHash: string, data: Record<string, unknown> = {}) => ({
  id: `${String(ledger).padStart(19, "0")}-000000000${id}`,
  group: "escrow",
  contractId: ESCROW,
  topic,
  ledger,
  closeTime: "2026-11-14T00:04:59.000Z",
  txHash,
  pool: "CPOOL",
  data: topic === "recovery" ? { caller: ADMIN, id, account: HOLDER, sy_shares: "10000000000", pt_amount: "2500000000", yt_amount: "2500000000", lp_amount: "0", ...data } : { id, account: HOLDER, underlying_from_pt: "1", underlying_from_yt: "2", ...data },
})
const permEvent = (ledger: number, topic: string, data: Record<string, unknown>) => ({
  id: `${String(ledger).padStart(19, "0")}-0000000000`,
  group: "permissioning",
  contractId: "CPERM",
  topic,
  ledger,
  closeTime: "2026-11-14T00:04:59.000Z",
  txHash: SEIZE_TX,
  pool: null,
  data,
})

type Answers = { escrow?: unknown[]; reconcile?: unknown; counts?: Record<string, number>; permissioning?: unknown[]; escrowDown?: boolean; escrowHang?: boolean }
let answers: Answers = {}

function answer(url: string): Response | Promise<Response> {
  if (url.includes("group=escrow") && answers.escrowHang) return new Promise<Response>(() => {})
  if (url.includes("group=escrow")) {
    if (answers.escrowDown) return Response.json({ error: "not_configured" }, { status: 503 })
    return Response.json({ ...INDEX, rows: answers.escrow ?? [], ...(answers.reconcile !== undefined ? { reconcile: answers.reconcile } : {}) })
  }
  if (url.includes("group=permissioning") && url.includes("counts=1")) return Response.json({ ...INDEX, counts: answers.counts ?? {} })
  if (url.includes("group=permissioning")) return Response.json({ ...INDEX, rows: answers.permissioning ?? [] })
  return Response.json(INDEX)
}

let client: QueryClient
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>

beforeEach(() => {
  answers = {}
  mocks.manifest = baseManifest()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.clock = { ledgerTime: LEDGER_TIME, sequence: 5_720_087, isError: false }
  mocks.fetchEscrowRecords.mockReset().mockImplementation(async () => records([])[0].records)
  mocks.fetchAssetCompliance.mockReset().mockResolvedValue(asset())
  mocks.fetch.mockReset().mockImplementation(async (url: string) => answer(url))
  vi.stubGlobal("fetch", mocks.fetch)
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
})

afterEach(() => vi.unstubAllGlobals())

const region = (name: string) => within(screen.getByRole("region", { name }))
const withRecords = (value: unknown[]) => mocks.fetchEscrowRecords.mockImplementation(async () => records(value)[0].records)

describe("the compliance page (/dashboard/compliance)", () => {
  it("shows the asset administrator (admin(), with its drawer) and the issuer flags, read from Horizon", async () => {
    render(wrap(<CompliancePanel />))
    expect(screen.getByRole("heading", { level: 1, name: "Compliance" })).toBeTruthy()
    const a = region("Underlying asset")
    expect(await a.findByRole("button", { name: "How to verify USDY administrator" })).toBeTruthy()
    expect(a.getByText("GDUG…FIDT")).toBeTruthy()
    expect(within(a.getByText("Authorization required").closest("div") as HTMLElement).getByText("Yes")).toBeTruthy()
    expect(within(a.getByText("Authorization revocable").closest("div") as HTMLElement).getByText("Yes")).toBeTruthy()
    expect(within(a.getByText("Clawback enabled").closest("div") as HTMLElement).getByText("No")).toBeTruthy()
    const horizon = a.getByRole("link", { name: /issuer's account on Horizon/ })
    expect(horizon.getAttribute("href")).toBe(`https://horizon-testnet.stellar.org/accounts/${ISSUER}`)
  })

  it("a SEP-57 asset says it has no flags and no administrator address", async () => {
    mocks.fetchAssetCompliance.mockResolvedValue(asset({ model: { status: "live", value: { kind: "sep57", administrator: null }, ledger: 1 }, admin: down("HostError: Error(Contract, #1)") }))
    render(wrap(<CompliancePanel />))
    expect(await region("Underlying asset").findByText(/The underlying is a SEP-57 token/)).toBeTruthy()
  })

  it("flags Horizon cannot give are Unavailable, with the reason; the admin still shows", async () => {
    mocks.fetchAssetCompliance.mockResolvedValue(asset({ model: down("Horizon responded 503") }))
    render(wrap(<CompliancePanel />))
    const a = region("Underlying asset")
    expect(await a.findByRole("button", { name: "More about Issuer flags (unavailable)" })).toBeTruthy()
    expect(a.getByRole("button", { name: "How to verify USDY administrator" })).toBeTruthy()
  })

  it("lists live records with the tx hashes joined from the indexed recovery and finalize events", async () => {
    withRecords([record(0n), record(1n, { finalized: true, underlyingFromPt: 2_400_000_000n, underlyingFromYt: 7_000_000n })])
    answers.escrow = [escrowEvent("finalize", "1", 5_800_000, FINAL_TX), escrowEvent("recovery", "1", 5_720_010, SEIZE_TX_1), escrowEvent("recovery", "0", 5_720_000, SEIZE_TX)]
    answers.reconcile = { at: "2026-11-14T02:13:14.633Z", results: [{ escrow: ESCROW, recordCount: 2, indexed: 2, ok: true }] }
    render(wrap(<CompliancePanel />))
    const r = region("RecoveryEscrow records")
    const zero = within(await r.findByRole("article", { name: "Record 0" }))
    expect(zero.getByText("1,000.00 SY")).toBeTruthy()
    expect(zero.getAllByText("250.00 PT").length).toBeGreaterThan(0)
    expect(zero.getByRole("button", { name: "How to verify Record 0 SY shares seized" })).toBeTruthy()
    // Each record shows its own seizure, joined by record id.
    expect(await zero.findByRole("link", { name: `View transaction ${SEIZE_TX} on stellar.expert` })).toBeTruthy()
    expect(zero.queryByRole("link", { name: `View transaction ${SEIZE_TX_1} on stellar.expert` })).toBeNull()
    expect(zero.getByText("Held in escrow")).toBeTruthy()
    const one = within(r.getByRole("article", { name: "Record 1" }))
    expect(one.getByRole("link", { name: `View transaction ${SEIZE_TX_1} on stellar.expert` })).toBeTruthy()
    expect(one.queryByRole("link", { name: `View transaction ${SEIZE_TX} on stellar.expert` })).toBeNull()
    expect(one.getByText("Finalized")).toBeTruthy()
    expect(one.getByText("240.00 USDY")).toBeTruthy()
    expect(one.getByRole("link", { name: `View transaction ${FINAL_TX} on stellar.expert` })).toBeTruthy()
    // The index's reconciliation, from the events API.
    expect(r.getByText("record_count 2, indexed 2: they match")).toBeTruthy()
  })

  it("Review Focus 4: an archived record the index holds shows the indexed row, labelled", async () => {
    withRecords([archived(0n), record(1n)])
    answers.escrow = [escrowEvent("recovery", "1", 5_720_010, SEIZE_TX), escrowEvent("recovery", "0", 5_720_000, SEIZE_TX)]
    render(wrap(<CompliancePanel />))
    const zero = within(await region("RecoveryEscrow records").findByRole("article", { name: "Record 0" }))
    expect(zero.getByText("Archived on-chain; shown from the index")).toBeTruthy()
    expect(zero.getByText("1,000.00 SY")).toBeTruthy()
    expect(zero.getByText("GBZX…MADI")).toBeTruthy()
    expect(zero.getByRole("link", { name: `View transaction ${SEIZE_TX} on stellar.expert` })).toBeTruthy()
    expect(zero.queryByText(/Unavailable/)).toBeNull()
  })

  it("an archived record the index does not hold is Unavailable, with the reason", async () => {
    const user = userEvent.setup()
    withRecords([archived(0n)])
    render(wrap(<CompliancePanel />))
    const zero = within(await region("RecoveryEscrow records").findByRole("article", { name: "Record 0" }))
    await user.click(zero.getByRole("button", { name: "More about Record 0 (unavailable)" }))
    expect(
      (await screen.findAllByText("Record 0 is archived on-chain (its read requires restoring), and the event index holds no recovery event for it")).length,
    ).toBeGreaterThan(0)
  })

  it("D-16 live first: records show from their live reads at once; the transaction waits for the index, an archived record too", async () => {
    withRecords([archived(0n), record(1n)])
    answers.escrowHang = true
    render(wrap(<CompliancePanel />))
    const r = region("RecoveryEscrow records")
    const one = within(await r.findByRole("article", { name: "Record 1" }))
    expect(one.getByText("1,000.00 SY")).toBeTruthy()
    expect(one.getByRole("button", { name: "How to verify Record 1 SY shares seized" })).toBeTruthy()
    const tx = one.getByText("Seizure transaction").closest("div") as HTMLElement
    expect(within(tx).getByRole("status", { name: "Reading the event index" })).toBeTruthy()
    expect(one.queryByText(/Unavailable|Not in the event index/)).toBeNull()
    const zero = within(r.getByRole("article", { name: "Record 0" }))
    expect(zero.getByText("Archived on-chain; reading the event index for it")).toBeTruthy()
    expect(zero.queryByText(/Unavailable/)).toBeNull()
  })

  it("a live record the index does not hold yet keeps its fields; its transaction says so", async () => {
    withRecords([record(0n)])
    render(wrap(<CompliancePanel />))
    const zero = within(await region("RecoveryEscrow records").findByRole("article", { name: "Record 0" }))
    expect(zero.getByText("Not in the event index yet")).toBeTruthy()
    expect(zero.getByText("1,000.00 SY")).toBeTruthy()
  })

  it("the index down: records still read live, each transaction Unavailable with the reason", async () => {
    withRecords([record(0n)])
    answers.escrowDown = true
    render(wrap(<CompliancePanel />))
    // The index answer is retried once (the app's default) before it counts as down.
    const zero = within(await region("RecoveryEscrow records").findByRole("article", { name: "Record 0" }, { timeout: 4000 }))
    expect(await zero.findByRole("button", { name: "More about Seizure transaction (unavailable)" })).toBeTruthy()
    expect(zero.getByText("1,000.00 SY")).toBeTruthy()
  })

  it("no record reads No seizure recorded yet, never an error; a reconcile mismatch is flagged", async () => {
    answers.reconcile = { at: "2026-11-14T02:13:14.633Z", results: [{ escrow: ESCROW, recordCount: 1, indexed: 0, ok: false }] }
    render(wrap(<CompliancePanel />))
    const r = region("RecoveryEscrow records")
    expect(await r.findByText("No seizure recorded yet")).toBeTruthy()
    expect(r.queryByText(/Unavailable/)).toBeNull()
    expect(await r.findByText("record_count 1, indexed 0: they differ")).toBeTruthy()
    expect(await region("Seizure history").findByText("No seizure or finalization indexed yet")).toBeTruthy()
  })

  it("records that cannot be read are Unavailable, with the reason, never partial", async () => {
    mocks.fetchEscrowRecords.mockResolvedValue(down("record 1: fetch failed"))
    render(wrap(<CompliancePanel />))
    expect(await region("RecoveryEscrow records").findByRole("button", { name: /Why RecoveryEscrow records .* is unavailable, and how to verify it/ })).toBeTruthy()
  })

  it("counts the Permissioning grants and revokes from the index, with the batch note", async () => {
    answers.counts = { acc_grant: 37, ast_grant: 68, acc_rev: 2, acc_batch: 3 }
    answers.permissioning = [permEvent(5_707_438, "acc_grant", { caller: ADMIN, account: HOLDER })]
    render(wrap(<CompliancePanel />))
    const p = region("Permissioning")
    const count = (label: string) => within(p.getByText(label).closest("div") as HTMLElement)
    expect(await p.findByText("Batch grants (acc_batch) carry only their caller, so their members are not counted.")).toBeTruthy()
    expect(count("Account grants").getByText("37")).toBeTruthy()
    expect(count("Account revokes").getByText("2")).toBeTruthy()
    expect(count("Asset grants").getByText("68")).toBeTruthy()
    expect(count("Asset revokes").getByText("0")).toBeTruthy()
    expect(count("Batch grants").getByText("3")).toBeTruthy()
    expect(mocks.fetch).toHaveBeenCalledWith("/api/dashboard/events?group=permissioning&counts=1&limit=1")
    expect((await region("Permissioning changes").findAllByText("Account allowed")).length).toBeGreaterThan(0)
  })

  it("no Permissioning change reads plainly", async () => {
    render(wrap(<CompliancePanel />))
    expect(await region("Permissioning changes").findByText("No Permissioning change indexed yet")).toBeTruthy()
  })

  it("offers the page's evidence table and the as-of line; fits 375 px", async () => {
    withRecords([record(0n)])
    render(wrap(<CompliancePanel />))
    await region("RecoveryEscrow records").findByRole("article", { name: "Record 0" })
    expect(screen.getByRole("button", { name: "Copy evidence table" })).toBeTruthy()
    expect(screen.getAllByTestId("as-of")[0].textContent).toContain("Ledger 5720087")
    const section = screen.getByRole("heading", { level: 1, name: "Compliance" }).closest("section")
    expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
  })
})
