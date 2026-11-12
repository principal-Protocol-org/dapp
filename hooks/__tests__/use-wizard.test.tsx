import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { StrKey } from "@stellar/stellar-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"

const contractAt = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
const salt = (fill: string) => fill.repeat(32)
const PUBLISHED = salt("a1")
const HALFWAY = salt("a2")
const NOTHING = salt("a3")

const mocks = vi.hoisted(() => ({ progress: {} as Record<string, unknown>, calls: [] as string[], listedPool: "" }))

vi.mock("@/components/app/manifest-provider", () => {
  // One object, as the provider gives: hooks depend on its identity.
  const manifest = {
    network: "testnet",
    rpcUrl: "http://rpc",
    markets: [
      {
        get contracts() {
          return { pool: mocks.listedPool }
        },
      },
    ],
  }
  return { useManifest: () => manifest }
})
vi.mock("@/lib/protocol/reader", () => ({ createRpcReader: () => ({}) }))
vi.mock("@/lib/protocol/stellar", () => ({ createRpcServer: () => ({}) }))
vi.mock("@/lib/protocol/market-progress", () => ({
  marketProgress: async (_reader: unknown, _rpc: unknown, _manifest: unknown, s: string) => {
    mocks.calls.push(s)
    return mocks.progress[s]
  },
}))

import { useMarketsInProgress } from "@/hooks/use-wizard"
import { readWizardSalts } from "@/lib/app/wizard-salts"

const LISTED_POOL = contractAt(50)
mocks.listedPool = LISTED_POOL

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  localStorage.clear()
  mocks.calls = []
  mocks.progress = {
    [PUBLISHED]: { step: 7, predicted: { pool: LISTED_POOL } },
    [HALFWAY]: { step: 4, predicted: { pool: contractAt(51) } },
    [NOTHING]: { step: 1, predicted: { pool: contractAt(52) } },
  }
  localStorage.setItem("pp-wizard-salts:testnet", JSON.stringify([PUBLISHED, HALFWAY, NOTHING]))
})

describe("useMarketsInProgress (the manager view's Resume list)", () => {
  it("drops a salt whose pool is listed (published) or that has nothing on chain, and keeps the half-finished one", async () => {
    const { result } = renderHook(() => useMarketsInProgress(), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY]))
    expect(readWizardSalts("testnet")).toEqual([HALFWAY])
  })

  it("reads each progress once, on mount: no polling of the list", async () => {
    const { result } = renderHook(() => useMarketsInProgress(), { wrapper })
    await waitFor(() => expect(result.current.map((m) => m.salt)).toEqual([HALFWAY]))
    const query = client.getQueryCache().find({ queryKey: ["manage", "testnet", "wizard-progress", HALFWAY] })
    expect(query).toBeDefined()
    for (const observer of query!.observers) expect((observer.options as { refetchInterval?: unknown }).refetchInterval).toBeFalsy()
  })
})
