"use client"

import { useQueries, useQuery } from "@tanstack/react-query"
import { useManifest } from "@/components/app/manifest-provider"
import { fetchMarketState } from "@/lib/protocol/market-state"
import { createRpcReader } from "@/lib/protocol/reader"
import type { Manifest } from "@/lib/protocol/types"

export const MARKET_REFETCH_MS = 6000
/** The market list and the manage list: every market's figures at once, so less often than one market's page (spec 0005 M-20). */
export const MARKET_LIST_REFETCH_MS = 30_000

function marketQuery(m: Manifest, marketId: string, refetchMs = MARKET_REFETCH_MS) {
  return {
    queryKey: ["market", m.network, marketId],
    queryFn: () => fetchMarketState(createRpcReader(m), m, marketId),
    refetchInterval: refetchMs,
  }
}

/**
 * Several markets at once (the list needs every market's figures for its asset rows), refetched
 * every `refetchMs`: the lists pass `MARKET_LIST_REFETCH_MS`. Same query keys as `useMarketState`,
 * so the market page reuses what the list fetched, and keeps its own 6 s.
 */
export function useMarketStates(marketIds: string[], refetchMs = MARKET_REFETCH_MS) {
  const m = useManifest()
  return useQueries({
    queries: marketIds.map((id) => marketQuery(m, id, refetchMs)),
    combine: (results) => results.map((q) => ({ data: q.data, isPending: q.isPending, stale: q.isError })),
  })
}

/**
 * Every on-chain value of one market, each as a `Live`. Refetched every 6 s. `null` reads nothing
 * (a simulation with no input yet), under the same hook call.
 */
export function useMarketState(marketId: string | null) {
  const m = useManifest()
  const query = useQuery({ ...marketQuery(m, marketId ?? ""), enabled: marketId !== null })
  // A failed refetch keeps the old `data`; `stale` tells callers not to show it as current (R35).
  return { ...query, stale: query.isError }
}
