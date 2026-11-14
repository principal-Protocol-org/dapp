// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  listTicks: vi.fn(),
  keeperHealth: vi.fn(),
  DatabaseConfigError: class DatabaseConfigError extends Error {},
}))
vi.mock("@/lib/server/db", () => ({ sql: "the-sql", DatabaseConfigError: mocks.DatabaseConfigError }))
vi.mock("@/lib/server/oracle-ticks", () => ({ listTicks: mocks.listTicks, keeperHealth: mocks.keeperHealth, ORACLE_TICK_INTERVAL_SECONDS: 1_800 }))
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const m = parseManifest((await import("@/config/manifests/local.example.json")).default)
  return { activeManifest: () => m }
})

import localExample from "@/config/manifests/local.example.json"
import { GET } from "../route"

const ORACLE = localExample.shared.oracle
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
const HEALTH = { healthy: true, lastSuccessAt: TICK.at, lastTickAt: TICK.at, rejected24h: 0, failures24h: 0 }
const get = (query = "") => GET(new Request(`https://app.example/api/dashboard/oracle-ticks${query}`))

describe("GET /api/dashboard/oracle-ticks (D-19)", () => {
  beforeEach(() => {
    mocks.listTicks.mockReset().mockResolvedValue([TICK])
    mocks.keeperHealth.mockReset().mockResolvedValue(HEALTH)
  })

  it("answers the recent ticks and the keeper's health for this network's oracle, cached 60 s", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ticks: [TICK], health: HEALTH, intervalSeconds: 1_800 })
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(mocks.listTicks).toHaveBeenCalledWith("the-sql", { network: "local", oracle: ORACLE, limit: 20 })
    expect(mocks.keeperHealth).toHaveBeenCalledWith("the-sql", "local", 1_800, { oracle: ORACLE })
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
