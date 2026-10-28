import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { down, live, marketState, accountState } from "./fixtures"

const mocks = vi.hoisted(() => ({
  wallet: { status: "disconnected" } as { status: string; publicKey?: string },
  fetchMarketState: vi.fn(),
  fetchAccountState: vi.fn(),
  fetchMarketCompliance: vi.fn(),
}))

vi.mock("@/lib/protocol/manifest-source", () => ({
  activeManifest: () => ({
    network: "testnet",
    horizonUrl: "https://h",
    markets: [{ marketId: "m1", displayName: "x", underlying: { code: "STA", decimals: 7 } }],
  }),
}))
vi.mock("@/lib/protocol/reader", () => ({ createRpcReader: () => ({}) }))
vi.mock("@/lib/protocol/horizon", () => ({ createHorizon: () => ({}) }))
vi.mock("@/lib/protocol/market-state", () => ({ fetchMarketState: mocks.fetchMarketState }))
vi.mock("@/lib/protocol/account-state", () => ({ fetchAccountState: mocks.fetchAccountState }))
vi.mock("@/lib/protocol/compliance", () => ({ fetchMarketCompliance: mocks.fetchMarketCompliance }))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))

import { useAccountState } from "@/hooks/use-account-state"
import { useMarketState } from "@/hooks/use-market-state"

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
)

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.wallet = { status: "disconnected" }
  mocks.fetchMarketState.mockReset().mockResolvedValue(marketState())
  mocks.fetchAccountState.mockReset().mockResolvedValue(accountState())
  mocks.fetchMarketCompliance.mockReset().mockResolvedValue(
    live({ kind: "sac", authRequired: true, authRevocable: true, clawbackEnabled: false, administrator: "G" }),
  )
})

describe("useMarketState", () => {
  it("uses the documented key and polls every 6 s", async () => {
    const { result } = renderHook(() => useMarketState("m1"), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    const query = client.getQueryCache().find({ queryKey: ["market", "testnet", "m1"] })
    expect(query).toBeDefined()
    expect((query!.observers[0].options as { refetchInterval?: number }).refetchInterval).toBe(6000)
    expect(result.current.stale).toBe(false)
  })

  it("is stale, with the old data kept, after a failed refetch", async () => {
    const { result } = renderHook(() => useMarketState("m1"), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    mocks.fetchMarketState.mockRejectedValue(new Error("429"))
    await result.current.refetch()
    await waitFor(() => expect(result.current.stale).toBe(true))
    expect(result.current.data).toBeDefined()
  })
})

describe("useAccountState", () => {
  it("does not fetch while the wallet is disconnected", async () => {
    const { result } = renderHook(() => useAccountState("m1"), { wrapper })
    await waitFor(() => expect(mocks.fetchMarketCompliance).toHaveBeenCalled())
    expect(result.current.fetchStatus).toBe("idle")
    expect(mocks.fetchAccountState).not.toHaveBeenCalled()
  })

  it("keys by network, market and address and passes the compliance kind", async () => {
    mocks.wallet = { status: "connected", publicKey: "GABC" }
    const { result } = renderHook(() => useAccountState("m1"), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.fetchAccountState.mock.calls[0].slice(3)).toEqual(["m1", "GABC", "sac"])
    expect(client.getQueryCache().find({ queryKey: ["account", "testnet", "m1", "GABC", "sac"] })).toBeDefined()
  })

  it("passes kind null when the compliance read is unavailable", async () => {
    mocks.wallet = { status: "connected", publicKey: "GABC" }
    mocks.fetchMarketCompliance.mockResolvedValue(down("horizon 503"))
    const { result } = renderHook(() => useAccountState("m1"), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.fetchAccountState.mock.calls[0][5]).toBeNull()
  })
})
