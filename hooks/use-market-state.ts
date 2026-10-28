"use client"

import { useQuery } from "@tanstack/react-query"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { fetchMarketState } from "@/lib/protocol/market-state"
import { createRpcReader } from "@/lib/protocol/reader"

export const MARKET_REFETCH_MS = 6000

/** Every on-chain value of one market, each as a `Live`. Refetched every 6 s. */
export function useMarketState(marketId: string) {
  const m = activeManifest()
  const query = useQuery({
    queryKey: ["market", m.network, marketId],
    queryFn: () => fetchMarketState(createRpcReader(m), m, marketId),
    refetchInterval: MARKET_REFETCH_MS,
  })
  // A failed refetch keeps the old `data`; `stale` tells callers not to show it as current (R35).
  return { ...query, stale: query.isError }
}
