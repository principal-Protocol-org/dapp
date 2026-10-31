import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useMarketHistory, useSparks } from "@/hooks/use-market-history"

const POOL = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

afterEach(() => vi.unstubAllGlobals())

describe("useMarketHistory", () => {
  it("fetches the history for the pool and range", async () => {
    const body = { fixedApy: [{ at: 1, value: 0.05 }], underlyingApy7d: [], liquidity: [], latestAt: 1, stale: false }
    const fetchMock = vi.fn(async () => Response.json(body))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useMarketHistory(POOL, "30d"), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual(body))
    expect(fetchMock).toHaveBeenCalledWith(`/api/markets/${POOL}/history?range=30d`)
  })

  it("is an error, not data, when the route fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })))
    const { result } = renderHook(() => useMarketHistory(POOL, "7d"), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})

describe("useSparks", () => {
  it("fetches sparks for the pools and stays idle with none", async () => {
    const fetchMock = vi.fn(async () => Response.json({ sparks: { [POOL]: { points: [], changePts: null } }, stale: false }))
    vi.stubGlobal("fetch", fetchMock)
    const idle = renderHook(() => useSparks([]), { wrapper })
    expect(idle.result.current.fetchStatus).toBe("idle")
    const { result } = renderHook(() => useSparks([POOL]), { wrapper })
    await waitFor(() => expect(result.current.data?.sparks[POOL].changePts).toBeNull())
    expect(fetchMock).toHaveBeenCalledWith(`/api/markets/sparks?pools=${POOL}`)
  })
})
