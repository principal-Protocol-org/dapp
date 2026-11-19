// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  listTicks: vi.fn(),
  keeperHealth: vi.fn(),
  keeperIntervalSeconds: vi.fn(),
  DatabaseConfigError: class DatabaseConfigError extends Error {},
  manifestError: null as Error | null,
}))
vi.mock("@/lib/server/db", () => ({ sql: "the-sql", DatabaseConfigError: mocks.DatabaseConfigError }))
vi.mock("@/lib/server/oracle-ticks", () => ({ listTicks: mocks.listTicks, keeperHealth: mocks.keeperHealth, keeperIntervalSeconds: mocks.keeperIntervalSeconds }))
/** A second market on its own oracle, as on Mainnet (one oracle per market). */
const ORACLE_B = "CBHAWS6B4YCNRLYRP2HUP77P4IRP3PZYPSYVPV4OMZNU2ZNKSAQQ2GXU"
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const json = (await import("@/config/manifests/local.example.json")).default
  const [first] = json.markets
  const m = parseManifest({
    ...json,
    markets: [
      first,
      {
        ...first,
        marketId: "local-gilt",
        underlying: { ...first.underlying, code: "GILT" },
        contracts: { ...first.contracts, oracle: "CBHAWS6B4YCNRLYRP2HUP77P4IRP3PZYPSYVPV4OMZNU2ZNKSAQQ2GXU", pool: "CBJGWQ7BJ7AND2MNG4RCA626PPX4RTDKLJGNG6UVXFTOYF6GGQ7T5GZ6" },
      },
    ],
  })
  return {
    activeManifest: () => {
      if (mocks.manifestError) throw mocks.manifestError
      return m
    },
  }
})

import localExample from "@/config/manifests/local.example.json"
import { GET } from "../route"

const ORACLE = localExample.shared.oracle
const ASSET = localExample.markets[0].underlying.code
const SIGNER = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const TICK = {
  id: "7",
  at: "2026-11-14T12:00:00.000Z",
  oracle: ORACLE,
  mode: "push",
  decision: "pushed",
  value: "10000919",
  reason: null,
  txHash: "ab".repeat(32),
  signer: SIGNER,
}
const HEALTH = { healthy: true, lastSuccessAt: TICK.at, lastOkAt: TICK.at, lastTickAt: TICK.at, rejected24h: 0, failures24h: 0 }
const get = (query = "") => GET(new Request(`https://app.example/api/dashboard/oracle-ticks${query}`))

describe("GET /api/dashboard/oracle-ticks (D-19)", () => {
  beforeEach(() => {
    mocks.listTicks.mockReset().mockResolvedValue([TICK])
    mocks.keeperHealth.mockReset().mockResolvedValue(HEALTH)
    mocks.keeperIntervalSeconds.mockReset().mockReturnValue(1_800)
    mocks.manifestError = null
  })

  it("a manifest that cannot be read answers 503 unavailable, never cached, logged by name only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.manifestError = new Error('NEXT_PUBLIC_PRINCIPAL_NETWORK must be "testnet" or "local", got "x".')
      const res = await get()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "unavailable" })
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(error.mock.calls.map((c) => c.map(String).join(" "))).toEqual(["dashboard oracle-ticks route: Error"])
    } finally {
      error.mockRestore()
    }
  })

  it("without ?oracle=, every manifest oracle in order, each with its asset, health and recent ticks; cached 60 s", async () => {
    const TICK_B = { ...TICK, id: "8", oracle: ORACLE_B }
    const HEALTH_B = { ...HEALTH, healthy: false, failures24h: 3 }
    mocks.listTicks.mockImplementation(async (_sql: unknown, q: { oracle: string }) => (q.oracle === ORACLE_B ? [TICK_B] : [TICK]))
    mocks.keeperHealth.mockImplementation(async (_sql: unknown, _n: unknown, _i: unknown, o: { oracle: string }) => (o.oracle === ORACLE_B ? HEALTH_B : HEALTH))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      intervalSeconds: 1_800,
      oracles: [
        { oracle: ORACLE, asset: ASSET, health: HEALTH, ticks: [TICK] },
        { oracle: ORACLE_B, asset: "GILT", health: HEALTH_B, ticks: [TICK_B] },
      ],
    })
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    // The limit applies per oracle.
    expect(mocks.listTicks.mock.calls).toEqual([
      ["the-sql", { network: "local", oracle: ORACLE, limit: 20 }],
      ["the-sql", { network: "local", oracle: ORACLE_B, limit: 20 }],
    ])
    expect(mocks.keeperHealth.mock.calls).toEqual([
      ["the-sql", "local", 1_800, { oracle: ORACLE }],
      ["the-sql", "local", 1_800, { oracle: ORACLE_B }],
    ])
    expect(mocks.keeperIntervalSeconds).toHaveBeenCalledWith(process.env)
  })

  it("?oracle= one of the manifest's oracles: the same shape with that one entry", async () => {
    const res = await get(`?oracle=${ORACLE_B}&limit=5`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ intervalSeconds: 1_800, oracles: [{ oracle: ORACLE_B, asset: "GILT", health: HEALTH, ticks: [TICK] }] })
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(mocks.listTicks.mock.calls).toEqual([["the-sql", { network: "local", oracle: ORACLE_B, limit: 5 }]])
    expect(mocks.keeperHealth.mock.calls).toEqual([["the-sql", "local", 1_800, { oracle: ORACLE_B }]])
  })

  it.each([
    ["a contract the manifest does not name", "CB2YO6BCOTN336RQUAMHOBCNABJG74URBIMNUHXB27K2QOLJKDCDXODZ"],
    ["an account, not a contract", "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"],
    ["a lower-case id", ORACLE.toLowerCase()],
    ["nothing", ""],
    ["junk", "x' or 1=1"],
  ])("400 unknown_oracle for %s, never cached, nothing read", async (_, oracle) => {
    const res = await get(`?oracle=${encodeURIComponent(oracle)}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "unknown_oracle" })
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(mocks.listTicks).not.toHaveBeenCalled()
    expect(mocks.keeperHealth).not.toHaveBeenCalled()
  })

  it("the schedule is ORACLE_KEEPER_INTERVAL_SECONDS, read per request; a bad one answers 503 unavailable, nothing read", async () => {
    mocks.keeperIntervalSeconds.mockReturnValue(300)
    expect((await (await get()).json()).intervalSeconds).toBe(300)
    expect(mocks.keeperHealth).toHaveBeenLastCalledWith("the-sql", "local", 300, { oracle: ORACLE_B })
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.listTicks.mockClear()
      mocks.keeperIntervalSeconds.mockImplementation(() => {
        throw new Error("ORACLE_KEEPER_INTERVAL_SECONDS must be a whole number of seconds from 60 to 86400.")
      })
      const res = await get()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "unavailable" })
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(mocks.listTicks).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it("takes ?limit= from 1 to 100", async () => {
    await get("?limit=1")
    expect(mocks.listTicks).toHaveBeenLastCalledWith("the-sql", expect.objectContaining({ limit: 1 }))
    await get("?limit=100")
    expect(mocks.listTicks).toHaveBeenLastCalledWith("the-sql", expect.objectContaining({ limit: 100 }))
  })

  it.each(["0", "101", "-1", "abc", "1.5", "", "1000"])("400 invalid_limit for ?limit=%s, not cached, nothing read", async (limit) => {
    const res = await get(`?limit=${limit}`)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid_limit" })
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(mocks.listTicks).not.toHaveBeenCalled()
  })

  it("503 not_configured without a database, never cached", async () => {
    mocks.listTicks.mockRejectedValue(new mocks.DatabaseConfigError("DATABASE_URL is not set."))
    const res = await get()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "not_configured" })
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it("503 unavailable when the database fails, logged by error name only, never cached", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.keeperHealth.mockRejectedValue(new Error("connect postgres://user:pw@db.example failed"))
      const res = await get()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "unavailable" })
      expect(res.headers.get("cache-control")).toBe("no-store")
      const line = error.mock.calls.map((c) => c.map(String).join(" ")).join("\n")
      expect(line).toBe("dashboard oracle-ticks route: Error")
    } finally {
      error.mockRestore()
    }
  })
})
