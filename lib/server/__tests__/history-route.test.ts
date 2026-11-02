// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { parseManifest } from "@/lib/protocol/manifest"

vi.mock("server-only", () => ({}))
const manifest = parseManifest(testnetJson)
vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => manifest }))
const state = vi.hoisted(() => ({ fail: null as unknown, registry: [] as Record<string, unknown>[] }))
vi.mock("@/lib/server/db", () => ({
  sql: async (strings: TemplateStringsArray) => {
    if (state.fail) throw state.fail
    return strings.join("?").includes("from market_registry") ? state.registry : []
  },
  DatabaseConfigError: class DatabaseConfigError extends Error {},
}))

import { GET as history } from "@/app/api/markets/[pool]/history/route"
import { GET as sparks } from "@/app/api/markets/sparks/route"

const pool = manifest.markets[0].contracts.pool
const call = (p: string, q = "") => history(new Request(`http://x/api/markets/${p}/history${q}`), { params: Promise.resolve({ pool: p }) })

beforeEach(() => {
  state.fail = null
  state.registry = []
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("history route", () => {
  it("the route returns 200 with an empty history when the database is down", async () => {
    state.fail = Object.assign(new Error("connect ECONNREFUSED host"), { code: "ECONNREFUSED" })
    const res = await call(pool, "?range=7d")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store") // the fallback is never cached
    expect(await res.json()).toEqual({ fixedApy: [], underlyingApy7d: [], liquidity: [], latestAt: null, stale: true, underlyingWindowSeconds: null })
  })

  it("also when the database is not configured", async () => {
    const { DatabaseConfigError } = await import("@/lib/server/db")
    state.fail = new DatabaseConfigError()
    const res = await call(pool)
    expect(res.status).toBe(200)
    expect((await res.json()).stale).toBe(true)
  })

  it("rejects a bad pool or range with 400", async () => {
    expect((await call("nope")).status).toBe(400)
    expect((await call(pool, "?range=1y")).status).toBe(400)
  })

  it("a valid registry market is known too (R2-33): a discovered pool gets its history, not 404", async () => {
    const discovered = "C" + "B".repeat(55)
    const market = { ...manifest.markets[0], marketId: "testnet-sta-discovered", contracts: { ...manifest.markets[0].contracts, pool: discovered } }
    state.registry = [{ pool: discovered, market_id: market.marketId, source: "discovered", valid: true, reason: null, market }]
    const res = await call(discovered, "?range=7d")
    expect(res.status).toBe(200)
    // An invalid row is not a known market.
    state.registry = [{ ...state.registry[0], valid: false }]
    expect((await call(discovered, "?range=7d")).status).toBe(404)
  })

  it("404 for a pool that is not a known market", async () => {
    expect((await call("C" + "A".repeat(55))).status).toBe(404)
  })
})

describe("cache headers", () => {
  it("a database answer is cached 60 s with stale-while-revalidate", async () => {
    const want = "public, s-maxage=60, stale-while-revalidate=300"
    expect((await call(pool, "?range=7d")).headers.get("cache-control")).toBe(want)
    const res = await sparks(new Request(`http://x/api/markets/sparks?pools=${pool}`))
    expect(res.headers.get("cache-control")).toBe(want)
    expect(res.status).toBe(200)
  })
})

describe("sparks route", () => {
  it("answers empty sparks when the database is down", async () => {
    state.fail = new Error("down")
    const res = await sparks(new Request(`http://x/api/markets/sparks?pools=${pool}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sparks: { [pool]: { points: [], changePts: null, stale: true } }, stale: true })
  })

  it("rejects a bad pool list", async () => {
    expect((await sparks(new Request("http://x/api/markets/sparks?pools=bad"))).status).toBe(400)
    expect((await sparks(new Request("http://x/api/markets/sparks"))).status).toBe(400)
  })
})
