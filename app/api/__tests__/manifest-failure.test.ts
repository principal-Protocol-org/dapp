// @vitest-environment node
/**
 * A manifest that cannot be read (a bad file, a wrong network) never crashes a route: each of the
 * 12 API routes and `/api/health` gives its own normal error answer, never cached, and reads nothing.
 */
import { StrKey } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  sql: vi.fn(() => {
    throw new Error("the database was read without a manifest")
  }),
  rpc: vi.fn(() => {
    throw new Error("the network was read without a manifest")
  }),
}))
vi.mock("@/lib/protocol/manifest-source", () => ({
  activeManifest: () => {
    throw new Error("Invalid manifest: shared.router: Expected Stellar contract ID (C...)")
  },
  activeNetwork: () => "testnet",
}))
vi.mock("@/lib/server/db", () => ({ sql: mocks.sql, DatabaseConfigError: class DatabaseConfigError extends Error {} }))
vi.mock("@/lib/protocol/stellar", async (importOriginal) => ({ ...(await importOriginal<object>()), createRpcServer: mocks.rpc }))
vi.mock("next/server", () => ({ connection: async () => {} }))

const SECRET = "test-cron-secret-0123456789"
const auth = { authorization: `Bearer ${SECRET}` }
const POOL = StrKey.encodeContract(Buffer.alloc(32, 1))
const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) })
const cron = (path: string) => new Request(`https://app.example/api/cron/${path}`, { headers: auth })

const FAILED = { error: "failed" }
const UNAVAILABLE = { error: "unavailable" }
const NONE = { status: "unavailable", reason: "the manifest could not be read" }

type Case = { route: string; call: () => Promise<Response>; status: number; body: unknown }

const CASES: Case[] = [
  {
    route: "GET /api/markets",
    call: async () => (await import("../markets/route")).GET(),
    status: 500,
    body: { error: "failed", message: "The markets could not be listed. Try again in a minute." },
  },
  {
    route: "POST /api/markets",
    call: async () => (await import("../markets/route")).POST(post("https://app.example/api/markets", { pool: POOL })),
    status: 500,
    body: { error: "failed", message: "Publishing failed. Try again in a minute." },
  },
  {
    route: "GET /api/markets/sparks (the stale answer)",
    call: async () => (await import("../markets/sparks/route")).GET(new Request(`https://app.example/api/markets/sparks?pools=${POOL}`)),
    status: 200,
    body: { sparks: { [POOL]: { points: [], changePts: null, stale: true } }, stale: true },
  },
  {
    route: "GET /api/markets/[pool]/history (the stale answer)",
    call: async () =>
      (await import("../markets/[pool]/history/route")).GET(new Request(`https://app.example/api/markets/${POOL}/history`), {
        params: Promise.resolve({ pool: POOL }),
      }),
    status: 200,
    body: { fixedApy: [], underlyingApy7d: [], liquidity: [], latestAt: null, stale: true, underlyingWindowSeconds: null },
  },
  {
    route: "POST /api/faucet",
    call: async () => (await import("../faucet/route")).POST(post("https://app.example/api/faucet", { account: ACCOUNT })),
    status: 502,
    body: { error: "failed", message: "The faucet could not finish — try again in a minute. Steps already done are kept." },
  },
  {
    route: "GET /api/dashboard/events",
    call: async () => (await import("../dashboard/events/route")).GET(new Request("https://app.example/api/dashboard/events")),
    status: 503,
    body: UNAVAILABLE,
  },
  {
    route: "GET /api/dashboard/oracle-ticks",
    call: async () => (await import("../dashboard/oracle-ticks/route")).GET(new Request("https://app.example/api/dashboard/oracle-ticks")),
    status: 503,
    body: UNAVAILABLE,
  },
  { route: "GET /api/dashboard/alerts", call: async () => (await import("../dashboard/alerts/route")).GET(), status: 503, body: UNAVAILABLE },
  { route: "GET /api/cron/record", call: async () => (await import("../cron/record/route")).GET(cron("record")), status: 500, body: FAILED },
  { route: "GET /api/cron/index", call: async () => (await import("../cron/index/route")).GET(cron("index")), status: 500, body: FAILED },
  { route: "GET /api/cron/oracle", call: async () => (await import("../cron/oracle/route")).GET(cron("oracle")), status: 500, body: FAILED },
  { route: "GET /api/cron/alerts", call: async () => (await import("../cron/alerts/route")).GET(cron("alerts")), status: 500, body: FAILED },
  {
    route: "GET /api/health",
    call: async () => (await import("../health/route")).GET(),
    status: 503,
    body: { network: null, ledger: NONE, indexer: NONE, keeper: NONE, openAlerts: NONE },
  },
]

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET)
  vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example/alert")
  vi.stubEnv("DATABASE_URL", "postgres://example")
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  mocks.sql.mockClear()
  mocks.rpc.mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("every API route when the manifest cannot be read", () => {
  it("covers the 12 routes and /api/health", () => {
    expect(CASES).toHaveLength(13)
  })

  it.each(CASES)("$route answers $status with its own error body, never cached, reading nothing", async ({ call, status, body }) => {
    const response = await call()
    expect(response.status).toBe(status)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual(body)
    expect(mocks.sql).not.toHaveBeenCalled()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
