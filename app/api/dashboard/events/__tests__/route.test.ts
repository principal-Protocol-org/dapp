// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const state = vi.hoisted(() => ({
  fail: null as unknown,
  texts: [] as string[],
  values: [] as unknown[][],
  events: [] as Record<string, unknown>[],
  cursors: [] as Record<string, unknown>[],
  counts: [] as Record<string, unknown>[],
  DatabaseConfigError: class DatabaseConfigError extends Error {},
  manifestError: null as Error | null,
}))
vi.mock("@/lib/server/db", () => ({
  // The events and ingest_cursor tables: the real read model runs its SQL against these rows.
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (state.fail) throw state.fail
    const text = strings.join("?").replace(/\s+/g, " ").trim()
    state.texts.push(text)
    state.values.push(values)
    if (text.includes("from ingest_cursor")) return state.cursors
    if (text.includes("group by topic")) return state.counts
    if (text.includes("from events")) {
      if (text.includes("where network = ? and id = ?")) return state.events.filter((e) => e.id === values[1])
      // A list never selects raw_xdr: drop it as the database would.
      return state.events.map((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== "raw_xdr")))
    }
    throw new Error(`unexpected SQL: ${text}`)
  },
  DatabaseConfigError: state.DatabaseConfigError,
}))
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const json = (await import("@/config/manifests/testnet.json")).default
  const m = parseManifest(json)
  return {
    activeManifest: () => {
      if (state.manifestError) throw state.manifestError
      return m
    },
  }
})

import { GET } from "../route"

const POOL = "CB3JI6H2HZ3PMWKLEKDPQUURFSKJSFTLNFNBU4CFEHAZXMWL5SNNS6OJ"
const ID = "0024512890283298816-0000000001"
const CACHED = "public, s-maxage=60, stale-while-revalidate=300"
const call = (q = "") => GET(new Request(`https://app.example/api/dashboard/events${q}`))

const EVENT = {
  id: ID,
  group_name: "escrow",
  contract_id: "CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q",
  topic: "recovery",
  ledger: 5_707_400,
  close_time: new Date("2026-11-13T10:00:00Z"),
  tx_hash: "ab".repeat(32),
  pool: POOL,
  data: { id: "0", sy_shares: "10" },
  raw_xdr: "AAAAEAAAAAEAAAAH",
}

beforeEach(() => {
  state.fail = null
  state.texts = []
  state.values = []
  state.events = [EVENT]
  state.counts = []
  state.cursors = (["escrow", "oracle", "permissioning", "risk", "market"] as const).map((g) => ({
    name: `events:${g}:testnet`,
    ledger: "5707500",
    close_time: new Date("2026-11-13T10:08:20Z"),
  }))
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("GET /api/dashboard/events", () => {
  it("is public: no credentials, a cached answer of { rows, indexedThrough, lagSeconds }", async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe(CACHED)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(["gaps", "indexedThrough", "indexedThroughCloseTime", "lagSeconds", "reconcile", "rows"])
    expect(body.indexedThroughCloseTime).toBe("2026-11-13T10:08:20.000Z")
    expect(body.gaps).toEqual([])
    expect(body.indexedThrough).toBe(5_707_500)
    expect(typeof body.lagSeconds).toBe("number")
    expect(body.rows).toEqual([
      {
        id: ID,
        group: "escrow",
        contractId: EVENT.contract_id,
        topic: "recovery",
        ledger: 5_707_400,
        closeTime: "2026-11-13T10:00:00.000Z",
        txHash: EVENT.tx_hash,
        pool: POOL,
        data: { id: "0", sy_shares: "10" },
      },
    ])
  })

  it("never returns raw xdr in a list", async () => {
    const body = await (await call("?limit=200")).json()
    for (const row of body.rows) {
      expect(row).not.toHaveProperty("rawXdr")
      expect(row).not.toHaveProperty("raw_xdr")
    }
    const list = state.texts.find((t) => t.includes("from events")) as string
    expect(list).not.toMatch(/raw_xdr/)
  })

  it("one event by ?id= carries its raw xdr", async () => {
    const res = await call(`?id=${ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe(CACHED)
    expect((await res.json()).event).toMatchObject({ id: ID, group: "escrow", rawXdr: EVENT.raw_xdr })
    // An id the index does not hold is a 404, never cached.
    const missing = await call(`?id=${"0".repeat(19)}-0000000000`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get("cache-control")).toBe("no-store")
  })

  it("passes group, pool, before and limit to the read model on this network", async () => {
    const before = "0024512890283298816-0000000000"
    expect((await call(`?group=escrow&pool=${POOL}&before=${before}&limit=7`)).status).toBe(200)
    const params = state.values[state.texts.findIndex((t) => t.includes("from events"))]
    expect(params).toEqual(expect.arrayContaining(["testnet", "escrow", POOL, before, 7]))
  })

  it("passes ?topic= (a comma list) to the read model", async () => {
    expect((await call("?group=risk&topic=cb_limit,ast_limit,cb_window")).status).toBe(200)
    const params = state.values[state.texts.findIndex((t) => t.includes("from events"))]
    expect(params).toContainEqual(["cb_limit", "ast_limit", "cb_window"])
  })

  it("?counts=1 adds every indexed event's count per topic to the answer, cached as the list", async () => {
    state.counts = [
      { topic: "acc_grant", n: "37" },
      { topic: "ast_grant", n: "68" },
    ]
    const res = await call("?group=permissioning&counts=1&limit=1")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe(CACHED)
    const body = await res.json()
    expect(body.counts).toEqual({ acc_grant: 37, ast_grant: 68 })
    expect(body.indexedThrough).toBe(5_707_500)
    const params = state.values[state.texts.findIndex((t) => t.includes("group by topic"))]
    expect(params).toEqual(expect.arrayContaining(["testnet", "permissioning"]))
    // Without the flag no count is made.
    state.texts = []
    expect(await (await call("?group=permissioning")).json()).not.toHaveProperty("counts")
    expect(state.texts.some((t) => t.includes("group by topic"))).toBe(false)
  })

  it.each([
    ["?topic=", "invalid_topic"],
    ["?topic=cb_limit,", "invalid_topic"],
    ["?topic=drop%20table", "invalid_topic"],
    [`?topic=${Array.from({ length: 11 }, (_, i) => `t${i}`).join(",")}`, "invalid_topic"],
    ["?counts=yes", "invalid_counts"],
    ["?group=pools", "invalid_group"],
    ["?pool=nope", "invalid_pool"],
    ["?before=123", "invalid_before"],
    ["?id=abc", "invalid_id"],
    ["?limit=0", "invalid_limit"],
    ["?limit=201", "invalid_limit"],
    ["?limit=1.5", "invalid_limit"],
    ["?limit=ten", "invalid_limit"],
  ])("400 for %s, never cached", async (q, error) => {
    const res = await call(q)
    expect(res.status).toBe(400)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error })
  })

  it("limit defaults to 50 and accepts 200", async () => {
    await call()
    expect(state.values[state.texts.findIndex((t) => t.includes("from events"))]).toContain(50)
    expect((await call("?limit=200")).status).toBe(200)
  })

  it("503 not_configured without DATABASE_URL, 503 unavailable when the database fails; no-store", async () => {
    state.fail = new state.DatabaseConfigError("DATABASE_URL is not set.")
    const a = await call()
    expect(a.status).toBe(503)
    expect(a.headers.get("cache-control")).toBe("no-store")
    expect(await a.json()).toEqual({ error: "not_configured" })
    state.fail = Object.assign(new Error("connect ECONNREFUSED postgres://user:pw@host/db"), { code: "ECONNREFUSED" })
    const b = await call(`?id=${ID}`)
    expect(b.status).toBe(503)
    expect(b.headers.get("cache-control")).toBe("no-store")
    expect(await b.json()).toEqual({ error: "unavailable" })
  })
})

describe("GET /api/dashboard/events when the manifest cannot be read", () => {
  it("answers 503 unavailable, never cached, logged by name only (not an unhandled 500)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      state.fail = null
      state.manifestError = new Error('NEXT_PUBLIC_PRINCIPAL_NETWORK must be "testnet" or "local", got "x".')
      for (const query of ["", "?id=0024565460586500096-0000000000"]) {
        const res = await GET(new Request(`https://app.example/api/dashboard/events${query}`))
        expect(res.status).toBe(503)
        expect(await res.json()).toEqual({ error: "unavailable" })
        expect(res.headers.get("cache-control")).toBe("no-store")
      }
      expect(error.mock.calls.map((c) => c.map(String).join(" "))).toEqual(["dashboard events route: Error", "dashboard events route: Error"])
    } finally {
      state.manifestError = null
      error.mockRestore()
    }
  })
})
