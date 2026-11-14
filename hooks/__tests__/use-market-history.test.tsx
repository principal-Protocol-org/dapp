import { StrKey } from "@stellar/stellar-sdk"
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
    expect(result.current.data?.failed.size).toBe(0)
  })

  // 120 distinct contract ids, sorted as the hook sorts them.
  const pools = Array.from({ length: 120 }, (_, i) => StrKey.encodeContract(Buffer.alloc(32, i + 1))).sort()
  const poolsOf = (url: string) => new URL(url, "http://x").searchParams.get("pools")!.split(",")
  const spark = { points: [], changePts: 0.5, stale: false }

  it("asks for 120 pools in 3 requests of at most 50, and merges the answers (D-26 item 2)", async () => {
    const fetchMock = vi.fn(async (url: string) => Response.json({ sparks: Object.fromEntries(poolsOf(url).map((p) => [p, spark])), stale: false }))
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useSparks(pools), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const asked = fetchMock.mock.calls.map(([url]) => poolsOf(url))
    expect(asked.map((c) => c.length)).toEqual([50, 50, 20])
    expect(asked.flat()).toEqual(pools)
    expect(Object.keys(result.current.data!.sparks)).toHaveLength(120)
    expect(result.current.data!.failed.size).toBe(0)
  })

  it("a failed chunk marks only its own pools as failed", async () => {
    const second = new Set(pools.slice(50, 100))
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const asked = poolsOf(url)
        if (second.has(asked[0])) return new Response("{}", { status: 500 })
        return Response.json({ sparks: Object.fromEntries(asked.map((p) => [p, spark])), stale: false })
      }),
    )
    const { result } = renderHook(() => useSparks(pools), { wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const data = result.current.data!
    expect([...data.failed].sort()).toEqual([...second].sort())
    expect(Object.keys(data.sparks)).toHaveLength(70)
    expect(data.sparks[pools[0]]).toEqual(spark)
    expect(data.sparks[pools[60]]).toBeUndefined()
  })

  it("is an error only when every chunk failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })))
    const { result } = renderHook(() => useSparks(pools), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
