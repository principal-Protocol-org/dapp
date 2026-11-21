import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Live, ReadSource } from "@/lib/protocol/types"

const MARKET = "testnet-usdy-1802336344"
const RPC = "https://rpc.test"
const LEDGER_TIME = 1_800_000_000
const ADMIN = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const A = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const B = "GBBPZ6KVXM72MVKSZMAPMM6O4UN6XID22ZO7EOEXGCKFCOZTNVY3JVXG"
const TX = "68be08ad3f0c4e2b9a1d7c5e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a"

const src = (fn: string, contractId = "CRISK", ledger = 5_720_087): ReadSource => ({ contractId, fn, args: [], rawXdr: "AAAA", ledger, rpcUrl: RPC })
const live = <T,>(value: T, fn = "f", contractId = "CRISK"): Live<T> => ({ status: "live", value, ledger: 5_720_087, source: src(fn, contractId) })
const down = (error = "rpc down"): Live<never> => ({ status: "unavailable", error })

const mocks = vi.hoisted(() => ({
  manifest: {} as Record<string, unknown>,
  clock: { ledgerTime: 0 as number | null, sequence: 5_720_087 as number | null, isError: false },
  fetchRiskView: vi.fn(),
  fetchPauses: vi.fn(),
  fetchPausers: vi.fn(),
  fetch: vi.fn(),
}))

const baseManifest = () => ({
  network: "testnet",
  rpcUrl: RPC,
  markets: [
    {
      marketId: MARKET,
      displayName: "USDY",
      underlying: { code: "USDY", decimals: 7, sac: "CSAC" },
      contracts: { sy: "CSY", pool: "CPOOL", manager: "CMGR", recoveryEscrow: "CESCROW" },
    },
  ],
  shared: { oracle: "CORACLE", riskControl: "CRISK", permissioning: "CPERM", router: "CROUTER" },
  wasmHashes: {},
})
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("@/lib/protocol/reader", async (importActual) => ({ ...(await importActual<object>()), createRpcReader: () => ({}) }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => mocks.clock }))
vi.mock("@/lib/protocol/dashboard/risk", async (importActual) => ({ ...(await importActual<object>()), fetchRiskView: mocks.fetchRiskView }))
vi.mock("@/lib/protocol/dashboard/pauses", async (importActual) => ({ ...(await importActual<object>()), fetchPauses: mocks.fetchPauses }))
vi.mock("@/lib/protocol/dashboard/pausers", async (importActual) => ({ ...(await importActual<object>()), fetchPausers: mocks.fetchPausers }))
// No wallet provider anywhere: a view that read the wallet would throw.
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => {
    throw new Error("the dashboard must not read the wallet")
  },
}))

import { EFFECTIVE_WRAP_AND_MINT_LABEL } from "@/lib/protocol/dashboard/risk"
import { RiskPanel } from "../risk-panel"

function riskView(over: Record<string, unknown> = {}) {
  return {
    contractId: "CRISK",
    limit: live(100_000_000_000_000n, "get_cb_limit"),
    volume: live(20_000_000_000_000n, "get_cb_volume"),
    remaining: { status: "live", value: 80_000_000_000_000n, ledger: 5_720_087, sources: [src("get_cb_limit"), src("get_cb_volume")] },
    effectiveWrapAndMint: { status: "live", value: 40_000_000_000_000n, ledger: 5_720_087, sources: [src("get_cb_limit"), src("get_cb_volume"), src("is_consumer")] },
    doubleReporting: [MARKET],
    consumers: {},
    window: { kind: "fixed", start: live(5_707_351, "get_window_start"), length: live(17_280, "get_window_ledgers"), lapsed: live(false) },
    assetLimits: [
      {
        asset: "CSAC",
        limit: live(50_000_000_000_000n, "get_asset_limit"),
        volume: live(10_000_000_000_000n, "get_asset_volume"),
        remaining: { status: "live", value: 40_000_000_000_000n, ledger: 5_720_087, sources: [src("get_asset_limit"), src("get_asset_volume")] },
      },
    ],
    paused: live(false, "is_paused"),
    ...over,
  }
}

const pause = (kind: string, contractId: string, label: string, paused: boolean | null) => ({
  kind,
  contractId,
  ...(kind === "riskControl" ? {} : { marketId: MARKET }),
  label,
  paused: paused === null ? down() : live(paused, "is_paused", contractId),
})
const pauses = (pool: boolean | null = false) => {
  const contracts = [
    pause("riskControl", "CRISK", "Risk control", false),
    pause("sy", "CSY", `SY wrapper (${MARKET})`, false),
    pause("pool", "CPOOL", `Market pool (${MARKET})`, pool),
    pause("manager", "CMGR", `Principal manager (${MARKET})`, false),
  ]
  return { contracts, paused: live(contracts.filter((c) => c.paused.status === "live" && c.paused.value).map((c) => c.label)) }
}

const pausersView = (over: Record<string, unknown> = {}) => ({
  admin: live(ADMIN, "get_admin"),
  adminIsPauser: live(true, "is_pauser"),
  pausers: [{ account: A, isPauser: live(true, "is_pauser") }],
  ...over,
})

const INDEX = {
  rows: [],
  indexedThrough: 5_719_749,
  indexedThroughCloseTime: new Date((LEDGER_TIME - 125) * 1000).toISOString(),
  lagSeconds: 125,
  gaps: [],
  reconcile: null,
}
let n = 0
const ev = (ledger: number, topic: string, data: Record<string, unknown>, contractId = "CRISK") => ({
  id: `${String(ledger).padStart(19, "0")}-${String(n++).padStart(10, "0")}`,
  group: "risk",
  contractId,
  topic,
  ledger,
  closeTime: "2026-11-14T00:04:59.000Z",
  txHash: TX,
  pool: null,
  data,
})

type Answers = { pausers?: unknown[]; pausersDown?: boolean; pausersFull?: boolean; limits?: unknown[]; pauseHistory?: unknown[]; alerts?: () => Response }
let answers: Answers = {}

function answer(url: string): Response {
  if (url.startsWith("/api/dashboard/alerts"))
    return answers.alerts ? answers.alerts() : new Response("<!DOCTYPE html><title>404</title>", { status: 404, headers: { "content-type": "text/html" } })
  if (url.includes("group=risk&topic=add_psr")) {
    if (answers.pausersDown) return Response.json({ error: "unavailable" }, { status: 503 })
    // A page of 200 every time: more history than the page reads.
    if (answers.pausersFull) return Response.json({ ...INDEX, rows: Array.from({ length: 200 }, () => ev(5_718_000, "add_psr", { caller: ADMIN, pauser: A })) })
    return Response.json({ ...INDEX, rows: answers.pausers ?? [] })
  }
  if (url.includes("topic=cb_limit")) return Response.json({ ...INDEX, rows: answers.limits ?? [] })
  if (url.includes("topic=paused")) return Response.json({ ...INDEX, rows: answers.pauseHistory ?? [] })
  return Response.json(INDEX)
}

let client: QueryClient
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>

beforeEach(() => {
  answers = {}
  mocks.manifest = baseManifest()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.clock = { ledgerTime: LEDGER_TIME, sequence: 5_720_087, isError: false }
  mocks.fetchRiskView.mockReset().mockResolvedValue(riskView())
  mocks.fetchPauses.mockReset().mockResolvedValue(pauses())
  mocks.fetchPausers.mockReset().mockResolvedValue(pausersView())
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

/** Every `dd` of the region's lists has its `dt` (valid `<dl>` nesting: each `div` group holds a term and its description). */
function expectValidLists(name: string) {
  const el = screen.getByRole("region", { name })
  for (const dl of el.querySelectorAll("dl")) {
    for (const child of dl.children) expect(child.tagName).toBe("DIV")
    for (const dd of dl.querySelectorAll("dd")) expect(dd.parentElement?.querySelector(":scope > dt"), dd.textContent ?? "").toBeTruthy()
  }
}

describe("the risk page (/dashboard/risk)", () => {
  it.each([
    ["testnet", "15 s"],
    ["mainnet", "1 min"],
  ] as const)("%s: the live panels say they refresh every %s", async (network, every) => {
    mocks.manifest = { ...baseManifest(), network }
    render(wrap(<RiskPanel />))
    await region("Circuit breaker").findByText("10,000,000.00 USDY")
    expect(screen.getByText(/protocol-wide · refreshes every/).textContent).toMatch(new RegExp(`, protocol-wide · refreshes every ${every}$`))
    expect(screen.getByText(/manager and pool · refreshes every/).textContent).toBe(`RiskControl, and each market's SY wrapper, manager and pool · refreshes every ${every}`)
    expect(screen.getAllByTestId("as-of")[0].textContent).toContain(`Refreshes every ${every}`)
  })

  it("shows the limit, the volume, the raw remaining capacity and the wrap-and-mint capacity with its explanation (D-10)", async () => {
    const user = userEvent.setup()
    render(wrap(<RiskPanel />))
    expect(screen.getByRole("heading", { level: 1, name: "Risk" })).toBeTruthy()
    const breaker = region("Circuit breaker")
    expect(await breaker.findByText("10,000,000.00 USDY")).toBeTruthy()
    expect(breaker.getByText("2,000,000.00 USDY")).toBeTruthy()
    expect(breaker.getByText("8,000,000.00 USDY")).toBeTruthy()
    expect(breaker.getByText("4,000,000.00 USDY")).toBeTruthy()
    for (const label of ["Circuit-breaker limit", "Volume in this window", "Remaining capacity (raw)", "Wrap-and-mint capacity"])
      expect(breaker.getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
    expect(breaker.getByText(/SY deposit and the manager mint each count the same underlying/)).toBeTruthy()
    expect(breaker.getByText(new RegExp(`Markets: ${MARKET}`))).toBeTruthy()
    // The short label; the long one is behind its tip.
    expect(breaker.queryByText(EFFECTIVE_WRAP_AND_MINT_LABEL)).toBeNull()
    await user.click(breaker.getByRole("button", { name: "More about Wrap-and-mint capacity" }))
    expect((await screen.findAllByText(new RegExp(EFFECTIVE_WRAP_AND_MINT_LABEL))).length).toBeGreaterThan(0)
  })

  it("no wrap-and-mint row when no market double-reports; a limit of 0 reads No limit (disabled)", async () => {
    mocks.fetchRiskView.mockResolvedValue(
      riskView({ limit: live(0n, "get_cb_limit"), remaining: { status: "live", value: null, ledger: 1, sources: [src("get_cb_limit")] }, effectiveWrapAndMint: null, doubleReporting: [] }),
    )
    render(wrap(<RiskPanel />))
    const breaker = region("Circuit breaker")
    // The limit and the room left both say so, never "0 left".
    expect(await breaker.findAllByText("No limit (disabled)")).toHaveLength(2)
    expect(breaker.queryByText("Wrap-and-mint capacity")).toBeNull()
  })

  it("the wrap-and-mint row turns Unavailable, never the last answer, when the risk refresh fails", async () => {
    render(wrap(<RiskPanel />))
    const breaker = region("Circuit breaker")
    await breaker.findByText("4,000,000.00 USDY")
    mocks.fetchRiskView.mockRejectedValue(new Error("rpc down"))
    await act(() => client.refetchQueries({ queryKey: ["dashboard", "risk"] }))
    expect(await breaker.findByRole("button", { name: "Why Wrap-and-mint capacity is unavailable, and how to verify it" })).toBeTruthy()
    expect(breaker.queryByText("4,000,000.00 USDY")).toBeNull()
  })

  it("shows the window: start, length, and the lapsed note when ledger − start ≥ length (D-11)", async () => {
    render(wrap(<RiskPanel />))
    const win = region("Window")
    expect(await win.findByText("Ledger 5707351")).toBeTruthy()
    expect(win.getByText("17,280 ledgers")).toBeTruthy()
    expect(win.getByText("Open through ledger 5724630")).toBeTruthy()
    for (const label of ["Window start", "Window length", "Window state"]) expect(win.getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
  })

  it("a lapsed window says the next counted deposit opens a new one", async () => {
    mocks.fetchRiskView.mockResolvedValue(riskView({ window: { kind: "fixed", start: live(5_707_351), length: live(17_280), lapsed: live(true) } }))
    render(wrap(<RiskPanel />))
    expect(await region("Window").findByText("Lapsed: the next counted deposit opens a new window")).toBeTruthy()
  })

  it("a fixed window (version 1) keeps its wording: the volume in this window, and the window panel says when it lapses", async () => {
    render(wrap(<RiskPanel />))
    const breaker = region("Circuit breaker")
    expect(await breaker.findByText("2,000,000.00 USDY")).toBeTruthy()
    expect(breaker.getByText("Volume in this window")).toBeTruthy()
    expect(breaker.queryByText("Volume counted now")).toBeNull()
    expect(
      region("Window").getByText(
        "The stored start does not reset by itself: once ledger − start reaches the length, the next counted deposit opens a new window, and the contract reports a volume of 0 until then.",
      ),
    ).toBeTruthy()
  })

  it("a sliding window (version 2): its length and how the volume decays; no open-through or lapsed text; the volume counted now", async () => {
    mocks.manifest = { ...baseManifest(), protocolAbi: 2 }
    mocks.fetchRiskView.mockResolvedValue(
      riskView({ window: { kind: "sliding", start: live(5_707_351, "get_window_start"), length: live(17_280, "get_window_ledgers") } }),
    )
    const user = userEvent.setup()
    render(wrap(<RiskPanel />))
    const win = region("Window")
    expect(await win.findByText("Sliding window of 17,280 ledgers: used volume decays as older deposits leave it")).toBeTruthy()
    expect(win.getByText("Ledger 5707351")).toBeTruthy()
    expect(win.queryByText(/Open through ledger/)).toBeNull()
    expect(win.queryByText(/Lapsed/)).toBeNull()
    expect(win.queryByText(/reports a volume of 0/)).toBeNull()
    expect(win.queryByText(/opens a new window/)).toBeNull()
    expect(win.getByText("The counted volume decays as older deposits leave the window, so room frees up gradually. The window never lapses or resets.")).toBeTruthy()
    const breaker = region("Circuit breaker")
    expect(breaker.getByText("Volume counted now")).toBeTruthy()
    expect(breaker.queryByText("Volume in this window")).toBeNull()
    expect(breaker.getByRole("button", { name: "How to verify Volume counted now" })).toBeTruthy()
    // The state is the window length read, with its drawer.
    await user.click(win.getByRole("button", { name: "How to verify Window state" }))
    const drawer = await screen.findByRole("dialog")
    const command = within(drawer).queryAllByText((_, el) => el?.tagName === "CODE" && (el.textContent ?? "").endsWith(" --send=no -- get_window_ledgers"))
    expect(command.length).toBeGreaterThan(0)
  })

  it("without a ledger clock nothing waits forever: the breaker figures and the per-asset limits are Unavailable, with the reason", async () => {
    mocks.clock = { ledgerTime: null, sequence: null, isError: true }
    render(wrap(<RiskPanel />))
    expect(await region("Circuit breaker").findByRole("button", { name: "Why Circuit-breaker limit is unavailable, and how to verify it" })).toBeTruthy()
    const assets = region("Per-asset limits")
    expect(assets.getByRole("button", { name: "More about Per-asset limits (unavailable)" })).toBeTruthy()
    expect(assets.queryByText((_, el) => el?.getAttribute("data-slot") === "skeleton")).toBeNull()
    expect(mocks.fetchRiskView).not.toHaveBeenCalled()
  })

  it("shows each asset's limit, volume and remaining", async () => {
    render(wrap(<RiskPanel />))
    const assets = region("Per-asset limits")
    expect(await assets.findByText("5,000,000.00 USDY")).toBeTruthy()
    expect(assets.getByText("1,000,000.00 USDY")).toBeTruthy()
    expect(assets.getByText("4,000,000.00 USDY")).toBeTruthy()
    for (const label of ["USDY asset limit", "USDY asset volume", "USDY asset remaining"]) expect(assets.getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
  })

  it("shows every pause: RiskControl, and each market's SY, manager and pool, each with its read", async () => {
    mocks.fetchPauses.mockResolvedValue(pauses(true))
    render(wrap(<RiskPanel />))
    const p = region("Pauses")
    expect(await p.findByText("Paused")).toBeTruthy()
    expect(p.getAllByText("Not paused")).toHaveLength(3)
    for (const label of ["Risk control", `SY wrapper (${MARKET})`, `Principal manager (${MARKET})`, `Market pool (${MARKET})`])
      expect(p.getByRole("button", { name: `How to verify ${label} pause` })).toBeTruthy()
  })

  it("an unreadable pause is Unavailable for that contract only", async () => {
    mocks.fetchPauses.mockResolvedValue(pauses(null))
    render(wrap(<RiskPanel />))
    const p = region("Pauses")
    expect(await p.findByRole("button", { name: `Why Market pool (${MARKET}) pause is unavailable, and how to verify it` })).toBeTruthy()
    expect(p.getAllByText("Not paused")).toHaveLength(3)
  })

  it("lists the pausers from indexed add_psr/rm_psr, each confirmed live with is_pauser, plus the admin", async () => {
    answers.pausers = [ev(5_718_600, "rm_psr", { caller: ADMIN, pauser: B }), ev(5_718_500, "add_psr", { caller: ADMIN, pauser: B }), ev(5_718_400, "add_psr", { caller: ADMIN, pauser: A })]
    render(wrap(<RiskPanel />))
    const p = region("Pausers")
    expect(p.getByText("From the event index, each confirmed live with is_pauser.")).toBeTruthy()
    expect(await p.findByRole("button", { name: `How to verify Pauser ${A}` })).toBeTruthy()
    expect(mocks.fetchPausers).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ network: "testnet" }), [A])
    expect(p.getByText("Pauser")).toBeTruthy()
    expect(p.getByText(/Added at ledger 5718400/)).toBeTruthy()
    expect(p.getAllByRole("link", { name: `View transaction ${TX} on stellar.expert` }).length).toBeGreaterThan(0)
    // B was removed last: not listed.
    expect(p.queryByText("GBBP…JVXG")).toBeNull()
    // The admin pauses by the contract's rule, with no event.
    expect(p.getByText("Admin (a pauser by the contract's rule)")).toBeTruthy()
    expect(p.getByRole("button", { name: "How to verify RiskControl admin" })).toBeTruthy()
    expectValidLists("Pausers")
  })

  it("an indexed pauser the contract no longer counts is flagged, never listed as a pauser", async () => {
    answers.pausers = [ev(5_718_400, "add_psr", { caller: ADMIN, pauser: A })]
    mocks.fetchPausers.mockResolvedValue(pausersView({ pausers: [{ account: A, isPauser: live(false, "is_pauser") }] }))
    render(wrap(<RiskPanel />))
    expect(await region("Pausers").findByText("Not a pauser: the index may be behind")).toBeTruthy()
  })

  it("no pauser indexed yet reads plainly, and the admin is still shown", async () => {
    render(wrap(<RiskPanel />))
    const p = region("Pausers")
    // While the index is read, the list's terms and descriptions stay paired.
    expectValidLists("Pausers")
    expect(await p.findByText("No pauser indexed yet")).toBeTruthy()
    expect(await p.findByText("GBLP…B7UA")).toBeTruthy()
    expectValidLists("Pausers")
  })

  it("the pausers list is Unavailable, never empty, when the index cannot be read", async () => {
    answers.pausersDown = true
    render(wrap(<RiskPanel />))
    const p = region("Pausers")
    // Retried once (the app's default) before it counts as down.
    expect(await p.findByRole("button", { name: "More about Indexed pausers (unavailable)" }, { timeout: 4000 })).toBeTruthy()
    expect(p.queryByText("No pauser indexed yet")).toBeNull()
    expectValidLists("Pausers")
  })

  it("the pausers list is Unavailable, never partial or empty, past the history the page reads", async () => {
    const user = userEvent.setup()
    answers.pausersFull = true
    render(wrap(<RiskPanel />))
    const p = region("Pausers")
    await user.click(await p.findByRole("button", { name: "More about Indexed pausers (unavailable)" }, { timeout: 4000 }))
    expect((await screen.findAllByText(/holds 5,000 or more rows/)).length).toBeGreaterThan(0)
    expect(p.queryByText("No pauser indexed yet")).toBeNull()
    expect(mocks.fetchPausers).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), [A])
  })

  it("shows the limit-change history (indexed cb_limit, ast_limit, cb_window) under the current live values", async () => {
    answers.limits = [
      ev(5_718_346, "cb_limit", { caller: ADMIN, limit: "100000000000000" }),
      ev(5_718_300, "ast_limit", { caller: ADMIN, asset: "CSAC", limit: "50000000000000" }),
      ev(5_718_250, "cb_window", { caller: ADMIN, ledgers: 17280 }),
      ev(5_718_211, "cb_limit", { caller: ADMIN, limit: "10000000000000" }),
    ]
    render(wrap(<RiskPanel />))
    const h = region("Limit changes")
    expect(await h.findByRole("table", { name: "Limit changes" })).toBeTruthy()
    expect(mocks.fetch).toHaveBeenCalledWith("/api/dashboard/events?group=risk&topic=cb_limit%2Cast_limit%2Ccb_window&limit=20")
    expect(h.getAllByText("Circuit-breaker limit set to 10,000,000.00 USDY").length).toBeGreaterThan(0)
    expect(h.getAllByText("Circuit-breaker limit set to 1,000,000.00 USDY").length).toBeGreaterThan(0)
    expect(h.getAllByText("USDY asset limit set to 5,000,000.00 USDY").length).toBeGreaterThan(0)
    expect(h.getAllByText("Window length set to 17,280 ledgers").length).toBeGreaterThan(0)
    expect(h.getAllByText("5718211").length).toBeGreaterThan(0)
    // The current values, live, above the history.
    expect(h.getByRole("button", { name: "How to verify Circuit-breaker limit (now)" })).toBeTruthy()
    expect(h.getByRole("button", { name: "How to verify Window length (now)" })).toBeTruthy()
  })

  it("empty histories read plainly, never as errors", async () => {
    render(wrap(<RiskPanel />))
    expect(await region("Limit changes").findByText("No limit change indexed yet")).toBeTruthy()
    expect(await region("Pause history").findByText("No pause recorded yet")).toBeTruthy()
    expect(screen.queryByText(/Unavailable/)).toBeNull()
  })

  it("the pause history lists every contract's pause and the pauser changes, worded per contract", async () => {
    answers.pauseHistory = [ev(5_718_700, "paused", { paused: false }, "CPOOL"), ev(5_718_650, "paused", { caller: ADMIN, paused: true })]
    render(wrap(<RiskPanel />))
    const h = region("Pause history")
    expect((await h.findAllByText("MarketPool CPOOL unpaused")).length).toBeGreaterThan(0)
    expect(h.getAllByText("RiskControl CRISK paused").length).toBeGreaterThan(0)
    expect(mocks.fetch).toHaveBeenCalledWith("/api/dashboard/events?topic=paused%2Cadd_psr%2Crm_psr&limit=20")
  })

  it("a pause event whose state was not decoded is never read as a pause", async () => {
    answers.pauseHistory = [ev(5_718_650, "paused", {}), ev(5_718_640, "paused", { caller: ADMIN, paused: true })]
    render(wrap(<RiskPanel />))
    const h = region("Pause history")
    expect((await h.findAllByText("RiskControl CRISK: pause state not decoded")).length).toBeGreaterThan(0)
    // Only the decoded one reads paused.
    expect(h.getAllByText("RiskControl CRISK paused")).toHaveLength(1)
  })

  it("a limit that is not an integer shows its raw value, never throws", async () => {
    answers.limits = [ev(5_718_400, "cb_limit", { caller: ADMIN, limit: "1.5" }), ev(5_718_300, "ast_limit", { caller: ADMIN, asset: "CSAC", limit: "lots" })]
    render(wrap(<RiskPanel />))
    const h = region("Limit changes")
    expect((await h.findAllByText("Circuit-breaker limit set to 1.5 (raw value)")).length).toBeGreaterThan(0)
    expect(h.getAllByText("USDY asset limit set to lots (raw value)").length).toBeGreaterThan(0)
  })

  it("exhaustion history: No alert data yet until the alerts route exists (D-12)", async () => {
    render(wrap(<RiskPanel />))
    const x = region("Exhaustion history")
    expect(await x.findByText("No alert data yet")).toBeTruthy()
    expect(x.getByText(/A trip rolls its transaction back, so it leaves no event/)).toBeTruthy()
    expect(x.getByText(/covers the last 7 days/)).toBeTruthy()
  })

  it("exhaustion history lists the risk alerts, open and closed, once the route answers", async () => {
    answers.alerts = () =>
      Response.json({
        open: [{ kind: "risk_warning", subject: "CRISK", severity: "warning", openedAt: "2026-11-14T03:00:00.000Z", payload: { scope: "protocol" } }],
        recent: [
          { kind: "risk_exhausted", subject: "CRISK", severity: "critical", openedAt: "2026-11-13T03:00:00.000Z", resolvedAt: "2026-11-13T04:10:00.000Z", payload: {} },
          {
            kind: "risk_warning",
            subject: "asset:CSAC",
            severity: "warning",
            openedAt: "2026-11-12T03:00:00.000Z",
            resolvedAt: "2026-11-12T05:00:00.000Z",
            payload: { scope: "asset", asset: "CSAC" },
          },
          { kind: "oracle_stale", subject: "CORACLE", severity: "critical", openedAt: "2026-11-13T01:00:00.000Z", resolvedAt: null, payload: {} },
        ],
      })
    render(wrap(<RiskPanel />))
    const x = region("Exhaustion history")
    expect(await x.findAllByText("Warning: volume at 90% or more of the limit")).toHaveLength(2)
    expect(x.getByText("Exhausted: volume at or above the limit")).toBeTruthy()
    expect(x.getByText("2026-11-13 04:10:00 UTC")).toBeTruthy()
    expect(x.getByText("Open")).toBeTruthy()
    expect(x.getAllByText("Protocol-wide limit")).toHaveLength(2)
    expect(x.getByText("USDY asset limit")).toBeTruthy()
    expect(x.queryByText(/oracle/i)).toBeNull()
  })

  it("no risk alert recorded reads plainly", async () => {
    answers.alerts = () => Response.json({ open: [], recent: [] })
    render(wrap(<RiskPanel />))
    expect(await region("Exhaustion history").findByText("No exhaustion in the last 7 days")).toBeTruthy()
  })

  it("offers the page's evidence table and the as-of line; fits 375 px", async () => {
    render(wrap(<RiskPanel />))
    await screen.findAllByText("10,000,000.00 USDY")
    expect(screen.getByRole("button", { name: "Copy evidence table" })).toBeTruthy()
    expect(screen.getAllByTestId("as-of")[0].textContent).toContain("Ledger 5720087")
    const section = screen.getByRole("heading", { level: 1, name: "Risk" }).closest("section")
    expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
  })
})
