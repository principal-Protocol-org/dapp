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

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

beforeEach(() => {
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
