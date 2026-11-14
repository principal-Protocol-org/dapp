// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  runAlertCheck: vi.fn(),
  sendTestAlert: vi.fn(),
  posterUrls: [] as string[],
  verify: vi.fn(),
  DatabaseConfigError: class DatabaseConfigError extends Error {},
}))
vi.mock("@/lib/server/alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/alerts")>()
  return {
    ...actual,
    runAlertCheck: mocks.runAlertCheck,
    sendTestAlert: mocks.sendTestAlert,
    webhookPoster: (url: string) => {
      mocks.posterUrls.push(url)
      return async () => {}
    },
  }
})
vi.mock("@/lib/server/db", () => ({ sql: vi.fn(async () => []), DatabaseConfigError: mocks.DatabaseConfigError }))
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

import { GET, maxDuration, POST } from "../route"

const SECRET = "test-cron-secret-0123456789"
const HOOK = "https://hooks.example.test/services/T000/B000/very-secret-token"
const URL_ = "https://app.example/api/cron/alerts"
const auth = { authorization: `Bearer ${SECRET}` }
const call = (headers: Record<string, string> = {}, query = "") => GET(new Request(`${URL_}${query}`, { headers }))

const ORACLE = "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS"
const openAlert = (kind: string, severity: "warning" | "critical") => ({ kind, subject: ORACLE, severity, openedAt: "2026-11-14T12:00:00.000Z", payload: {} })
const result = (open: ReturnType<typeof openAlert>[], over: Record<string, unknown> = {}) => ({
  network: "testnet",
  opened: [],
  resolved: [],
  open,
  posted: 0,
  postFailures: 0,
  held: [],
  unread: [],
  critical: open.some((a) => a.severity === "critical"),
  ...over,
})

describe("/api/cron/alerts", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
    process.env.ALERT_WEBHOOK_URL = HOOK
    process.env.DATABASE_URL = "postgres://u:p@db.example/x"
    process.env.QSTASH_CURRENT_SIGNING_KEY = "current"
    process.env.QSTASH_NEXT_SIGNING_KEY = "next"
    process.env.VERCEL = "1"
    mocks.runAlertCheck.mockReset()
    mocks.runAlertCheck.mockResolvedValue(result([]))
    mocks.sendTestAlert.mockReset()
    mocks.sendTestAlert.mockResolvedValue({ openedAt: "2026-11-14T12:00:00.000Z", delivered: true })
    mocks.posterUrls.length = 0
    mocks.verify.mockReset()
  })
  afterEach(() => {
    for (const k of ["CRON_SECRET", "ALERT_WEBHOOK_URL", "DATABASE_URL", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "VERCEL"]) delete process.env[k]
    vi.restoreAllMocks()
  })

  it("401 without credentials, and nothing runs", async () => {
    const res = await call()
    expect(res.status).toBe(401)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(401)
    expect((await call({}, "?test=1")).status).toBe(401)
    expect(mocks.runAlertCheck).not.toHaveBeenCalled()
    expect(mocks.sendTestAlert).not.toHaveBeenCalled()
  })

  it("200 with the run's result while no critical alert is open, never cached", async () => {
    mocks.runAlertCheck.mockResolvedValue(result([openAlert("oracle_warning", "warning"), openAlert("indexer_lag", "warning")]))
    const res = await call(auth)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect((await res.json()).open).toHaveLength(2)
  })

  it.each(["oracle_stale", "oracle_unavailable", "keeper_unhealthy", "risk_exhausted", "indexer_gap"])("500 while a critical alert is open (%s)", async (kind) => {
    mocks.runAlertCheck.mockResolvedValue(result([openAlert("paused", "warning"), openAlert(kind, "critical")]))
    const res = await call(auth)
    expect(res.status).toBe(500)
    expect((await res.json()).open.map((a: { kind: string }) => a.kind)).toEqual(["paused", kind])
  })

  it("runs the check on the manifest's network with the server's environment and the webhook poster (maxDuration 60)", async () => {
    expect(maxDuration).toBe(60)
    await call(auth)
    const [deps] = mocks.runAlertCheck.mock.calls[0]
    expect(deps.manifest.network).toBe("testnet")
    expect(deps.env).toBe(process.env)
    expect(typeof deps.post).toBe("function")
    expect(mocks.posterUrls).toEqual([HOOK])
  })

  it("a QStash POST runs the same checks", async () => {
    mocks.verify.mockResolvedValue(true)
    expect((await POST(new Request(URL_, { method: "POST", headers: { "upstash-signature": "sig" }, body: "" }))).status).toBe(200)
    mocks.verify.mockResolvedValue(false)
    expect((await POST(new Request(URL_, { method: "POST", headers: { "upstash-signature": "bad" }, body: "" }))).status).toBe(401)
  })

  it.each([
    ["ALERT_WEBHOOK_URL", undefined],
    ["ALERT_WEBHOOK_URL", "  "],
    ["ALERT_WEBHOOK_URL", "not a url"],
    ["ALERT_WEBHOOK_URL", "ftp://hooks.example.test/x"],
    ["DATABASE_URL", undefined],
  ])("503 not_configured when %s is %s, and nothing runs", async (name, value) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    for (const query of ["", "?test=1"]) {
      const res = await call(auth, query)
      expect(res.status).toBe(503)
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(await res.json()).toEqual({ error: "not_configured" })
    }
    expect(mocks.runAlertCheck).not.toHaveBeenCalled()
    expect(mocks.sendTestAlert).not.toHaveBeenCalled()
    expect(error.mock.calls.flat().join(" ")).toContain(name)
    expect(error.mock.calls.flat().join(" ")).not.toContain("hooks.example.test")
  })

  it("503 not_configured when the database module says so", async () => {
    mocks.runAlertCheck.mockRejectedValue(new mocks.DatabaseConfigError("DATABASE_URL is not set."))
    const res = await call(auth)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: "not_configured" })
  })

  it("?test=1 sends and records the test alert only: 200 when delivered", async () => {
    const res = await call(auth, "?test=1")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ test: { openedAt: "2026-11-14T12:00:00.000Z", delivered: true } })
    expect(mocks.sendTestAlert).toHaveBeenCalledTimes(1)
    expect(mocks.sendTestAlert.mock.calls[0][1]).toBe("testnet")
    expect(mocks.runAlertCheck).not.toHaveBeenCalled()
  })

  it("?test=1 answers 502 when the webhook did not take it", async () => {
    mocks.sendTestAlert.mockResolvedValue({ openedAt: "2026-11-14T12:00:00.000Z", delivered: false })
    const res = await call(auth, "?test=1")
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ test: { openedAt: "2026-11-14T12:00:00.000Z", delivered: false } })
  })

  it("500 on any other failure, logging its name only: the webhook URL is never in a log or an answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.runAlertCheck.mockRejectedValue(new TypeError(`fetch ${HOOK} failed`))
    const res = await call(auth)
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ error: "failed" })
    expect(body).not.toContain("hooks.example.test")
    expect([...error.mock.calls, ...warn.mock.calls].flat().join(" ")).not.toContain("hooks.example.test")
  })

  it("reports the sources it could not read by name, and the answer carries the post failures as a count", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    mocks.runAlertCheck.mockResolvedValue(result([], { unread: ["risk", "signer"], held: ["risk_warning", "risk_exhausted", "signer_low"], postFailures: 2 }))
    const res = await call(auth)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(JSON.parse(body)).toMatchObject({ postFailures: 2, unread: ["risk", "signer"] })
    expect(body).not.toContain("hooks.example.test")
    expect(warn.mock.calls.flat().join(" ")).toContain("risk, signer")
  })
})
