// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  recordAll: vi.fn(),
  verify: vi.fn(),
  DatabaseConfigError: class DatabaseConfigError extends Error {},
  discover: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  revalidate: vi.fn(),
  resolvedCalls: [] as unknown[],
}))
vi.mock("@/lib/server/recorder", () => ({ recordAll: mocks.recordAll }))
vi.mock("@/lib/server/db", () => ({ sql: vi.fn(), DatabaseConfigError: mocks.DatabaseConfigError }))
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = mocks.verify
  },
}))
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const json = (await import("@/config/manifests/testnet.json")).default
  const m = parseManifest(json)
  return { activeManifest: () => m }
})
vi.mock("@/lib/protocol/reader", () => ({ createRpcReader: () => vi.fn() }))
// The registry is real (its SQL answers nothing) unless a test replaces discovery; re-validation and
// the markets read are watched.
vi.mock("@/lib/server/registry", async (orig) => {
  const real = await orig<typeof import("@/lib/server/registry")>()
  return {
    ...real,
    discover: (...args: Parameters<typeof real.discover>) => (mocks.discover ? mocks.discover(...args) : real.discover(...args)),
    revalidate: (...args: Parameters<typeof real.revalidate>) => {
      mocks.revalidate(...args)
      return Promise.resolve({ checked: [], complete: true })
    },
    resolvedMarkets: (deps: Parameters<typeof real.resolvedMarkets>[0]) => {
      mocks.resolvedCalls.push(deps)
      return real.resolvedMarkets(deps)
    },
  }
})
vi.mock("@/lib/protocol/stellar", () => ({ createRpcServer: () => ({}) }))

import { GET, POST } from "../route"

const SECRET = "test-cron-secret-0123456789"
const call = (headers: Record<string, string> = {}) =>
  GET(new Request("http://localhost/api/cron/record", { headers }))
const post = (headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/cron/record", { method: "POST", headers, body: "" }))

describe("GET /api/cron/record", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    process.env.QSTASH_CURRENT_SIGNING_KEY = "current"
    process.env.QSTASH_NEXT_SIGNING_KEY = "next"
    process.env.QSTASH_RECORD_URL = "https://app.example/api/cron/record"
    mocks.recordAll.mockResolvedValue({ recorded: 1, failed: [] })
    mocks.verify.mockReset()
    mocks.recordAll.mockClear()
    mocks.revalidate.mockClear()
    mocks.discover = undefined
    mocks.resolvedCalls = []
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.QSTASH_CURRENT_SIGNING_KEY
    delete process.env.QSTASH_NEXT_SIGNING_KEY
    delete process.env.QSTASH_RECORD_URL
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL
  })

  it("401 without credentials", async () => {
    const res = await call()
    expect(res.status).toBe(401)
    expect(mocks.recordAll).not.toHaveBeenCalled()
  })

  it("401 with the wrong bearer secret, and with a bearer of another length", async () => {
    expect((await call({ authorization: `Bearer ${SECRET}x` })).status).toBe(401)
    expect((await call({ authorization: "Bearer x" })).status).toBe(401)
    expect((await call({ authorization: SECRET })).status).toBe(401)
  })

  it("200 with Bearer CRON_SECRET and returns { recorded, failed }", async () => {
    const res = await call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recorded: 1, failed: [] })
  })

  it("each run refreshes the registry and records its resolved markets (R2-4)", async () => {
    await call({ authorization: `Bearer ${SECRET}` })
    const deps = mocks.recordAll.mock.calls[0][0]
    expect(typeof deps.refreshRegistry).toBe("function")
    // With the database unreadable (the sql mock answers nothing), the seeds are recorded.
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await deps.markets()).toEqual(deps.manifest.markets)
  })

  it("never authorizes an empty bearer when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET
    expect((await call({ authorization: "Bearer " })).status).toBe(401)
    expect((await call({ authorization: "Bearer undefined" })).status).toBe(401)
  })

  it("200 with a valid QStash signature", async () => {
    mocks.verify.mockResolvedValue(true)
    const res = await call({ "upstash-signature": "sig" })
    expect(res.status).toBe(200)
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ signature: "sig" }))
  })

  it("401 with a bad signature (verify false or throwing)", async () => {
    mocks.verify.mockResolvedValue(false)
    expect((await call({ "upstash-signature": "bad" })).status).toBe(401)
    mocks.verify.mockRejectedValue(new Error("bad signature"))
    expect((await call({ "upstash-signature": "bad" })).status).toBe(401)
    expect(mocks.recordAll).not.toHaveBeenCalled()
  })

  it("401 for a signature when the QStash keys are not configured", async () => {
    delete process.env.QSTASH_CURRENT_SIGNING_KEY
    expect((await call({ "upstash-signature": "sig" })).status).toBe(401)
  })

  it("verifies the signature against the configured URL", async () => {
    mocks.verify.mockResolvedValue(true)
    await call({ "upstash-signature": "sig" })
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ url: "https://app.example/api/cron/record" }))
  })

  it("falls back to the Vercel production domain", async () => {
    delete process.env.QSTASH_RECORD_URL
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "principal.example"
    mocks.verify.mockResolvedValue(true)
    expect((await call({ "upstash-signature": "sig" })).status).toBe(200)
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ url: "https://principal.example/api/cron/record" }))
  })

  it("401 when the signature was issued for a different url", async () => {
    mocks.verify.mockImplementation(async ({ url }: { url: string }) => url === "https://other.example/api/x")
    expect((await call({ "upstash-signature": "sig" })).status).toBe(401)
  })

  it("401 on the QStash path when no url is configured (fails closed)", async () => {
    delete process.env.QSTASH_RECORD_URL
    mocks.verify.mockResolvedValue(true)
    expect((await call({ "upstash-signature": "sig" })).status).toBe(401)
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it("503 not_configured when the database is not configured", async () => {
    mocks.recordAll.mockRejectedValue(new mocks.DatabaseConfigError())
    const res = await call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "not_configured" })
  })

  it("POST runs too, behind the same checks: QStash schedules call with POST by default (M13)", async () => {
    expect((await post()).status).toBe(401)
    expect((await post({ authorization: `Bearer ${SECRET}x` })).status).toBe(401)
    mocks.verify.mockResolvedValue(false)
    expect((await post({ "upstash-signature": "bad" })).status).toBe(401)
    expect(mocks.recordAll).not.toHaveBeenCalled()
    expect((await post({ authorization: `Bearer ${SECRET}` })).status).toBe(200)
    mocks.verify.mockResolvedValue(true)
    const res = await post({ "upstash-signature": "sig" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recorded: 1, failed: [] })
    expect(mocks.recordAll).toHaveBeenCalledTimes(2)
  })

  it("a failed discovery still re-validates the listed markets, and logs only the error's name (M8)", async () => {
    const boom = new Error("getEvents: https://rpc.secret.example/?key=abc failed")
    boom.name = "RpcError"
    mocks.discover = vi.fn().mockRejectedValue(boom)
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    await call({ authorization: `Bearer ${SECRET}` })
    const deps = mocks.recordAll.mock.calls[0][0]
    await expect(deps.refreshRegistry(Date.now() + 1_000)).resolves.toBeUndefined()
    expect(mocks.revalidate).toHaveBeenCalledTimes(1)
    expect(mocks.revalidate.mock.calls[0][1]).toMatchObject({ skip: new Set() })
    expect(logged).toHaveBeenCalledWith("registry: discovery failed:", "RpcError")
    expect(JSON.stringify(logged.mock.calls)).not.toContain("secret.example")
  })

  it("a missing database stops the refresh as before: it is not a discovery failure", async () => {
    mocks.discover = vi.fn().mockRejectedValue(new mocks.DatabaseConfigError())
    await call({ authorization: `Bearer ${SECRET}` })
    const deps = mocks.recordAll.mock.calls[0][0]
    await expect(deps.refreshRegistry(Date.now() + 1_000)).rejects.toBeInstanceOf(mocks.DatabaseConfigError)
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })

  it("the recorder reads the registry with its own 10 s budget, not the page's 1.5 s race (M9)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await call({ authorization: `Bearer ${SECRET}` })
    await mocks.recordAll.mock.calls[0][0].markets()
    expect(mocks.resolvedCalls.at(-1)).toMatchObject({ timeoutMs: 10_000 })
  })

  it("500 with the same body when any market failed", async () => {
    const body = { recorded: 0, failed: [{ pool: "C1", error: "boom" }] }
    mocks.recordAll.mockResolvedValue(body)
    const res = await call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual(body)
  })
})
