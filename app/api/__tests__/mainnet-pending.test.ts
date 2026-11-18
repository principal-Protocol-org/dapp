// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

// Nothing may be read while the Mainnet manifest is the pending stub: no database, no network.
const mocks = vi.hoisted(() => ({
  sql: vi.fn(() => {
    throw new Error("the database was read while Mainnet is pending")
  }),
  rpc: vi.fn(() => {
    throw new Error("the network was read while Mainnet is pending")
  }),
}))
vi.mock("@/lib/server/db", () => ({ sql: mocks.sql, DatabaseConfigError: class DatabaseConfigError extends Error {} }))
vi.mock("@/lib/protocol/stellar", async (importOriginal) => ({ ...(await importOriginal<object>()), createRpcServer: mocks.rpc }))
vi.mock("next/server", () => ({ connection: async () => {} }))

const SECRET = "test-cron-secret-0123456789"
const auth = { authorization: `Bearer ${SECRET}` }
const MESSAGE = "Mainnet contracts are not deployed yet."
const POOL = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin }, body: JSON.stringify(body) })

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "mainnet")
  vi.stubEnv("CRON_SECRET", SECRET)
  vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.example/alert")
  vi.stubEnv("DATABASE_URL", "postgres://example")
  mocks.sql.mockClear()
  mocks.rpc.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

async function expectPending(response: Response) {
  expect(response.status).toBe(503)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toMatchObject({ error: "not_configured", message: MESSAGE })
  expect(mocks.sql).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
}

describe("every API route while the Mainnet manifest is the pending stub (D-24)", () => {
  it("public reads answer 503 not_configured with the message, never cached", async () => {
    const markets = await import("../markets/route")
    await expectPending(await markets.GET())
    const sparks = await import("../markets/sparks/route")
    await expectPending(await sparks.GET(new Request(`https://app.example/api/markets/sparks?pools=${POOL}`)))
    const history = await import("../markets/[pool]/history/route")
    await expectPending(await history.GET(new Request(`https://app.example/api/markets/${POOL}/history`), { params: Promise.resolve({ pool: POOL }) }))
    const events = await import("../dashboard/events/route")
    await expectPending(await events.GET(new Request("https://app.example/api/dashboard/events")))
    const ticks = await import("../dashboard/oracle-ticks/route")
    await expectPending(await ticks.GET(new Request("https://app.example/api/dashboard/oracle-ticks")))
    const alerts = await import("../dashboard/alerts/route")
    await expectPending(await alerts.GET())
    const health = await import("../health/route")
    await expectPending(await health.GET())
  })

  it("the POST routes answer the same, and nothing is published or granted", async () => {
    const markets = await import("../markets/route")
    await expectPending(await markets.POST(post("https://app.example/api/markets", { pool: POOL })))
    const faucet = await import("../faucet/route")
    await expectPending(await faucet.POST(post("https://app.example/api/faucet", { account: ACCOUNT })))
  })

  it("the cron routes still refuse other callers first, then answer the same", async () => {
    for (const path of ["record", "index", "oracle", "alerts"]) {
      const route = await import(`../cron/${path}/route`)
      const url = `https://app.example/api/cron/${path}`
      expect((await route.GET(new Request(url))).status).toBe(401)
      await expectPending(await route.GET(new Request(url, { headers: auth })))
    }
  })
})
