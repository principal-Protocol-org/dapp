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
}))

vi.mock("@/components/app/manifest-provider", () => {
  // One object, as the provider gives: hooks depend on its identity.
  const manifest = { network: "testnet", rpcUrl: "https://rpc.test", markets: [{ marketId: "m1" }, { marketId: "m2" }], shared: {} }
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

import {
  DASHBOARD_AGGREGATE_MS,
  DASHBOARD_LIVE_MS,
  secondsToBlockNow,
  useComplianceEvents,
  useIndexStatus,
  useMarketDashboard,
  useOpenAlerts,
  useOracleView,
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
    expect(mocks.fetchMarketDashboard).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ network: "testnet" }), { marketId: "m2" })
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
    expect(mocks.pendingClaim).toHaveBeenCalledWith(expect.anything(), { marketId: "m1" }, ACCOUNT, ms)
    expect(result.current.data).toEqual({ status: "live", value: 5n, ledger: 1 })
    expect(interval(["dashboard", "pending", "testnet", "m1", ACCOUNT])).toBe(DASHBOARD_LIVE_MS)
  })
})

describe("useOracleView", () => {
  it("passes the ledger time and returns it with the view, every 15 s", async () => {
    const { result } = renderHook(() => useOracleView(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.fetchOracleView).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ network: "testnet" }), 1_000_000)
    expect(result.current.data).toEqual({ view: { contractId: "ORACLE" }, ledgerTime: 1_000_000 })
    expect(interval(["dashboard", "oracle", "testnet"])).toBe(DASHBOARD_LIVE_MS)
  })

  it("waits for the ledger clock instead of reading with no time", () => {
    mocks.clock = { ledgerTime: null, sequence: null, isError: false }
    renderHook(() => useOracleView(), { wrapper })
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
    await waitFor(() => expect(result.current.data).toEqual({ open }))
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
