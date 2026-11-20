import { afterEach, describe, expect, it, vi } from "vitest"
import { addPending, PENDING_KEY, readPending, removePending, subscribePending, type PendingTx } from "../pending-tx"

/** A Map-backed `Storage`, so a reload can be a second read of the same data. */
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

/** A `Storage` whose every access throws, as in a private window with storage blocked. */
const blocked = (): Storage =>
  new Proxy({} as Storage, {
    get() {
      throw new DOMException("The operation is insecure.", "SecurityError")
    },
  })

const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const entry = (over: Partial<PendingTx> = {}): PendingTx => ({
  hash: "a".repeat(64),
  action: "buy_pt",
  marketId: "m1",
  account: A,
  validUntil: 1_700_000_300,
  sentAt: 1_700_000_000,
  ...over,
})

afterEach(() => {
  localStorage.clear()
})

describe("pending transactions", () => {
  it("adds an entry under pp-pending, read by account", () => {
    const s = memoryStorage()
    addPending(entry(), s)
    addPending(entry({ hash: "b".repeat(64), account: B, action: "deposit" }), s)
    expect(PENDING_KEY).toBe("pp-pending")
    expect(s.getItem("pp-pending")).not.toBeNull()
    expect(readPending(A, s)).toEqual([entry()])
    expect(readPending(B, s)).toEqual([entry({ hash: "b".repeat(64), account: B, action: "deposit" })])
    expect(readPending("GCCC", s)).toEqual([])
  })

  it("lists the newest first, and an entry added again replaces the one with its hash", () => {
    const s = memoryStorage()
    addPending(entry({ hash: "1".repeat(64) }), s)
    addPending(entry({ hash: "2".repeat(64) }), s)
    addPending(entry({ hash: "1".repeat(64), validUntil: 1_700_000_900 }), s)
    expect(readPending(A, s).map((e) => [e.hash[0], e.validUntil])).toEqual([
      ["1", 1_700_000_900],
      ["2", 1_700_000_300],
    ])
  })

  it("removes an entry by account and hash, and says whether it was there", () => {
    const s = memoryStorage()
    addPending(entry({ hash: "1".repeat(64) }), s)
    addPending(entry({ hash: "2".repeat(64) }), s)
    addPending(entry({ hash: "1".repeat(64), account: B }), s)
    expect(removePending(A, "1".repeat(64), s)).toBe(true)
    expect(readPending(A, s).map((e) => e.hash[0])).toEqual(["2"])
    // Another account's entry with the same hash stays.
    expect(readPending(B, s).map((e) => e.hash[0])).toEqual(["1"])
    expect(removePending(A, "1".repeat(64), s)).toBe(false)
  })

  it("survives a reload: a second read of the same storage finds the entry", () => {
    const s = memoryStorage()
    addPending(entry(), s)
    const reloaded = memoryStorage({ [PENDING_KEY]: s.getItem(PENDING_KEY)! })
    expect(readPending(A, reloaded)).toEqual([entry()])
    expect(readPending(A, reloaded)).toEqual([entry()])
  })

  it("is kept apart from the route log and the local log", () => {
    const s = memoryStorage({ "pp-routes": "[]", "pp-txlog": "{}" })
    addPending(entry(), s)
    removePending(A, entry().hash, s)
    expect(s.getItem("pp-routes")).toBe("[]")
    expect(s.getItem("pp-txlog")).toBe("{}")
  })

  it("skips malformed storage and entries, never throws", () => {
    expect(readPending(A, memoryStorage({ [PENDING_KEY]: "not json" }))).toEqual([])
    expect(readPending(A, memoryStorage({ [PENDING_KEY]: "[1, 2]" }))).toEqual([])
    const odd = [
      { ...entry(), action: "launch_rocket" },
      { ...entry(), validUntil: "soon" },
      { ...entry(), sentAt: Number.NaN },
      { ...entry(), account: B },
      { ...entry(), hash: 7 },
      null,
    ]
    const s = memoryStorage({ [PENDING_KEY]: JSON.stringify({ [A]: [...odd, entry({ hash: "c".repeat(64) })] }) })
    expect(readPending(A, s)).toEqual([entry({ hash: "c".repeat(64) })])
    // Adding to it drops what could not be read.
    addPending(entry(), s)
    expect(JSON.parse(s.getItem(PENDING_KEY)!)[A]).toEqual([entry(), entry({ hash: "c".repeat(64) })])
  })

  it("never throws when storage is blocked, and keeps the entries in this tab so the guard still holds", () => {
    const s = blocked()
    expect(() => addPending(entry(), s)).not.toThrow()
    expect(readPending(A, s)).toEqual([entry()])
    expect(readPending(B, s)).toEqual([])
    expect(removePending(A, entry().hash, s)).toBe(true)
    expect(readPending(A, s)).toEqual([])
    expect(removePending(A, entry().hash, s)).toBe(false)
  })

  it("keeps guarding in this tab when storage reads but cannot be written (full), until a write succeeds again", () => {
    const s = memoryStorage({ [PENDING_KEY]: JSON.stringify({ [A]: [entry({ hash: "1".repeat(64) })] }) })
    const write = s.setItem
    s.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError")
    }
    addPending(entry(), s)
    expect(readPending(A, s).map((e) => e.hash[0])).toEqual(["a", "1"])
    expect(JSON.parse(s.getItem(PENDING_KEY)!)[A]).toHaveLength(1)
    expect(removePending(A, entry().hash, s)).toBe(true)
    expect(readPending(A, s).map((e) => e.hash[0])).toEqual(["1"])
    // Storage takes writes again: the next change is written to it, and it is what is read.
    s.setItem = write
    addPending(entry({ hash: "2".repeat(64) }), s)
    expect(JSON.parse(s.getItem(PENDING_KEY)!)[A].map((e: PendingTx) => e.hash[0])).toEqual(["2", "1"])
    s.setItem(PENDING_KEY, JSON.stringify({ [A]: [] }))
    expect(readPending(A, s)).toEqual([])
  })

  it("uses the browser's localStorage by default", () => {
    addPending(entry())
    expect(readPending(A)).toEqual([entry()])
    expect(localStorage.getItem(PENDING_KEY)).not.toBeNull()
    expect(removePending(A, entry().hash)).toBe(true)
    expect(readPending(A)).toEqual([])
  })

  it("tells subscribers about every change in this tab, and about another tab's", () => {
    const fn = vi.fn()
    const stop = subscribePending(fn)
    const s = memoryStorage()
    addPending(entry(), s)
    expect(fn).toHaveBeenCalledTimes(1)
    removePending(A, entry().hash, s)
    expect(fn).toHaveBeenCalledTimes(2)
    // Nothing removed, nothing to tell.
    removePending(A, entry().hash, s)
    expect(fn).toHaveBeenCalledTimes(2)
    window.dispatchEvent(new StorageEvent("storage", { key: PENDING_KEY }))
    expect(fn).toHaveBeenCalledTimes(3)
    window.dispatchEvent(new StorageEvent("storage", { key: "pp-txlog" }))
    expect(fn).toHaveBeenCalledTimes(3)
    stop()
    addPending(entry(), s)
    window.dispatchEvent(new StorageEvent("storage", { key: PENDING_KEY }))
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
