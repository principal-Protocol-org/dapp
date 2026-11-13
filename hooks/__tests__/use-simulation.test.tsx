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

import { derive, simulate, useSimulation } from "@/hooks/use-simulation"
import { useManifest } from "@/components/app/manifest-provider"
import { openGuards } from "@/lib/protocol/guards"
import type { Manifest } from "@/lib/protocol/types"

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

const buyYt: ActionInput = {
  action: "buy_yt_flash_underlying",
  marketId: "m1",
  source: A,
  amount: 100n * S,
  // `sy_in`, the SY the budget deposits (R5-2).
  secondaryAmount: 90n * S,
  guards: {},
  deadline: 1_700_000_300n,
}
/** flash_mint_yt_from_underlying -> (yt_out, net_cost, underlying_back), through scValToNative. */
const simulated: SimulationOutcome = { ok: true, retval: [40n * S, 15n * S, 85n * S], latestLedger: 1, minResourceFee: "1" }

beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.fetchMarketState.mockReset().mockResolvedValue(marketState())
  mocks.simulateInvocation.mockReset().mockResolvedValue(simulated)
})

describe("simulate: a rejection becomes an rpc_error the user can read", () => {
  const manifest = useManifest() as unknown as Manifest
  // Open guards, as the hook simulates it (the flash's budget in SY at the exchange rate, R5-3).
  const input: ActionInput = { ...buyYt, guards: openGuards(buyYt.action, buyYt.amount, { exchangeRate: S }) }
  it("an overloaded RPC (the SDK's plain -32004 object) reads as the busy message, never [object Object]", async () => {
    mocks.simulateInvocation.mockRejectedValueOnce({ code: -32004, message: "preflight queue full; retry later" })
    expect(await simulate(manifest, input)).toEqual({ ok: false, kind: "rpc_error", message: "The Stellar network is busy. Try again in a moment." })
  })
  it("a plain Error keeps its message", async () => {
    mocks.simulateInvocation.mockRejectedValueOnce(new Error("boom"))
    expect(await simulate(manifest, input)).toEqual({ ok: false, kind: "rpc_error", message: "boom" })
  })
})

describe("derive (R5-3)", () => {
  it("passes the exchange rate to the floors", () => {
    const { guards } = derive(buyYt, simulated, 50n, { exchangeRate: S })
    // budget 100 SY; net cost 15 SY · 1.005; the rest, 84.925 SY, unwraps to the same USDY.
    expect(guards).toEqual({ ok: true, guards: { minOut: (40n * S * 9_950n) / 10_000n, maxNetCost: 150_750_000n, minOut2: 849_250_000n } })
  })
  it("refuses the USDY flash without it", () => {
    const { output, guards } = derive(buyYt, simulated, 50n)
    expect(output).toEqual({ kind: "flash_yt_underlying", yt_out: 40n * S, net_cost: 15n * S, underlying_back: 85n * S })
    expect(guards?.ok).toBe(false)
    if (guards && !guards.ok) expect(guards.reason).toMatch(/exchange rate/)
  })
})

describe("useSimulation hands the live exchange rate to the open guards and to derive", () => {
  it("the USDY flash is simulated with its budget in SY as the cost bound, and its floors follow from the exchange rate", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: live(10_500_000n) }))
    const { result } = renderHook(() => useSimulation(buyYt), { wrapper })
    await waitFor(() => expect(result.current.guards).toBeDefined())
    // budget = floor(100 · 1e7 / 1.05) SY; max_net_cost = ceil(15 SY · 1.005), well inside it.
    const budget = (100n * S * S) / 10_500_000n
    const maxNetCost = (15n * S * 10_050n + 9_999n) / 10_000n
    expect(result.current.guards).toEqual({
      ok: true,
      guards: { minOut: (40n * S * 9_950n) / 10_000n, maxNetCost, minOut2: ((budget - maxNetCost) * 10_500_000n) / S },
    })
    // Simulated with the whole budget as max_net_cost and no floor on the rest.
    const call = mocks.simulateInvocation.mock.calls[0][0].invocation
    expect(call.functionName).toBe("flash_mint_yt_from_underlying")
    expect(call.args.map((a: { value: unknown }) => a.value)).toContain(budget)
  })

  it("without the exchange rate the USDY flash is not simulated: it waits, and is never reported as a failed simulation", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: down() }))
    const { result } = renderHook(() => useSimulation(buyYt), { wrapper })
    await waitFor(() => expect(mocks.fetchMarketState).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(result.current.outcome).toBeUndefined()
    expect(result.current.guards).toBeUndefined()
    expect(result.current.simulated).toBeUndefined()
    expect(result.current.pending).toBe(true)
    expect(mocks.simulateInvocation).not.toHaveBeenCalled()
  })

  it("once the rate loads it simulates at once, with that rate: no refusal is kept from before (the rate is in the key)", async () => {
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: down() }))
    const { result } = renderHook(() => useSimulation(buyYt), { wrapper })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(result.current.outcome).toBeUndefined()
    mocks.fetchMarketState.mockResolvedValue(marketState({ exchangeRate: live(10_500_000n) }))
    await client.refetchQueries({ queryKey: ["market"] })
    await waitFor(() => expect(result.current.guards).toBeDefined())
    expect(result.current.outcome).toMatchObject({ ok: true })
    const budget = (100n * S * S) / 10_500_000n
    // Simulated with the budget at the rate that loaded, and the floors from that same rate.
    expect(result.current.simulated?.guards).toEqual({ minOut: 0n, maxNetCost: budget, minOut2: 0n })
    const maxNetCost = (15n * S * 10_050n + 9_999n) / 10_000n
    expect(result.current.guards).toEqual({ ok: true, guards: { minOut: (40n * S * 9_950n) / 10_000n, maxNetCost, minOut2: ((budget - maxNetCost) * 10_500_000n) / S } })
  })
})
