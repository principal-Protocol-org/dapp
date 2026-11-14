// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/server", () => ({ connection: async () => {} }))

const mocks = vi.hoisted(() => ({
  getLedgerClock: vi.fn(),
  getIndexedEvents: vi.fn(),
  keeperHealth: vi.fn(),
  openAlertCounts: vi.fn(),
  manifest: vi.fn(),
  DatabaseConfigError: class DatabaseConfigError extends Error {},
}))
vi.mock("@/lib/protocol/stellar", () => ({ createRpcServer: () => ({ rpc: "fake" }), getLedgerClock: mocks.getLedgerClock }))
vi.mock("@/lib/server/indexer", () => ({ getIndexedEvents: mocks.getIndexedEvents }))
vi.mock("@/lib/server/oracle-ticks", () => ({ keeperHealth: mocks.keeperHealth, ORACLE_TICK_INTERVAL_SECONDS: 1_800 }))
vi.mock("@/lib/server/alerts", () => ({ openAlertCounts: mocks.openAlertCounts }))
vi.mock("@/lib/server/db", () => ({ sql: vi.fn(async () => []), DatabaseConfigError: mocks.DatabaseConfigError }))
vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => mocks.manifest() }))

import { parseManifest } from "@/lib/protocol/manifest"
import testnetJson from "@/config/manifests/testnet.json"
import { GET, HEALTH_PART_TIMEOUT_MS } from "../route"

const MANIFEST = parseManifest(testnetJson)
const CLOSE = 1_794_657_600 // 2026-11-14T12:00:00Z
const INDEX = { rows: [], indexedThrough: 5_719_749, indexedThroughCloseTime: "2026-11-14T11:55:00.000Z", lagSeconds: 300, gaps: [], reconcile: null }
const KEEPER = { healthy: true, lastSuccessAt: "2026-11-14T11:30:00.000Z", lastTickAt: "2026-11-14T11:30:00.000Z", rejected24h: 0, failures24h: 0 }

describe("GET /api/health", () => {
  beforeEach(() => {
    mocks.manifest.mockReset()
    mocks.manifest.mockReturnValue(MANIFEST)
    mocks.getLedgerClock.mockReset()
    mocks.getLedgerClock.mockResolvedValue({ sequence: 5_720_000, closeTime: CLOSE, readAtMs: 0 })
    mocks.getIndexedEvents.mockReset()
    mocks.getIndexedEvents.mockResolvedValue(INDEX)
    mocks.keeperHealth.mockReset()
    mocks.keeperHealth.mockResolvedValue(KEEPER)
    mocks.openAlertCounts.mockReset()
    mocks.openAlertCounts.mockResolvedValue({ count: 2, critical: 1 })
    process.env.DATABASE_URL = "postgres://u:p@db.example/x"
  })
  afterEach(() => {
    delete process.env.DATABASE_URL
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("is public and cached 15 s: network, ledger, indexer, keeper and open alerts", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=15, stale-while-revalidate=15")
    expect(await res.json()).toEqual({
      network: "testnet",
      ledger: { status: "ok", sequence: 5_720_000, closeTime: "2026-11-14T12:00:00.000Z" },
      indexer: { status: "ok", indexedThrough: 5_719_749, indexedThroughCloseTime: "2026-11-14T11:55:00.000Z", lagSeconds: 300, gaps: [] },
      keeper: { status: "ok", healthy: true, lastSuccessAt: "2026-11-14T11:30:00.000Z", lastTickAt: "2026-11-14T11:30:00.000Z" },
      openAlerts: { status: "ok", count: 2, critical: 1 },
    })
    expect(mocks.getIndexedEvents.mock.calls[0][1]).toMatchObject({ network: "testnet", limit: 1 })
    expect(mocks.keeperHealth.mock.calls[0]).toEqual([expect.anything(), "testnet", 1_800, { oracle: MANIFEST.shared.oracle }])
    expect(mocks.openAlertCounts.mock.calls[0][1]).toBe("testnet")
  })

  it("no keeper run recorded reads healthy null: unknown, not unhealthy", async () => {
    mocks.keeperHealth.mockResolvedValue({ healthy: false, lastSuccessAt: null, lastTickAt: null, rejected24h: 0, failures24h: 0 })
    expect((await (await GET()).json()).keeper).toEqual({ status: "ok", healthy: null, lastSuccessAt: null, lastTickAt: null })
  })

  it("each part fails alone: an RPC failure leaves the database parts, with 200", async () => {
    mocks.getLedgerClock.mockRejectedValue(new Error("fetch https://rpc.provider.example/key/abc failed"))
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ledger).toEqual({ status: "unavailable", reason: "the RPC could not be read" })
    expect(body.indexer.status).toBe("ok")
    expect(body.keeper.status).toBe("ok")
    expect(body.openAlerts.status).toBe("ok")
  })

  it("no database: the database parts are unavailable, the ledger still reads", async () => {
    for (const m of [mocks.getIndexedEvents, mocks.keeperHealth, mocks.openAlertCounts]) m.mockRejectedValue(new mocks.DatabaseConfigError("DATABASE_URL is not set."))
    const body = await (await GET()).json()
    expect(body.ledger.status).toBe("ok")
    for (const part of ["indexer", "keeper", "openAlerts"]) expect(body[part]).toEqual({ status: "unavailable", reason: "the database is not configured" })
  })

  it("a database that fails reads unavailable, its error never shown", async () => {
    mocks.openAlertCounts.mockRejectedValue(new Error("connect to postgres://u:p@db.example/x failed"))
    const res = await GET()
    const text = await res.text()
    expect(JSON.parse(text).openAlerts).toEqual({ status: "unavailable", reason: "the database could not be read" })
    expect(text).not.toContain("db.example")
    expect(text).not.toContain("postgres://")
  })

  it(`a part that hangs is cut after ${HEALTH_PART_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers()
    mocks.getLedgerClock.mockReturnValue(new Promise(() => {}))
    const answer = GET()
    await vi.advanceTimersByTimeAsync(HEALTH_PART_TIMEOUT_MS + 1)
    const body = await (await answer).json()
    expect(body.ledger).toEqual({ status: "unavailable", reason: "timed out" })
    expect(body.indexer.status).toBe("ok")
  })

  it("never throws: a manifest that cannot be read answers 200 with every part unavailable", async () => {
    mocks.manifest.mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_PRINCIPAL_NETWORK must be testnet or local")
    })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.network).toBeNull()
    for (const part of ["ledger", "indexer", "keeper", "openAlerts"]) expect(body[part]).toEqual({ status: "unavailable", reason: "the manifest could not be read" })
  })
})
