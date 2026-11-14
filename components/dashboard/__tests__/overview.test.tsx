import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Live, ReadSource } from "@/lib/protocol/types"

const MARKET = "testnet-usdy-1802336344"
const RPC = "https://rpc.test"
const LEDGER_TIME = 1_800_000_000

const src = (fn: string, ledger = 5_720_087): ReadSource => ({ contractId: "CCONTRACT", fn, args: [], rawXdr: "AAAA", ledger, rpcUrl: RPC })
const live = <T,>(value: T, fn = "f"): Live<T> => ({ status: "live", value, ledger: 5_720_087, source: src(fn) })
const down = (error = "rpc down"): Live<never> => ({ status: "unavailable", error })

const mocks = vi.hoisted(() => ({
  clock: { ledgerTime: 0 as number | null, sequence: 5_720_087 as number | null, isError: false },
  fetchProtocolState: vi.fn(),
  fetchOracleView: vi.fn(),
  fetchRiskView: vi.fn(),
  fetchPauses: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock("@/components/app/manifest-provider", () => {
  const manifest = {
    network: "testnet",
    rpcUrl: "https://rpc.test",
    markets: [{ marketId: "testnet-usdy-1802336344", displayName: "USDY", underlying: { code: "USDY", decimals: 7, sac: "CSAC" } }],
    shared: { oracle: "CORACLE", riskControl: "CRISK" },
    wasmHashes: {},
  }
  return { useManifest: () => manifest }
})
vi.mock("@/lib/protocol/reader", async (importActual) => ({ ...(await importActual<object>()), createRpcReader: () => ({}) }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => mocks.clock }))
vi.mock("@/lib/protocol/dashboard/protocol-state", async (importActual) => ({
  ...(await importActual<object>()),
  fetchProtocolState: mocks.fetchProtocolState,
}))
vi.mock("@/lib/protocol/dashboard/oracle", async (importActual) => ({ ...(await importActual<object>()), fetchOracleView: mocks.fetchOracleView }))
vi.mock("@/lib/protocol/dashboard/risk", async (importActual) => ({ ...(await importActual<object>()), fetchRiskView: mocks.fetchRiskView }))
vi.mock("@/lib/protocol/dashboard/pauses", () => ({ fetchPauses: mocks.fetchPauses }))
// No wallet provider anywhere: a view that read the wallet would throw.
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => {
    throw new Error("the dashboard must not read the wallet")
  },
}))

import { Overview } from "../overview"

function protocolState(over: { tvl?: Live<bigint>; liquidity?: Live<bigint> } = {}) {
  return {
    markets: {},
    totals: {
      tvl: over.tvl ?? { status: "live", value: 2_230_113_029_038n, ledger: 5_720_087, sources: [src("total_underlying"), src("balance", 5_720_086)], ledgerSpread: { min: 5_720_086, max: 5_720_087 } },
      tvlReference: live(2_230_323_997_730n),
      liquidity: over.liquidity ?? live(1_052_000_000_000n),
      escrowUnderlying: live(0n),
    },
  }
}

function oracleView(over: Record<string, unknown> = {}) {
  return {
    contractId: "CORACLE",
    value: live(10_000_946n),
    timestamp: live(BigInt(LEDGER_TIME - 708)),
    available: live(true),
    freshness: "fresh",
    timeToBlock: { status: "live", value: 2892, ledger: 5_720_087, sources: [src("get_reference_timestamp"), src("max_stale_seconds")] },
    maxStale: live(3600n),
    deviationBps: live(500n),
    bounds: live(null),
    sources: { primary: { hash: live(null) }, fallback: { hash: live(null) }, active: { hash: live(null) } },
    path: { status: "unsupported" },
    lastRejection: live(null),
    blockedWhenStale: ["mint", "trade", "single-sided liquidity", "redemption"],
    ...over,
  }
}

function riskView(over: Record<string, unknown> = {}) {
  return {
    contractId: "CRISK",
    limit: live(100_000_000_000_000n, "get_cb_limit"),
    volume: live(0n, "get_cb_volume"),
    remaining: { status: "live", value: 100_000_000_000_000n, ledger: 5_720_087, sources: [src("get_cb_limit"), src("get_cb_volume")] },
    effectiveWrapAndMint: null,
    doubleReporting: [],
    consumers: {},
    window: { start: live(5_707_351), length: live(17_280), lapsed: live(false) },
    assetLimits: [],
    paused: live(false),
    ...over,
  }
}

const pauses = (paused: Live<string[]> = { status: "live", value: [], ledger: 5_720_087, sources: [src("is_paused")] }) => ({ contracts: [], paused })

const INDEX = {
  rows: [],
  indexedThrough: 5_719_749,
  indexedThroughCloseTime: new Date((LEDGER_TIME - 125) * 1000).toISOString(),
  lagSeconds: 125,
  gaps: [],
  reconcile: { at: "2026-11-14T02:13:14.633Z", results: [{ escrow: "CESCROW", recordCount: 0, indexed: 0, ok: true }] },
}

const event = (id: string, ledger: number, group: string, topic: string, data: Record<string, unknown>) => ({
  id,
  group,
  contractId: "CPERM",
  topic,
  ledger,
  closeTime: new Date((LEDGER_TIME - 3600) * 1000).toISOString(),
  txHash: "68be08ad3f0c4e2b9a1d7c5e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a",
  pool: null,
  data,
})

function answer(url: string): Response {
  if (url.startsWith("/api/dashboard/alerts")) return new Response("<!DOCTYPE html><title>404</title>", { status: 404, headers: { "content-type": "text/html" } })
  if (url.includes("group=permissioning"))
    return Response.json({ ...INDEX, rows: [event("0000000000000000500-0000000000", 5_707_438, "permissioning", "acc_grant", { caller: "GCALLER", account: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI" })] })
  if (url.includes("group=escrow")) return Response.json({ ...INDEX, rows: [] })
  return Response.json(INDEX)
}

let client: QueryClient
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.clock = { ledgerTime: LEDGER_TIME, sequence: 5_720_087, isError: false }
  mocks.fetchProtocolState.mockReset().mockResolvedValue(protocolState())
  mocks.fetchOracleView.mockReset().mockResolvedValue(oracleView())
  mocks.fetchRiskView.mockReset().mockResolvedValue(riskView())
  mocks.fetchPauses.mockReset().mockResolvedValue(pauses())
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

describe("the overview (/dashboard)", () => {
  it("renders with no wallet: protocol totals, the safety summary, compliance events and the indexer status", async () => {
    render(wrap(<Overview />))
    expect(screen.getByRole("heading", { level: 1, name: "Protocol overview" })).toBeTruthy()

    const totals = region("Protocol totals")
    expect(await totals.findByText("223,011.30 USDY")).toBeTruthy()
    expect(totals.getByText("223,032.39")).toBeTruthy()
    expect(totals.getByText("105,200.00 USDY")).toBeTruthy()
    expect(totals.getByText("1")).toBeTruthy()

    const safety = region("Safety")
    expect(await safety.findByText("10,000,000.00 USDY left of 10,000,000.00 USDY")).toBeTruthy()
    expect(safety.getByText("None paused")).toBeTruthy()
    expect(safety.getByText("Fresh · operations block in 48m 12s without an update")).toBeTruthy()

    const events = region("Latest compliance events")
    expect(await events.findByText("Account allowed")).toBeTruthy()
    expect(events.getByText("5707438")).toBeTruthy()
    const tx = events.getByRole("link", { name: "View transaction 68be08ad3f0c4e2b9a1d7c5e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a on stellar.expert" })
    expect(tx.textContent).toBe("68be08…8f7a")
    expect(tx.getAttribute("href")).toBe(
      "https://stellar.expert/explorer/testnet/tx/68be08ad3f0c4e2b9a1d7c5e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a",
    )

    const index = region("Event index")
    expect(await index.findByText("5719749")).toBeTruthy()
    expect(index.getByText("2m 5s behind ledger time")).toBeTruthy()
    expect(index.getByText("No gaps")).toBeTruthy()
    expect(index.getByText("RecoveryEscrow records match the index (0 of 0)")).toBeTruthy()
  })

  it("every contract figure has its How to verify button", async () => {
    render(wrap(<Overview />))
    await screen.findByText("223,011.30 USDY")
    await screen.findByText("None paused")
    for (const label of ["TVL", "TVL, reference value", "Pool liquidity", "RiskControl capacity", "Contract pauses", "Oracle freshness"])
      expect(screen.getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
  })

  it("shows open alerts as Unavailable, with the reason, until the alerts route exists", async () => {
    const user = userEvent.setup()
    render(wrap(<Overview />))
    const safety = region("Safety")
    const tip = await safety.findByRole("button", { name: "More about Open alerts (unavailable)" })
    await user.click(tip)
    expect((await screen.findAllByText("alerts not available yet")).length).toBeGreaterThan(0)
  })

  it("a total is Unavailable, never partial, when an input is", async () => {
    mocks.fetchProtocolState.mockResolvedValue(protocolState({ tvl: down("second: rpc down") }))
    render(wrap(<Overview />))
    const totals = region("Protocol totals")
    await totals.findByText("105,200.00 USDY")
    expect(totals.getByRole("button", { name: "Why TVL is unavailable, and how to verify it" })).toBeTruthy()
  })

  it("a stale oracle says operations are blocked", async () => {
    mocks.fetchOracleView.mockResolvedValue(
      oracleView({ freshness: "stale", timeToBlock: { status: "live", value: -40, ledger: 1, sources: [src("get_reference_timestamp")] } }),
    )
    render(wrap(<Overview />))
    expect(await region("Safety").findByText("Stale · mint, trade, single-sided liquidity and redemption are blocked")).toBeTruthy()
  })

  it("names the paused contracts", async () => {
    mocks.fetchPauses.mockResolvedValue(pauses({ status: "live", value: ["Risk control", `Market pool (${MARKET})`], ledger: 1 }))
    render(wrap(<Overview />))
    expect(await region("Safety").findByText(`Paused: Risk control, Market pool (${MARKET})`)).toBeTruthy()
  })

  it("says why the index cannot be read when the server has no database", async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("/api/dashboard/events") ? Response.json({ error: "not_configured" }, { status: 503 }) : answer(url),
    )
    render(wrap(<Overview />))
    const index = region("Event index")
    expect(await index.findByRole("button", { name: "More about Event index (unavailable)" })).toBeTruthy()
  })

  it("offers the page's evidence table and the as-of line", async () => {
    render(wrap(<Overview />))
    await screen.findByText("223,011.30 USDY")
    expect(screen.getByRole("button", { name: "Copy evidence table" })).toBeTruthy()
    expect(screen.getAllByTestId("as-of")[0].textContent).toContain("As of ledger 5720087")
    expect(screen.getByText("No fallback RPC configured")).toBeTruthy()
  })

  it("keeps a 375 px page from scrolling sideways: the page column may shrink below its content", () => {
    render(wrap(<Overview />))
    const section = screen.getByRole("heading", { level: 1, name: "Protocol overview" }).closest("section")
    expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
  })
})
