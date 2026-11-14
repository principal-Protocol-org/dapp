"use client"

import { useQuery } from "@tanstack/react-query"
import { SPARKS_CHUNK, type MarketHistory, type Range, type Spark } from "@/lib/app/history-types"

export const HISTORY_SERIES_REFETCH_MS = 60_000

export type { MarketHistory, Range, Spark }
/** The merged answer: each pool's spark, and the pools whose chunk failed (their sparks show their error state). */
export type Sparks = { sparks: Record<string, Spark>; stale: boolean; failed: Set<string> }

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

/**
 * 30-day fixed-APY sparks (and change in points) for several pools, refetched every 60 s. The route
 * takes at most `SPARKS_CHUNK` pools per request, so they are asked in chunks of that size, side by
 * side, and merged (D-26 item 2): a failed chunk marks only its own pools as failed. The query is an
 * error only when every chunk failed.
 */
export function useSparks(pools: string[]) {
  const sorted = [...new Set(pools)].sort()
  const key = sorted.join(",")
  return useQuery({
    queryKey: ["market-sparks", key],
    queryFn: async (): Promise<Sparks> => {
      const chunks: string[][] = []
      for (let i = 0; i < sorted.length; i += SPARKS_CHUNK) chunks.push(sorted.slice(i, i + SPARKS_CHUNK))
      const answers = await Promise.allSettled(chunks.map((chunk) => getJson<Omit<Sparks, "failed">>(`/api/markets/sparks?pools=${chunk.join(",")}`)))
      const merged: Sparks = { sparks: {}, stale: false, failed: new Set() }
      answers.forEach((answer, i) => {
        if (answer.status === "rejected") {
          for (const pool of chunks[i]) merged.failed.add(pool)
          return
        }
        Object.assign(merged.sparks, answer.value.sparks)
        merged.stale ||= answer.value.stale
      })
      if (answers.every((a) => a.status === "rejected")) throw (answers[0] as PromiseRejectedResult).reason
      return merged
    },
    enabled: sorted.length > 0,
    refetchInterval: HISTORY_SERIES_REFETCH_MS,
  })
}
