// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/server", () => ({ connection: async () => {} }))

const mocks = vi.hoisted(() => ({
  getLedgerClock: vi.fn(),
  getIndexedEvents: vi.fn(),
  keeperHealth: vi.fn(),
  keeperIntervalSeconds: vi.fn(),
  openAlertCounts: vi.fn(),
  manifest: vi.fn(),
  DatabaseConfigError: class DatabaseConfigError extends Error {},
}))
vi.mock("@/lib/protocol/stellar", () => ({ createRpcServer: () => ({ rpc: "fake" }), getLedgerClock: mocks.getLedgerClock }))
vi.mock("@/lib/server/indexer", () => ({ getIndexedEvents: mocks.getIndexedEvents }))
vi.mock("@/lib/server/oracle-ticks", () => ({ keeperHealth: mocks.keeperHealth, keeperIntervalSeconds: mocks.keeperIntervalSeconds }))
vi.mock("@/lib/server/alerts", () => ({ openAlertCounts: mocks.openAlertCounts }))
vi.mock("@/lib/server/db", () => ({ sql: vi.fn(async () => []), DatabaseConfigError: mocks.DatabaseConfigError }))
vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => mocks.manifest() }))

import { parseManifest } from "@/lib/protocol/manifest"
import testnetJson from "@/config/manifests/testnet.json"
import { GET, HEALTH_PART_TIMEOUT_MS } from "../route"

const MANIFEST = parseManifest(testnetJson)
const ORACLE = MANIFEST.shared.oracle
/** Two more markets on a second oracle, as on Mainnet (one oracle per market). */
const ORACLE_B = "CBHAWS6B4YCNRLYRP2HUP77P4IRP3PZYPSYVPV4OMZNU2ZNKSAQQ2GXU"
const [M1] = MANIFEST.markets
const TWO = {
  ...MANIFEST,
  markets: [
    M1,
    { ...M1, marketId: "m2", underlying: { ...M1.underlying, code: "USTRY" }, contracts: { ...M1.contracts, oracle: ORACLE_B, pool: "CBJGWQ7BJ7AND2MNG4RCA626PPX4RTDKLJGNG6UVXFTOYF6GGQ7T5GZ6" } },
    { ...M1, marketId: "m3", underlying: { ...M1.underlying, code: "GILT" }, contracts: { ...M1.contracts, oracle: ORACLE_B, pool: "CDWVSTG3UZXZOEF2FGKJXFZFGEYEO3HUH7IFZNHOEFSQYZ575GAUYQH4" } },
  ],
}
const CLOSE = 1_794_657_600 // 2026-11-14T12:00:00Z
const INDEX = { rows: [], indexedThrough: 5_719_749, indexedThroughCloseTime: "2026-11-14T11:55:00.000Z", lagSeconds: 300, gaps: [], pendingGroups: [], reconcile: null }
const KEEPER = {
  healthy: true,
  lastSuccessAt: "2026-11-14T11:30:00.000Z",
  lastOkAt: "2026-11-14T11:45:00.000Z",
  lastTickAt: "2026-11-14T11:45:00.000Z",
  rejected24h: 0,
  failures24h: 0,
}

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
    mocks.keeperIntervalSeconds.mockReset().mockReturnValue(1_800)
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
      indexer: { status: "ok", indexedThrough: 5_719_749, indexedThroughCloseTime: "2026-11-14T11:55:00.000Z", lagSeconds: 300, gaps: [], pendingGroups: [] },
      keeper: { status: "ok", healthy: true, lastSuccessAt: "2026-11-14T11:30:00.000Z", lastOkAt: "2026-11-14T11:45:00.000Z", lastTickAt: "2026-11-14T11:45:00.000Z" },
      keepers: [{ oracle: ORACLE, asset: "USDY", healthy: true, lastOkAt: "2026-11-14T11:45:00.000Z", lastTickAt: "2026-11-14T11:45:00.000Z" }],
      openAlerts: { status: "ok", count: 2, critical: 1 },
    })
    expect(mocks.getIndexedEvents.mock.calls[0][1]).toMatchObject({ network: "testnet", limit: 1 })
    expect(mocks.keeperHealth.mock.calls).toEqual([[expect.anything(), "testnet", 1_800, { oracle: ORACLE }]])
    // The schedule is read from the environment at request time.
    expect(mocks.keeperIntervalSeconds).toHaveBeenCalledWith(process.env)
    expect(mocks.openAlertCounts.mock.calls[0][1]).toBe("testnet")
  })

  it("before the first run of a group the indexer reads pending, with the reason and the groups, never ok; still 200 (M-7)", async () => {
    // market and escrow have no cursor yet (no market listed, as on Mainnet before its first market).
    mocks.getIndexedEvents.mockResolvedValue({ ...INDEX, indexedThrough: 0, indexedThroughCloseTime: null, lagSeconds: null, pendingGroups: ["escrow", "market"] })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=15, stale-while-revalidate=15")
    expect((await res.json()).indexer).toEqual({
      status: "pending",
      reason: "no index run yet",
      indexedThrough: 0,
      indexedThroughCloseTime: null,
      lagSeconds: null,
      gaps: [],
      pendingGroups: ["escrow", "market"],
    })
  })

  it("a pending indexer is not unavailable: with every other part down the answer is still 200", async () => {
    mocks.getIndexedEvents.mockResolvedValue({ ...INDEX, indexedThrough: 0, indexedThroughCloseTime: null, lagSeconds: null, pendingGroups: ["escrow", "oracle", "permissioning", "risk", "market"] })
    mocks.getLedgerClock.mockRejectedValue(new Error("rpc down"))
    mocks.keeperHealth.mockRejectedValue(new Error("db down"))
    mocks.openAlertCounts.mockRejectedValue(new Error("db down"))
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).indexer.status).toBe("pending")
  })

  it("no keeper run recorded reads healthy null: unknown, not unhealthy", async () => {
    mocks.keeperHealth.mockResolvedValue({ healthy: false, lastSuccessAt: null, lastOkAt: null, lastTickAt: null, rejected24h: 0, failures24h: 0 })
    const body = await (await GET()).json()
    expect(body.keeper).toEqual({ status: "ok", healthy: null, lastSuccessAt: null, lastOkAt: null, lastTickAt: null })
    expect(body.keepers).toEqual([{ oracle: ORACLE, asset: "USDY", healthy: null, lastOkAt: null, lastTickAt: null }])
  })

  describe("several oracles: keeper is the worst one's state (one object, for monitors), keepers lists each", () => {
    const at = (minutes: number) => `2026-11-14T${String(11 + Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00.000Z`
    const health = (o: { healthy: boolean; ok: string | null; tick: string | null; success?: string | null }) => ({
      healthy: o.healthy,
      lastSuccessAt: o.success ?? null,
      lastOkAt: o.ok,
      lastTickAt: o.tick,
      rejected24h: 0,
      failures24h: 0,
    })
    const answer = async (a: ReturnType<typeof health>, b: ReturnType<typeof health>) => {
      mocks.manifest.mockReturnValue(TWO)
      mocks.keeperHealth.mockImplementation(async (_sql: unknown, _n: unknown, _i: unknown, o: { oracle: string }) => (o.oracle === ORACLE_B ? b : a))
      return (await GET()).json()
    }

    it("one health read per oracle; keepers names each oracle and its markets' assets", async () => {
      const body = await answer(health({ healthy: true, ok: at(45), tick: at(45) }), health({ healthy: true, ok: at(40), tick: at(50), success: at(10) }))
      expect(mocks.keeperHealth.mock.calls.map((c) => c[3])).toEqual([{ oracle: ORACLE }, { oracle: ORACLE_B }])
      expect(body.keepers).toEqual([
        { oracle: ORACLE, asset: "USDY", healthy: true, lastOkAt: at(45), lastTickAt: at(45) },
        { oracle: ORACLE_B, asset: "USTRY, GILT", healthy: true, lastOkAt: at(40), lastTickAt: at(50) },
      ])
      // All healthy: the oldest lastOkAt stands for them.
      expect(body.keeper).toEqual({ status: "ok", healthy: true, lastSuccessAt: at(10), lastOkAt: at(40), lastTickAt: at(50) })
    })

    it("unhealthy beats healthy, whatever the ages", async () => {
      const body = await answer(health({ healthy: true, ok: at(5), tick: at(5) }), health({ healthy: false, ok: at(40), tick: at(50) }))
      expect(body.keeper).toMatchObject({ status: "ok", healthy: false, lastOkAt: at(40), lastTickAt: at(50) })
      expect(body.keepers.map((k: { healthy: boolean }) => k.healthy)).toEqual([true, false])
    })

    it("among unhealthy ones, the oldest lastOkAt; none recorded is the oldest", async () => {
      expect((await answer(health({ healthy: false, ok: at(30), tick: at(50) }), health({ healthy: false, ok: at(20), tick: at(50) }))).keeper).toMatchObject({ healthy: false, lastOkAt: at(20) })
      expect((await answer(health({ healthy: false, ok: null, tick: at(50) }), health({ healthy: false, ok: at(20), tick: at(50) }))).keeper).toMatchObject({ healthy: false, lastOkAt: null })
    })

    it("an oracle with no run yet is unknown: it beats a healthy one (healthy null), not an unhealthy one", async () => {
      const none = health({ healthy: false, ok: null, tick: null })
      expect((await answer(health({ healthy: true, ok: at(45), tick: at(45) }), none)).keeper).toEqual({ status: "ok", healthy: null, lastSuccessAt: null, lastOkAt: null, lastTickAt: null })
      expect((await answer(health({ healthy: false, ok: at(5), tick: at(50) }), none)).keeper).toMatchObject({ healthy: false, lastOkAt: at(5) })
    })

    it("one oracle's read failing makes the keeper part unavailable, and keepers null", async () => {
      mocks.manifest.mockReturnValue(TWO)
      mocks.keeperHealth.mockImplementation(async (_sql: unknown, _n: unknown, _i: unknown, o: { oracle: string }) => {
        if (o.oracle === ORACLE_B) throw new Error("db down")
        return KEEPER
      })
      const body = await (await GET()).json()
      expect(body.keeper).toEqual({ status: "unavailable", reason: "the database could not be read" })
      expect(body.keepers).toBeNull()
    })
  })

  it("the keeper is measured against ORACLE_KEEPER_INTERVAL_SECONDS; a bad value makes its part unavailable, the others still read", async () => {
    mocks.keeperIntervalSeconds.mockReturnValue(300)
    await GET()
    expect(mocks.keeperHealth.mock.calls[0][2]).toBe(300)
    mocks.keeperHealth.mockClear()
    mocks.keeperIntervalSeconds.mockImplementation(() => {
      throw new Error("ORACLE_KEEPER_INTERVAL_SECONDS must be a whole number of seconds from 60 to 86400.")
    })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.keeper).toEqual({ status: "unavailable", reason: "the keeper's interval is not valid" })
    expect(body.keepers).toBeNull()
    expect(body.ledger.status).toBe("ok")
    expect(mocks.keeperHealth).not.toHaveBeenCalled()
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

  it("503, not cached, when every part is unavailable; the JSON still names each part's reason", async () => {
    mocks.getLedgerClock.mockRejectedValue(new Error("rpc down"))
    for (const m of [mocks.getIndexedEvents, mocks.keeperHealth, mocks.openAlertCounts]) m.mockRejectedValue(new mocks.DatabaseConfigError("DATABASE_URL is not set."))
    const res = await GET()
    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(body.network).toBe("testnet")
    expect(body.ledger).toEqual({ status: "unavailable", reason: "the RPC could not be read" })
    expect(body.openAlerts).toEqual({ status: "unavailable", reason: "the database is not configured" })
  })

  it("one part reading is enough for 200", async () => {
    for (const m of [mocks.getIndexedEvents, mocks.keeperHealth, mocks.openAlertCounts]) m.mockRejectedValue(new Error("db down"))
    expect((await GET()).status).toBe(200)
  })

  it("never throws: a manifest that cannot be read answers 503 with every part unavailable", async () => {
    mocks.manifest.mockImplementation(() => {
      throw new Error("NEXT_PUBLIC_PRINCIPAL_NETWORK must be testnet or local")
    })
    const res = await GET()
    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(body.network).toBeNull()
    for (const part of ["ledger", "indexer", "keeper", "openAlerts"]) expect(body[part]).toEqual({ status: "unavailable", reason: "the manifest could not be read" })
    expect(body.keepers).toBeNull()
  })
})
