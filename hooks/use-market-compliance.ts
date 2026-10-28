"use client"

import { useQuery } from "@tanstack/react-query"
import { fetchMarketCompliance } from "@/lib/protocol/compliance"
import { createHorizon } from "@/lib/protocol/horizon"
import { getMarket } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { createRpcReader } from "@/lib/protocol/reader"

const REFETCH_MS = 60_000

/** The market's compliance model (SAC flags or SEP-57), read from the chain and Horizon. */
export function useMarketCompliance(marketId: string) {
  const m = activeManifest()
  return useQuery({
    queryKey: ["compliance", m.network, marketId],
    queryFn: () => {
      const market = getMarket(m, marketId)
      if (!market) throw new Error(`Unknown market "${marketId}"`)
      return fetchMarketCompliance(createHorizon(m.horizonUrl), createRpcReader(m), market)
    },
    refetchInterval: REFETCH_MS,
  })
}
