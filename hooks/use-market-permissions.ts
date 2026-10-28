"use client"

import { useQuery } from "@tanstack/react-query"
import { MARKET_REFETCH_MS } from "@/hooks/use-market-state"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { fetchMarketPermissions } from "@/lib/protocol/onboarding"
import { createRpcReader } from "@/lib/protocol/reader"

/**
 * The connected account's PT and YT permissions on every market (R44): onboarding is done only when
 * all of them are granted. Keyed under `account`, so refreshing the account reads refreshes these.
 */
export function useMarketPermissions(address: string | null) {
  const m = activeManifest()
  const query = useQuery({
    queryKey: ["account", m.network, "permissions", address],
    queryFn: () => fetchMarketPermissions(createRpcReader(m), m, address as string),
    enabled: address !== null,
    refetchInterval: MARKET_REFETCH_MS,
  })
  // A failed refetch keeps the old `data`; `stale` tells callers not to trust it (R35).
  return { ...query, stale: query.isError }
}
