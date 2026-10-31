// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  recordAll: vi.fn(),
  verify: vi.fn(),
  DatabaseConfigError: class DatabaseConfigError extends Error {},
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
vi.mock("@/lib/protocol/stellar", () => ({ createRpcServer: () => ({}) }))

import { GET } from "../route"

const SECRET = "test-cron-secret-0123456789"
const call = (headers: Record<string, string> = {}) =>
  GET(new Request("http://localhost/api/cron/record", { headers }))

describe("GET /api/cron/record", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    process.env.QSTASH_CURRENT_SIGNING_KEY = "current"
    process.env.QSTASH_NEXT_SIGNING_KEY = "next"
    process.env.QSTASH_RECORD_URL = "https://app.example/api/cron/record"
    mocks.recordAll.mockResolvedValue({ recorded: 1, failed: [] })
    mocks.verify.mockReset()
    mocks.recordAll.mockClear()
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

  it("500 with the same body when any market failed", async () => {
    const body = { recorded: 0, failed: [{ pool: "C1", error: "boom" }] }
    mocks.recordAll.mockResolvedValue(body)
    const res = await call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual(body)
  })
})
