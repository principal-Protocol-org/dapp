import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyReview, RestoreReview } from "@/lib/protocol/review"

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  forgetInFlight: vi.fn(),
  executeReview: vi.fn(),
  executeRestore: vi.fn(),
}))

vi.mock("@/components/app/manifest-provider", () => {
  const manifest = { network: "testnet" }
  return { useManifest: () => manifest }
})
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ sign: vi.fn() }) }))
vi.mock("@/lib/app/local-log", () => ({ appendLog: vi.fn() }))
vi.mock("@/lib/protocol/review", async (orig) => ({
  ...(await orig<object>()),
  executeReview: mocks.executeReview,
  executeRestore: mocks.executeRestore,
}))
vi.mock("@/lib/protocol/rpc-limiter", async (orig) => ({ ...(await orig<object>()), forgetInFlight: mocks.forgetInFlight }))

import { useExecute } from "@/hooks/use-execute"
import { readPending } from "@/lib/app/pending-tx"

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.order = []
  mocks.forgetInFlight.mockReset().mockImplementation(() => mocks.order.push("forget"))
  vi.spyOn(client, "invalidateQueries").mockImplementation(async (filters) => {
    mocks.order.push(`invalidate:${String((filters as { queryKey?: unknown[] })?.queryKey?.[0])}`)
  })
  mocks.executeReview.mockReset().mockResolvedValue({ hash: "abc", status: "SUCCESS" })
  mocks.executeRestore.mockReset().mockResolvedValue({ hash: "def", status: "SUCCESS" })
})

// A landed write ends read sharing first: the refresh must not join a read sent before the write.
describe("useExecute's refresh after a transaction", () => {
  it("ends read sharing before it invalidates the market, account and manage reads", async () => {
    const { result } = renderHook(() => useExecute(), { wrapper })
    await act(() => result.current.execute({ origin: { type: "manager" } } as unknown as AnyReview))
    expect(mocks.order).toEqual(["forget", "invalidate:market", "invalidate:account", "invalidate:manage"])
  })

  it("does the same after a restore", async () => {
    const { result } = renderHook(() => useExecute(), { wrapper })
    await act(() => result.current.executeRestore({} as RestoreReview))
    expect(mocks.order).toEqual(["forget", "invalidate:market", "invalidate:account", "invalidate:manage"])
  })
})

// M-21: an action whose result is not known yet is kept, so its panel refuses a second send until it settles.
describe("useExecute's pending entry", () => {
  const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  const PREPARED_MS = 1_700_000_000_500
  const action = {
    origin: { type: "action", input: { action: "buy_pt", marketId: "m1", source: A } },
    summary: { validUntil: 1_700_000_300 },
    preparedAtMs: PREPARED_MS,
  } as unknown as AnyReview

  it("adds one when an action's result is NOT_FOUND, with the time bound and send time executeReview reports", async () => {
    mocks.executeReview.mockResolvedValue({ hash: "abc", status: "NOT_FOUND", validUntil: 1_700_000_400, sentAt: 1_699_999_990 })
    const { result } = renderHook(() => useExecute(), { wrapper })
    await act(() => result.current.execute(action))
    expect(readPending(A)).toEqual([{ hash: "abc", action: "buy_pt", marketId: "m1", account: A, validUntil: 1_700_000_400, sentAt: 1_699_999_990 }])
  })

  it("still arms the guard from the review signed when the result carries no time bound", async () => {
    mocks.executeReview.mockResolvedValue({ hash: "abc", status: "NOT_FOUND" })
    const { result } = renderHook(() => useExecute(), { wrapper })
    await act(() => result.current.execute(action))
    expect(readPending(A)).toEqual([{ hash: "abc", action: "buy_pt", marketId: "m1", account: A, validUntil: 1_700_000_300, sentAt: 1_700_000_000 }])
  })

  it("adds none for a confirmed or failed action, nor for a manager call", async () => {
    const { result } = renderHook(() => useExecute(), { wrapper })
    for (const status of ["SUCCESS", "FAILED"]) {
      mocks.executeReview.mockResolvedValue({ hash: "abc", status })
      await act(() => result.current.execute(action))
    }
    mocks.executeReview.mockResolvedValue({ hash: "abc", status: "NOT_FOUND", validUntil: 1, sentAt: 1 })
    await act(() => result.current.execute({ origin: { type: "manager" } } as unknown as AnyReview))
    expect(readPending(A)).toEqual([])
  })
})
