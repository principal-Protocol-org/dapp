// @vitest-environment node
import { describe, expect, it } from "vitest"
import { appendLog, LOG_KEY, LOG_LIMIT, readLog, type LogEntry } from "../local-log"

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
const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  hash: "a".repeat(64),
  action: "buy_pt",
  marketId: "m1",
  account: A,
  at: 1_000,
  status: "SUCCESS",
  ...over,
})

describe("local log", () => {
  it("keeps entries per account, under pp-txlog", () => {
    const s = memoryStorage()
    appendLog(entry({ hash: "1".repeat(64) }), s)
    appendLog(entry({ hash: "2".repeat(64), account: B, action: "deposit" }), s)
    expect(LOG_KEY).toBe("pp-txlog")
    expect(s.getItem("pp-txlog")).not.toBeNull()
    expect(readLog(A, s).map((e) => e.hash)).toEqual(["1".repeat(64)])
    expect(readLog(B, s)).toEqual([entry({ hash: "2".repeat(64), account: B, action: "deposit" })])
    expect(readLog("GCCC", s)).toEqual([])
  })

  it("lists the newest first and replaces an entry with the same hash (a status update)", () => {
    const s = memoryStorage()
    appendLog(entry({ hash: "1".repeat(64), at: 1, status: "NOT_FOUND" }), s)
    appendLog(entry({ hash: "2".repeat(64), at: 2 }), s)
    appendLog(entry({ hash: "1".repeat(64), at: 3, status: "SUCCESS" }), s)
    expect(readLog(A, s).map((e) => [e.hash[0], e.status])).toEqual([
      ["1", "SUCCESS"],
      ["2", "SUCCESS"],
    ])
  })

  it(`keeps at most ${LOG_LIMIT} entries per account`, () => {
    const s = memoryStorage()
    for (let i = 0; i < LOG_LIMIT + 5; i++) appendLog(entry({ hash: i.toString(16).padStart(64, "0"), at: i }), s)
    const log = readLog(A, s)
    expect(log).toHaveLength(LOG_LIMIT)
    expect(log[0].at).toBe(LOG_LIMIT + 4)
  })

  it("ignores malformed storage and malformed entries", () => {
    expect(readLog(A, memoryStorage({ "pp-txlog": "{not json" }))).toEqual([])
    expect(readLog(A, memoryStorage({ "pp-txlog": JSON.stringify([1, 2]) }))).toEqual([])
    const mixed = memoryStorage({
      "pp-txlog": JSON.stringify({ [A]: [entry(), { hash: 5 }, { ...entry(), action: "steal" }, { ...entry(), status: "MAYBE" }] }),
    })
    expect(readLog(A, mixed)).toEqual([entry()])
    // A malformed store is replaced on the next append, never thrown on.
    const s = memoryStorage({ "pp-txlog": "{not json" })
    appendLog(entry(), s)
    expect(readLog(A, s)).toEqual([entry()])
  })

  it("survives storage that throws or is missing", () => {
    const broken = memoryStorage()
    broken.getItem = () => {
      throw new Error("blocked")
    }
    broken.setItem = () => {
      throw new Error("full")
    }
    expect(() => appendLog(entry(), broken)).not.toThrow()
    expect(readLog(A, broken)).toEqual([])
    expect(() => appendLog(entry())).not.toThrow() // node: no localStorage at all
    expect(readLog(A)).toEqual([])
  })
})
