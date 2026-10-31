// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { readRoutes, ROUTES_KEY, ROUTES_LIMIT, subscribeRoutes, writeRoute, type RouteRun } from "../route-log"

/** A Map-backed `Storage`, so the log is tested without a browser. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial))
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  }
}

const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

const run = (over: Partial<RouteRun> = {}): RouteRun => ({
  id: "r1",
  account: A,
  marketId: "m1",
  kind: "buy_pt",
  request: { kind: "buy_pt", marketId: "m1", source: A, amount: 1_000_0000000n, pay: "underlying", receive: "underlying", matured: false },
  plans: [
    { action: "deposit", amount: { from: "input" }, gives: "USDY", takes: "SY" },
    { action: "buy_pt", amount: { from: "step", index: 0, field: "value" }, gives: "SY", takes: "PT" },
  ],
  outputs: [{ kind: "amount", value: 999_0000000n }],
  steps: [
    { action: "deposit", status: "confirmed", hash: "a".repeat(64) },
    { action: "buy_pt", status: "pending" },
  ],
  startedAt: 1_000,
  ...over,
})

describe("route log", () => {
  it("keeps runs per account under pp-routes, bigints included", () => {
    const s = memoryStorage()
    writeRoute(run(), s)
    writeRoute(run({ id: "r2", account: B, request: { ...run().request, source: B } }), s)
    expect(ROUTES_KEY).toBe("pp-routes")
    expect(s.getItem("pp-routes")).not.toBeNull()
    expect(readRoutes(A, s)).toEqual([run()])
    expect(readRoutes(B, s).map((r) => r.id)).toEqual(["r2"])
    expect(readRoutes("GCCC", s)).toEqual([])
    // bigints survive the round trip as bigints, not strings or numbers
    const back = readRoutes(A, s)[0]
    expect(back.request.amount).toBe(1_000_0000000n)
    expect(back.outputs[0]).toEqual({ kind: "amount", value: 999_0000000n })
  })

  it("replaces a run by id and keeps the newest first", () => {
    const s = memoryStorage()
    writeRoute(run({ id: "old", startedAt: 1 }), s)
    writeRoute(run({ id: "new", startedAt: 2 }), s)
    writeRoute(run({ id: "old", startedAt: 1, steps: [{ action: "deposit", status: "unknown", hash: "b".repeat(64) }, { action: "buy_pt", status: "pending" }] }), s)
    const runs = readRoutes(A, s)
    expect(runs.map((r) => r.id)).toEqual(["new", "old"])
    expect(runs[1].steps[0]).toEqual({ action: "deposit", status: "unknown", hash: "b".repeat(64) })
  })

  it(`keeps the ${ROUTES_LIMIT} most recent runs per account`, () => {
    const s = memoryStorage()
    for (let i = 0; i < ROUTES_LIMIT + 5; i++) writeRoute(run({ id: `r${i}`, startedAt: i }), s)
    writeRoute(run({ id: "other", account: B, request: { ...run().request, source: B } }), s)
    const runs = readRoutes(A, s)
    expect(ROUTES_LIMIT).toBe(20)
    expect(runs).toHaveLength(20)
    expect(runs[0].id).toBe(`r${ROUTES_LIMIT + 4}`)
    expect(runs.at(-1)?.id).toBe("r5")
    expect(readRoutes(B, s)).toHaveLength(1)
  })

  it("skips malformed storage and runs, never throws", () => {
    expect(readRoutes(A, memoryStorage({ "pp-routes": "{not json" }))).toEqual([])
    expect(readRoutes(A, memoryStorage({ "pp-routes": "[]" }))).toEqual([])
    const good = memoryStorage()
    writeRoute(run(), good)
    const raw = JSON.parse(good.getItem("pp-routes")!) as Record<string, unknown[]>
    const bad = [
      { ...(raw[A][0] as object), account: B },
      { ...(raw[A][0] as object), steps: [{ action: "nope", status: "pending" }] },
      { ...(raw[A][0] as object), steps: [{ action: "deposit", status: "sent" }, { action: "buy_pt", status: "pending" }] },
      { ...(raw[A][0] as object), steps: [{ action: "deposit", status: "unknown" }, { action: "buy_pt", status: "pending" }] },
      { ...(raw[A][0] as object), steps: [] },
      { ...(raw[A][0] as object), startedAt: "yesterday" },
      { ...(raw[A][0] as object), kind: "fly" },
      { ...(raw[A][0] as object), plans: "x" },
      null,
    ]
    const s = memoryStorage({ "pp-routes": JSON.stringify({ [A]: [...bad, raw[A][0]] }) })
    expect(readRoutes(A, s).map((r) => r.id)).toEqual(["r1"])
    // and a write over malformed storage starts the account over rather than throwing
    expect(() => writeRoute(run({ id: "r9" }), memoryStorage({ "pp-routes": "42" }))).not.toThrow()
  })

  it("tolerates missing, blocked or full storage", () => {
    const throwing = {
      ...memoryStorage(),
      getItem: () => {
        throw new Error("SecurityError")
      },
      setItem: () => {
        throw new Error("QuotaExceededError")
      },
    } as Storage
    expect(readRoutes(A, throwing)).toEqual([])
    expect(() => writeRoute(run(), throwing)).not.toThrow()
    expect(readRoutes(A, undefined)).toEqual([])
    expect(() => writeRoute(run(), undefined)).not.toThrow()
  })

  it("notifies subscribers on every write", () => {
    const s = memoryStorage()
    const fn = vi.fn()
    const off = subscribeRoutes(fn)
    writeRoute(run(), s)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    writeRoute(run(), s)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
