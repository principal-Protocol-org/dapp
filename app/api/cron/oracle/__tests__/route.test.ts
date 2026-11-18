// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  /** A manifest that replaces local.example.json for one test (null: local.example.json). */
  manifest: null as unknown,
  tickOracle: vi.fn(),
  tickFeedAll: vi.fn(),
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
  tickFeedAll: mocks.tickFeedAll,
  keeperSigner: mocks.keeperSigner,
  OracleKeeperConfigError: mocks.OracleKeeperConfigError,
  OracleSubmitError: mocks.OracleSubmitError,
}))
// The telemetry write is mocked: these tests need no database. `sql` is passed through as is. The two
// environment readers are the real ones (their config error is the mocked keeper's class).
vi.mock("@/lib/server/oracle-ticks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/oracle-ticks")>()
  return {
    recordTick: mocks.recordTick,
    lastSubmittedRejection: mocks.lastSubmittedRejection,
    keeperIntervalSeconds: actual.keeperIntervalSeconds,
    recordsRejections: actual.recordsRejections,
  }
})
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

describe("cron/oracle feed mode (D-21, M-13): ORACLE_KEEPER_MODE=feed, every oracle of the manifest in one run", () => {
  const KEEPER = "S-keeper-not-read-by-these-tests"
  const OTHER = "CACQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQLC2U"
  const SECOND = "CADAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMSST"
  const SYNCED = { status: "synced", mode: "feed", signer: SIGNER, value: "10000000", timestamp: 2_800, hash: "ab".repeat(32) }
  const VARS = [
    "CRON_SECRET",
    "ORACLE_ADMIN_SECRET",
    "ORACLE_KEEPER_MODE",
    "ORACLE_KEEPER_SECRET",
    "ORACLE_KEEPER_ORACLE_ID",
    "ORACLE_KEEPER_INTERVAL_SECONDS",
    "ORACLE_KEEPER_RECORD_REJECTIONS",
  ]
  type Outcome = Record<string, unknown>
  type FeedDeps = {
    oracles: string[]
    secret: string
    recordRejections: boolean
    deadlineMs: number
    lastSubmittedRejection(oracle: string): Promise<unknown>
  }
  let local: { network: string; shared: { oracle: string }; markets: { contracts: { oracle: string } }[] }
  /** local.example.json with a second market on a second oracle, as the local stack and Mainnet have. */
  let twoOracles: typeof local
  /** What tickFeedAll answers, per oracle (synced by default). */
  let outcomes: Record<string, Outcome>
  beforeEach(async () => {
    process.env.CRON_SECRET = SECRET
    process.env.ORACLE_ADMIN_SECRET = "S-not-read-by-these-tests"
    process.env.ORACLE_KEEPER_MODE = "feed"
    process.env.ORACLE_KEEPER_SECRET = KEEPER
    mocks.tickOracle.mockReset()
    outcomes = {}
    mocks.tickFeedAll.mockReset().mockImplementation(async (deps: FeedDeps) => deps.oracles.map((oracle) => ({ oracle, outcome: outcomes[oracle] ?? SYNCED })))
    mocks.keeperSigner.mockReset().mockReturnValue(SIGNER)
    mocks.recordTick.mockReset().mockResolvedValue(undefined)
    mocks.lastSubmittedRejection.mockReset().mockResolvedValue(null)
    const { parseManifest } = await import("@/lib/protocol/manifest")
    local = parseManifest((await import("@/config/manifests/local.example.json")).default) as unknown as typeof local
    const [market] = local.markets
    twoOracles = { ...local, markets: [market, { ...market, marketId: "second", contracts: { ...market.contracts, oracle: SECOND } }] } as typeof local
  })
  afterEach(() => {
    for (const k of VARS) delete process.env[k]
    mocks.manifest = null
    vi.restoreAllMocks()
  })
  const run = () => call({ authorization: `Bearer ${SECRET}` })
  const deps = (): FeedDeps => {
    expect(mocks.tickFeedAll).toHaveBeenCalledTimes(1)
    return mocks.tickFeedAll.mock.calls[0][0] as FeedDeps
  }
  /** Every recordTick call as (network, oracle, tick). */
  const rows = () => mocks.recordTick.mock.calls.map(([sqlArg, network, oracle, tick]) => {
    expect(sqlArg).toBe("the-sql")
    return { network, oracle, tick }
  })
  const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c.map(String).join(" "))

  it("runs every oracle of the manifest with ORACLE_KEEPER_SECRET (never the admin key), records one row per oracle, and answers 200 with one entry each", async () => {
    mocks.manifest = twoOracles
    const res = await run()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "feed", oracles: [{ oracle: local.shared.oracle, ...SYNCED }, { oracle: SECOND, ...SYNCED }] })
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(mocks.tickOracle).not.toHaveBeenCalled()
    const d = deps()
    expect(d.secret).toBe(KEEPER)
    expect(d.oracles).toEqual([local.shared.oracle, SECOND])
    expect(rows()).toEqual([
      { network: "local", oracle: local.shared.oracle, tick: SYNCED },
      { network: "local", oracle: SECOND, tick: SYNCED },
    ])
  })

  it("the run's deadline is its start plus 50 s: the route's 60 s leave room for the rows", async () => {
    const before = Date.now()
    await run()
    const after = Date.now()
    const { deadlineMs } = deps()
    expect(deadlineMs).toBeGreaterThanOrEqual(before + 50_000)
    expect(deadlineMs).toBeLessThanOrEqual(after + 50_000)
  })

  it("rejections go on-chain only with ORACLE_KEEPER_RECORD_REJECTIONS=1 (M-14); anything else, or unset, is off", async () => {
    for (const [raw, on] of [[undefined, false], ["1", true], ["0", false], ["true", false]] as const) {
      if (raw === undefined) delete process.env.ORACLE_KEEPER_RECORD_REJECTIONS
      else process.env.ORACLE_KEEPER_RECORD_REJECTIONS = raw
      mocks.tickFeedAll.mockClear()
      expect((await run()).status).toBe(200)
      expect(deps().recordRejections).toBe(on)
    }
  })

  it("hands the keeper its memory per oracle: the last submitted rejection read from oracle_ticks", async () => {
    mocks.lastSubmittedRejection.mockResolvedValue({ reason: "deviate", value: "11500000" })
    await run()
    expect(mocks.lastSubmittedRejection).not.toHaveBeenCalled()
    expect(await deps().lastSubmittedRejection(SECOND)).toEqual({ reason: "deviate", value: "11500000" })
    expect(mocks.lastSubmittedRejection).toHaveBeenCalledWith("the-sql", "local", SECOND)
  })

  it("no memory when the database cannot be read: null (every significant rejection is new), logged by name, the run goes on", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    class DatabaseConfigError extends Error {
      name = "DatabaseConfigError"
    }
    mocks.lastSubmittedRejection.mockRejectedValue(new DatabaseConfigError("postgres://user:pw@db.example/x is down"))
    expect((await run()).status).toBe(200)
    expect(await deps().lastSubmittedRejection(local.shared.oracle)).toBeNull()
    expect(lines(error)).toEqual(["oracle keeper: the last submitted rejection was not read: DatabaseConfigError"])
  })

  it("ORACLE_KEEPER_INTERVAL_SECONDS: a valid schedule runs; a bad one is 503 not_configured, nothing runs, one row per manifest oracle", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.manifest = twoOracles
    process.env.ORACLE_KEEPER_INTERVAL_SECONDS = "300"
    expect((await run()).status).toBe(200)
    const message = "ORACLE_KEEPER_INTERVAL_SECONDS must be a whole number of seconds from 60 to 86400."
    for (const raw of ["59", "86401", "5m", "300.5"]) {
      process.env.ORACLE_KEEPER_INTERVAL_SECONDS = raw
      mocks.tickFeedAll.mockClear()
      mocks.recordTick.mockClear()
      error.mockClear()
      const res = await run()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "not_configured" })
      expect(mocks.tickFeedAll).not.toHaveBeenCalled()
      const failure = { status: "not_configured", mode: "feed", signer: SIGNER, message }
      expect(rows()).toEqual([
        { network: "local", oracle: local.shared.oracle, tick: failure },
        { network: "local", oracle: SECOND, tick: failure },
      ])
      expect(lines(error)).toEqual([`oracle keeper: ${message}`])
    }
  })

  it("ORACLE_KEEPER_ORACLE_ID (local only) replaces the manifest's oracles with one id or a comma-separated list, with one warning per run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    process.env.ORACLE_KEEPER_ORACLE_ID = ` ${OTHER} `
    expect((await run()).status).toBe(200)
    expect(deps().oracles).toEqual([OTHER])
    expect(rows().map((r) => r.oracle)).toEqual([OTHER])
    expect(lines(warn)).toEqual([
      `oracle keeper: ORACLE_KEEPER_ORACLE_ID overrides the manifest's oracles (${local.shared.oracle}): this run syncs ${OTHER}, which the dashboard and the alert check do not follow`,
    ])
    // A list: each id trimmed, in its order, a repeat once.
    mocks.tickFeedAll.mockClear()
    mocks.recordTick.mockClear()
    warn.mockClear()
    process.env.ORACLE_KEEPER_ORACLE_ID = ` ${OTHER} ,${SECOND}, ${OTHER}`
    expect((await run()).status).toBe(200)
    expect(deps().oracles).toEqual([OTHER, SECOND])
    expect(rows().map((r) => r.oracle)).toEqual([OTHER, SECOND])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(lines(warn)[0]).toContain(`this run syncs ${OTHER}, ${SECOND},`)
  })

  it("an ORACLE_KEEPER_ORACLE_ID with anything but contract ids: 503 not_configured, nothing runs, recorded under the manifest's oracles", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    for (const raw of ["GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA", `${OTHER},`, `${OTHER},,${SECOND}`, `${OTHER};${SECOND}`]) {
      process.env.ORACLE_KEEPER_ORACLE_ID = raw
      mocks.tickFeedAll.mockClear()
      mocks.recordTick.mockClear()
      const res = await run()
      expect(res.status, raw).toBe(503)
      expect(mocks.tickFeedAll).not.toHaveBeenCalled()
      expect(rows()).toEqual([
        {
          network: "local",
          oracle: local.shared.oracle,
          tick: { status: "not_configured", mode: "feed", signer: SIGNER, message: "ORACLE_KEEPER_ORACLE_ID is not a contract id or a comma-separated list of contract ids." },
        },
      ])
    }
  })

  it("off the local network, an override is refused: 503 not_configured, nothing runs, recorded under each manifest oracle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const network of ["testnet", "mainnet"]) {
      mocks.manifest = { ...local, network }
      mocks.recordTick.mockClear()
      mocks.tickFeedAll.mockClear()
      warn.mockClear()
      process.env.ORACLE_KEEPER_ORACLE_ID = OTHER
      const res = await run()
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: "not_configured" })
      expect(mocks.tickFeedAll).not.toHaveBeenCalled()
      const refused = {
        status: "not_configured",
        mode: "feed",
        signer: SIGNER,
        message: "ORACLE_KEEPER_ORACLE_ID names another oracle than the manifest's: the override oracle is for local proofs only.",
      }
      expect(rows()).toEqual([{ network, oracle: local.shared.oracle, tick: refused }])
      expect(warn).toHaveBeenCalledTimes(1)
      // The manifest's own single oracle named explicitly is no override: it runs, with no warning.
      warn.mockClear()
      mocks.tickFeedAll.mockClear()
      process.env.ORACLE_KEEPER_ORACLE_ID = local.shared.oracle
      expect((await run()).status).toBe(200)
      expect(deps().oracles).toEqual([local.shared.oracle])
      expect(warn).not.toHaveBeenCalled()
      // With two oracles, naming one of them is an override: refused.
      mocks.manifest = { ...twoOracles, network }
      mocks.tickFeedAll.mockClear()
      mocks.recordTick.mockClear()
      expect((await run()).status).toBe(503)
      expect(mocks.tickFeedAll).not.toHaveBeenCalled()
      expect(rows().map((r) => r.oracle)).toEqual([local.shared.oracle, SECOND])
    }
  })

  it("a rejected, skipped (no_feed included) or synced oracle answers 200; rejections are logged as warnings that name the oracle", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.manifest = twoOracles
    const rejected = { status: "rejected", mode: "feed", signer: SIGNER, value: "11500000", timestamp: 2_800, reason: "deviate" }
    const cases: [Outcome, string][] = [
      // A new significant rejection, submitted: its hash.
      [{ ...rejected, hash: "cd".repeat(32) }, `oracle keeper: ${SECOND}: the oracle rejected value 11500000 at timestamp 2800 (reason deviate, tx ${"cd".repeat(32)})`],
      // Not submitted: a repeat, a broken feed, or rejections kept off-chain (M-14).
      [rejected, `oracle keeper: ${SECOND}: the oracle rejected value 11500000 at timestamp 2800 (reason deviate, not submitted)`],
      [{ ...rejected, value: null, timestamp: null, reason: "feed_err" }, `oracle keeper: ${SECOND}: the oracle rejected value unknown at timestamp unknown (reason feed_err, not submitted)`],
    ]
    for (const [tick, line] of cases) {
      outcomes = { [local.shared.oracle]: { status: "skipped", mode: "feed", signer: SIGNER, value: null, timestamp: null, reason: "no_feed" }, [SECOND]: tick }
      mocks.tickFeedAll.mockClear()
      mocks.recordTick.mockClear()
      warn.mockClear()
      const res = await run()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ mode: "feed", oracles: [{ oracle: local.shared.oracle, ...outcomes[local.shared.oracle] }, { oracle: SECOND, ...tick }] })
      expect(lines(warn)).toEqual([line])
      expect(rows().map((r) => r.tick)).toEqual([outcomes[local.shared.oracle], tick])
    }
    expect(error).not.toHaveBeenCalled()
  })

  it("500 when any oracle failed, with every oracle's entry; each failure logged by name (and hash), never its text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.manifest = twoOracles
    const failed = { status: "failed", mode: "feed", signer: SIGNER, name: "txBadSeq", hash: "ef".repeat(32) }
    outcomes = { [SECOND]: failed }
    const res = await run()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ mode: "feed", oracles: [{ oracle: local.shared.oracle, ...SYNCED }, { oracle: SECOND, ...failed }] })
    expect(rows().map((r) => r.tick)).toEqual([SYNCED, failed])
    expect(lines(error)).toEqual([`oracle keeper: ${SECOND}: the oracle update did not land: txBadSeq (tx ${"ef".repeat(32)})`])
    error.mockClear()
    outcomes = { [SECOND]: { status: "failed", mode: "feed", signer: SIGNER, name: "TypeError" } }
    expect((await run()).status).toBe(500)
    expect(lines(error)).toEqual([`oracle keeper: ${SECOND}: the run failed: TypeError`])
  })

  it("503 when every oracle is not_configured (no key, the admin's key everywhere); 200 when only some are", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.manifest = twoOracles
    const nc = (message: string) => ({ status: "not_configured", mode: "feed", signer: null, message })
    outcomes = { [local.shared.oracle]: nc("ORACLE_KEEPER_SECRET is not set."), [SECOND]: nc("ORACLE_KEEPER_SECRET is not set.") }
    const res = await run()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ mode: "feed", oracles: [{ oracle: local.shared.oracle, ...outcomes[local.shared.oracle] }, { oracle: SECOND, ...outcomes[SECOND] }] })
    expect(rows()).toHaveLength(2)
    expect(lines(error)).toEqual([`oracle keeper: ${local.shared.oracle}: ORACLE_KEEPER_SECRET is not set.`, `oracle keeper: ${SECOND}: ORACLE_KEEPER_SECRET is not set.`])
    // One oracle refused (its admin is the keeper's key), the other synced: the run worked.
    outcomes = { [SECOND]: { ...nc("ORACLE_KEEPER_SECRET is the oracle admin's key: feed mode needs a key with no protocol role."), signer: SIGNER } }
    expect((await run()).status).toBe(200)
    // A failure beats the rest: 500.
    outcomes = { [local.shared.oracle]: nc("x"), [SECOND]: { status: "failed", mode: "feed", signer: SIGNER, name: "Error" } }
    expect((await run()).status).toBe(500)
  })

  it("rows that cannot be written never change the answer: each logged by error name", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.manifest = twoOracles
    class DatabaseConfigError extends Error {
      name = "DatabaseConfigError"
    }
    mocks.recordTick.mockRejectedValue(new DatabaseConfigError("postgres://user:pw@db.example/x is down"))
    const res = await run()
    expect(res.status).toBe(200)
    expect(lines(error)).toEqual(["oracle keeper: the tick was not recorded: DatabaseConfigError", "oracle keeper: the tick was not recorded: DatabaseConfigError"])
  })

  it("the keeper's key reaches no row and no answer, whatever the outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.manifest = twoOracles
    outcomes = { [SECOND]: { status: "failed", mode: "feed", signer: SIGNER, name: "Error" } }
    const body = await (await run()).text()
    process.env.ORACLE_KEEPER_INTERVAL_SECONDS = "1"
    await run()
    expect(body).not.toContain(KEEPER)
    expect(JSON.stringify(mocks.recordTick.mock.calls)).not.toContain(KEEPER)
    expect(mocks.keeperSigner).toHaveBeenCalledWith(KEEPER)
  })

  it("push mode keeps 500 for a rejection (unchanged)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    process.env.ORACLE_KEEPER_MODE = "push"
    mocks.tickOracle.mockResolvedValue({ status: "rejected", mode: "push", signer: SIGNER, value: "1", timestamp: 2_800, hash: "ab".repeat(32), reason: "deviate" })
    expect((await run()).status).toBe(500)
  })

  it("push mode ignores the feed variables: a bad interval or an override changes nothing there", async () => {
    process.env.ORACLE_KEEPER_MODE = "push"
    process.env.ORACLE_KEEPER_INTERVAL_SECONDS = "1"
    process.env.ORACLE_KEEPER_ORACLE_ID = "not-an-id"
    mocks.tickOracle.mockResolvedValue(UPDATED)
    const res = await run()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(UPDATED)
    expect(mocks.tickFeedAll).not.toHaveBeenCalled()
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
    expect(mocks.tickFeedAll).not.toHaveBeenCalled()
    expect(mocks.lastSubmittedRejection).not.toHaveBeenCalled()
  })

  it("a mode that is neither push nor feed: 503 not_configured, nothing runs, recorded under the default (push)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    process.env.ORACLE_KEEPER_MODE = "pull"
    const res = await run()
    expect(res.status).toBe(503)
    expect(mocks.tickOracle).not.toHaveBeenCalled()
    expect(mocks.tickFeedAll).not.toHaveBeenCalled()
    expect(rows()).toEqual([{ network: "local", oracle: local.shared.oracle, tick: { status: "not_configured", mode: "push", signer: null, message: "ORACLE_KEEPER_MODE is neither push nor feed." } }])
  })
})
