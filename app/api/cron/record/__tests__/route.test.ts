// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({ recordAll: vi.fn(), verify: vi.fn() }))
vi.mock("@/lib/server/recorder", () => ({ recordAll: mocks.recordAll }))
vi.mock("@/lib/server/db", () => ({ sql: vi.fn(), DatabaseConfigError: class extends Error {} }))
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
    mocks.recordAll.mockResolvedValue({ recorded: 1, failed: [] })
    mocks.verify.mockReset()
    mocks.recordAll.mockClear()
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.QSTASH_CURRENT_SIGNING_KEY
    delete process.env.QSTASH_NEXT_SIGNING_KEY
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
})
