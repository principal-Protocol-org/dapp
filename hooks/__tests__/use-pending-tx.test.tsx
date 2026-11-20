import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Lookup } from "@/lib/protocol/tx-lookup"

/**
 * A single action whose result was not known when it was sent stays pending (spec 0005 M-21): the
 * hook checks it by its hash every 5 s until it settles or its time bound passes. The lookup is a
 * fake; the pending store and the local log are jsdom's localStorage.
 */

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  lookupTransaction: vi.fn(),
  forgetInFlight: vi.fn(),
}))

vi.mock("@/components/app/manifest-provider", () => {
  // One object, as the provider gives: hooks depend on its identity.
  const manifest = { network: "testnet", rpcUrl: "https://rpc" }
  return { useManifest: () => manifest }
})
vi.mock("@/lib/protocol/tx-lookup", async (orig) => ({ ...(await orig<object>()), lookupTransaction: mocks.lookupTransaction }))
vi.mock("@/lib/protocol/rpc-limiter", async (orig) => ({ ...(await orig<object>()), forgetInFlight: mocks.forgetInFlight }))

import { PENDING_RECHECK_MS, usePendingTx, type PendingSettled } from "@/hooks/use-pending-tx"
import { appendLog, readLog } from "@/lib/app/local-log"
import { addPending, PENDING_KEY, readPending, removePending, type PendingTx } from "@/lib/app/pending-tx"

const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const HASH = "ab".repeat(32)
const SENT = 1_700_000_000
const SENT_MS = 1_700_000_123_000

const entry = (over: Partial<PendingTx> = {}): PendingTx => ({
  hash: HASH,
  action: "buy_pt",
  marketId: "m1",
  account: A,
  validUntil: SENT + 300,
  sentAt: SENT,
  ...over,
})
const PENDING: Lookup = { status: "NOT_FOUND", final: false, lost: false }

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

function setup(account: string | null = A, marketId = "m1", action: PendingTx["action"] = "buy_pt") {
  const onSettled = vi.fn<(s: PendingSettled) => void>()
  const hook = renderHook(() => usePendingTx(account, marketId, action, onSettled), { wrapper })
  return { ...hook, onSettled }
}

/** Advances the fake clock by `ms`, then lets the lookup's promise and React settle. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.order = []
  mocks.forgetInFlight.mockReset().mockImplementation(() => mocks.order.push("forget"))
  vi.spyOn(client, "invalidateQueries").mockImplementation(async (filters) => {
    mocks.order.push(`invalidate:${String((filters as { queryKey?: unknown[] })?.queryKey?.[0])}:${String((filters as { queryKey?: unknown[] })?.queryKey?.[1])}`)
  })
  mocks.lookupTransaction.mockReset().mockResolvedValue(PENDING)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("usePendingTx", () => {
  it("is null, and looks nothing up, without an entry for this account, market and action", async () => {
    addPending(entry({ hash: "1".repeat(64), marketId: "m2" }))
    addPending(entry({ hash: "2".repeat(64), action: "sell_pt" }))
    addPending(entry({ hash: "3".repeat(64), account: B }))
    const { result } = setup()
    await settle(PENDING_RECHECK_MS * 2)
    expect(result.current).toBeNull()
    expect(mocks.lookupTransaction).not.toHaveBeenCalled()
    const none = setup(null)
    await settle()
    expect(none.result.current).toBeNull()
  })

  it("returns the entry and checks it at once, then every 5 s while it is pending", async () => {
    addPending(entry())
    const { result } = setup()
    await settle()
    expect(result.current).toEqual(entry())
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(1)
    expect(mocks.lookupTransaction).toHaveBeenCalledWith({ network: "testnet", rpcUrl: "https://rpc" }, entry())
    await settle(PENDING_RECHECK_MS - 1)
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(1)
    await settle(1)
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(2)
    await settle(PENDING_RECHECK_MS)
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(3)
    expect(result.current).toEqual(entry())
    expect(readPending(A)).toEqual([entry()])
  })

  it("shows an entry added after mount: the one this panel just sent", async () => {
    const { result } = setup()
    await settle()
    expect(result.current).toBeNull()
    act(() => addPending(entry()))
    await settle()
    expect(result.current).toEqual(entry())
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(1)
  })

  it("never runs two lookups at once: the next check waits for the slow one", async () => {
    let answer: (l: Lookup) => void = () => {}
    mocks.lookupTransaction.mockImplementation(() => new Promise<Lookup>((resolve) => (answer = resolve)))
    addPending(entry())
    setup()
    await settle(PENDING_RECHECK_MS * 3)
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(1)
    await act(async () => answer(PENDING))
    await settle(PENDING_RECHECK_MS)
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(2)
  })

  it("SUCCESS: removes the entry, marks the logged action confirmed, and refreshes the reads after ending read sharing", async () => {
    appendLog({ hash: HASH, action: "buy_pt", marketId: "m1", account: A, at: SENT_MS, status: "NOT_FOUND" })
    addPending(entry())
    const { result, onSettled } = setup()
    await settle()
    expect(result.current).toEqual(entry())
    const found: Lookup = { status: "SUCCESS", returnValue: 95n }
    mocks.lookupTransaction.mockResolvedValue(found)
    await settle(PENDING_RECHECK_MS)
    expect(result.current).toBeNull()
    expect(readPending(A)).toEqual([])
    // The same log entry, now confirmed: its submission time is kept, no second entry is added.
    expect(readLog(A)).toEqual([{ hash: HASH, action: "buy_pt", marketId: "m1", account: A, at: SENT_MS, status: "SUCCESS" }])
    // A landed write ends read sharing first (Task 14), then the market and account reads refresh.
    expect(mocks.order).toEqual(["forget", "invalidate:market:testnet", "invalidate:account:testnet"])
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith({ tx: entry(), lookup: found })
    // Settled: never looked up again.
    await settle(PENDING_RECHECK_MS * 2)
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(2)
  })

  it("FAILED: removes the entry, logs the cause, and refreshes the reads after ending read sharing", async () => {
    appendLog({ hash: HASH, action: "buy_pt", marketId: "m1", account: A, at: SENT_MS, status: "NOT_FOUND" })
    addPending(entry())
    const reason = "Cause: the contract call failed. Nothing was taken except the network fee."
    mocks.lookupTransaction.mockResolvedValue({ status: "FAILED", reason })
    const { result, onSettled } = setup()
    await settle()
    expect(result.current).toBeNull()
    expect(readLog(A)).toEqual([{ hash: HASH, action: "buy_pt", marketId: "m1", account: A, at: SENT_MS, status: "FAILED", reason }])
    expect(mocks.order).toEqual(["forget", "invalidate:market:testnet", "invalidate:account:testnet"])
    expect(onSettled).toHaveBeenCalledWith({ tx: entry(), lookup: { status: "FAILED", reason } })
  })

  it("logs a settled action again when its log entry is gone", async () => {
    addPending(entry())
    mocks.lookupTransaction.mockResolvedValue({ status: "SUCCESS" })
    setup()
    await settle()
    expect(readLog(A)).toEqual([{ hash: HASH, action: "buy_pt", marketId: "m1", account: A, at: SENT * 1000, status: "SUCCESS" }])
  })

  it("a final NOT_FOUND removes the entry and leaves the log and the reads alone", async () => {
    appendLog({ hash: HASH, action: "buy_pt", marketId: "m1", account: A, at: SENT_MS, status: "NOT_FOUND" })
    addPending(entry())
    const found: Lookup = { status: "NOT_FOUND", final: true, lost: false }
    mocks.lookupTransaction.mockResolvedValue(found)
    const { result, onSettled } = setup()
    await settle()
    expect(result.current).toBeNull()
    expect(readPending(A)).toEqual([])
    expect(readLog(A)[0].status).toBe("NOT_FOUND")
    expect(mocks.order).toEqual([])
    expect(onSettled).toHaveBeenCalledWith({ tx: entry(), lookup: found })
  })

  it("a lost NOT_FOUND removes the entry too: its time bound has passed, so it can no longer land", async () => {
    addPending(entry())
    const found: Lookup = { status: "NOT_FOUND", final: false, lost: true }
    mocks.lookupTransaction.mockResolvedValue(found)
    const { result, onSettled } = setup()
    await settle()
    expect(result.current).toBeNull()
    expect(readPending(A)).toEqual([])
    expect(mocks.order).toEqual([])
    expect(onSettled).toHaveBeenCalledWith({ tx: entry(), lookup: found })
  })

  it("a lookup that fails keeps the entry and checks again in 5 s", async () => {
    addPending(entry())
    mocks.lookupTransaction.mockRejectedValueOnce(new Error("socket hang up"))
    const { result, onSettled } = setup()
    await settle()
    expect(result.current).toEqual(entry())
    await settle(PENDING_RECHECK_MS)
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(2)
    expect(result.current).toEqual(entry())
    expect(onSettled).not.toHaveBeenCalled()
  })

  it("two panels on one entry settle it once: one toast, one refresh", async () => {
    addPending(entry())
    const first = setup()
    const second = setup()
    await settle()
    mocks.lookupTransaction.mockResolvedValue({ status: "SUCCESS" })
    await settle(PENDING_RECHECK_MS)
    expect(first.result.current).toBeNull()
    expect(second.result.current).toBeNull()
    expect(first.onSettled.mock.calls.length + second.onSettled.mock.calls.length).toBe(1)
    expect(mocks.order).toEqual(["forget", "invalidate:market:testnet", "invalidate:account:testnet"])
  })

  it("an entry settled in another tab is dropped here, without a second toast", async () => {
    addPending(entry())
    const { result, onSettled } = setup()
    await settle()
    expect(result.current).toEqual(entry())
    // Another tab removes it: this tab hears of it through the storage event.
    const raw = JSON.stringify({ [A]: [] })
    act(() => {
      localStorage.setItem(PENDING_KEY, raw)
      window.dispatchEvent(new StorageEvent("storage", { key: PENDING_KEY }))
    })
    await settle(PENDING_RECHECK_MS)
    expect(result.current).toBeNull()
    expect(onSettled).not.toHaveBeenCalled()
    expect(mocks.lookupTransaction).toHaveBeenCalledTimes(1)
  })

  it("an answer that arrives after the entry was settled elsewhere does nothing", async () => {
    let answer: (l: Lookup) => void = () => {}
    mocks.lookupTransaction.mockImplementation(() => new Promise<Lookup>((resolve) => (answer = resolve)))
    addPending(entry())
    const { onSettled } = setup()
    await settle()
    // Removed from the store while this look was in flight (as another panel's settle does).
    act(() => void removePending(A, HASH))
    await act(async () => answer({ status: "SUCCESS" }))
    await settle()
    expect(onSettled).not.toHaveBeenCalled()
    expect(mocks.order).toEqual([])
  })
})
