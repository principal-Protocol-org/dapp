import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionInput } from "@/lib/protocol/actions"
import type { SimulationOutcome } from "@/lib/protocol/stellar"
import { down, live, marketState } from "@/components/app/__tests__/fixtures"

/**
 * R4-6: one-step Buy YT's `max_net_cost` is in SY, worked out from the simulated
 * `(yt_out, underlying_back)` and the SY exchange rate. `useSimulation` reads the rate from the
 * market state and hands it to `derive` only while it is live; without it the quote is refused.
 */

const S = 10_000_000n
const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

const mocks = vi.hoisted(() => ({
  fetchMarketState: vi.fn(),
  simulateInvocation: vi.fn(),
}))

vi.mock("@/components/app/manifest-provider", () => {
  // One object, as the provider gives: hooks depend on its identity.
  const manifest = {
    network: "testnet",
    rpcUrl: "https://rpc",
    networkPassphrase: "Test SDF Network ; September 2015",
    markets: [
      {
        marketId: "m1",
        displayName: "x",
        underlying: { code: "USDY", decimals: 7 },
        contracts: { router: "CROUTER", sy: "CSY", pool: "CPOOL", manager: "CMANAGER" },
      },
    ],
  }
  return { useManifest: () => manifest }
})
vi.mock("@/lib/protocol/reader", () => ({ createRpcReader: () => ({}) }))
vi.mock("@/lib/protocol/market-state", async (orig) => ({ ...(await orig<object>()), fetchMarketState: mocks.fetchMarketState }))
vi.mock("@/lib/protocol/stellar", async (orig) => ({ ...(await orig<object>()), simulateInvocation: mocks.simulateInvocation }))

import { derive, useSimulation } from "@/hooks/use-simulation"

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

const buyYt: ActionInput = {
  action: "buy_yt_underlying",
  marketId: "m1",
  source: A,
  amount: 100n * S,
  guards: {},
  deadline: 1_700_000_300n,
}
/** swap_underlying_for_yt -> (yt_minted, underlying_back), through scValToNative. */
const simulated: SimulationOutcome = { ok: true, retval: [40n * S, 85n * S], latestLedger: 1, minResourceFee: "1" }

beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.fetchMarketState.mockReset().mockResolvedValue(marketState())
  mocks.simulateInvocation.mockReset().mockResolvedValue(simulated)
})

describe("derive (R4-6)", () => {
  it("passes the exchange rate to the floors", () => {
    const { guards } = derive(buyYt, simulated, 50n, { exchangeRate: S })
    // sy_in 100 SY, 85 SY back at least: net 15 SY · 1.005, rounded up.
    expect(guards).toEqual({ ok: true, guards: { minOut: (40n * S * 9_950n) / 10_000n, maxNetCost: 150_750_000n, syIn: 100n * S } })
  })
  it("refuses one-step Buy YT without it", () => {
    const { output, guards } = derive(buyYt, simulated, 50n)
    expect(output).toEqual({ kind: "buy_yt_underlying", yt_out: 40n * S, underlying_back: 85n * S })
    expect(guards?.ok).toBe(false)
    if (guards && !guards.ok) expect(guards.reason).toMatch(/exchange rate/)
  })
})

describe("useSimulation hands the live exchange rate to derive", () => {
  it("one-step Buy YT gets its cost bound in SY from the market's exchange rate", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: live(10_500_000n) }))
    const { result } = renderHook(() => useSimulation(buyYt), { wrapper })
    await waitFor(() => expect(result.current.guards).toBeDefined())
    // sy_in = floor(100 · 1e7 / 1.05) SY; sy_back_min = ceil(85 · 1e7 / 1.05) SY.
    const syIn = (100n * S * S) / 10_500_000n
    const syBackMin = (85n * S * S + 10_500_000n - 1n) / 10_500_000n
    const net = syIn - syBackMin
    expect(result.current.guards).toEqual({
      ok: true,
      guards: { minOut: (40n * S * 9_950n) / 10_000n, maxNetCost: (net * 10_050n + 9_999n) / 10_000n, syIn },
    })
    // Simulated with no cost bound at all.
    expect(mocks.simulateInvocation.mock.calls[0][0].invocation.functionName).toBe("swap_underlying_for_yt")
  })

  it("an unreadable exchange rate refuses the quote, with the reason", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: down() }))
    const { result } = renderHook(() => useSimulation(buyYt), { wrapper })
    await waitFor(() => expect(result.current.guards).toBeDefined())
    expect(result.current.guards?.ok).toBe(false)
    if (result.current.guards && !result.current.guards.ok) expect(result.current.guards.reason).toMatch(/exchange rate/)
  })
})
