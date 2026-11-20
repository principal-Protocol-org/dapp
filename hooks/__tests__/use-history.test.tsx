import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  account: "GDDKLGGW5HG76QBESUX4JHFVYA3765HJGVUDXFGQLAJYJ4CQDPHW7ZHQ",
  load: { inFlight: 0, peak: 0, requests: 0 },
}))

vi.mock("@/components/app/manifest-provider", async () => {
  const { default: json } = await import("@/lib/protocol/__tests__/fixtures/testnet-interim.json")
  const { parseManifest: parse } = await import("@/lib/protocol/manifest")
  const base = parse(json)
  // Mainnet's shape: five markets, so ten contract groups at once.
  const manifest = { ...base, markets: [1, 2, 3, 4, 5].map((n) => ({ ...base.markets[0], marketId: `m${n}` })) }
  return { useManifest: () => manifest }
})
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: { status: "connected", publicKey: mocks.account } }) }))
vi.mock("@/lib/protocol/stellar", async (orig) => ({
  ...(await orig<object>()),
  createRpcServer: () => ({
    getHealth: async () => ({ oldestLedger: 100, latestLedger: 500 }),
    // One page per group: an empty page whose cursor is past the window's end.
    async getEvents(req: { endLedger?: number }) {
      mocks.load.requests++
      mocks.load.inFlight++
      mocks.load.peak = Math.max(mocks.load.peak, mocks.load.inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      mocks.load.inFlight--
      return { events: [], cursor: `${(BigInt(req.endLedger ?? 501) << 32n).toString().padStart(19, "0")}-0000000000` }
    },
  }),
}))

import { useHistory } from "@/hooks/use-history"
import { RPC_CONCURRENCY } from "@/lib/protocol/rpc-limiter"

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.load = { inFlight: 0, peak: 0, requests: 0 }
})

describe("useHistory's event reads", () => {
  it("never has more than six getEvents in flight across five markets' ten contract groups", async () => {
    const { result } = renderHook(() => useHistory(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(mocks.load.requests).toBe(10)
    expect(mocks.load.peak).toBeLessThanOrEqual(RPC_CONCURRENCY)
    expect(mocks.load.peak).toBe(RPC_CONCURRENCY)
  })
})
