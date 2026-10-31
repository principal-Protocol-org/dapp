"use client"

import { useQuery } from "@tanstack/react-query"
import type { MarketHistory, Range, Spark } from "@/lib/server/history"

export const HISTORY_SERIES_REFETCH_MS = 60_000

// Types only: `lib/server/history` is never bundled into the browser (type imports are erased).
export type { MarketHistory, Range, Spark }
export type Sparks = { sparks: Record<string, Spark>; stale: boolean }

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return (await res.json()) as T
}

/** Fixed APY, 7-day underlying APY and liquidity series of one market, refetched every 60 s. */
export function useMarketHistory(pool: string, range: Range) {
  return useQuery({
    queryKey: ["market-history", pool, range],
    queryFn: () => getJson<MarketHistory>(`/api/markets/${pool}/history?range=${range}`),
    refetchInterval: HISTORY_SERIES_REFETCH_MS,
  })
}

/** 30-day fixed-APY sparks (and change in points) for several pools, refetched every 60 s. */
export function useSparks(pools: string[]) {
  const key = [...pools].sort().join(",")
  return useQuery({
    queryKey: ["market-sparks", key],
    queryFn: () => getJson<Sparks>(`/api/markets/sparks?pools=${key}`),
    enabled: pools.length > 0,
    refetchInterval: HISTORY_SERIES_REFETCH_MS,
  })
}
