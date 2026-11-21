import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Live, ReadSource } from "@/lib/protocol/types"

const MARKET = "testnet-usdy-1802336344"
const RPC = "https://rpc.test"
const LEDGER_TIME = 1_800_000_000

const srcOn = (contractId: string, fn: string, ledger = 5_720_087): ReadSource => ({ contractId, fn, args: [], rawXdr: "AAAA", ledger, rpcUrl: RPC })
const src = (fn: string, ledger = 5_720_087): ReadSource => srcOn("CCONTRACT", fn, ledger)
const live = <T,>(value: T, fn = "f"): Live<T> => ({ status: "live", value, ledger: 5_720_087, source: src(fn) })
const down = (error = "rpc down"): Live<never> => ({ status: "unavailable", error })

const mocks = vi.hoisted(() => ({
  manifest: {} as Record<string, unknown>,
  clock: { ledgerTime: 0 as number | null, sequence: 5_720_087 as number | null, isError: false },
  fetchProtocolState: vi.fn(),
  fetchOracleView: vi.fn(),
  fetchRiskView: vi.fn(),
  fetchPauses: vi.fn(),
  fetch: vi.fn(),
  seedCount: 1,
}))

const market = (marketId: string, underlying = { code: "USDY", decimals: 7, sac: "CSAC" }, oracle = "CORACLE") => ({
  marketId,
  displayName: underlying.code,
  underlying,
  contracts: { sy: `CSY${marketId}`, pool: `CPOOL${marketId}`, manager: `CMGR${marketId}`, oracle },
})
const baseManifest = () => ({
  network: "testnet",
  rpcUrl: "https://rpc.test",
  markets: [market(MARKET)],
  shared: { oracle: "CORACLE", riskControl: "CRISK", permissioning: "CPERM", router: "CROUTER" },
  wasmHashes: {},
})
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest, useSeedCount: () => mocks.seedCount }))
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

import { EFFECTIVE_WRAP_AND_MINT_LABEL } from "@/lib/protocol/dashboard/risk"
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
    available: live(true, "is_available"),
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
    window: { kind: "fixed", start: live(5_707_351), length: live(17_280), lapsed: live(false) },
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

const ALERT = { kind: "oracle_stale", subject: "CORACLE", severity: "critical", openedAt: "2026-11-14T02:00:00.000Z", payload: {} }

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
  mocks.manifest = baseManifest()
  mocks.seedCount = 1
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
    // The oracle's unit is US dollars, as /app says it ("USD (oracle units)").
    expect(totals.getByText("223,032.39 USD (oracle units)")).toBeTruthy()
    expect(totals.getByText("105,200.00 USDY")).toBeTruthy()
    expect(totals.getByText("1")).toBeTruthy()

    const safety = region("Safety")
    expect(await safety.findByText("10,000,000.00 USDY left of 10,000,000.00 USDY")).toBeTruthy()
    expect(safety.getByText("None paused")).toBeTruthy()
    // One oracle on Testnet: "1 of 1 fresh", the badge naming the worst state.
    expect(safety.getByText("1 of 1 fresh")).toBeTruthy()
    expect(within(safety.getByText("Oracles", { selector: "dt" }).parentElement!).getByText("Fresh")).toBeTruthy()

    const events = region("Latest compliance events")
    expect(await events.findByText("Account allowed")).toBeTruthy()
    expect(events.getByText("5707438")).toBeTruthy()
    // One link per breakpoint: in its own column from 520 px, under the event below it.
    const [tx] = events.getAllByRole("link", { name: "View transaction 68be08ad3f0c4e2b9a1d7c5e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a on stellar.expert" })
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
    for (const label of ["TVL", "TVL in USD", "Pool liquidity", "RiskControl capacity", "Contract pauses", "Oracle freshness"])
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

  it("pool liquidity reads No liquidity yet, never 0, while no pool is seeded (as /app)", async () => {
    mocks.fetchProtocolState.mockResolvedValue({
      ...protocolState({ liquidity: live(0n) }),
      markets: { [MARKET]: { poolSeeded: live(false, "reserves") } },
    })
    render(wrap(<Overview />))
    const totals = region("Protocol totals")
    expect(await totals.findByText("No liquidity yet")).toBeTruthy()
    expect(totals.queryByText("0.00 USDY")).toBeNull()
    expect(totals.getByRole("button", { name: "How to verify Pool liquidity" })).toBeTruthy()
  })

  it("shows the effective wrap-and-mint capacity, with its reason, when a market double-reports (D-10)", async () => {
    mocks.fetchRiskView.mockResolvedValue(
      riskView({
        doubleReporting: [MARKET],
        effectiveWrapAndMint: { status: "live", value: 50_000_000_000_000n, ledger: 5_720_087, sources: [src("get_cb_limit"), src("get_cb_volume"), src("is_consumer")] },
      }),
    )
    const user = userEvent.setup()
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByText("10,000,000.00 USDY left of 10,000,000.00 USDY")).toBeTruthy()
    // A short label at 375 px; the long one is in its info tip.
    expect(safety.getByText("Wrap-and-mint capacity")).toBeTruthy()
    expect(safety.queryByText(EFFECTIVE_WRAP_AND_MINT_LABEL)).toBeNull()
    expect(safety.getByText("5,000,000.00 USDY")).toBeTruthy()
    expect(safety.getByText(/SY deposit and the manager mint each count the same underlying/)).toBeTruthy()
    expect(safety.getByRole("button", { name: "How to verify Wrap-and-mint capacity" })).toBeTruthy()
    await user.click(safety.getByRole("button", { name: "More about Wrap-and-mint capacity" }))
    expect((await screen.findAllByText(new RegExp(EFFECTIVE_WRAP_AND_MINT_LABEL))).length).toBeGreaterThan(0)
  })

  it("the wrap-and-mint row turns Unavailable with the reason, and does not vanish, when the risk refresh fails", async () => {
    const user = userEvent.setup()
    mocks.fetchRiskView.mockResolvedValue(
      riskView({
        doubleReporting: [MARKET],
        effectiveWrapAndMint: { status: "live", value: 50_000_000_000_000n, ledger: 5_720_087, sources: [src("get_cb_limit"), src("get_cb_volume"), src("is_consumer")] },
      }),
    )
    render(wrap(<Overview />))
    const safety = region("Safety")
    await safety.findByText("5,000,000.00 USDY")
    mocks.fetchRiskView.mockRejectedValue(new Error("rpc down"))
    await act(() => client.refetchQueries({ queryKey: ["dashboard", "risk"] }))
    const why = await safety.findByRole("button", { name: "Why Wrap-and-mint capacity is unavailable, and how to verify it" })
    expect(safety.getByText("Wrap-and-mint capacity")).toBeTruthy()
    expect(safety.queryByText("5,000,000.00 USDY")).toBeNull()
    await user.click(why)
    expect((await screen.findAllByText(/the last refresh failed: rpc down/)).length).toBeGreaterThan(0)
  })

  it("no effective capacity line when no market double-reports; the raw remaining comes from the risk view", async () => {
    mocks.fetchRiskView.mockResolvedValue(
      riskView({ limit: live(0n), remaining: { status: "live", value: null, ledger: 5_720_087, sources: [src("get_cb_limit"), src("get_cb_volume")] } }),
    )
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByText("No limit (disabled)")).toBeTruthy()
    expect(safety.queryByText("Wrap-and-mint capacity")).toBeNull()
  })

  it("an effective capacity that cannot be read is Unavailable, with its reason", async () => {
    mocks.fetchRiskView.mockResolvedValue(riskView({ effectiveWrapAndMint: down(`whether market ${MARKET} double-reports: rpc down`) }))
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByRole("button", { name: "Why Wrap-and-mint capacity is unavailable, and how to verify it" })).toBeTruthy()
  })

  it("refuses to format amounts when the markets' decimals differ", async () => {
    mocks.manifest = { ...baseManifest(), markets: [market(MARKET), market("second", { code: "BENJI", decimals: 6, sac: "CSAC2" })] }
    render(wrap(<Overview />))
    const totals = region("Protocol totals")
    expect(await totals.findByRole("button", { name: "Why TVL in USD is unavailable, and how to verify it" })).toBeTruthy()
    expect(totals.getByRole("button", { name: "Why TVL is unavailable, and how to verify it" })).toBeTruthy()
    expect(totals.getByText("2")).toBeTruthy()
  })

  it("says where the markets count comes from", async () => {
    const user = userEvent.setup()
    render(wrap(<Overview />))
    await user.click(region("Protocol totals").getByRole("button", { name: "More about Markets" }))
    expect((await screen.findAllByText(/the registry: markets discovered from the Router and published by the app/)).length).toBeGreaterThan(0)
  })

  it("counts the open alerts once the alerts route answers", async () => {
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("/api/dashboard/alerts") ? Response.json({ open: [ALERT], recent: [], lastTest: null }) : answer(url),
    )
    render(wrap(<Overview />))
    expect(await region("Safety").findByText("1 open · 1 critical")).toBeTruthy()
    expect(region("Safety").getByText("Oracle stale")).toBeTruthy()
  })

  it("names the open alerts in words, critical first, counting a kind with several subjects", async () => {
    const lag = (subject: string) => ({ kind: "indexer_lag", subject, severity: "warning", openedAt: "2026-11-14T02:00:00.000Z", payload: {} })
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("/api/dashboard/alerts") ? Response.json({ open: [lag("oracle"), lag("market"), ALERT], recent: [], lastTest: null }) : answer(url),
    )
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByText("3 open · 1 critical")).toBeTruthy()
    expect(safety.getByText("Oracle stale, Event index lagging (2)")).toBeTruthy()
  })

  it("an unconfirmed oracle_unavailable is open but not counted critical until a second check confirms it", async () => {
    const unavailable = (confirmedAt?: string) => ({ kind: "oracle_unavailable", subject: "CORACLE", severity: "critical", openedAt: "2026-11-14T02:00:00.000Z", payload: confirmedAt ? { confirmedAt } : {} })
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("/api/dashboard/alerts") ? Response.json({ open: [unavailable()], recent: [], lastTest: null }) : answer(url),
    )
    const first = render(wrap(<Overview />))
    expect(await region("Safety").findByText("1 open")).toBeTruthy()
    first.unmount()
    mocks.fetch.mockImplementation(async (url: string) =>
      url.startsWith("/api/dashboard/alerts") ? Response.json({ open: [unavailable("2026-11-14T02:05:00.000Z")], recent: [], lastTest: null }) : answer(url),
    )
    render(wrap(<Overview />))
    expect(await region("Safety").findByText("1 open · 1 critical")).toBeTruthy()
  })

  it("no open alert reads None open", async () => {
    mocks.fetch.mockImplementation(async (url: string) => (url.startsWith("/api/dashboard/alerts") ? Response.json({ open: [], recent: [], lastTest: null }) : answer(url)))
    render(wrap(<Overview />))
    expect(await region("Safety").findByText("None open")).toBeTruthy()
  })

  it("below 520 px a compliance event folds its ledger and transaction under it, and the meta line can wrap", async () => {
    render(wrap(<Overview />))
    const events = region("Latest compliance events")
    await events.findByText("Account allowed")
    const links = events.getAllByRole("link", { name: /^View transaction / })
    expect(links.map((a) => a.closest("td")?.className.includes("max-[520px]:hidden") || a.closest("span")?.className.includes("min-[520px]:hidden"))).toEqual([true, true])
    expect(events.getByRole("columnheader", { name: "Transaction" }).className).toContain("max-[520px]:hidden")
    // A space inside a nowrap span is no break point: the separators sit outside them.
    for (const el of events.getByText("Account allowed").parentElement!.querySelectorAll(".whitespace-nowrap")) expect(el.textContent).not.toMatch(/·/)
  })

  it("a stale oracle says operations are blocked", async () => {
    mocks.fetchOracleView.mockResolvedValue(
      oracleView({ freshness: "stale", timeToBlock: { status: "live", value: -40, ledger: 1, sources: [src("get_reference_timestamp")] } }),
    )
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByText("0 of 1 fresh")).toBeTruthy()
    expect(safety.getByText("Not fresh: USDY (Stale)")).toBeTruthy()
    expect(safety.getByText("On a stale oracle's markets, mint, trade, single-sided liquidity and redemption are blocked")).toBeTruthy()
  })

  it("a Stale line decided by is_available() = false lists that read in How to verify, with the timestamp and max_stale reads (M-3)", async () => {
    mocks.fetchOracleView.mockResolvedValue(oracleView({ available: live(false, "is_available"), freshness: "stale" }))
    const user = userEvent.setup()
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByText("0 of 1 fresh")).toBeTruthy()
    expect(safety.getByText("Not fresh: USDY (Stale)")).toBeTruthy()
    await user.click(safety.getByRole("button", { name: "How to verify Oracle freshness" }))
    const drawer = await screen.findByRole("dialog")
    // The command is one span per word; its <code> reads as typed.
    const command = (fn: string) => within(drawer).queryAllByText((_, el) => el?.tagName === "CODE" && (el.textContent ?? "").endsWith(` --send=no -- ${fn}`))
    for (const fn of ["get_reference_timestamp", "max_stale_seconds", "is_available"]) expect(command(fn).length, fn).toBeGreaterThan(0)
  })

  it("an unreadable is_available() makes the oracle line Unavailable, with that read's reason (as the oracle page)", async () => {
    mocks.fetchOracleView.mockResolvedValue(oracleView({ available: down("is_available: rpc down") }))
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByRole("button", { name: "Why Oracle freshness is unavailable, and how to verify it" })).toBeTruthy()
    expect(safety.queryByText(/ of 1 fresh$/)).toBeNull()
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
    expect(screen.getAllByTestId("as-of")[0].textContent).toContain("Ledger 5720087")
    expect(screen.getByText("No fallback RPC configured")).toBeTruthy()
  })

  it("shows the RPC's host, never its URL: a keyed provider URL is not advertised", async () => {
    mocks.manifest = { ...baseManifest(), rpcUrl: "https://rpc.test/stellar/SECRET-PATH", rpcFallbackUrls: ["https://fb.test/KEY-PATH"] }
    const { container } = render(wrap(<Overview />))
    await screen.findByText("223,011.30 USDY")
    expect(screen.getByText("RPC rpc.test")).toBeTruthy()
    expect(screen.getByText("Fallback fb.test")).toBeTruthy()
    expect(container.textContent).not.toMatch(/SECRET-PATH|KEY-PATH/)
  })

  it("keeps a 375 px page from scrolling sideways: the page column may shrink below its content", () => {
    render(wrap(<Overview />))
    const section = screen.getByRole("heading", { level: 1, name: "Protocol overview" }).closest("section")
    expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
  })
})

/** Five markets, each with its own oracle (Mainnet's shape). */
const FIVE = [
  ["CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT", "MOCKUSDY"],
  ["CBTW7CU46PMCPKZQ3VX6OBELOEC7HHQXJSAX535VW3EK34MVS7UWPFR7", "MOCKUSTRY"],
  ["CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7", "MOCKGILTS"],
  ["CBK2GO7UPMES2B7LZYZXNO3JP5JPNIIE74E4PUUJGSZZKD4FZ47QMUZK", "MOCKCETES"],
  ["CDFI7IXUTGLV2EQE3VCHPCYOEBX2LSLXDKNU7ELJFZH726VDF73SOPFD", "MOCKXAUM"],
] as const
const fiveManifest = () => ({
  ...baseManifest(),
  markets: FIVE.map(([oracle, code], i) => market(`m${i}`, { code, decimals: 7, sac: `CSAC${i}` }, oracle)),
})

/** One oracle's view, its reads on that oracle; `left` seconds until operations block (3,600 s max stale). */
function viewOn(id: string, left: number, over: Record<string, unknown> = {}) {
  const on = <T,>(value: T, fn: string): Live<T> => ({ status: "live", value, ledger: 5_720_087, source: srcOn(id, fn) })
  return oracleView({
    contractId: id,
    timestamp: on(BigInt(LEDGER_TIME - (3_600 - left)), "get_reference_timestamp"),
    available: on(left >= 0, "is_available"),
    freshness: left < 0 ? "stale" : (3_600 - left) * 4 >= 3_600 * 3 ? "warning" : "fresh",
    timeToBlock: { status: "live", value: left, ledger: 5_720_087, sources: [srcOn(id, "get_reference_timestamp"), srcOn(id, "max_stale_seconds")] },
    maxStale: on(3_600n, "max_stale_seconds"),
    ...over,
  })
}

/** A failed read on oracle `id`, with the call it attempted. */
const downOn = (id: string, fn: string, error: string): Live<never> => ({ status: "unavailable", error, source: { contractId: id, fn, args: [], rpcUrl: RPC } })

/** The command block in `drawer` that reads `fn` on contract `id`. */
const command = (drawer: HTMLElement, id: string, fn: string) =>
  within(drawer).queryAllByText((_, el) => el?.tagName === "CODE" && (el.textContent ?? "").includes(`--id ${id} `) && (el.textContent ?? "").endsWith(` -- ${fn}`))

const by = (views: Record<string, unknown>) => async (_r: unknown, _m: unknown, oracle: string) => {
  if (!(oracle in views)) throw new Error(`no fixture for ${oracle}`)
  return views[oracle] instanceof Promise ? await views[oracle] : views[oracle]
}

describe("the overview with several oracles (plan 0009)", () => {
  beforeEach(() => {
    mocks.manifest = fiveManifest()
    mocks.seedCount = 5
  })

  it("3 fresh of 5: '3 of 5 fresh', the badge naming the worst state, the others named, a link to the oracle page", async () => {
    const [a, b, c, d, e] = FIVE.map(([id]) => id)
    mocks.fetchOracleView.mockImplementation(by({ [a]: viewOn(a, 2_892), [b]: viewOn(b, 3_000), [c]: viewOn(c, 600), [d]: viewOn(d, 3_500), [e]: viewOn(e, -40) }))
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByText("3 of 5 fresh")).toBeTruthy()
    const oracles = within(safety.getByText("Oracles", { selector: "dt" }).parentElement!)
    // Worst first: Stale over Warning over Fresh.
    expect(oracles.getByText("Stale")).toBeTruthy()
    expect(oracles.getByText("Not fresh: MOCKGILTS (Warning), MOCKXAUM (Stale)")).toBeTruthy()
    expect(oracles.getByText("On a stale oracle's markets, mint, trade, single-sided liquidity and redemption are blocked")).toBeTruthy()
    expect(oracles.getByRole("link", { name: "Each oracle" }).getAttribute("href")).toBe("/dashboard/oracle")
  })

  it("its How to verify drawer lists every oracle's inputs", async () => {
    const user = userEvent.setup()
    mocks.fetchOracleView.mockImplementation(by(Object.fromEntries(FIVE.map(([id]) => [id, viewOn(id, 2_892)]))))
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByText("5 of 5 fresh")).toBeTruthy()
    await user.click(safety.getByRole("button", { name: "How to verify Oracle freshness" }))
    const drawer = await screen.findByRole("dialog")
    for (const [id] of FIVE) for (const fn of ["get_reference_timestamp", "max_stale_seconds", "is_available"]) expect(command(drawer, id, fn).length, `${id} ${fn}`).toBe(1)
  })

  it("one oracle unread and one stale among five: the unread one is named apart with its reason, never as not fresh, and its call is in the drawer", async () => {
    const [a, b, c, d, e] = FIVE.map(([id]) => id)
    mocks.fetchOracleView.mockImplementation(
      by({ [a]: viewOn(a, 2_892), [b]: viewOn(b, 2_892), [c]: viewOn(c, -40), [d]: viewOn(d, 2_892), [e]: viewOn(e, 2_892, { available: downOn(e, "is_available", "rpc down") }) }),
    )
    const user = userEvent.setup()
    render(wrap(<Overview />))
    const safety = region("Safety")
    expect(await safety.findByText("3 of 5 fresh")).toBeTruthy()
    const oracles = within(safety.getByText("Oracles", { selector: "dt" }).parentElement!)
    // An oracle nobody could read colors the badge Unavailable.
    expect(oracles.getByText("Unavailable")).toBeTruthy()
    expect(oracles.getByText("Not fresh: MOCKGILTS (Stale)")).toBeTruthy()
    expect(oracles.getByText("Not read: MOCKXAUM (rpc down)")).toBeTruthy()
    expect(oracles.queryByText(/MOCKXAUM \(Unavailable\)/)).toBeNull()
    await user.click(safety.getByRole("button", { name: "How to verify Oracle freshness" }))
    const drawer = await screen.findByRole("dialog")
    // The failed read's attempted call, beside the others' reads.
    expect(command(drawer, e, "is_available")).toHaveLength(1)
    expect(command(drawer, a, "is_available")).toHaveLength(1)
    expect(within(drawer).getAllByText(/Not read: MOCKXAUM: rpc down/).length).toBeGreaterThan(0)
  })

  it("every oracle unread: the row is Unavailable, and its drawer gives each oracle's reason and attempted call", async () => {
    mocks.fetchOracleView.mockImplementation(by(Object.fromEntries(FIVE.map(([id], i) => [id, viewOn(id, 2_892, { available: downOn(id, "is_available", `rpc down ${i}`) })]))))
    const user = userEvent.setup()
    render(wrap(<Overview />))
    const safety = region("Safety")
    await user.click(await safety.findByRole("button", { name: "Why Oracle freshness is unavailable, and how to verify it" }))
    const drawer = await screen.findByRole("dialog")
    expect(within(drawer).getAllByText(/none of the 5 oracles could be read/).length).toBeGreaterThan(0)
    for (const [i, [id, code]] of FIVE.entries()) {
      expect(within(drawer).getAllByText(new RegExp(`${code}: rpc down ${i}`)).length).toBeGreaterThan(0)
      expect(command(drawer, id, "is_available"), code).toHaveLength(1)
    }
  })

  it("while any oracle is still being read, the row is a skeleton, never a partial count", async () => {
    const [a, b, c, d, e] = FIVE.map(([id]) => id)
    mocks.fetchOracleView.mockImplementation(by({ [a]: viewOn(a, 2_892), [b]: viewOn(b, 2_892), [c]: viewOn(c, 2_892), [d]: viewOn(d, 2_892), [e]: new Promise(() => {}) }))
    render(wrap(<Overview />))
    const safety = region("Safety")
    await safety.findByText("None paused")
    await waitFor(() => expect(mocks.fetchOracleView).toHaveBeenCalledTimes(5))
    expect(safety.queryByText(/ of 5 fresh$/)).toBeNull()
    expect(safety.getByText("Oracles", { selector: "dt" }).parentElement!.querySelector("[data-slot=skeleton]")).toBeTruthy()
  })

  it("4 listed of 5 seeds: '4 of 5 manifest markets listed'; all listed: just the count", async () => {
    mocks.fetchOracleView.mockImplementation(by(Object.fromEntries(FIVE.map(([id]) => [id, viewOn(id, 2_892)]))))
    mocks.manifest = { ...fiveManifest(), markets: fiveManifest().markets.slice(0, 4) }
    const first = render(wrap(<Overview />))
    expect(await region("Protocol totals").findByText("4 of 5 manifest markets listed")).toBeTruthy()
    first.unmount()
    mocks.manifest = fiveManifest()
    render(wrap(<Overview />))
    const totals = region("Protocol totals")
    expect(await totals.findByText("5")).toBeTruthy()
    expect(totals.queryByText(/manifest markets listed/)).toBeNull()
  })
})
