"use client"

import { useQueries, useQuery } from "@tanstack/react-query"
import { useManifest } from "@/components/app/manifest-provider"
import { fetchMarketState } from "@/lib/protocol/market-state"
import { createRpcReader } from "@/lib/protocol/reader"
import type { Manifest } from "@/lib/protocol/types"

export const MARKET_REFETCH_MS = 6000

function marketQuery(m: Manifest, marketId: string) {
  return {
    queryKey: ["market", m.network, marketId],
    queryFn: () => fetchMarketState(createRpcReader(m), m, marketId),
    refetchInterval: MARKET_REFETCH_MS,
  }
}

/**
 * Several markets at once (the list needs every market's figures for its asset rows). Same query
 * keys as `useMarketState`, so the market page reuses what the list fetched.
 */
export function useMarketStates(marketIds: string[]) {
  const m = useManifest()
  return useQueries({
    queries: marketIds.map((id) => marketQuery(m, id)),
    combine: (results) => results.map((q) => ({ data: q.data, isPending: q.isPending, stale: q.isError })),
  })
}

/** Every on-chain value of one market, each as a `Live`. Refetched every 6 s. */
export function useMarketState(marketId: string) {
  const m = useManifest()
  const query = useQuery(marketQuery(m, marketId))
  // A failed refetch keeps the old `data`; `stale` tells callers not to show it as current (R35).
  return { ...query, stale: query.isError }
}
