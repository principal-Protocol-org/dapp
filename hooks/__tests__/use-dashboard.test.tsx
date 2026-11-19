import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import type { Alert } from "@/lib/app/alert-types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  clock: { ledgerTime: 1_000_000 as number | null, sequence: 5_720_000 as number | null, isError: false },
  fetchProtocolState: vi.fn(),
  fetchMarketDashboard: vi.fn(),
  pendingClaim: vi.fn(),
  fetchOracleView: vi.fn(),
  fetchRiskView: vi.fn(),
  fetchPauses: vi.fn(),
  fetchPausers: vi.fn(),
  fetchEscrowRecords: vi.fn(),
  fetchAssetCompliance: vi.fn(),
}))

vi.mock("@/components/app/manifest-provider", () => {
  // One object, as the provider gives: hooks depend on its identity.
  const manifest = {
    network: "testnet",
    rpcUrl: "https://rpc.test",
    horizonUrl: "https://horizon.test",
    markets: [
      { marketId: "m1", contracts: { recoveryEscrow: "CESCROW" } },
      { marketId: "m2", contracts: { recoveryEscrow: "CESCROW" } },
    ],
    shared: { riskControl: "CRISK" },
  }
  return { useManifest: () => manifest }
})
vi.mock("@/lib/protocol/reader", () => ({ createRpcReader: () => ({}) }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => mocks.clock }))
vi.mock("@/lib/protocol/dashboard/protocol-state", () => ({
  fetchProtocolState: mocks.fetchProtocolState,
  fetchMarketDashboard: mocks.fetchMarketDashboard,
  pendingClaim: mocks.pendingClaim,
}))
vi.mock("@/lib/protocol/dashboard/oracle", () => ({ fetchOracleView: mocks.fetchOracleView }))
vi.mock("@/lib/protocol/dashboard/risk", () => ({ fetchRiskView: mocks.fetchRiskView }))
vi.mock("@/lib/protocol/dashboard/pauses", () => ({ fetchPauses: mocks.fetchPauses }))
vi.mock("@/lib/protocol/dashboard/pausers", async (importActual) => ({ ...(await importActual<object>()), fetchPausers: mocks.fetchPausers }))
vi.mock("@/lib/protocol/dashboard/compliance", async (importActual) => ({
  ...(await importActual<object>()),
  fetchEscrowRecords: mocks.fetchEscrowRecords,
  fetchAssetCompliance: mocks.fetchAssetCompliance,
}))

import {
  ALERTS_NOT_AVAILABLE,
  DASHBOARD_AGGREGATE_MS,
  DASHBOARD_LIVE_MS,
  MAX_EVENT_PAGES,
  parseOracleTicks,
  secondsToBlockNow,
  useAllEvents,
  useAssetCompliance,
  useComplianceEvents,
  useEscrowRecords,
  useEventCounts,
  useEventPages,
  useIndexStatus,
  usePausers,
  useMarketDashboard,
  useOpenAlerts,
  useOracleTicks,
  useOracleView,
  useOracleViews,
  usePauses,
  usePendingClaim,
  useProtocolState,
  useRiskView,
} from "@/hooks/use-dashboard"

let client: QueryClient
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

const interval = (key: unknown[]) => {
  const query = client.getQueryCache().find({ queryKey: key })
  expect(query, `query ${JSON.stringify(key)}`).toBeDefined()
  return (query!.observers[0].options as { refetchInterval?: number }).refetchInterval
}

const indexAnswer = (over: Record<string, unknown> = {}) => ({
  rows: [],
  indexedThrough: 5_719_749,
  indexedThroughCloseTime: "2026-11-14T02:13:09.000Z",
  lagSeconds: 12,
  gaps: [],
  reconcile: null,
  ...over,
})

const row = (id: string, ledger: number, group: string, topic: string) => ({
  id,
  group,
  contractId: "C1",
  topic,
  ledger,
  closeTime: "2026-11-14T02:00:00.000Z",
  txHash: `tx${id}`,
  pool: null,
  data: {},
})

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.clock = { ledgerTime: 1_000_000, sequence: 5_720_000, isError: false }
  mocks.fetchProtocolState.mockReset().mockResolvedValue({ markets: {}, totals: {} })
  mocks.fetchMarketDashboard.mockReset().mockResolvedValue({ marketId: "m1" })
  mocks.pendingClaim.mockReset().mockResolvedValue({ status: "live", value: 5n, ledger: 1 })
  mocks.fetchOracleView.mockReset().mockResolvedValue({ contractId: "ORACLE" })
  mocks.fetchRiskView.mockReset().mockResolvedValue({ contractId: "RISK" })
  mocks.fetchPauses.mockReset().mockResolvedValue({ contracts: [], paused: { status: "live", value: [], ledger: 1 } })
})

afterEach(() => vi.unstubAllGlobals())

describe("refresh cadence (D-6)", () => {
  it("is 15 s for live widgets and 60 s for aggregates and history; /app's 6 s is untouched", async () => {
    expect(DASHBOARD_LIVE_MS).toBe(15_000)
    expect(DASHBOARD_AGGREGATE_MS).toBe(60_000)
    const { MARKET_REFETCH_MS } = await vi.importActual<typeof import("@/hooks/use-market-state")>("@/hooks/use-market-state")
    expect(MARKET_REFETCH_MS).toBe(6000)
  })
})

describe("useProtocolState", () => {
  it("reads every manifest market, keyed by network, every 60 s", async () => {
    const { result } = renderHook(() => useProtocolState(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.fetchProtocolState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ network: "testnet" }), ["m1", "m2"])
    expect(interval(["dashboard", "protocol", "testnet", "m1,m2"])).toBe(DASHBOARD_AGGREGATE_MS)
    expect(result.current.stale).toBe(false)
  })

  it("is stale, not current, after a failed refetch", async () => {
    const { result } = renderHook(() => useProtocolState(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    mocks.fetchProtocolState.mockRejectedValue(new Error("rpc down"))
    await act(() => result.current.refetch())
    await waitFor(() => expect(result.current.stale).toBe(true))
  })
})

describe("useMarketDashboard", () => {
  it("reads one market's figures (the detail page) every 15 s, keyed by network and market", async () => {
    const { result } = renderHook(() => useMarketDashboard("m2"), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.fetchMarketDashboard).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ network: "testnet" }), expect.objectContaining({ marketId: "m2" }))
    expect(mocks.fetchProtocolState).not.toHaveBeenCalled()
    expect(interval(["dashboard", "market", "testnet", "m2"])).toBe(DASHBOARD_LIVE_MS)
  })

  it("an id the manifest does not list is an error, not a read", async () => {
    const { result } = renderHook(() => useMarketDashboard("nope"), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toMatch(/nope/)
    expect(mocks.fetchMarketDashboard).not.toHaveBeenCalled()
  })
})

describe("usePendingClaim", () => {
  const ms = { ytFrozen: { status: "live", value: false, ledger: 1 } } as never
  const ACCOUNT = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"

  it("reads nothing until an address is looked up and the market is read", () => {
    renderHook(() => usePendingClaim("m1", null, ms), { wrapper })
    renderHook(() => usePendingClaim("m1", ACCOUNT, undefined), { wrapper })
    expect(mocks.pendingClaim).not.toHaveBeenCalled()
  })

  it("reads the account's pending claim with the market's state, keyed by account, every 15 s", async () => {
    const { result } = renderHook(() => usePendingClaim("m1", ACCOUNT, ms), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.pendingClaim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ marketId: "m1" }), ACCOUNT, ms)
    expect(result.current.data).toEqual({ status: "live", value: 5n, ledger: 1 })
    expect(interval(["dashboard", "pending", "testnet", "m1", ACCOUNT])).toBe(DASHBOARD_LIVE_MS)
  })
})

describe("useOracleView", () => {
  it("reads the oracle it is given at the ledger time and returns that time with the view, every 15 s", async () => {
    const { result } = renderHook(() => useOracleView("CORACLE1"), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.fetchOracleView).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ network: "testnet" }), "CORACLE1", 1_000_000)
    expect(result.current.data).toEqual({ view: { contractId: "ORACLE" }, ledgerTime: 1_000_000 })
    expect(interval(["dashboard", "oracle", "testnet", "CORACLE1"])).toBe(DASHBOARD_LIVE_MS)
  })

  it("keys each oracle apart: two oracles are two reads", async () => {
    const a = renderHook(() => useOracleView("CORACLE1"), { wrapper })
    const b = renderHook(() => useOracleView("CORACLE2"), { wrapper })
    await waitFor(() => expect(a.result.current.data).toBeDefined())
    await waitFor(() => expect(b.result.current.data).toBeDefined())
    expect(mocks.fetchOracleView.mock.calls.map((c) => c[2]).sort()).toEqual(["CORACLE1", "CORACLE2"])
  })

  it("waits for the ledger clock instead of reading with no time", () => {
    mocks.clock = { ledgerTime: null, sequence: null, isError: false }
    renderHook(() => useOracleView("CORACLE1"), { wrapper })
    expect(mocks.fetchOracleView).not.toHaveBeenCalled()
  })})

describe("useOracleViews", () => {
  it("reads every oracle it is given, one query each, under useOracleView's key and cadence", async () => {
    const { result } = renderHook(() => useOracleViews(["CORACLE1", "CORACLE2", "CORACLE3"]), { wrapper })
    await waitFor(() => expect(result.current.every((q) => q.data !== undefined)).toBe(true))
    expect(result.current).toHaveLength(3)
    expect(mocks.fetchOracleView.mock.calls.map((c) => c[2])).toEqual(["CORACLE1", "CORACLE2", "CORACLE3"])
    expect(result.current[1].data).toEqual({ view: { contractId: "ORACLE" }, ledgerTime: 1_000_000 })
    expect(result.current[0].stale).toBe(false)
    for (const id of ["CORACLE1", "CORACLE2", "CORACLE3"]) expect(interval(["dashboard", "oracle", "testnet", id])).toBe(DASHBOARD_LIVE_MS)
  })

  it("shares its queries with useOracleView: the same oracle, asked by both at once, is read once", async () => {
    const { result } = renderHook(() => ({ many: useOracleViews(["CORACLE1", "CORACLE2"]), one: useOracleView("CORACLE2") }), { wrapper })
    await waitFor(() => expect(result.current.many.every((q) => q.data !== undefined)).toBe(true))
    expect(result.current.one.data).toBe(result.current.many[1].data)
    expect(mocks.fetchOracleView).toHaveBeenCalledTimes(2)
  })

  it("a failed refresh flags that oracle stale, not the others", async () => {
    const { result } = renderHook(() => useOracleViews(["CORACLE1", "CORACLE2"]), { wrapper })
    await waitFor(() => expect(result.current.every((q) => q.data !== undefined)).toBe(true))
    mocks.fetchOracleView.mockImplementation(async (_r: unknown, _m: unknown, oracle: string) => {
      if (oracle === "CORACLE2") throw new Error("rpc down")
      return { contractId: "ORACLE" }
    })
    await act(() => client.refetchQueries({ queryKey: ["dashboard", "oracle"] }))
    await waitFor(() => expect(result.current[1].stale).toBe(true))
    expect(result.current[0].stale).toBe(false)
  })

  it("waits for the ledger clock instead of reading with no time", () => {
    mocks.clock = { ledgerTime: null, sequence: null, isError: false }
    renderHook(() => useOracleViews(["CORACLE1"]), { wrapper })
    expect(mocks.fetchOracleView).not.toHaveBeenCalled()
  })
})

describe("secondsToBlockNow", () => {
  const live = { status: "live" as const, value: 600, ledger: 1 }
  it("counts down by the ledger time elapsed since the read", () => {
    expect(secondsToBlockNow(live, 1000, 1000)).toBe(600)
    expect(secondsToBlockNow(live, 1000, 1042.7)).toBe(557)
    expect(secondsToBlockNow(live, 1000, 1700)).toBe(-100)
  })
  it("is null without a ledger time or a time to block", () => {
    expect(secondsToBlockNow(live, 1000, null)).toBeNull()
    expect(secondsToBlockNow({ status: "unavailable", error: "x" }, 1000, 1000)).toBeNull()
  })
})

describe("useRiskView", () => {
  it("passes the ledger sequence (for the lapsed window) without keying on it, every 15 s", async () => {
    const { result } = renderHook(() => useRiskView(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.fetchRiskView).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ network: "testnet" }), 5_720_000)
    expect(interval(["dashboard", "risk", "testnet"])).toBe(DASHBOARD_LIVE_MS)
  })
})

describe("usePauses", () => {
  it("reads the pauses every 15 s", async () => {
    const { result } = renderHook(() => usePauses(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(interval(["dashboard", "pauses", "testnet", "m1,m2"])).toBe(DASHBOARD_LIVE_MS)
  })
})

describe("useIndexStatus", () => {
  it("reads the index state over every group, every 60 s", async () => {
    const fetchMock = vi.fn(async () => Response.json(indexAnswer()))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useIndexStatus(), { wrapper })
    await waitFor(() => expect(result.current.data?.indexedThrough).toBe(5_719_749))
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/events?limit=1")
    expect(interval(["dashboard", "index-status", "testnet"])).toBe(DASHBOARD_AGGREGATE_MS)
  })

  it("says why when the server has no database", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "not_configured" }, { status: 503 })))
    const { result } = renderHook(() => useIndexStatus(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe("the event index is not configured on this server")
  })

  it("says why when the database fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })))
    const { result } = renderHook(() => useIndexStatus(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe("the event index could not be read")
  })
})

describe("useComplianceEvents", () => {
  it("merges the RecoveryEscrow and Permissioning events, newest first, and keeps the slower group's state", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("group=escrow")
        ? Response.json(indexAnswer({ rows: [row("0000000000000000300-0000000000", 300, "escrow", "recovery")], indexedThrough: 400, lagSeconds: 30 }))
        : Response.json(
            indexAnswer({
              rows: [
                row("0000000000000000500-0000000000", 500, "permissioning", "acc_grant"),
                row("0000000000000000200-0000000001", 200, "permissioning", "ast_grant"),
                row("0000000000000000200-0000000000", 200, "permissioning", "acc_grant"),
              ],
              indexedThrough: 450,
              lagSeconds: 5,
            }),
          ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useComplianceEvents(3), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/events?group=escrow&limit=3")
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/events?group=permissioning&limit=3")
    expect(result.current.data?.rows.map((r) => r.ledger)).toEqual([500, 300, 200])
    expect(result.current.data?.rows[2].id).toBe("0000000000000000200-0000000001")
    expect(result.current.data?.indexedThrough).toBe(400)
    expect(result.current.data?.lagSeconds).toBe(30)
    expect(interval(["dashboard", "compliance-events", "testnet", 3])).toBe(DASHBOARD_AGGREGATE_MS)
  })

  it("is an error, never a partial list, when one group fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("escrow") ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json(indexAnswer()))),
    )
    const { result } = renderHook(() => useComplianceEvents(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toBeUndefined()
  })
})

describe("useOpenAlerts", () => {
  it("is unavailable, 'alerts not available yet', while the alerts route does not exist (404 page)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!DOCTYPE html><html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } })))
    const { result } = renderHook(() => useOpenAlerts(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe("alerts not available yet")
  })

  it("does not retry a 404: the route is missing, not failing", async () => {
    // The app's Providers retry once; this query must not, whatever the default.
    client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } })
    const fetchMock = vi.fn(async () => new Response("<!DOCTYPE html>", { status: 404, headers: { "content-type": "text/html" } }))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useOpenAlerts(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("still retries once on another failure", async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } })
    const fetchMock = vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 }))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useOpenAlerts(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("returns the open alerts ({ open: Alert[] }), every 60 s", async () => {
    const open: Alert[] = [
      { kind: "oracle_stale", subject: "CORACLE", severity: "critical", openedAt: "2026-11-14T02:00:00.000Z", payload: { age: 4000 } },
      { kind: "risk_warning", subject: "CRISK", severity: "warning", openedAt: "2026-11-14T03:00:00.000Z", payload: {} },
    ]
    const fetchMock = vi.fn(async () => Response.json({ open, recent: [], lastTest: null }))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useOpenAlerts(), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual({ open, recent: [] }))
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/alerts")
    expect(interval(["dashboard", "alerts", "testnet"])).toBe(DASHBOARD_AGGREGATE_MS)
  })

  it.each([
    ["no open list", { alerts: "?" }],
    ["an alert without its severity", { open: [{ kind: "k", subject: "s", openedAt: "2026-11-14T00:00:00Z", payload: {} }] }],
    ["an unknown severity", { open: [{ kind: "k", subject: "s", severity: "info", openedAt: "2026-11-14T00:00:00Z", payload: {} }] }],
  ])("refuses an answer it cannot read (%s) rather than guess a count", async (_, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)))
    const { result } = renderHook(() => useOpenAlerts(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe("the alerts answer is not in the expected shape")
  })
})

describe("useOpenAlerts: the recent list (Task 9 adds it; optional until then)", () => {
  const open: Alert[] = [{ kind: "risk_warning", subject: "CRISK", severity: "warning", openedAt: "2026-11-14T03:00:00.000Z", payload: {} }]
  const closed = { kind: "risk_exhausted", subject: "CRISK", severity: "critical", openedAt: "2026-11-13T03:00:00.000Z", resolvedAt: "2026-11-13T04:00:00.000Z", payload: {} }

  it("passes recent alerts through, with their close time", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ open, recent: [closed] })))
    const { result } = renderHook(() => useOpenAlerts(), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual({ open, recent: [closed] }))
  })

  it("an answer without recent, or with one it cannot read, keeps the open list and no recent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ open, recent: [{ kind: "x" }] })))
    const { result } = renderHook(() => useOpenAlerts(), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual({ open }))
  })

  it("names the missing-route reason, so a page can say there is no alert data yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!DOCTYPE html>", { status: 404, headers: { "content-type": "text/html" } })))
    const { result } = renderHook(() => useOpenAlerts(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe(ALERTS_NOT_AVAILABLE)
  })
})

describe("useEventPages (EventList)", () => {
  it("asks the group, pool and topics, then older pages by the last row's id; a full page has a next page", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      Response.json(indexAnswer({ rows: url.includes("before=") ? [row("0000000000000000001-0000000000", 1, "risk", "cb_limit")] : [row("0000000000000000003-0000000000", 3, "risk", "cb_limit"), row("0000000000000000002-0000000000", 2, "risk", "cb_window")] })),
    )
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useEventPages({ group: "risk", pool: "CPOOL", topics: ["cb_limit", "cb_window"] }, 2), { wrapper })
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/events?group=risk&pool=CPOOL&topic=cb_limit%2Ccb_window&limit=2")
    expect(result.current.hasNextPage).toBe(true)
    await act(() => result.current.fetchNextPage())
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2))
    expect(fetchMock).toHaveBeenLastCalledWith("/api/dashboard/events?group=risk&pool=CPOOL&topic=cb_limit%2Ccb_window&limit=2&before=0000000000000000002-0000000000")
    // A short page is the last.
    expect(result.current.hasNextPage).toBe(false)
    expect(interval(["dashboard", "events", "testnet", "risk", "CPOOL", "cb_limit,cb_window", "all", 2])).toBe(DASHBOARD_AGGREGATE_MS)
  })

  it("asks one contract's events (an oracle's history), keyed apart from the group's", async () => {
    const fetchMock = vi.fn(async () => Response.json(indexAnswer()))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useEventPages({ group: "oracle", contract: "CORACLE", topics: ["ref_set"] }, 20), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/events?group=oracle&contract=CORACLE&topic=ref_set&limit=20")
    expect(interval(["dashboard", "events", "testnet", "oracle", "all", "ref_set", "CORACLE", 20])).toBe(DASHBOARD_AGGREGATE_MS)
  })

  it("every group when none is named", async () => {
    const fetchMock = vi.fn(async () => Response.json(indexAnswer()))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useEventPages({ topics: ["paused"] }, 20), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/events?topic=paused&limit=20")
    expect(result.current.hasNextPage).toBe(false)
  })
})

describe("useAllEvents", () => {
  it("reads every page of 200 until a short one, oldest pages last", async () => {
    const full = Array.from({ length: 200 }, (_, i) => row(`${String(1000 - i).padStart(19, "0")}-0000000000`, 1000 - i, "escrow", "recovery"))
    const fetchMock = vi.fn(async (url: string) => Response.json(indexAnswer({ rows: url.includes("before=") ? [row("0000000000000000001-0000000000", 1, "escrow", "finalize")] : full })))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useAllEvents({ group: "escrow", topics: ["recovery", "finalize"] }), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.rows).toHaveLength(201)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/dashboard/events?group=escrow&topic=recovery%2Cfinalize&limit=200&before=${full[199].id}`)
    expect(result.current.data?.indexedThrough).toBe(5_719_749)
  })

  it("refuses a history longer than it reads, rather than show part of it", async () => {
    let n = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++
        return Response.json(indexAnswer({ rows: Array.from({ length: 200 }, (_, i) => row(`${String(10 ** 6 - n * 200 - i).padStart(19, "0")}-0000000000`, 1, "risk", "add_psr")) }))
      }),
    )
    const { result } = renderHook(() => useAllEvents({ group: "risk", topics: ["add_psr", "rm_psr"] }), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(n).toBe(MAX_EVENT_PAGES)
    // 25 full pages may be exactly 5,000 rows, or more: the page cannot tell without reading on.
    expect(result.current.error?.message).toBe("the event index holds 5,000 or more rows for this list, more than this page reads")
    expect(MAX_EVENT_PAGES * 200).toBe(5000)
  })
})

describe("useEventCounts", () => {
  it("asks the group's counts per topic, every 60 s", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ...indexAnswer(), counts: { acc_grant: 37, ast_grant: 68 } }))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useEventCounts("permissioning"), { wrapper })
    await waitFor(() => expect(result.current.data?.counts).toEqual({ acc_grant: 37, ast_grant: 68 }))
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/events?group=permissioning&counts=1&limit=1")
    expect(interval(["dashboard", "event-counts", "testnet", "permissioning", "all"])).toBe(DASHBOARD_AGGREGATE_MS)
  })

  it("over every group, or one market's pool, for the activity page's kinds", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ...indexAnswer(), counts: { deposit: 111 } }))
    vi.stubGlobal("fetch", fetchMock)
    const all = renderHook(() => useEventCounts(), { wrapper })
    await waitFor(() => expect(all.result.current.data?.counts).toEqual({ deposit: 111 }))
    expect(fetchMock).toHaveBeenLastCalledWith("/api/dashboard/events?counts=1&limit=1")
    const pool = renderHook(() => useEventCounts("market", "CPOOL"), { wrapper })
    await waitFor(() => expect(pool.result.current.data).toBeDefined())
    expect(fetchMock).toHaveBeenLastCalledWith("/api/dashboard/events?group=market&pool=CPOOL&counts=1&limit=1")
  })

  it("an answer without counts is refused, never read as zero", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(indexAnswer())))
    const { result } = renderHook(() => useEventCounts("permissioning"), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})

describe("usePausers", () => {
  const A = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
  it("lists the indexed pausers, then confirms each live every 15 s", async () => {
    const added = { ...row("0000000000000000009-0000000000", 9, "risk", "add_psr"), contractId: "CRISK", data: { caller: "GADMIN", pauser: A } }
    const fetchMock = vi.fn(async () => Response.json(indexAnswer({ rows: [added] })))
    vi.stubGlobal("fetch", fetchMock)
    mocks.fetchPausers.mockResolvedValue({ admin: { status: "live", value: "GADMIN", ledger: 1 }, adminIsPauser: { status: "live", value: true, ledger: 1 }, pausers: [] })
    const { result } = renderHook(() => usePausers(), { wrapper })
    await waitFor(() => expect(result.current.live.data).toBeDefined())
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/events?group=risk&topic=add_psr%2Crm_psr&limit=200")
    expect(result.current.indexed.map((p) => p.account)).toEqual([A])
    expect(mocks.fetchPausers).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ network: "testnet" }), [A])
    expect(interval(["dashboard", "pausers", "testnet", A])).toBe(DASHBOARD_LIVE_MS)
  })
})

describe("useEscrowRecords and useAssetCompliance", () => {
  it("reads every escrow's records, and every asset's model, every 60 s", async () => {
    mocks.fetchEscrowRecords.mockResolvedValue({ status: "live", value: [], ledger: 1 })
    mocks.fetchAssetCompliance.mockResolvedValue([])
    const records = renderHook(() => useEscrowRecords(), { wrapper })
    const assets = renderHook(() => useAssetCompliance(), { wrapper })
    await waitFor(() => expect(records.result.current.data).toBeDefined())
    await waitFor(() => expect(assets.result.current.data).toBeDefined())
    expect(interval(["dashboard", "escrow-records", "testnet", "m1,m2"])).toBe(DASHBOARD_AGGREGATE_MS)
    expect(interval(["dashboard", "assets", "testnet", "m1,m2"])).toBe(DASHBOARD_AGGREGATE_MS)
  })
})

describe("useOracleTicks (spec 0004 D-19)", () => {
  const ORACLE = "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS"
  const entry = {
    oracle: ORACLE,
    asset: "USDY",
    health: { healthy: true, lastSuccessAt: "2026-11-14T11:00:00.000Z", lastOkAt: "2026-11-14T12:00:00.000Z", lastTickAt: "2026-11-14T12:00:00.000Z", rejected24h: 0, failures24h: 0 },
    ticks: [
      { id: "9", at: "2026-11-14T12:00:00.000Z", oracle: ORACLE, mode: "feed", decision: "skipped", value: "10000919", reason: "stale_ts", txHash: null, signer: "GSIGNER" },
    ],
  }
  const answer = { intervalSeconds: 1_800, oracles: [entry] }
  const withEntry = (over: Record<string, unknown>) => ({ ...answer, oracles: [{ ...entry, ...over }] })

  it("reads every oracle's keeper runs and health, every 60 s", async () => {
    const fetchMock = vi.fn(async () => Response.json(answer))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useOracleTicks(), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual(answer))
    expect(fetchMock).toHaveBeenCalledWith("/api/dashboard/oracle-ticks?limit=20")
    expect(interval(["dashboard", "oracle-ticks", "testnet", null, 20])).toBe(DASHBOARD_AGGREGATE_MS)
  })

  it("one oracle: ?oracle= in the URL and in the query key", async () => {
    const fetchMock = vi.fn(async () => Response.json(answer))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useOracleTicks(ORACLE, 5), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual(answer))
    expect(fetchMock).toHaveBeenCalledWith(`/api/dashboard/oracle-ticks?oracle=${ORACLE}&limit=5`)
    expect(interval(["dashboard", "oracle-ticks", "testnet", ORACLE, 5])).toBe(DASHBOARD_AGGREGATE_MS)
  })

  it("parseOracleTicks reads the per-oracle shape, lastOkAt included", () => {
    expect(parseOracleTicks(answer)).toEqual(answer)
    expect(parseOracleTicks({ intervalSeconds: 300, oracles: [] })).toEqual({ intervalSeconds: 300, oracles: [] })
    expect(parseOracleTicks(withEntry({ health: { ...entry.health, lastOkAt: null, lastSuccessAt: null } })).oracles[0].health.lastOkAt).toBeNull()
  })

  it.each([
    ["the old one-oracle shape", { ticks: entry.ticks, health: entry.health, intervalSeconds: 1_800 }],
    ["no oracles list", { ...answer, oracles: undefined }],
    ["an entry without its oracle", withEntry({ oracle: undefined })],
    ["an entry without its asset", withEntry({ asset: 3 })],
    ["no ticks list", withEntry({ ticks: undefined })],
    ["a tick without its decision", withEntry({ ticks: [{ ...entry.ticks[0], decision: 3 }] })],
    ["health without its flag", withEntry({ health: { ...entry.health, healthy: "yes" } })],
    ["health without lastOkAt", withEntry({ health: { ...entry.health, lastOkAt: undefined } })],
    ["a count that is not a whole number", withEntry({ health: { ...entry.health, rejected24h: -1 } })],
    ["no interval", { ...answer, intervalSeconds: 0 }],
  ])("refuses an answer it cannot read (%s), without asking again, rather than show a healthy keeper", async (_, body) => {
    client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } })
    const fetchMock = vi.fn(async () => Response.json(body))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useOracleTicks(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe("the keeper telemetry answered in an unexpected shape")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("a server without a database says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "not_configured" }, { status: 503 })))
    const { result } = renderHook(() => useOracleTicks(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3_000 })
    expect(result.current.error?.message).toBe("the keeper telemetry is not configured on this server")
  })
})
