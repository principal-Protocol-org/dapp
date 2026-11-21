// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  indexEvents: vi.fn(),
  createRpcServer: vi.fn<(url: string) => object>(() => ({ rpc: "fake" })),
  verify: vi.fn(),
  sql: vi.fn(),
  manifestError: null as Error | null,
  DatabaseConfigError: class DatabaseConfigError extends Error {},
}))
// The indexer's run is faked; its group choice (runGroups) is the real one.
vi.mock("@/lib/server/indexer", async (importActual) => ({ ...(await importActual<object>()), indexEvents: mocks.indexEvents }))
// The registry is real; its SQL answers nothing, so the markets are the manifest seeds (read from the registry).
vi.mock("@/lib/server/db", () => ({ sql: mocks.sql, DatabaseConfigError: mocks.DatabaseConfigError }))
vi.mock("@upstash/qstash", () => ({
  Receiver: class {
    verify = mocks.verify
  },
}))
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const json = (await import("@/config/manifests/testnet.json")).default
  const m = parseManifest(json)
  return {
    activeManifest: () => {
      if (mocks.manifestError) throw mocks.manifestError
      return m
    },
  }
})
vi.mock("@/lib/protocol/stellar", () => ({ createRpcServer: mocks.createRpcServer }))

import { GET, maxDuration, POST } from "../route"

const SECRET = "test-cron-secret-0123456789"
const URL_ = "https://app.example/api/cron/index"
const call = (headers: Record<string, string> = {}) => GET(new Request(URL_, { headers }))
const auth = { authorization: `Bearer ${SECRET}` }

const RESULT = {
  inserted: 3,
  groups: [{ group: "escrow", indexedThrough: 5_707_400, gap: null, complete: true }],
  reconcile: [{ escrow: "CAMOW", recordCount: 0, indexed: 0, ok: true }],
}

describe("/api/cron/index", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    process.env.QSTASH_CURRENT_SIGNING_KEY = "current"
    process.env.QSTASH_NEXT_SIGNING_KEY = "next"
    process.env.VERCEL = "1"
    mocks.createRpcServer.mockReset().mockImplementation(() => ({ rpc: "fake" }))
    mocks.indexEvents.mockReset()
    mocks.indexEvents.mockResolvedValue(RESULT)
    mocks.verify.mockReset()
    mocks.sql.mockReset().mockResolvedValue([])
    mocks.manifestError = null
  })
  afterEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.QSTASH_CURRENT_SIGNING_KEY
    delete process.env.QSTASH_NEXT_SIGNING_KEY
    delete process.env.VERCEL
    vi.restoreAllMocks()
  })

  it("401 without credentials, and nothing runs", async () => {
    const res = await call()
    expect(res.status).toBe(401)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401)
    expect(mocks.indexEvents).not.toHaveBeenCalled()
  })

  it("200 with the IndexResult, never cached", async () => {
    const res = await call(auth)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual(RESULT)
  })

  it("indexes the resolved markets on the manifest's RPC within a 50 s budget (maxDuration 60)", async () => {
    expect(maxDuration).toBe(60)
    const before = Date.now()
    await call(auth)
    const [deps, opts] = mocks.indexEvents.mock.calls[0]
    expect(deps.manifest.network).toBe("testnet")
    expect(deps.markets).toEqual(deps.manifest.markets)
    expect(deps.rpc).toEqual({ rpc: "fake" })
    expect(opts.deadline).toBeGreaterThanOrEqual(before + 50_000)
    expect(opts.deadline).toBeLessThanOrEqual(Date.now() + 50_000)
    // The list came from the registry: every group runs, and nothing is skipped.
    expect(opts.groups).toEqual(["escrow", "oracle", "permissioning", "risk", "market"])
  })

  it("reads through SERVER_RPC_URL when it is set, and never answers it", async () => {
    const sentinel = "https://server-rpc.invalid/secret-sentinel"
    process.env.SERVER_RPC_URL = sentinel
    try {
      const res = await call(auth)
      expect(mocks.createRpcServer).toHaveBeenCalledWith(sentinel)
      expect(await res.text()).not.toContain("sentinel")
    } finally {
      delete process.env.SERVER_RPC_URL
    }
  })

  it("a registry that cannot be read (the seeds alone): the market and escrow groups wait, and the answer says why (I-1)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.sql.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
    const res = await call(auth)
    expect(res.status).toBe(200)
    const [deps, opts] = mocks.indexEvents.mock.calls[0]
    expect(deps.markets).toEqual(deps.manifest.markets)
    expect(opts.groups).toEqual(["oracle", "permissioning", "risk"])
    const body = await res.json()
    expect(body).toEqual({
      ...RESULT,
      skipped: {
        groups: ["escrow", "market"],
        reason: "The markets list could not be read, so only the manifest seeds were known. The market and escrow groups wait for the next run.",
      },
    })
    expect(warn.mock.calls.flat().join(" ")).toMatch(/skipped the escrow and market groups/)
  })

  it("a manifest that cannot be read answers the route's JSON 500, never a bare one (M-6)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.manifestError = new Error('NEXT_PUBLIC_PRINCIPAL_NETWORK must be "testnet", "local" or "mainnet", got "x".')
    const res = await call(auth)
    expect(res.status).toBe(500)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error: "failed" })
    expect(error.mock.calls.flat().join(" ")).toBe("index route failed: Error")
    expect(mocks.indexEvents).not.toHaveBeenCalled()
  })

  it("a QStash POST runs the same checks", async () => {
    mocks.verify.mockResolvedValue(true)
    const res = await POST(new Request(URL_, { method: "POST", headers: { "upstash-signature": "sig" }, body: "" }))
    expect(res.status).toBe(200)
    mocks.verify.mockResolvedValue(false)
    expect((await POST(new Request(URL_, { method: "POST", headers: { "upstash-signature": "bad" }, body: "" }))).status).toBe(401)
  })

  it("503 not_configured without DATABASE_URL", async () => {
    mocks.indexEvents.mockRejectedValue(new mocks.DatabaseConfigError("DATABASE_URL is not set."))
    const res = await call(auth)
    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error: "not_configured" })
  })

  it("500 when a group failed, so the scheduler alerts", async () => {
    mocks.indexEvents.mockResolvedValue({ ...RESULT, groups: [{ group: "oracle", indexedThrough: 1, gap: null, complete: false, error: "failed" }] })
    expect((await call(auth)).status).toBe(500)
  })

  it("500 on any other failure, logging its name only", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.indexEvents.mockRejectedValue(new TypeError("fetch https://secret.example/rpc?key=abc failed"))
    const res = await call(auth)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "failed" })
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/secret\.example/)
  })
})
