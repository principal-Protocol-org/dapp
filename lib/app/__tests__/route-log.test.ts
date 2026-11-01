// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  closedCopy,
  firstOpen,
  holdsFunds,
  isDone,
  pickRun,
  readRoutes,
  resumable,
  ROUTES_KEY,
  ROUTES_LIMIT,
  sameProgress,
  subscribeRoutes,
  writeRoute,
  type RouteRun,
} from "../route-log"

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

describe("route runs (R2-76, R2-77)", () => {
  const H = "a".repeat(64)
  const done = (over: Partial<RouteRun> = {}) =>
    run({ steps: [{ action: "deposit", status: "confirmed", hash: H }, { action: "buy_pt", status: "confirmed", hash: "b".repeat(64) }], ...over })
  const nothingMoved = (over: Partial<RouteRun> = {}) =>
    run({ outputs: [], steps: [{ action: "deposit", status: "failed", hash: H }, { action: "buy_pt", status: "pending" }], ...over })

  it("a dismissed run keeps a 'dismissed' flag through the log, distinct from 'closed'", () => {
    const s = memoryStorage()
    writeRoute(run({ dismissed: true }), s)
    expect(readRoutes(A, s)[0]).toMatchObject({ dismissed: true })
    expect(readRoutes(A, s)[0].closed).toBeUndefined()
    const raw = JSON.parse(s.getItem("pp-routes")!) as Record<string, Record<string, unknown>[]>
    raw[A][0].dismissed = "yes"
    expect(readRoutes(A, memoryStorage({ "pp-routes": JSON.stringify(raw) }))).toEqual([])
  })

  it("isDone and firstOpen read the steps", () => {
    expect(isDone(done())).toBe(true)
    expect(isDone(run())).toBe(false)
    expect(firstOpen(run())).toBe(1)
    expect(firstOpen(done())).toBe(2)
    expect(firstOpen(nothingMoved())).toBe(0)
  })

  it("holdsFunds: a confirmed or unknown step of an unfinished, unclosed run; a dismissed run still holds them", () => {
    expect(holdsFunds(run())).toBe(true)
    expect(holdsFunds(run({ dismissed: true }))).toBe(true)
    expect(holdsFunds(run({ steps: [{ action: "deposit", status: "unknown", hash: H }, { action: "buy_pt", status: "pending" }] }))).toBe(true)
    expect(holdsFunds(run({ closed: true }))).toBe(false)
    expect(holdsFunds(done())).toBe(false)
    expect(holdsFunds(nothingMoved())).toBe(false)
  })

  it("resumable: holds funds and was not dismissed", () => {
    expect(resumable(run())).toBe(true)
    expect(resumable(run({ dismissed: true }))).toBe(false)
    expect(resumable(nothingMoved())).toBe(false)
  })

  it("sameProgress compares each step's status and hash, and whether the run was unwound; never the flags", () => {
    expect(sameProgress(run(), run({ dismissed: true, closed: true }))).toBe(true)
    expect(sameProgress(run(), done())).toBe(false)
    expect(sameProgress(run(), run({ steps: [{ action: "deposit", status: "confirmed", hash: "c".repeat(64) }, { action: "buy_pt", status: "pending" }] }))).toBe(false)
    expect(sameProgress(run(), run({ unwound: true }))).toBe(false)
    expect(sameProgress(run(), run({ steps: [run().steps[0]], plans: [run().plans[0]] }))).toBe(false)
  })

  describe("pickRun", () => {
    const PT = ["buy_pt", "sell_pt"] as const
    const sellPt = (over: Partial<RouteRun> = {}) => run({ kind: "sell_pt", request: { ...run().request, kind: "sell_pt" }, ...over })
    const recombine = (over: Partial<RouteRun> = {}) => run({ kind: "recombine", request: { ...run().request, kind: "recombine" }, ...over })

    it("picks the newest resumable run of the host's kinds on the market; never another kind's", () => {
      const runs = [recombine({ id: "rc", startedAt: 9 }), sellPt({ id: "new", startedAt: 5 }), run({ id: "old", startedAt: 1 })]
      expect(pickRun(runs, { marketId: "m1", kinds: PT })?.id).toBe("new")
      expect(pickRun(runs, { marketId: "m1", kinds: ["recombine"] })?.id).toBe("rc")
      expect(pickRun(runs, { marketId: "m2", kinds: PT })).toBeUndefined()
      expect(pickRun([run({ dismissed: true }), nothingMoved({ id: "x" }), done({ id: "y" })], { marketId: "m1", kinds: PT })).toBeUndefined()
    })

    it("prefers the run History's Continue names, dismissed included, when it is this host's and holds funds", () => {
      const runs = [sellPt({ id: "new", startedAt: 5 }), run({ id: "old", startedAt: 1, dismissed: true }), recombine({ id: "rc" })]
      expect(pickRun(runs, { marketId: "m1", kinds: PT, preferId: "old" })?.id).toBe("old")
      // Another host's run, a finished one or an unknown id: the newest resumable instead.
      expect(pickRun(runs, { marketId: "m1", kinds: PT, preferId: "rc" })?.id).toBe("new")
      expect(pickRun([done({ id: "d" }), run({ id: "o", startedAt: 0 })], { marketId: "m1", kinds: PT, preferId: "d" })?.id).toBe("o")
      expect(pickRun(runs, { marketId: "m1", kinds: PT, preferId: "nope" })?.id).toBe("new")
      expect(pickRun(runs, { marketId: "m2", kinds: PT, preferId: "old" })).toBeUndefined()
    })
  })

  it("closedCopy: a funded run is dismissed (continuable), one with nothing held is closed for good, a finished one is left as it is", () => {
    expect(closedCopy(run())).toEqual({ ...run(), dismissed: true })
    expect(closedCopy(nothingMoved())).toEqual({ ...nothingMoved(), closed: true })
    expect(closedCopy(done())).toEqual(done())
  })
})
