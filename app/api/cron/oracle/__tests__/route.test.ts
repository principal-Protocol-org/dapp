// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  /** A manifest that replaces local.example.json for one test (null: local.example.json). */
  manifest: null as unknown,
  tickOracle: vi.fn(),
  tickFeed: vi.fn(),
  lastSubmittedRejection: vi.fn(),
  keeperSigner: vi.fn(),
  recordTick: vi.fn(),
  verify: vi.fn(),
  OracleKeeperConfigError: class OracleKeeperConfigError extends Error {},
  OracleSubmitError: class OracleSubmitError extends Error {
    constructor(
      readonly hash: string,
      readonly code: string,
    ) {
      super(`the oracle update failed on-chain (${hash}, ${code})`)
      this.name = "OracleSubmitError"
    }
  },
}))
vi.mock("@/lib/server/oracle-keeper", () => ({
  tickOracle: mocks.tickOracle,
  tickFeed: mocks.tickFeed,
  keeperSigner: mocks.keeperSigner,
  OracleKeeperConfigError: mocks.OracleKeeperConfigError,
  OracleSubmitError: mocks.OracleSubmitError,
}))
// The telemetry write is mocked: these tests need no database. `sql` is passed through as is.
vi.mock("@/lib/server/oracle-ticks", () => ({ recordTick: mocks.recordTick, lastSubmittedRejection: mocks.lastSubmittedRejection }))
vi.mock("@/lib/server/db", () => ({ sql: "the-sql" }))
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = mocks.verify
  },
}))
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const m = parseManifest((await import("@/config/manifests/local.example.json")).default)
  return { activeManifest: () => mocks.manifest ?? m }
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

  it("a submitted transaction that did not land is recorded with its hash and its result code (500 failed)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const hash = "ef".repeat(32)
      mocks.tickOracle.mockRejectedValue(new mocks.OracleSubmitError(hash, "invokeHostFunctionTrapped"))
      const res = await run()
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: "failed" })
      expect(recorded()).toEqual({ status: "failed", mode: "push", signer: SIGNER, name: "invokeHostFunctionTrapped", hash })
      expect(error.mock.calls.map((c) => c.map(String).join(" "))).toEqual([`oracle keeper: the oracle update did not land: invokeHostFunctionTrapped (tx ${hash})`])
      mocks.recordTick.mockClear()
      mocks.tickOracle.mockRejectedValue(new mocks.OracleSubmitError(hash, "not confirmed"))
      await run()
      expect(recorded()).toMatchObject({ name: "not confirmed", hash })
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

describe("cron/oracle feed mode (D-21): ORACLE_KEEPER_MODE=feed", () => {
  const KEEPER = "S-keeper-not-read-by-these-tests"
  const OTHER = "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U"
  const SYNCED = { status: "synced", mode: "feed", signer: SIGNER, value: "10000000", timestamp: 2_800, hash: "ab".repeat(32) }
  const VARS = ["CRON_SECRET", "ORACLE_ADMIN_SECRET", "ORACLE_KEEPER_MODE", "ORACLE_KEEPER_SECRET", "ORACLE_KEEPER_ORACLE_ID"]
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    process.env.ORACLE_ADMIN_SECRET = "S-not-read-by-these-tests"
    process.env.ORACLE_KEEPER_MODE = "feed"
    process.env.ORACLE_KEEPER_SECRET = KEEPER
    mocks.tickOracle.mockReset()
    mocks.tickFeed.mockReset().mockResolvedValue(SYNCED)
    mocks.keeperSigner.mockReset().mockReturnValue(SIGNER)
    mocks.recordTick.mockReset().mockResolvedValue(undefined)
    mocks.lastSubmittedRejection.mockReset().mockResolvedValue(null)
  })
  afterEach(() => {
    for (const k of VARS) delete process.env[k]
    mocks.manifest = null
    vi.restoreAllMocks()
  })
  const run = () => call({ authorization: `Bearer ${SECRET}` })
  const recordedAt = () => {
    expect(mocks.recordTick).toHaveBeenCalledTimes(1)
    const [, network, oracle, tick] = mocks.recordTick.mock.calls[0]
    return { network, oracle, tick }
  }

  it("signs with ORACLE_KEEPER_SECRET (never the admin key) on the manifest's oracle, and answers 200 synced", async () => {
    const res = await run()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SYNCED)
    expect(mocks.tickOracle).not.toHaveBeenCalled()
    expect(mocks.tickFeed).toHaveBeenCalledTimes(1)
    const [deps] = mocks.tickFeed.mock.calls[0]
    expect(deps.secret).toBe(KEEPER)
    expect(deps.oracle).toMatch(/^C[A-Z2-7]{55}$/)
    expect(deps.lastSubmittedRejection).toBeNull()
    const { oracle, tick } = recordedAt()
    expect(oracle).toBe(deps.oracle)
    expect(tick).toEqual(SYNCED)
  })

  it("hands the keeper its memory: the last submitted rejection read from oracle_ticks for that oracle", async () => {
    mocks.lastSubmittedRejection.mockResolvedValue({ reason: "deviate", value: "11500000" })
    await run()
    const [sqlArg, network, oracle] = mocks.lastSubmittedRejection.mock.calls[0]
    expect(sqlArg).toBe("the-sql")
    expect(network).toBe("local")
    expect(oracle).toBe(mocks.tickFeed.mock.calls[0][0].oracle)
    expect(mocks.tickFeed.mock.calls[0][0].lastSubmittedRejection).toEqual({ reason: "deviate", value: "11500000" })
  })

  it("no memory when the database cannot be read: null (every significant rejection is submitted), logged by name, the run goes on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    class DatabaseConfigError extends Error {
      name = "DatabaseConfigError"
    }
    mocks.lastSubmittedRejection.mockRejectedValue(new DatabaseConfigError("postgres://user:pw@db.example/x is down"))
    const res = await run()
    expect(res.status).toBe(200)
    expect(mocks.tickFeed.mock.calls[0][0].lastSubmittedRejection).toBeNull()
    const lines = error.mock.calls.map((c) => c.map(String).join(" "))
    expect(lines).toEqual(["oracle keeper: the last submitted rejection was not read: DatabaseConfigError"])
  })

  it("ORACLE_KEEPER_ORACLE_ID points the keeper, its memory and its record at another oracle (local), with one warning per run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.ORACLE_KEEPER_ORACLE_ID = ` ${OTHER} `
    expect((await run()).status).toBe(200)
    expect(mocks.tickFeed.mock.calls[0][0].oracle).toBe(OTHER)
    expect(mocks.lastSubmittedRejection.mock.calls[0][2]).toBe(OTHER)
    expect(recordedAt().oracle).toBe(OTHER)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(new RegExp(`^oracle keeper: ORACLE_KEEPER_ORACLE_ID overrides the manifest's oracle \\(C[A-Z2-7]{55}\\): this run syncs ${OTHER}`))
  })

  it("off the local network, an override oracle is refused: 503 not_configured, nothing runs, recorded under the manifest's oracle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { parseManifest } = await import("@/lib/protocol/manifest")
    const local = parseManifest((await import("@/config/manifests/local.example.json")).default)
    for (const network of ["testnet", "mainnet"]) {
      mocks.manifest = { ...local, network }
      mocks.recordTick.mockClear()
      mocks.tickFeed.mockClear()
      warn.mockClear()
      process.env.ORACLE_KEEPER_ORACLE_ID = OTHER
      const res = await run()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "not_configured" })
      expect(mocks.tickFeed).not.toHaveBeenCalled()
      const { network: n, oracle, tick } = recordedAt()
      expect(n).toBe(network)
      expect(oracle).toBe(local.shared.oracle)
      expect(tick).toEqual({
        status: "not_configured",
        mode: "feed",
        signer: SIGNER,
        message: "ORACLE_KEEPER_ORACLE_ID names another oracle than the manifest's: the override oracle is for local proofs only.",
      })
      expect(warn).toHaveBeenCalledTimes(1)
      // The manifest's own oracle named explicitly is no override: it runs, with no warning.
      warn.mockClear()
      mocks.tickFeed.mockClear()
      process.env.ORACLE_KEEPER_ORACLE_ID = local.shared.oracle
      expect((await run()).status).toBe(200)
      expect(mocks.tickFeed.mock.calls[0][0].oracle).toBe(local.shared.oracle)
      expect(warn).not.toHaveBeenCalled()
    }
  })

  it("an ORACLE_KEEPER_ORACLE_ID that is not a contract id: 503 not_configured, nothing runs, recorded under feed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    process.env.ORACLE_KEEPER_ORACLE_ID = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
    const res = await run()
    expect(res.status).toBe(503)
    expect(mocks.tickFeed).not.toHaveBeenCalled()
    expect(recordedAt().tick).toEqual({ status: "not_configured", mode: "feed", signer: SIGNER, message: "ORACLE_KEEPER_ORACLE_ID is not a contract id." })
  })

  it("a skipped run (a routine rejection) answers 200 and logs nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const skipped = { status: "skipped", mode: "feed", signer: SIGNER, value: "10000000", timestamp: 2_800, reason: "stale_ts" }
    mocks.tickFeed.mockResolvedValue(skipped)
    const res = await run()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(skipped)
    expect(recordedAt().tick).toEqual(skipped)
    expect(error).not.toHaveBeenCalled()
  })

  it("every feed-mode rejection answers 200 (a 5xx would make QStash retry and record it again), logged as a warning", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const rejected = (over: Record<string, unknown>) => ({ status: "rejected", mode: "feed", signer: SIGNER, value: "11500000", timestamp: 2_800, reason: "deviate", ...over })
    const cases = [
      // A new significant rejection, submitted: its hash.
      [rejected({ hash: "cd".repeat(32) }), `oracle keeper: the oracle rejected value 11500000 at timestamp 2800 (reason deviate, tx ${"cd".repeat(32)})`],
      // A repeat of the last submitted one.
      [rejected({}), "oracle keeper: the oracle rejected value 11500000 at timestamp 2800 (reason deviate, not submitted)"],
      // A broken feed.
      [rejected({ value: "0", reason: "bad_price" }), "oracle keeper: the oracle rejected value 0 at timestamp 2800 (reason bad_price, not submitted)"],
      // No ref_rej event.
      [rejected({ value: null, timestamp: null, reason: "unknown" }), "oracle keeper: the oracle rejected value unknown at timestamp unknown (reason unknown, not submitted)"],
    ] as const
    for (const [tick, line] of cases) {
      mocks.tickFeed.mockResolvedValue(tick)
      mocks.recordTick.mockClear()
      warn.mockClear()
      const res = await run()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(tick)
      expect(warn.mock.calls.map((c) => c.map(String).join(" "))).toEqual([line])
      expect(recordedAt().tick).toEqual(tick)
    }
    expect(error).not.toHaveBeenCalled()
  })

  it("push mode keeps 500 for a rejection (unchanged)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    process.env.ORACLE_KEEPER_MODE = "push"
    mocks.tickOracle.mockResolvedValue({ status: "rejected", mode: "push", signer: SIGNER, value: "1", timestamp: 2_800, hash: "ab".repeat(32), reason: "deviate" })
    expect((await run()).status).toBe(500)
  })

  it("not_configured (no key, no feed_source, error 15): 503, recorded under feed with ORACLE_KEEPER_SECRET's public key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.tickFeed.mockRejectedValue(new mocks.OracleKeeperConfigError("the oracle has no feed source (set_feed_source was never called)."))
    const res = await run()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "not_configured" })
    expect(mocks.keeperSigner).toHaveBeenCalledWith(KEEPER)
    expect(recordedAt().tick).toEqual({ status: "not_configured", mode: "feed", signer: SIGNER, message: "the oracle has no feed source (set_feed_source was never called)." })
  })

  it("a failed run is recorded under feed, by error name", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.tickFeed.mockRejectedValue(new TypeError("rpc https://provider.example/key=abc said no"))
    expect((await run()).status).toBe(500)
    expect(recordedAt().tick).toEqual({ status: "failed", mode: "feed", signer: SIGNER, name: "TypeError" })
  })

  it("push stays the default: an unset or blank mode runs tickOracle with ORACLE_ADMIN_SECRET", async () => {
    mocks.tickOracle.mockResolvedValue(UPDATED)
    for (const mode of [undefined, "  ", "push"]) {
      if (mode === undefined) delete process.env.ORACLE_KEEPER_MODE
      else process.env.ORACLE_KEEPER_MODE = mode
      mocks.tickOracle.mockClear()
      expect((await run()).status).toBe(200)
      expect(mocks.tickOracle).toHaveBeenCalledWith(expect.objectContaining({ secret: "S-not-read-by-these-tests" }))
    }
    expect(mocks.tickFeed).not.toHaveBeenCalled()
    expect(mocks.lastSubmittedRejection).not.toHaveBeenCalled()
  })

  it("a mode that is neither push nor feed: 503 not_configured, nothing runs, recorded under the default (push)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    process.env.ORACLE_KEEPER_MODE = "pull"
    const res = await run()
    expect(res.status).toBe(503)
    expect(mocks.tickOracle).not.toHaveBeenCalled()
    expect(mocks.tickFeed).not.toHaveBeenCalled()
    expect(recordedAt().tick).toEqual({ status: "not_configured", mode: "push", signer: null, message: "ORACLE_KEEPER_MODE is neither push nor feed." })
  })
})
