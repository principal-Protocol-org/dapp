// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  tickOracle: vi.fn(),
  keeperSigner: vi.fn(),
  recordTick: vi.fn(),
  verify: vi.fn(),
  OracleKeeperConfigError: class OracleKeeperConfigError extends Error {},
}))
vi.mock("@/lib/server/oracle-keeper", () => ({
  tickOracle: mocks.tickOracle,
  keeperSigner: mocks.keeperSigner,
  OracleKeeperConfigError: mocks.OracleKeeperConfigError,
}))
// The telemetry write is mocked: these tests need no database. `sql` is passed through as is.
vi.mock("@/lib/server/oracle-ticks", () => ({ recordTick: mocks.recordTick }))
vi.mock("@/lib/server/db", () => ({ sql: "the-sql" }))
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
const SIGNER = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const UPDATED = { status: "updated", mode: "push", signer: SIGNER, value: "10000027", timestamp: 2_800, hash: "ab".repeat(32) }

describe("GET and POST /api/cron/oracle", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    process.env.QSTASH_CURRENT_SIGNING_KEY = "current"
    process.env.QSTASH_NEXT_SIGNING_KEY = "next"
    process.env.VERCEL = "1"
    process.env.ORACLE_ADMIN_SECRET = "S-not-read-by-these-tests"
    mocks.tickOracle.mockReset()
    mocks.tickOracle.mockResolvedValue(UPDATED)
    mocks.keeperSigner.mockReset().mockReturnValue(SIGNER)
    mocks.recordTick.mockReset().mockResolvedValue(undefined)
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
    // No run, no tick record.
    expect(mocks.recordTick).not.toHaveBeenCalled()
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

  it("500 rejected for a rejected tick, with the reason: a rejection is a successful transaction (R4-8)", async () => {
    mocks.tickOracle.mockResolvedValue({ status: "rejected", mode: "push", signer: SIGNER, value: "1", timestamp: 2_800, hash: "ab".repeat(32), reason: "deviate" })
    const res = await call({ authorization: `Bearer ${SECRET}` })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ status: "rejected", reason: "deviate" })
  })

  it("logs a rejected tick as an error, with its reason, value, timestamp and hash, never the key (final review 5)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.tickOracle.mockResolvedValue({ status: "rejected", mode: "push", signer: SIGNER, value: "10000027", timestamp: 2_800, hash: "cd".repeat(32), reason: "deviation" })
      await call({ authorization: `Bearer ${SECRET}` })
      expect(error).toHaveBeenCalledTimes(1)
      const line = error.mock.calls[0].map(String).join(" ")
      expect(line).toBe(`oracle keeper: the oracle rejected value 10000027 at timestamp 2800 (reason deviation, tx ${"cd".repeat(32)})`)
      expect(line).not.toContain("S-not-read-by-these-tests")
      // An update or an unchanged tick logs nothing.
      error.mockClear()
      mocks.tickOracle.mockResolvedValue(UPDATED)
      await call({ authorization: `Bearer ${SECRET}` })
      expect(error).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
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

describe("cron/oracle telemetry (D-19): one oracle_ticks row per run", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    process.env.ORACLE_ADMIN_SECRET = "S-not-read-by-these-tests"
    mocks.tickOracle.mockReset().mockResolvedValue(UPDATED)
    mocks.keeperSigner.mockReset().mockReturnValue(SIGNER)
    mocks.recordTick.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.ORACLE_ADMIN_SECRET
  })
  const run = () => call({ authorization: `Bearer ${SECRET}` })
  const recorded = () => {
    expect(mocks.recordTick).toHaveBeenCalledTimes(1)
    const [sqlArg, network, oracle, tick] = mocks.recordTick.mock.calls[0]
    expect(sqlArg).toBe("the-sql")
    // The manifest's network and oracle (local.example.json here).
    expect(network).toBe("local")
    expect(oracle).toMatch(/^C[A-Z2-7]{55}$/)
    return tick
  }

  it("records an update, a skipped run and a rejection as the tick itself", async () => {
    await run()
    expect(recorded()).toEqual(UPDATED)
    mocks.recordTick.mockClear()
    const unchanged = { status: "unchanged", mode: "push", signer: SIGNER, value: "10000027", timestamp: 2_800 }
    mocks.tickOracle.mockResolvedValue(unchanged)
    await run()
    expect(recorded()).toEqual(unchanged)
    mocks.recordTick.mockClear()
    const rejected = { status: "rejected", mode: "push", signer: SIGNER, value: "1", timestamp: 2_800, hash: "ab".repeat(32), reason: "deviate" }
    mocks.tickOracle.mockResolvedValue(rejected)
    vi.spyOn(console, "error").mockImplementation(() => {})
    await run()
    expect(recorded()).toEqual(rejected)
    vi.mocked(console.error).mockRestore()
  })

  it("records a run that could not start (not_configured) with the config error's words and the key's public key", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.tickOracle.mockRejectedValue(new mocks.OracleKeeperConfigError("ORACLE_ADMIN_SECRET is not the key of the oracle admin."))
      const res = await run()
      expect(res.status).toBe(503)
      expect(recorded()).toEqual({ status: "not_configured", mode: "push", signer: SIGNER, message: "ORACLE_ADMIN_SECRET is not the key of the oracle admin." })
      expect(mocks.keeperSigner).toHaveBeenCalledWith("S-not-read-by-these-tests")
    } finally {
      error.mockRestore()
    }
  })

  it("records a failed run by the error's name only, never its text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      mocks.tickOracle.mockRejectedValue(new TypeError("rpc https://provider.example/key=abc said no"))
      const res = await run()
      expect(res.status).toBe(500)
      expect(recorded()).toEqual({ status: "failed", mode: "push", signer: SIGNER, name: "TypeError" })
      expect(JSON.stringify(mocks.recordTick.mock.calls)).not.toContain("provider.example")
    } finally {
      error.mockRestore()
    }
  })

  it("never hands the key to the record, whatever the outcome", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await run()
      mocks.tickOracle.mockRejectedValueOnce(new mocks.OracleKeeperConfigError("ORACLE_ADMIN_SECRET is not set."))
      await run()
      mocks.tickOracle.mockRejectedValueOnce(new Error("boom"))
      await run()
      expect(mocks.recordTick).toHaveBeenCalledTimes(3)
      expect(JSON.stringify(mocks.recordTick.mock.calls)).not.toContain("S-not-read-by-these-tests")
    } finally {
      error.mockRestore()
    }
  })

  it("a tick that cannot be recorded never changes the answer: logged by error name, the scheduler sees the tick", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      class DatabaseConfigError extends Error {
        name = "DatabaseConfigError"
      }
      mocks.recordTick.mockRejectedValue(new DatabaseConfigError("postgres://user:pw@db.example/x is down"))
      const res = await run()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(UPDATED)
      expect(error).toHaveBeenCalledTimes(1)
      const line = error.mock.calls[0].map(String).join(" ")
      expect(line).toBe("oracle keeper: the tick was not recorded: DatabaseConfigError")
      expect(line).not.toContain("db.example")

      // The same for a not-configured and a failed run: 503 and 500 stand.
      mocks.tickOracle.mockRejectedValueOnce(new mocks.OracleKeeperConfigError("ORACLE_ADMIN_SECRET is not set."))
      expect((await run()).status).toBe(503)
      mocks.tickOracle.mockRejectedValueOnce(new Error("boom"))
      expect((await run()).status).toBe(500)
      // A write that never settles in time is the database's own timeout (5 s): it also lands in this catch.
    } finally {
      error.mockRestore()
    }
  })
})
