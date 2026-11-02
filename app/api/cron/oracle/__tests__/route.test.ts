// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  tickOracle: vi.fn(),
  verify: vi.fn(),
  OracleKeeperConfigError: class OracleKeeperConfigError extends Error {},
}))
vi.mock("@/lib/server/oracle-keeper", () => ({ tickOracle: mocks.tickOracle, OracleKeeperConfigError: mocks.OracleKeeperConfigError }))
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = mocks.verify
  },
}))
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const m = parseManifest((await import("@/config/manifests/local.example.json")).default)
  return { activeManifest: () => m }
})

import { GET, POST } from "../route"

const SECRET = "test-cron-secret-0123456789"
const URL_ = "https://app.example/api/cron/oracle"
const call = (headers: Record<string, string> = {}) => GET(new Request(URL_, { headers }))
const post = (headers: Record<string, string> = {}) => POST(new Request(URL_, { method: "POST", headers, body: "" }))
const UPDATED = { status: "updated", value: "10000027", timestamp: 2_800, hash: "ab".repeat(32) }

describe("GET and POST /api/cron/oracle", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    process.env.QSTASH_CURRENT_SIGNING_KEY = "current"
    process.env.QSTASH_NEXT_SIGNING_KEY = "next"
    process.env.VERCEL = "1"
    process.env.ORACLE_ADMIN_SECRET = "S-not-read-by-these-tests"
    mocks.tickOracle.mockReset()
    mocks.tickOracle.mockResolvedValue(UPDATED)
    mocks.verify.mockReset()
  })
  afterEach(() => {
    for (const k of ["CRON_SECRET", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "VERCEL", "ORACLE_ADMIN_SECRET"]) delete process.env[k]
  })

  it("401 and no tick without credentials, with a wrong bearer or a bad signature", async () => {
    expect((await call()).status).toBe(401)
    expect((await call({ authorization: `Bearer ${SECRET}x` })).status).toBe(401)
    mocks.verify.mockResolvedValue(false)
    expect((await call({ "upstash-signature": "bad" })).status).toBe(401)
    expect(mocks.tickOracle).not.toHaveBeenCalled()
  })

  it("200 with the tick for a scheduler, by bearer (GET) or QStash signature (POST)", async () => {
    const res = await call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(UPDATED)
    expect(res.headers.get("cache-control")).toBe("no-store")
    mocks.verify.mockResolvedValue(true)
    expect((await post({ "upstash-signature": "sig" })).status).toBe(200)
    expect(mocks.verify).toHaveBeenCalledWith(expect.objectContaining({ url: URL_ }))
    expect(mocks.tickOracle).toHaveBeenCalledTimes(2)
    expect(mocks.tickOracle).toHaveBeenCalledWith(expect.objectContaining({ secret: "S-not-read-by-these-tests" }))
  })

  it("503 not_configured when the keeper cannot run (no key, wrong key, mainnet)", async () => {
    mocks.tickOracle.mockRejectedValue(new mocks.OracleKeeperConfigError("ORACLE_ADMIN_SECRET is not set."))
    const res = await call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "not_configured" })
  })

  it("500 failed on any other error, without its text", async () => {
    mocks.tickOracle.mockRejectedValue(new Error("rpc https://provider.example/key=abc said no"))
    const res = await call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "failed" })
  })
})
