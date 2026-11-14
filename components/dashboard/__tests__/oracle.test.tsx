import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, within } from "@testing-library/react"
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

const src = (fn: string, ledger = 5_720_087): ReadSource => ({ contractId: ORACLE, fn, args: [], rawXdr: "AAAA", ledger, rpcUrl: RPC })
const live = <T,>(value: T, fn = "f"): Live<T> => ({ status: "live", value, ledger: 5_720_087, source: src(fn) })
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
}))

const baseManifest = () => ({
  network: "testnet",
  rpcUrl: RPC,
  markets: [{ marketId: "testnet-usdy-1802336344", displayName: "USDY", underlying: { code: "USDY", decimals: 7, sac: "CSAC" }, contracts: { pool: "CPOOL" } }],
  shared: { oracle: ORACLE, riskControl: "CRISK", permissioning: "CPERM", router: "CROUTER" },
  oracleSources: [{ hash: PRIMARY, preimage: PREIMAGE }],
  wasmHashes: { oracle: WASM_665 },
})
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
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
    ...over,
  }
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
const HEALTHY = { healthy: true, lastSuccessAt: new Date((LEDGER_TIME - 720) * 1000).toISOString(), lastTickAt: new Date((LEDGER_TIME - 720) * 1000).toISOString(), rejected24h: 1, failures24h: 2 }

type Answers = { rejections?: unknown[]; updates?: unknown[]; ticks?: () => Response }
let answers: Answers = {}

function answer(url: string): Response {
  if (url.startsWith("/api/dashboard/oracle-ticks"))
    return answers.ticks ? answers.ticks() : Response.json({ ticks: [tick()], health: HEALTHY, intervalSeconds: 1_800 })
  if (url.includes("topic=ref_rej")) return Response.json({ ...INDEX, rows: answers.rejections ?? [] })
  if (url.includes("topic=ref_set")) return Response.json({ ...INDEX, rows: answers.updates ?? [] })
  return Response.json(INDEX)
}

let client: QueryClient
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>

beforeEach(() => {
  answers = {}
  mocks.manifest = baseManifest()
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

  it("the path: push or feed when the oracle's code has the view", async () => {
    mocks.fetchOracleView.mockResolvedValue(oracleView({ path: live("feed", "last_update_was_feed") }))
    render(wrap(<OraclePanel />))
    const path = region("Update path")
    expect(await path.findByText("Feed: the oracle read its feed (sync_from_feed)")).toBeTruthy()
    expect(path.getByRole("button", { name: "How to verify Update path" })).toBeTruthy()
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
    expect(urls.some((u) => u.includes("group=oracle") && u.includes("topic=ref_rej"))).toBe(true)
    expect(urls.some((u) => u.includes("group=oracle") && u.includes("topic=ref_set"))).toBe(true)
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
      Response.json({
        ticks: [
          tick(),
          tick({ id: "8", decision: "rejected", value: "12000000", reason: "deviate", txHash: TX }),
          tick({ id: "7", decision: "error", value: null, reason: "failed: TypeError", txHash: null }),
          tick({ id: "6", decision: "skipped", txHash: null }),
          tick({ id: "5", decision: "error", value: null, reason: "not_configured: ORACLE_ADMIN_SECRET is not set.", txHash: null, signer: null }),
        ],
        health: HEALTHY,
        intervalSeconds: 1_800,
      })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Healthy")).toBeTruthy()
    expect(row(keeper, "Last successful update")).toContain("2027-01-15 07:48:00 UTC")
    expect(row(keeper, "Last successful update")).toContain("12m ago")
    expect(row(keeper, "Rejected runs (24 h)")).toBe("1")
    expect(row(keeper, "Failed runs (24 h)")).toBe("2")
    expect(keeper.getByText(/Healthy while the last successful update is under 1 hour old: twice the keeper's schedule, every 30 minutes\./)).toBeTruthy()
    const runs = keeper.getByRole("table", { name: "Recent keeper runs" })
    expect(within(runs).getByText("Pushed")).toBeTruthy()
    expect(within(runs).getByText("Rejected: Moved more than the cap")).toBeTruthy()
    expect(within(runs).getByText("Failed: TypeError")).toBeTruthy()
    expect(within(runs).getByText("Skipped: the value was already current")).toBeTruthy()
    expect(within(runs).getByText("Not configured: ORACLE_ADMIN_SECRET is not set.")).toBeTruthy()
    expect(within(runs).getAllByRole("link", { name: `View transaction ${TX2} on stellar.expert` }).length).toBeGreaterThan(0)
    expect(within(runs).getAllByTitle(SIGNER).length).toBeGreaterThan(0)
    expect(keeper.getByRole("link", { name: /oracle-ticks/ }).getAttribute("href")).toBe("/api/dashboard/oracle-ticks?limit=100")
  })

  it("the badge follows the ledger clock, not the cached answer: healthy:true but a last success 3,600 s old reads Unhealthy", async () => {
    // The API answer is cached up to ~6 min: it said healthy when it was computed.
    const at = (ageSeconds: number) => new Date((LEDGER_TIME - ageSeconds) * 1000).toISOString()
    answers.ticks = () => Response.json({ ticks: [tick({ at: at(3_600) })], health: { ...HEALTHY, healthy: true, lastSuccessAt: at(3_600), lastTickAt: at(3_600) }, intervalSeconds: 1_800 })
    const { unmount } = render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Unhealthy")).toBeTruthy()
    expect(keeper.queryByText("Healthy")).toBeNull()
    expect(row(keeper, "Last successful update")).toContain("1h 0m ago")
    unmount()
    client.clear()
    // 3,599 s: still healthy, even if the cached answer said otherwise.
    answers.ticks = () => Response.json({ ticks: [tick({ at: at(3_599) })], health: { ...HEALTHY, healthy: false, lastSuccessAt: at(3_599), lastTickAt: at(3_599) }, intervalSeconds: 1_800 })
    render(wrap(<OraclePanel />))
    expect(await region("Keeper").findByText("Healthy")).toBeTruthy()
  })

  it("unhealthy when the last success is too old, or there is none", async () => {
    answers.ticks = () => Response.json({ ticks: [tick({ decision: "error", reason: "failed: Error", txHash: null })], health: { ...HEALTHY, healthy: false, lastSuccessAt: null }, intervalSeconds: 1_800 })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Unhealthy")).toBeTruthy()
    expect(row(keeper, "Last successful update")).toBe("None recorded")
  })

  it("no run recorded: a neutral 'No keeper run recorded yet', neither healthy nor unhealthy, and no skeleton", async () => {
    answers.ticks = () =>
      Response.json({ ticks: [], health: { healthy: false, lastSuccessAt: null, lastTickAt: null, rejected24h: 0, failures24h: 0 }, intervalSeconds: 1_800 })
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

  it("an answer not in the expected shape is refused, never read as healthy", async () => {
    answers.ticks = () => Response.json({ ticks: "nope", health: HEALTHY })
    render(wrap(<OraclePanel />))
    const keeper = region("Keeper")
    expect(await keeper.findByText("Unavailable")).toBeTruthy()
    expect(keeper.queryByText("Healthy")).toBeNull()
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
