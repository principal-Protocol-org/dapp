// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("next/server", () => ({ connection: async () => {} }))

const mocks = vi.hoisted(() => ({
  listAlerts: vi.fn(),
  DatabaseConfigError: class DatabaseConfigError extends Error {},
}))
vi.mock("@/lib/server/alerts", () => ({ listAlerts: mocks.listAlerts }))
vi.mock("@/lib/server/db", () => ({ sql: vi.fn(async () => []), DatabaseConfigError: mocks.DatabaseConfigError }))
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const json = (await import("@/config/manifests/testnet.json")).default
  const m = parseManifest(json)
  return { activeManifest: () => m }
})

import { parseOpenAlerts } from "@/lib/app/alert-types"
import { GET } from "../route"

const HOOK = "https://hooks.example.test/services/T000/B000/very-secret-token"
const RISK = "CCRZ55SG273OTUZSFME6A6XXXEZ3GM5IMVRLF4NEEWNC54NGCRHIMHJC"
const OPEN = { kind: "oracle_stale", subject: "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS", severity: "critical", openedAt: "2026-11-14T11:59:00.000Z", payload: { ageSeconds: 3_700 } }
const ANSWER = {
  open: [OPEN],
  recent: [
    { ...OPEN, resolvedAt: null },
    { kind: "risk_exhausted", subject: RISK, severity: "critical", openedAt: "2026-11-12T10:00:00.000Z", resolvedAt: "2026-11-12T11:00:00.000Z", payload: { percent: "100.0" } },
  ],
  lastTest: { openedAt: "2026-11-14T09:00:00.000Z", delivered: true },
}

describe("GET /api/dashboard/alerts", () => {
  beforeEach(() => {
    process.env.ALERT_WEBHOOK_URL = HOOK
    mocks.listAlerts.mockReset()
    mocks.listAlerts.mockResolvedValue(ANSWER)
  })
  afterEach(() => {
    delete process.env.ALERT_WEBHOOK_URL
    vi.restoreAllMocks()
  })

  it("is public: { open, recent, lastTest } for this network, cached 30 s, in the shape the dashboard reads", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=30")
    const body = await res.json()
    expect(body).toEqual(ANSWER)
    expect(mocks.listAlerts.mock.calls[0][1]).toBe("testnet")
    // The overview and the risk page parse it: recent is kept (resolved ones included).
    expect(parseOpenAlerts(body)).toEqual({ open: ANSWER.open, recent: ANSWER.recent })
  })

  it("carries no webhook URL and no secret", async () => {
    const body = await (await GET()).text()
    expect(body).not.toContain("hooks.example.test")
    expect(body).not.toMatch(/S[A-Z2-7]{55}/)
  })

  it("503 not_configured without a database, never cached", async () => {
    mocks.listAlerts.mockRejectedValue(new mocks.DatabaseConfigError("DATABASE_URL is not set."))
    const res = await GET()
    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error: "not_configured" })
  })

  it("503 unavailable when the database fails, logged by name only, never cached", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.listAlerts.mockRejectedValue(new Error("connect to postgres://u:p@db.example/x failed"))
    const res = await GET()
    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error: "unavailable" })
    expect(error.mock.calls.flat().join(" ")).not.toContain("db.example")
  })
})
