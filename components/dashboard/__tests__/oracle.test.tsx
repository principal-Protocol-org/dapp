import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Live, ReadSource } from "@/lib/protocol/types"

const RPC = "https://rpc.test"
const LEDGER_TIME = 1_800_000_000
const ORACLE = "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS"
const SIGNER = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const TX = "68be08ad3f0c4e2b9a1d7c5e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a"
const TX2 = "e9b077b453befd8e05293a57aa3ee4f5099a32e5e2829345b1124aa787506c9a"
const PRIMARY = "8f157e8dfc6b0bef22553de5a980e24fc7c7c9eacc8bccbb8df0f2cab866b3b4"
const PREIMAGE = "principal-oracle-source:testnet:USDY:app-team:keeper"
const OTHER = "cd".repeat(32)
const WASM_665 = "adb87f76c1bafd93c67489645fe49df771ede639edc0d1919233563ffae86bce"

const srcOn = (contractId: string, fn: string, args: unknown[] = [], ledger = 5_720_087): ReadSource => ({ contractId, fn, args, rawXdr: "AAAA", ledger, rpcUrl: RPC })
const src = (fn: string, ledger = 5_720_087): ReadSource => srcOn(ORACLE, fn, [], ledger)
const live = <T,>(value: T, fn = "f"): Live<T> => ({ status: "live", value, ledger: 5_720_087, source: src(fn) })
const liveOn = <T,>(contractId: string, value: T, fn: string): Live<T> => ({ status: "live", value, ledger: 5_720_087, source: srcOn(contractId, fn) })
const down = (error = "rpc down"): Live<never> => ({ status: "unavailable", error })

const mocks = vi.hoisted(() => ({
  manifest: {} as Record<string, unknown>,
  clock: { ledgerTime: 0 as number | null, sequence: 5_720_087 as number | null, isError: false } as {
    ledgerTime: number | null
    sequence: number | null
    isError: boolean
    sinceReadSeconds?: number | null
  },
  fetchOracleView: vi.fn(),
  fetch: vi.fn(),
  search: "",
}))

const baseManifest = () => ({
  network: "testnet",
  rpcUrl: RPC,
  markets: [{ marketId: "testnet-usdy-1802336344", displayName: "USDY", underlying: { code: "USDY", decimals: 7, sac: "CSAC" }, contracts: { pool: "CPOOL", oracle: ORACLE } }],
  shared: { oracle: ORACLE, riskControl: "CRISK", permissioning: "CPERM", router: "CROUTER" },
  oracleSources: [{ hash: PRIMARY, preimage: PREIMAGE }],
  wasmHashes: { oracle: WASM_665 },
})
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }))
vi.mock("@/lib/protocol/reader", async (importActual) => ({ ...(await importActual<object>()), createRpcReader: () => ({}) }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => mocks.clock, LEDGER_CLOCK_REFETCH_MS: 6_000 }))
vi.mock("@/lib/protocol/dashboard/oracle", async (importActual) => ({ ...(await importActual<object>()), fetchOracleView: mocks.fetchOracleView }))
// No wallet provider anywhere: a view that read the wallet would throw.
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => {
    throw new Error("the dashboard must not read the wallet")
  },
}))

import { lastRejectionNote } from "@/lib/protocol/dashboard/rejections"
import { OraclePanel } from "../oracle-panel"

/** The 665bb67 oracle of our Testnet market, 12 minutes after its last update. */
function oracleView(over: Record<string, unknown> = {}) {
  return {
    contractId: ORACLE,
    value: live(10_000_919n, "get_reference_value"),
    timestamp: live(BigInt(LEDGER_TIME - 720), "get_reference_timestamp"),
    available: live(true, "is_available"),
    freshness: "fresh",
    timeToBlock: { status: "live", value: 2_880, ledger: 5_720_087, sources: [src("get_reference_timestamp"), src("max_stale_seconds")] },
    maxStale: live(3_600n, "max_stale_seconds"),
    deviationBps: live(1_000n, "max_deviation_bps"),
    bounds: live(null, "value_bounds"),
    sources: {
      primary: { hash: live(PRIMARY, "get_primary_source"), preimage: PREIMAGE },
      fallback: { hash: live(null, "get_fallback_source") },
      active: { hash: live(PRIMARY, "get_active_source"), preimage: PREIMAGE },
    },
    path: { status: "unsupported", source: { contractId: ORACLE, fn: "last_update_was_feed", args: [], rpcUrl: RPC } },
    lastRejection: live(null, "last_rejection"),
    blockedWhenStale: ["mint", "trade", "single-sided liquidity", "redemption"],
    // 665bb67 has no feed views.
    feed: { status: "unsupported", source: { contractId: ORACLE, fn: "feed_source", args: [], rpcUrl: RPC } },
    feedMinInterval: { status: "unsupported", source: { contractId: ORACLE, fn: "feed_min_interval_seconds", args: [], rpcUrl: RPC } },
    feedPrice: null,
    ...over,
  }
}

/** The five Mainnet oracles (`config/manifests/mainnet.json`), one per market. */
const MAINNET_ORACLES = [
  ["CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT", "MOCKUSDY"],
  ["CBTW7CU46PMCPKZQ3VX6OBELOEC7HHQXJSAX535VW3EK34MVS7UWPFR7", "MOCKUSTRY"],
  ["CD22HNREJHKTATZMFKALCTHJVKC35MHO2SAUSTG4M6PWLJZPS724J6X7", "MOCKGILTS"],
  ["CBK2GO7UPMES2B7LZYZXNO3JP5JPNIIE74E4PUUJGSZZKD4FZ47QMUZK", "MOCKCETES"],
  ["CDFI7IXUTGLV2EQE3VCHPCYOEBX2LSLXDKNU7ELJFZH726VDF73SOPFD", "MOCKXAUM"],
] as const
const [O1, O2, O3, O4, O5] = MAINNET_ORACLES.map(([id]) => id)
const WASM_3AF = "8581bbba82bb57f5c5c9c00adf98b1691ad20821840e55a67ad8d7ecace0c1b0"
/** A SEP-40 feed contract: not in the manifest. */
const FEED = "CAL7LXAUKP634THLOVPESX4WBZKKONY2PZN4A2CJ6HM4JW6QKU5ILLCT"
const ASSET_ARG = { type: "enum", variant: "Other", value: { type: "symbol", value: "USDY" } }

const mainnetManifest = () => ({
  ...baseManifest(),
  network: "mainnet",
  markets: MAINNET_ORACLES.map(([oracle, code], i) => ({
    marketId: `mainnet-${i}`,
    displayName: code,
    underlying: { code, decimals: 7, sac: `CSAC${i}` },
    contracts: { pool: `CPOOL${i}`, oracle },
  })),
  shared: { oracle: O1, riskControl: "CRISK", permissioning: "CPERM", router: "CROUTER" },
  wasmHashes: { oracle: WASM_3AF },
})

/** The feed's price, `value` at 7 decimals (raw at 14), read on the feed contract. */
const feedPriceOf = (value: bigint, timestamp = BigInt(LEDGER_TIME - 90)) => ({
  status: "live",
  value: { raw: value * 10_000_000n, decimals: 14, value, timestamp },
  ledger: 5_720_087,
  sources: [srcOn(FEED, "decimals"), srcOn(FEED, "lastprice", [ASSET_ARG])],
})

/** The freshness reads of oracle `id`, each on that oracle: 12 minutes after its last update. */
const freshnessOn = (id: string) => ({
  timestamp: liveOn(id, BigInt(LEDGER_TIME - 720), "get_reference_timestamp"),
  available: liveOn(id, true, "is_available"),
  maxStale: liveOn(id, 3_600n, "max_stale_seconds"),
  timeToBlock: { status: "live", value: 2_880, ledger: 5_720_087, sources: [srcOn(id, "get_reference_timestamp"), srcOn(id, "max_stale_seconds")] },
})

/** A 3af9388 oracle reading a feed: its stored value and the feed's, both at 7 decimals. */
function feedOracle(id: string, stored: bigint, feed: bigint, over: Record<string, unknown> = {}) {
  return oracleView({
    contractId: id,
    value: liveOn(id, stored, "get_reference_value"),
    ...freshnessOn(id),
    path: liveOn(id, "feed", "last_update_was_feed"),
    feed: liveOn(id, { contract: FEED, asset: { kind: "Other", symbol: "USDY" } }, "feed_source"),
    feedMinInterval: liveOn(id, 300n, "feed_min_interval_seconds"),
    feedPrice: feedPriceOf(feed),
    ...over,
  })
}

/** A 3af9388 oracle with no feed source: updated by push. */
function noFeedOracle(id: string, stored: bigint) {
  return oracleView({
    contractId: id,
    value: liveOn(id, stored, "get_reference_value"),
    ...freshnessOn(id),
    path: liveOn(id, "push", "last_update_was_feed"),
    feed: liveOn(id, null, "feed_source"),
    feedMinInterval: liveOn(id, 300n, "feed_min_interval_seconds"),
    feedPrice: null,
  })
}

/**
 * A synthetic spread over the five Mainnet oracle ids, to cover each state the panel can show: one
 * oracle ten times its feed's price (Review Focus 5), one a little off it, one with no feed. It is
 * not the state of any real market: on the v2 deployment all five oracles name a feed and store
 * values at its price.
 */
const spreadViews = (): Record<string, unknown> => ({
  [O1]: feedOracle(O1, 108_065_700n, 10_807_670n),
  [O2]: feedOracle(O2, 11_534_743n, 11_535_907n),
  [O3]: feedOracle(O3, 13_370_000n, 13_370_000n),
  [O4]: feedOracle(O4, 5_000_000n, 500_000n),
  [O5]: noFeedOracle(O5, 26_000_000_000n),
})

/** `fetchOracleView(reader, manifest, oracle, ledgerTime)` answers per oracle. */
const viewsBy = (views: Record<string, unknown>) => async (_reader: unknown, _m: unknown, oracle: string) => {
  if (!(oracle in views)) throw new Error(`no fixture for ${oracle}`)
  return views[oracle]
}

const INDEX = {
  rows: [],
  indexedThrough: 5_719_749,
  indexedThroughCloseTime: new Date((LEDGER_TIME - 125) * 1000).toISOString(),
  lagSeconds: 125,
  gaps: [],
  reconcile: null,
}
let n = 0
const ev = (ledger: number, topic: string, data: Record<string, unknown>, txHash = TX) => ({
  id: `${String(ledger).padStart(19, "0")}-${String(n++).padStart(10, "0")}`,
  group: "oracle",
  contractId: ORACLE,
  topic,
  ledger,
  closeTime: "2027-01-15T07:48:05.000Z",
  txHash,
  pool: null,
  data,
})

const tick = (over: Record<string, unknown> = {}) => ({
  id: "9",
  at: new Date((LEDGER_TIME - 720) * 1000).toISOString(),
  oracle: ORACLE,
  mode: "push",
  decision: "pushed",
  value: "10000919",
  reason: null,
  txHash: TX2,
  signer: SIGNER,
  ...over,
})
const HEALTHY = {
  healthy: true,
  lastSuccessAt: new Date((LEDGER_TIME - 720) * 1000).toISOString(),
  lastOkAt: new Date((LEDGER_TIME - 720) * 1000).toISOString(),
  lastTickAt: new Date((LEDGER_TIME - 720) * 1000).toISOString(),
  rejected24h: 1,
  failures24h: 2,
}
/** `GET /api/dashboard/oracle-ticks?oracle=…`: the one oracle asked, in the per-oracle shape. */
const ticksAnswer = (ticks: unknown[], health: Record<string, unknown> = HEALTHY) =>
  Response.json({ intervalSeconds: 1_800, oracles: [{ oracle: ORACLE, asset: "USDY", health, ticks }] })

type Answers = { rejections?: unknown[]; updates?: unknown[]; ticks?: () => Response }
let answers: Answers = {}

function answer(url: string): Response {
  if (url.startsWith("/api/dashboard/oracle-ticks"))
    return answers.ticks ? answers.ticks() : ticksAnswer([tick()])
  if (url.includes("topic=ref_rej")) return Response.json({ ...INDEX, rows: answers.rejections ?? [] })
  if (url.includes("topic=ref_set")) return Response.json({ ...INDEX, rows: answers.updates ?? [] })
  return Response.json(INDEX)
}

let client: QueryClient
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>

beforeEach(() => {
  answers = {}
  mocks.manifest = baseManifest()
  mocks.search = ""
  window.history.replaceState(null, "", "/dashboard/oracle")
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.clock = { ledgerTime: LEDGER_TIME, sequence: 5_720_087, isError: false }
  mocks.fetchOracleView.mockReset().mockResolvedValue(oracleView())
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
/** A row's value: the `dd` under the `dt` with this label. */
const row = (scope: ReturnType<typeof within>, label: string) => scope.getByText(label, { selector: "dt" }).parentElement?.querySelector("dd")?.textContent ?? ""

describe("the oracle page (/dashboard/oracle, D-17)", () => {
  it("shows the value, its timestamp, its freshness and the time until operations block, each with its drawer", async () => {
    render(wrap(<OraclePanel />))
    expect(screen.getByRole("heading", { level: 1, name: "Oracle" })).toBeTruthy()
    const value = region("Reference value")
    expect(await value.findByText("1.0000919")).toBeTruthy()
    expect(row(value, "Timestamp")).toContain("2027-01-15 07:48:00 UTC")
    expect(row(value, "Timestamp")).toContain("12m 0s ago on the ledger clock")
    expect(row(value, "Freshness")).toContain("Fresh")
    expect(row(value, "Freshness")).toContain("age 12m 0s of 1 hour")
    expect(row(value, "Time until operations block")).toContain("48m 0s")
    for (const label of ["Reference value", "Oracle timestamp", "Freshness", "Time until operations block"])
      expect(value.getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
    // Verbatim (ruling 4).
    expect(value.getByText("Operations blocked when stale: mint, trades, single-sided liquidity, redemption")).toBeTruthy()
  })

  it("the countdown follows the ledger clock (ledger time plus elapsed seconds), never the browser's wall clock alone", async () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(5_000_000_000_000)
    try {
      const { rerender } = render(wrap(<OraclePanel />))
      const value = region("Reference value")
      await value.findByText("1.0000919")
      expect(row(value, "Time until operations block")).toContain("48m 0s")
      // The browser's clock jumps an hour: nothing moves.
      wall.mockReturnValue(5_000_003_600_000)
      rerender(wrap(<OraclePanel />))
      expect(row(value, "Time until operations block")).toContain("48m 0s")
      // The ledger clock ticks 7 s: the countdown follows it, as does the freshness age.
      mocks.clock = { ...mocks.clock, ledgerTime: LEDGER_TIME + 7 }
      rerender(wrap(<OraclePanel />))
      expect(row(value, "Time until operations block")).toContain("47m 53s")
      expect(row(value, "Freshness")).toContain("age 12m 7s")
    } finally {
      wall.mockRestore()
    }
  })

  it("Warning from 75% of max_stale, Stale past it (operations blocked), as the ledger clock moves", async () => {
    const { rerender } = render(wrap(<OraclePanel />))
    const value = region("Reference value")
    await value.findByText("1.0000919")
    // Age 2,699 s: still Fresh. 2,700 s (75%): Warning.
    mocks.clock = { ...mocks.clock, ledgerTime: LEDGER_TIME + 2_699 - 720 }
    rerender(wrap(<OraclePanel />))
    expect(row(value, "Freshness")).toMatch(/^Fresh/)
    mocks.clock = { ...mocks.clock, ledgerTime: LEDGER_TIME + 2_700 - 720 }
    rerender(wrap(<OraclePanel />))
    expect(row(value, "Freshness")).toMatch(/^Warning/)
    // Exactly max_stale: the contract still counts it fresh (age <= max), so Warning; 1 s later, Stale.
    mocks.clock = { ...mocks.clock, ledgerTime: LEDGER_TIME + 3_600 - 720 }
    rerender(wrap(<OraclePanel />))
    expect(row(value, "Freshness")).toMatch(/^Warning/)
    expect(row(value, "Time until operations block")).toContain("0s")
    mocks.clock = { ...mocks.clock, ledgerTime: LEDGER_TIME + 3_642 - 720 }
    rerender(wrap(<OraclePanel />))
    expect(row(value, "Freshness")).toMatch(/^Stale/)
    expect(row(value, "Time until operations block")).toContain("Blocked for 42s")
  })

  it("the contract's own is_available false reads Stale, whatever the clock", async () => {
    mocks.fetchOracleView.mockResolvedValue(oracleView({ available: live(false, "is_available"), freshness: "stale" }))
    render(wrap(<OraclePanel />))
    const value = region("Reference value")
    await value.findByText("1.0000919")
    expect(row(value, "Freshness")).toMatch(/^Stale/)
  })

  it("Unavailable, with the reason, without a ledger clock, or when the figures cannot be read", async () => {
    mocks.clock = { ledgerTime: null, sequence: null, isError: true }
    const { unmount } = render(wrap(<OraclePanel />))
    const value = region("Reference value")
    expect(await value.findAllByRole("button", { name: /^Why .* is unavailable/ })).toHaveLength(4)
    expect(row(value, "Freshness")).toBe("Unavailable")
    unmount()

    mocks.clock = { ledgerTime: LEDGER_TIME, sequence: 5_720_087, isError: false }
    mocks.fetchOracleView.mockResolvedValue(oracleView({ value: down("HostError: boom"), timestamp: down("HostError: boom"), freshness: "unavailable", timeToBlock: down("HostError: boom") }))
    render(wrap(<OraclePanel />))
    const again = region("Reference value")
    expect(await again.findByRole("button", { name: "Why Reference value is unavailable, and how to verify it" })).toBeTruthy()
    expect(row(again, "Freshness")).toBe("Unavailable")
  })

  it("after a failed refresh the old read is never shown as current: every figure is Unavailable with the reason (oracle.stale)", async () => {
    const user = userEvent.setup()
    render(wrap(<OraclePanel />))
    const value = region("Reference value")
    expect(await value.findByText("1.0000919")).toBeTruthy()
    // The refetch fails; React Query keeps the old data, flagged stale.
    mocks.fetchOracleView.mockRejectedValue(new Error("rpc down"))
    await act(() => client.refetchQueries({ queryKey: ["dashboard", "oracle"] }))
    expect(await value.findByRole("button", { name: "Why Reference value is unavailable, and how to verify it" })).toBeTruthy()
    expect(value.queryByText("1.0000919")).toBeNull()
    expect(row(value, "Freshness")).toBe("Unavailable")
    expect(row(value, "Time until operations block")).toBe("Unavailable")
    expect(row(region("Policy"), "Max stale")).toBe("Unavailable")
    expect(region("Update path").queryByText("Not supported by this oracle's code")).toBeNull()
    await user.click(value.getByRole("button", { name: "Why Reference value is unavailable, and how to verify it" }))
    expect((await screen.findAllByText(/the last refresh failed: rpc down/)).length).toBeGreaterThan(0)
  })

  it("one rounding: with a ledger clock between seconds, the timestamp's age, the freshness age and the countdown agree", async () => {
    mocks.clock = { ...mocks.clock, ledgerTime: LEDGER_TIME + 0.5 }
    render(wrap(<OraclePanel />))
    const value = region("Reference value")
    await value.findByText("1.0000919")
    // The view was read at ledger time LEDGER_TIME + 0.5 (floored by fetchOracleView); now is the same instant.
    expect(row(value, "Timestamp")).toContain("12m 0s ago")
    expect(row(value, "Freshness")).toContain("age 12m 0s of 1 hour")
    expect(row(value, "Time until operations block")).toContain("48m 0s")
  })

  it("marks the countdown when the ledger clock has not been refreshed for over 2 × its cadence (12 s)", async () => {
    mocks.clock = { ...mocks.clock, isError: true, sinceReadSeconds: 12 }
    const { rerender } = render(wrap(<OraclePanel />))
    const value = region("Reference value")
    await value.findByText("1.0000919")
    expect(row(value, "Time until operations block")).not.toContain("not refreshed")
    mocks.clock = { ...mocks.clock, isError: true, sinceReadSeconds: 15.4 }
    rerender(wrap(<OraclePanel />))
    expect(row(value, "Time until operations block")).toContain("Ledger clock not refreshed for 15s")
    // Read again: the marker goes.
    mocks.clock = { ...mocks.clock, isError: false, sinceReadSeconds: 1 }
    rerender(wrap(<OraclePanel />))
    expect(row(value, "Time until operations block")).not.toContain("not refreshed")
  })

  it("shows the policy and the value bounds", async () => {
    render(wrap(<OraclePanel />))
    const policy = region("Policy")
    expect(await policy.findByText("3,600 s (1 hour)")).toBeTruthy()
    expect(policy.getByText("10.00% per update (1000 bps)")).toBeTruthy()
    expect(policy.getByText("None set")).toBeTruthy()
    for (const label of ["Max stale", "Deviation cap", "Value bounds"]) expect(policy.getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
  })

  it("shows set value bounds as a range", async () => {
    mocks.fetchOracleView.mockResolvedValue(oracleView({ bounds: live({ min: 5_000_000n, max: 20_000_000n }, "value_bounds") }))
    render(wrap(<OraclePanel />))
    expect(await region("Policy").findByText("0.5000000 to 2.0000000")).toBeTruthy()
  })

  it("shows the primary, fallback and active sources, with the manifest's preimage and the command that hashes it", async () => {
    mocks.fetchOracleView.mockResolvedValue(
      oracleView({ sources: { primary: { hash: live(PRIMARY, "get_primary_source"), preimage: PREIMAGE }, fallback: { hash: live(null) }, active: { hash: live(OTHER, "get_active_source") } } }),
    )
    render(wrap(<OraclePanel />))
    const sources = region("Sources")
    expect((await sources.findAllByText(PRIMARY)).length).toBe(1)
    expect(row(sources, "Primary source")).toContain(`Preimage ${PREIMAGE}`)
    expect(sources.getByText(`printf %s '${PREIMAGE}' | shasum -a 256`)).toBeTruthy()
    expect(row(sources, "Fallback source")).toBe("None set")
    expect(row(sources, "Active source")).toContain(OTHER)
    expect(row(sources, "Active source")).toContain("No preimage in the manifest")
    for (const label of ["Primary source", "Fallback source", "Active source"]) expect(sources.getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
  })

  it("the path: Not supported by this oracle's code, with a drawer giving the call that shows it", async () => {
    const user = userEvent.setup()
    render(wrap(<OraclePanel />))
    const path = region("Update path")
    expect(await path.findByText("Not supported by this oracle's code")).toBeTruthy()
    await user.click(path.getByRole("button", { name: "How to verify Update path" }))
    const drawer = await screen.findByRole("dialog")
    // The command is one span per word; its <code> reads as typed.
    const command = within(drawer).getAllByText((_, el) => el?.tagName === "CODE" && / --send=no -- last_update_was_feed$/.test(el.textContent ?? ""))
    expect(command[0].textContent).toContain(`--id ${ORACLE}`)
    expect(within(drawer).getAllByText(/MissingValue/).length).toBeGreaterThan(0)
  })

  it("the path: push or feed when the oracle's code has the view; Active source only on push (after a feed sync it still names the last push source)", async () => {
    mocks.fetchOracleView.mockResolvedValue(oracleView({ path: live("feed", "last_update_was_feed") }))
    const first = render(wrap(<OraclePanel />))
    const path = region("Update path")
    expect(await path.findByText("Feed: the oracle read its feed (sync_from_feed)")).toBeTruthy()
    expect(path.getByRole("button", { name: "How to verify Update path" })).toBeTruthy()
    const sources = region("Sources")
    expect(sources.queryByText("Active source", { selector: "dt" })).toBeNull()
    expect(sources.queryByRole("button", { name: "How to verify Active source" })).toBeNull()
    expect(row(sources, "Primary source")).toContain(PRIMARY)
    first.unmount()
    client.clear()

    mocks.fetchOracleView.mockResolvedValue(oracleView({ path: live("push", "last_update_was_feed") }))
    const second = render(wrap(<OraclePanel />))
    expect(await region("Update path").findByText("Push: the value was set by the oracle's admin (set_reference_value)")).toBeTruthy()
    expect(row(region("Sources"), "Active source")).toContain(PRIMARY)
    second.unmount()
    client.clear()

    // The path could not be read: whether the value came from the feed is not known, so Active source stays.
    mocks.fetchOracleView.mockResolvedValue(oracleView({ path: down("HostError: boom") }))
    render(wrap(<OraclePanel />))
    expect(await region("Update path").findByRole("button", { name: "Why Update path is unavailable, and how to verify it" })).toBeTruthy()
    expect(row(region("Sources"), "Active source")).toContain(PRIMARY)
  })

  it("the last rejection, worded (rejectionText), with its reason symbol and the note for this oracle's wasm", async () => {
    mocks.fetchOracleView.mockResolvedValue(oracleView({ lastRejection: live({ reason: "deviate", value: 12_000_000n, timestamp: BigInt(LEDGER_TIME - 300) }, "last_rejection") }))
    render(wrap(<OraclePanel />))
    const last = region("Last rejection")
    expect(await last.findByText("Moved more than the cap · value 1.2000000 · dated 2027-01-15 07:55:00 UTC")).toBeTruthy()
    expect(last.getByText(/reason deviate · significant/)).toBeTruthy()
    expect(last.getByText(lastRejectionNote(WASM_665))).toBeTruthy()
    expect(last.getByRole("button", { name: "How to verify Last rejection" })).toBeTruthy()
  })

  it("a feed reason and an unknown one: worded, or shown raw; none recorded reads None", async () => {
    mocks.fetchOracleView.mockResolvedValue(oracleView({ lastRejection: live({ reason: "no_data", value: 0n, timestamp: BigInt(LEDGER_TIME) }, "last_rejection") }))
    const { unmount } = render(wrap(<OraclePanel />))
    expect(await region("Last rejection").findByText(/^The feed had no price/)).toBeTruthy()
    unmount()
    client.clear()
    mocks.fetchOracleView.mockResolvedValue(oracleView({ lastRejection: live({ reason: "brand_new", value: 0n, timestamp: BigInt(LEDGER_TIME) }, "last_rejection") }))
    const second = render(wrap(<OraclePanel />))
    expect(await region("Last rejection").findByText(/^brand_new · value/)).toBeTruthy()
    second.unmount()
    client.clear()
    mocks.fetchOracleView.mockResolvedValue(oracleView())
    render(wrap(<OraclePanel />))
    expect(await region("Last rejection").findByText("None recorded")).toBeTruthy()
  })

  it("an oracle wasm the dashboard does not know gets the hedged note", async () => {
    mocks.manifest = { ...baseManifest(), wasmHashes: {} }
    render(wrap(<OraclePanel />))
    expect(await region("Last rejection").findByText(lastRejectionNote(""))).toBeTruthy()
  })

  it("the rejection and update histories, from the index (?topic=), each row with its tx link", async () => {
    answers.rejections = [ev(5_719_600, "ref_rej", { value: "12000000", timestamp: "1799999280", reason: "deviate" })]
    answers.updates = [ev(5_719_592, "ref_set", { value: "10000919", timestamp: "1799999280" }, TX2)]
    render(wrap(<OraclePanel />))
    const rejections = region("Rejection history")
    expect(await rejections.findByText("Moved more than the cap")).toBeTruthy()
    expect(rejections.getByText(/value 1\.2000000 · dated 2027-01-15 07:48:00 UTC · reason deviate/)).toBeTruthy()
    expect(rejections.getAllByRole("link", { name: `View transaction ${TX} on stellar.expert` })[0].getAttribute("href")).toContain(TX)
    const updates = region("Update history")
    expect(await updates.findByText("Value set to 1.0000919")).toBeTruthy()
    expect(updates.getAllByRole("link", { name: `View transaction ${TX2} on stellar.expert` }).length).toBeGreaterThan(0)
    const urls = mocks.fetch.mock.calls.map((c) => String(c[0]))
    // This oracle's history only: the events API's contract filter.
    expect(urls.some((u) => u.includes("group=oracle") && u.includes(`contract=${ORACLE}`) && u.includes("topic=ref_rej"))).toBe(true)
    expect(urls.some((u) => u.includes("group=oracle") && u.includes(`contract=${ORACLE}`) && u.includes("topic=ref_set"))).toBe(true)
  })

  it("empty histories read their plain text, never an error", async () => {
    render(wrap(<OraclePanel />))
    expect(await region("Rejection history").findByText("No rejection indexed yet")).toBeTruthy()
    expect(await region("Update history").findByText("No update indexed yet")).toBeTruthy()
  })
})

describe("the keeper's health on the oracle page (D-19)", () => {
  it("healthy: the last success, the rejected and failed runs of 24 h, and the recent runs with their tx and signer", async () => {
    answers.ticks = () =>
      ticksAnswer([
          tick(),
          tick({ id: "8", decision: "rejected", value: "12000000", reason: "deviate", txHash: TX }),
          tick({ id: "7", decision: "error", value: null, reason: "failed: TypeError", txHash: null }),
          tick({ id: "6", decision: "skipped", txHash: null }),
          tick({ id: "5", decision: "error", value: null, reason: "not_configured: ORACLE_ADMIN_SECRET is not set.", txHash: null, signer: null }),
          // Feed mode (D-21): a routine rejection is skipped and keeps its reason.
          tick({ id: "4", mode: "feed", decision: "skipped", reason: "stale_ts", txHash: null }),
          tick({ id: "3", mode: "feed", decision: "skipped", value: null, reason: "no_data", txHash: null }),
          tick({ id: "2", mode: "feed", decision: "skipped", value: null, reason: "throttle", txHash: null }),
          tick({ id: "1", mode: "feed", decision: "skipped", value: null, reason: "no_feed", txHash: null }),
          tick({ id: "0", mode: "feed", decision: "skipped", value: null, reason: null, txHash: null }),
        ])
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Healthy")).toBeTruthy()
    expect(row(keeper, "Last successful update")).toContain("2027-01-15 07:48:00 UTC")
    expect(row(keeper, "Last successful update")).toContain("12m ago")
    expect(row(keeper, "Rejected runs (24 h)")).toBe("1")
    expect(row(keeper, "Failed runs (24 h)")).toBe("2")
    expect(keeper.getByText(/Healthy while the last run that did not fail is under 1 hour old: twice the keeper's schedule, every 30 minutes\./)).toBeTruthy()
    // The panel asks for its own oracle only.
    expect(mocks.fetch.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/dashboard/oracle-ticks"))).toEqual([`/api/dashboard/oracle-ticks?oracle=${ORACLE}&limit=20`])
    const runs = keeper.getByRole("table", { name: "Recent keeper runs" })
    expect(within(runs).getByText("Pushed")).toBeTruthy()
    expect(within(runs).getByText("Rejected: Moved more than the cap")).toBeTruthy()
    expect(within(runs).getByText("Failed: TypeError")).toBeTruthy()
    // A push run that changed nothing: the value was already current (push mode is untouched on Testnet).
    expect(within(runs).getByText("Skipped: the value was already current")).toBeTruthy()
    // Feed mode, by reason: no feed source, the minimum interval, otherwise nothing newer (stale_ts, no_data, none).
    expect(within(runs).getByText("Skipped: no feed source")).toBeTruthy()
    expect(within(runs).getByText("Skipped: too soon after the last accepted update")).toBeTruthy()
    expect(within(runs).getAllByText("Skipped: the feed had nothing newer")).toHaveLength(3)
    expect(within(runs).queryByText("Skipped: Not newer than the current value")).toBeNull()
    expect(within(runs).getByText("Not configured: ORACLE_ADMIN_SECRET is not set.")).toBeTruthy()
    expect(within(runs).getAllByRole("link", { name: `View transaction ${TX2} on stellar.expert` }).length).toBeGreaterThan(0)
    expect(within(runs).getAllByTitle(SIGNER).length).toBeGreaterThan(0)
    // The raw telemetry of this oracle.
    expect(keeper.getByRole("link", { name: /oracle-ticks/ }).getAttribute("href")).toBe(`/api/dashboard/oracle-ticks?oracle=${ORACLE}&limit=100`)
  })

  it("the badge follows the ledger clock, not the cached answer: healthy:true but a last run without an error 3,600 s old reads Unhealthy", async () => {
    // The API answer is cached up to ~6 min: it said healthy when it was computed.
    const at = (ageSeconds: number) => new Date((LEDGER_TIME - ageSeconds) * 1000).toISOString()
    answers.ticks = () => ticksAnswer([tick({ at: at(3_600) })], { ...HEALTHY, healthy: true, lastSuccessAt: at(3_600), lastOkAt: at(3_600), lastTickAt: at(3_600) })
    const { unmount } = render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Unhealthy")).toBeTruthy()
    expect(keeper.queryByText("Healthy")).toBeNull()
    expect(row(keeper, "Last successful update")).toContain("1h 0m ago")
    unmount()
    client.clear()
    // 3,599 s: still healthy, even if the cached answer said otherwise.
    answers.ticks = () => ticksAnswer([tick({ at: at(3_599) })], { ...HEALTHY, healthy: false, lastSuccessAt: at(3_599), lastOkAt: at(3_599), lastTickAt: at(3_599) })
    render(wrap(<OraclePanel />))
    expect(await region("Keeper").findByText("Healthy")).toBeTruthy()
  })

  it("health follows the last run without an error (M-15), not the last update: a feed run that changed nothing keeps it healthy", async () => {
    const at = (ageSeconds: number) => new Date((LEDGER_TIME - ageSeconds) * 1000).toISOString()
    answers.ticks = () => ticksAnswer([tick({ mode: "feed", decision: "skipped", reason: "stale_ts", at: at(300) })], { ...HEALTHY, healthy: true, lastSuccessAt: at(86_000), lastOkAt: at(300), lastTickAt: at(300) })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Healthy")).toBeTruthy()
    expect(row(keeper, "Last successful update")).toContain("23h")
  })

  it("unhealthy when the last run without an error is too old, or there is none", async () => {
    answers.ticks = () => ticksAnswer([tick({ decision: "error", reason: "failed: Error", txHash: null })], { ...HEALTHY, healthy: false, lastSuccessAt: null, lastOkAt: null })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Unhealthy")).toBeTruthy()
    expect(row(keeper, "Last successful update")).toBe("None recorded")
  })

  it("no run recorded: a neutral 'No keeper run recorded yet', neither healthy nor unhealthy, and no skeleton", async () => {
    answers.ticks = () => ticksAnswer([], { healthy: false, lastSuccessAt: null, lastOkAt: null, lastTickAt: null, rejected24h: 0, failures24h: 0 })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect((await keeper.findAllByText("No keeper run recorded yet")).length).toBeGreaterThan(0)
    expect(keeper.queryByText("Unhealthy")).toBeNull()
    expect(keeper.queryByText("Healthy")).toBeNull()
    expect(screen.getByRole("region", { name: "Keeper" }).querySelector("[data-slot=skeleton]")).toBeNull()
  })

  it("telemetry the server cannot give is Unavailable, with the reason", async () => {
    answers.ticks = () => Response.json({ error: "not_configured" }, { status: 503 })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    // The telemetry query retries once (1 s) before it shows Unavailable.
    expect(await keeper.findByRole("button", { name: /Keeper health/ }, { timeout: 3_000 })).toBeTruthy()
    expect(keeper.getByText("Unavailable")).toBeTruthy()
  })

  it("an answer without this oracle's entry is Unavailable, never read as healthy", async () => {
    answers.ticks = () => Response.json({ intervalSeconds: 1_800, oracles: [{ oracle: "CBTW7CU46PMCPKZQ3VX6OBELOEC7HHQXJSAX535VW3EK34MVS7UWPFR7", asset: "USTRY", health: HEALTHY, ticks: [] }] })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByRole("button", { name: /Keeper health/ })).toBeTruthy()
    expect(keeper.getByText("Unavailable")).toBeTruthy()
    expect(keeper.queryByText("Healthy")).toBeNull()
  })

  it("an answer not in the expected shape is refused, never read as healthy", async () => {
    answers.ticks = () => Response.json({ ticks: "nope", health: HEALTHY })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Unavailable")).toBeTruthy()
    expect(keeper.queryByText("Healthy")).toBeNull()
  })
})

/** The Oracles table's body rows. */
const oracleRows = async () => within(await screen.findByRole("table", { name: "Oracles" })).getAllByRole("row").slice(1)

/** A `<code>` command in `scope` whose text matches `re` (the command is one span per word). */
const commands = (scope: HTMLElement, re: RegExp) => within(scope).queryAllByText((_, el) => el?.tagName === "CODE" && re.test(el.textContent ?? ""))

/** No fixed width in `el` or below: only shrinkable boxes (min-w-0, w-full, w-fit, max widths), as the 375 px rule needs. */
function expectNoFixedWidth(el: HTMLElement) {
  expect(el.className).toContain("min-w-0")
  for (const child of el.querySelectorAll("*")) expect(child.getAttribute("class") ?? "").not.toMatch(/(^|\s)(min-w|w)-(\[|[1-9]|px\b)/)
}

describe("every oracle of the manifest (plan 0009: five on Mainnet)", () => {
  beforeEach(() => {
    mocks.manifest = mainnetManifest()
    mocks.fetchOracleView.mockImplementation(viewsBy(spreadViews()))
  })

  it("says its cadence: 15 s on Testnet, 1 min on Mainnet (the public RPC's read allowance)", async () => {
    const cadence = async () => {
      await oracleRows()
      return {
        table: screen.getByText(/^One per market, each read live every/).textContent,
        detail: screen.getByText(/· refreshes every/).textContent?.replace(/^.*· refreshes every/, "refreshes every"),
        asOf: (await screen.findAllByTestId("as-of")).map((p) => p.textContent?.match(/Refreshes every [^·]*/)?.[0]),
      }
    }
    render(wrap(<OraclePanel />))
    expect(await cadence()).toEqual({
      table: "One per market, each read live every 1 min. Pick one to see it in detail below.",
      detail: "refreshes every 1 min; the countdown follows the ledger clock",
      asOf: ["Refreshes every 1 min"],
    })
    cleanup()
    mocks.manifest = { ...mainnetManifest(), network: "testnet" }
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(wrap(<OraclePanel />))
    expect(await cadence()).toEqual({
      table: "One per market, each read live every 15 s. Pick one to see it in detail below.",
      detail: "refreshes every 15 s; the countdown follows the ledger clock",
      asOf: ["Refreshes every 15 s"],
    })
  })

  it("an Oracles table lists the five, one row each linking to ?oracle=<id>, with its state, countdown and path; the first is shown below", async () => {
    render(wrap(<OraclePanel />))
    const rows = await oracleRows()
    expect(rows).toHaveLength(5)
    for (const [i, [id, code]] of MAINNET_ORACLES.entries()) {
      const link = within(rows[i]).getByRole("link", { name: code })
      expect(link.getAttribute("href")).toBe(`/dashboard/oracle?oracle=${id}`)
      expect(within(rows[i]).getByTitle(id).textContent).toBe(`${id.slice(0, 4)}…${id.slice(-4)}`)
    }
    await waitFor(() => expect(within(rows[0]).getAllByText("Fresh").length).toBeGreaterThan(0))
    expect(within(rows[0]).getAllByText("48m 0s").length).toBeGreaterThan(0)
    expect(within(rows[0]).getAllByText("Feed").length).toBeGreaterThan(0)
    expect(within(rows[4]).getAllByText("Push").length).toBeGreaterThan(0)
    // The first is selected by default.
    expect(within(rows[0]).getByRole("link", { name: "MOCKUSDY" }).getAttribute("aria-current")).toBe("true")
    expect(within(rows[1]).getByRole("link", { name: "MOCKUSTRY" }).getAttribute("aria-current")).toBeNull()
    expect(await region("Reference value").findByText("10.8065700")).toBeTruthy()
    // One read per oracle: the detail reuses the selected oracle's query.
    expect(mocks.fetchOracleView.mock.calls.map((c) => c[2]).sort()).toEqual(MAINNET_ORACLES.map(([id]) => id).sort())
  })

  it("a stale oracle reads Stale in the list, and one that cannot be read Unavailable with its reason", async () => {
    mocks.fetchOracleView.mockImplementation(
      viewsBy({
        ...spreadViews(),
        [O2]: feedOracle(O2, 11_534_743n, 11_535_907n, { available: liveOn(O2, false, "is_available"), freshness: "stale", timeToBlock: { status: "live", value: -40, ledger: 1, sources: [srcOn(O2, "get_reference_timestamp")] } }),
        [O4]: feedOracle(O4, 5_000_000n, 500_000n, { timestamp: down("HostError: boom"), freshness: "unavailable", timeToBlock: down("HostError: boom") }),
      }),
    )
    render(wrap(<OraclePanel />))
    const rows = await oracleRows()
    await waitFor(() => expect(within(rows[1]).getAllByText("Stale").length).toBeGreaterThan(1))
    expect(within(rows[3]).getAllByText("Unavailable").length).toBeGreaterThan(0)
    // Its drawer says why, and gives the call that failed.
    expect(within(rows[3]).getAllByRole("button", { name: "Why Freshness · MOCKCETES is unavailable, and how to verify it" }).length).toBeGreaterThan(0)
  })

  it("every figure in the table opens its drawer, whose commands name that row's oracle", async () => {
    const user = userEvent.setup()
    render(wrap(<OraclePanel />))
    const rows = await oracleRows()
    await waitFor(() => expect(within(rows[0]).getAllByText("Fresh").length).toBeGreaterThan(0))
    const open = async (name: string) => {
      await user.click(screen.getAllByRole("button", { name })[0])
      return screen.findByRole("dialog")
    }
    const close = async () => {
      await user.keyboard("{Escape}")
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    }
    for (const [id, code] of MAINNET_ORACLES) {
      const state = await open(`How to verify Freshness · ${code}`)
      for (const fn of ["get_reference_timestamp", "max_stale_seconds", "is_available"]) expect(commands(state, new RegExp(`--id ${id} .* -- ${fn}$`)), `${code} ${fn}`).toHaveLength(1)
      await close()
      const countdown = await open(`How to verify Time until operations block · ${code}`)
      expect(commands(countdown, new RegExp(`--id ${id} .* -- get_reference_timestamp$`))).toHaveLength(1)
      await close()
      const path = await open(`How to verify Update path · ${code}`)
      expect(commands(path, new RegExp(`--id ${id} .* -- last_update_was_feed$`))).toHaveLength(1)
      // Another oracle's id never appears in this row's commands.
      expect(commands(path, /--id /).every((c) => (c.textContent ?? "").includes(`--id ${id} `))).toBe(true)
      await close()
    }
  })

  it("the copied evidence table covers every oracle's state, countdown and path, labelled with its asset", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true })
    render(wrap(<OraclePanel />))
    const rows = await oracleRows()
    await waitFor(() => expect(within(rows[4]).getAllByText("Fresh").length).toBeGreaterThan(0))
    await region("Feed").findByText("Differs by a factor of 10.0")
    await user.click(screen.getByRole("button", { name: "Copy evidence table" }))
    const lines = String(writeText.mock.calls[0][0]).split("\n")
    for (const [id, code] of MAINNET_ORACLES) {
      for (const label of ["Freshness", "Time until operations block", "Update path"]) {
        const line = lines.filter((l) => l.startsWith(`| ${label} · ${code} |`))
        expect(line, `${label} · ${code}`).toHaveLength(1)
        expect(line[0]).toContain(id)
      }
    }
    // The selected oracle's own figures are still there.
    expect(lines.some((l) => l.startsWith("| Stored value against feed |"))).toBe(true)
  })

  it("a stored value of zero or below: the comparison is Unavailable with the get_reference_value call and a plain reason", async () => {
    const user = userEvent.setup()
    mocks.fetchOracleView.mockImplementation(viewsBy({ ...spreadViews(), [O1]: feedOracle(O1, 0n, 10_807_670n) }))
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    await user.click(await feed.findByRole("button", { name: "Why Stored value against feed is unavailable, and how to verify it" }))
    const drawer = await screen.findByRole("dialog")
    expect(within(drawer).getAllByText(/The stored value is not positive, so it has no ratio to the feed's price/).length).toBeGreaterThan(0)
    expect(commands(drawer, new RegExp(`--id ${O1} .* -- get_reference_value$`))).toHaveLength(1)
  })

  it("an interval of 0 reads No minimum; a Stellar asset key reads Stellar and the short address, the full one in its title", async () => {
    const SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
    mocks.fetchOracleView.mockImplementation(
      viewsBy({
        ...spreadViews(),
        [O1]: feedOracle(O1, 10_000_000n, 10_000_000n, {
          feedMinInterval: liveOn(O1, 0n, "feed_min_interval_seconds"),
          feed: liveOn(O1, { contract: FEED, asset: { kind: "Stellar", address: SAC } }, "feed_source"),
        }),
      }),
    )
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    expect(await feed.findByText("No minimum")).toBeTruthy()
    expect(row(feed, "Asset key")).toBe("Stellar CDLZ…CYSC")
    expect(feed.getByTitle(SAC).textContent).toBe("Stellar CDLZ…CYSC")
  })

  it("each Feed figure's drawer gives the commands of its own reads", async () => {
    const user = userEvent.setup()
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    await feed.findByText("Differs by a factor of 10.0")
    const drawerFor = async (label: string) => {
      await user.click(feed.getByRole("button", { name: `How to verify ${label}` }))
      return screen.findByRole("dialog")
    }
    const close = async () => {
      await user.keyboard("{Escape}")
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    }
    const expectCommands = (drawer: HTMLElement, expected: RegExp[]) => {
      expect(commands(drawer, /--send=no/)).toHaveLength(expected.length)
      for (const re of expected) expect(commands(drawer, re), String(re)).toHaveLength(1)
    }
    expectCommands(await drawerFor("Feed contract"), [new RegExp(`--id ${O1} .* -- feed_source$`)])
    await close()
    expectCommands(await drawerFor("Asset key"), [new RegExp(`--id ${O1} .* -- feed_source$`)])
    await close()
    expectCommands(await drawerFor("Minimum interval between feed updates"), [new RegExp(`--id ${O1} .* -- feed_min_interval_seconds$`)])
    await close()
    expectCommands(await drawerFor("Feed price"), [new RegExp(`--id ${FEED} .* -- decimals$`), new RegExp(`--id ${FEED} .* -- lastprice --asset '\\{"Other":"USDY"\\}'$`)])
    await close()
    // The age comes from lastprice alone.
    expectCommands(await drawerFor("Feed tick age"), [new RegExp(`--id ${FEED} .* -- lastprice --asset '\\{"Other":"USDY"\\}'$`)])
  })

  it("?oracle=<third> shows the third oracle's values and asks for its keeper runs and its history only", async () => {
    mocks.search = `oracle=${O3}`
    answers.ticks = () => Response.json({ intervalSeconds: 1_800, oracles: [{ oracle: O3, asset: "MOCKGILTS", health: HEALTHY, ticks: [tick({ oracle: O3 })] }] })
    render(wrap(<OraclePanel />))
    expect(await region("Reference value").findByText("1.3370000")).toBeTruthy()
    expect((await oracleRows())[2].querySelector("a")?.getAttribute("aria-current")).toBe("true")
    expect(await region("Keeper").findByText("Healthy")).toBeTruthy()
    await region("Rejection history").findByText("No rejection indexed yet")
    await region("Update history").findByText("No update indexed yet")
    const urls = mocks.fetch.mock.calls.map((c) => String(c[0]))
    expect(urls.filter((u) => u.startsWith("/api/dashboard/oracle-ticks"))).toEqual([`/api/dashboard/oracle-ticks?oracle=${O3}&limit=20`])
    const events = urls.filter((u) => u.startsWith("/api/dashboard/events"))
    expect(events.length).toBeGreaterThanOrEqual(2)
    for (const u of events) expect(u).toContain(`contract=${O3}`)
    expect(region("Keeper").getByRole("link", { name: /oracle-ticks/ }).getAttribute("href")).toBe(`/api/dashboard/oracle-ticks?oracle=${O3}&limit=100`)
  })

  it("an ?oracle= that is not one of the manifest's shows the first, and the page says nothing about it", async () => {
    mocks.search = "oracle=CNOTANORACLE"
    render(wrap(<OraclePanel />))
    expect(await region("Reference value").findByText("10.8065700")).toBeTruthy()
    expect(screen.queryByText(/CNOTANORACLE/)).toBeNull()
    expect(mocks.fetchOracleView.mock.calls.map((c) => c[2])).not.toContain("CNOTANORACLE")
  })

  it("picking a row shows that oracle and writes ?oracle= into the address bar, reading nothing again", async () => {
    const user = userEvent.setup()
    render(wrap(<OraclePanel />))
    await region("Reference value").findByText("10.8065700")
    const reads = mocks.fetchOracleView.mock.calls.length
    await user.click(screen.getByRole("link", { name: "MOCKUSTRY" }))
    expect(await region("Reference value").findByText("1.1534743")).toBeTruthy()
    expect(window.location.search).toBe(`?oracle=${O2}`)
    expect(screen.getByRole("link", { name: "MOCKUSTRY" }).getAttribute("aria-current")).toBe("true")
    expect(mocks.fetchOracleView.mock.calls.length).toBe(reads)
  })

  it("the oracle with no feed source says so, with its drawer, and shows no feed figures", async () => {
    mocks.search = `oracle=${O5}`
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    expect(await feed.findByText("No feed source set: updated by push only.")).toBeTruthy()
    expect(feed.getByRole("button", { name: "How to verify Feed source" })).toBeTruthy()
    for (const label of ["Feed price", "Stored value against feed", "Asset key"]) expect(feed.queryByText(label, { selector: "dt" })).toBeNull()
  })

  it("the Feed card: the feed contract, the asset key, the minimum interval, the feed's price and its age, each with its drawer", async () => {
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    const link = await feed.findByRole("link", { name: `Feed contract ${FEED} on stellar.expert` })
    expect(link.textContent).toBe("CAL7…LLCT")
    expect(link.getAttribute("href")).toBe(`https://stellar.expert/explorer/public/contract/${FEED}`)
    expect(row(feed, "Asset key")).toBe("Other USDY")
    expect(row(feed, "Minimum interval between feed updates")).toBe("300 s")
    expect(row(feed, "Feed price")).toBe("1.0807670")
    expect(row(feed, "Feed tick age")).toContain("1m 30s ago on the ledger clock")
    expect(row(feed, "Stored value against feed")).toBe("Differs by a factor of 10.0")
    for (const label of ["Feed contract", "Asset key", "Minimum interval between feed updates", "Feed price", "Feed tick age", "Stored value against feed"])
      expect(feed.getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
  })

  it.each([
    // Review Focus 5: a stored value ten times the feed's price (a synthetic case).
    [108_065_700n, 10_807_670n, "Differs by a factor of 10.0"],
    [11_534_743n, 11_535_907n, "Differs by 0.01 %"],
    [11_535_907n, 11_535_907n, "Equal"],
    // Either way round, and at the factor-of-2 boundary.
    [10_807_670n, 108_065_700n, "Differs by a factor of 10.0"],
    [20_000_000n, 10_000_000n, "Differs by a factor of 2.0"],
    [19_999_999n, 10_000_000n, "Differs by 99.99 %"],
    [10_000_001n, 10_000_000n, "Differs by less than 0.01 %"],
  ])("Review Focus 5: stored %s against the feed's %s reads %s, both values shown", async (stored, feedValue, text) => {
    mocks.fetchOracleView.mockImplementation(viewsBy({ ...spreadViews(), [O1]: feedOracle(O1, stored, feedValue) }))
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    await feed.findByText(text)
    expect(row(feed, "Stored value against feed")).toBe(text)
    const seven = (v: bigint) => `${v / 10_000_000n}.${String(v % 10_000_000n).padStart(7, "0")}`
    expect(row(feed, "Feed price")).toBe(seven(feedValue))
    expect(row(region("Reference value"), "Value")).toBe(seven(stored))
  })

  it("the comparison's drawer lists both inputs: the oracle's stored value and the feed's two reads, each with a command that runs", async () => {
    const user = userEvent.setup()
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    await feed.findByText("Differs by a factor of 10.0")
    await user.click(feed.getByRole("button", { name: "How to verify Stored value against feed" }))
    const drawer = await screen.findByRole("dialog")
    expect(commands(drawer, new RegExp(`--id ${O1} .* -- get_reference_value$`))).toHaveLength(1)
    expect(commands(drawer, new RegExp(`--id ${FEED} .* -- decimals$`))).toHaveLength(1)
    expect(commands(drawer, new RegExp(`--id ${FEED} .* -- lastprice --asset '\\{"Other":"USDY"\\}'$`))).toHaveLength(1)
  })

  it("a feed price of zero or below is shown, and in place of a comparison: the oracle would refuse it", async () => {
    mocks.fetchOracleView.mockImplementation(viewsBy({ ...spreadViews(), [O1]: feedOracle(O1, 10_000_000n, 0n) }))
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    expect(await feed.findByText("The feed's price is not positive: the oracle would refuse it.")).toBeTruthy()
    expect(row(feed, "Feed price")).toBe("0.0000000")
  })

  it("a feed price that cannot be read: the price, its age and the comparison are Unavailable, with the reason", async () => {
    const user = userEvent.setup()
    const call = { contractId: FEED, fn: "lastprice", args: [ASSET_ARG], rpcUrl: RPC }
    mocks.fetchOracleView.mockImplementation(
      viewsBy({ ...spreadViews(), [O1]: feedOracle(O1, 10_000_000n, 0n, { feedPrice: { status: "unavailable", error: "The feed has no price for this asset.", source: call } }) }),
    )
    render(wrap(<OraclePanel />))
    const feed = region("Feed")
    const why = await feed.findByRole("button", { name: "Why Stored value against feed is unavailable, and how to verify it" })
    expect(row(feed, "Feed price")).toBe("Unavailable")
    expect(row(feed, "Feed tick age")).toBe("Unavailable")
    expect(row(feed, "Stored value against feed")).toBe("Unavailable")
    await user.click(why)
    const drawer = await screen.findByRole("dialog")
    expect(within(drawer).getAllByText(/The feed has no price for this asset/).length).toBeGreaterThan(0)
    expect(commands(drawer, /-- lastprice --asset/)).toHaveLength(1)
  })

  it("no fixed width in the Oracles table or the Feed card (375 px), and the table folds its columns rather than scroll", async () => {
    render(wrap(<OraclePanel />))
    await region("Feed").findByText("Differs by a factor of 10.0")
    const table = screen.getByRole("table", { name: "Oracles" })
    expect(within(table).getByRole("columnheader", { name: "Blocks in" }).className).toContain("max-[520px]:hidden")
    expect(within(table).getByRole("columnheader", { name: "Update path" }).className).toContain("max-[720px]:hidden")
    // What a hidden column holds is under the oracle's name below that width.
    const first = (await oracleRows())[0]
    expect(first.querySelector(".min-\\[520px\\]\\:hidden")?.textContent).toContain("48m 0s")
    expect(first.querySelector(".min-\\[720px\\]\\:hidden")?.textContent).toContain("Feed")
    expectNoFixedWidth(screen.getByRole("region", { name: "Oracles" }))
    expectNoFixedWidth(screen.getByRole("region", { name: "Feed" }))
  })
})

describe("Testnet's one oracle, on 665bb67", () => {
  it("the table still lists it, and the Feed card says its code has no feed, with the call that shows it", async () => {
    const user = userEvent.setup()
    render(wrap(<OraclePanel />))
    const rows = await oracleRows()
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByRole("link", { name: "USDY" }).getAttribute("href")).toBe(`/dashboard/oracle?oracle=${ORACLE}`)
    await waitFor(() => expect(within(rows[0]).getAllByText("Not supported").length).toBeGreaterThan(0))
    const feed = region("Feed")
    expect(await feed.findByText("Not supported by this oracle's code")).toBeTruthy()
    expect(feed.queryByText("No feed source set: updated by push only.")).toBeNull()
    // Above that sentence, the card's description is true for code without a feed too.
    expect(feed.getByText(/the SEP-40 price feed this oracle reads with sync_from_feed, when its code supports one and one is set/)).toBeTruthy()
    expect(screen.getByText(/its sources and, when its code supports one, the price feed it reads\./)).toBeTruthy()
    // The table's path cell: "Not supported", with the call that shows it.
    await user.click(within(rows[0]).getAllByRole("button", { name: "How to verify Update path · USDY" })[0])
    const pathDrawer = await screen.findByRole("dialog")
    expect(commands(pathDrawer, new RegExp(`--id ${ORACLE} .* -- last_update_was_feed$`))).toHaveLength(1)
    expect(within(pathDrawer).getAllByText(/MissingValue/).length).toBeGreaterThan(0)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // The path is unsupported: Active source stays, as before.
    expect(row(region("Sources"), "Active source")).toContain(PRIMARY)
    await user.click(feed.getByRole("button", { name: "How to verify Feed source" }))
    const drawer = await screen.findByRole("dialog")
    expect(commands(drawer, new RegExp(`--id ${ORACLE} .* -- feed_source$`))).toHaveLength(1)
    expect(within(drawer).getAllByText(/MissingValue/).length).toBeGreaterThan(0)
  })
})

describe("the oracle page as a whole", () => {
  it("offers the page's evidence table and the as-of line; reads no wallet; fits 375 px", async () => {
    render(wrap(<OraclePanel />))
    await region("Reference value").findByText("1.0000919")
    expect(screen.getByRole("button", { name: /Copy evidence/ })).toBeTruthy()
    expect(screen.getAllByTestId("as-of")[0].textContent).toContain("Ledger 5720087")
    const section = screen.getByRole("heading", { level: 1, name: "Oracle" }).closest("section")
    expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
  })
})
