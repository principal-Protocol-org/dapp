"use client"

import { useQuery } from "@tanstack/react-query"
import { useMarketCompliance } from "@/hooks/use-market-compliance"
import { useWallet } from "@/hooks/use-wallet"
import { fetchAccountState } from "@/lib/protocol/account-state"
import { createHorizon } from "@/lib/protocol/horizon"
import { useManifest } from "@/components/app/manifest-provider"
import { createRpcReader } from "@/lib/protocol/reader"
import { MARKET_REFETCH_MS } from "@/hooks/use-market-state"

/**
 * The connected account's balances and compliance reads for one market. Disabled until a wallet
 * is connected on the right network and the market's compliance read has settled (it decides which
 * reads apply). `kind` is null when that read is unavailable: nothing is assumed.
 */
export function useAccountState(marketId: string) {
  const m = useManifest()
  const { state } = useWallet()
  const address = state.status === "connected" ? state.publicKey : null
  const compliance = useMarketCompliance(marketId)
  const settled = !compliance.isPending
  const kind = compliance.data?.status === "live" ? compliance.data.value.kind : null
  const query = useQuery({
    // The kind trails the documented key so a change in the compliance model refetches.
    queryKey: ["account", m.network, marketId, address, kind],
    queryFn: () => fetchAccountState(createRpcReader(m), createHorizon(m.horizonUrl), m, marketId, address as string, kind),
    enabled: address !== null && settled,
    refetchInterval: MARKET_REFETCH_MS,
  })
  // A failed refetch keeps the old `data`; `stale` tells callers not to show it as current (R35).
  return { ...query, stale: query.isError }
}
