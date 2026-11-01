"use client"

import { useQueries, useQuery } from "@tanstack/react-query"
import { useManifest } from "@/components/app/manifest-provider"
import { useWallet } from "@/hooks/use-wallet"
import { createRpcReader } from "@/lib/protocol/reader"
import { accruedFees, issuerOfAsset, rolesOf, sharedRolesOf, type AccountRoles, type MarketRoles } from "@/lib/protocol/roles"

const ROLES_REFETCH_MS = 30_000
const FEES_REFETCH_MS = 15_000

/**
 * The connected account's roles on every listed market, the shared contracts' admins and the
 * issuer of the test asset. Every query key carries the address, so a wallet switch never shows
 * the previous account's roles; `["manage", network]` is what a manager transaction refreshes.
 * `pending` while any read is still on its first answer.
 */
export function useMyRoles(): { account: string | null; roles: AccountRoles; pending: boolean } {
  const manifest = useManifest()
  const { state } = useWallet()
  const account = state.status === "connected" ? state.publicKey : null
  const { network } = manifest
  const reader = () => createRpcReader(manifest)

  const perMarket = useQueries({
    queries: manifest.markets.map((market) => ({
      queryKey: ["manage", network, "roles", account, market.marketId],
      queryFn: () => rolesOf(reader(), market, account as string),
      enabled: account !== null,
      refetchInterval: ROLES_REFETCH_MS,
    })),
  })
  const shared = useQuery({
    queryKey: ["manage", network, "shared-roles", account],
    queryFn: () => sharedRolesOf(reader(), manifest, account as string),
    enabled: account !== null,
    refetchInterval: ROLES_REFETCH_MS,
  })
  const testAsset = manifest.testAsset
  const issuer = useQuery({
    queryKey: ["manage", network, "test-issuer", account, testAsset?.sac],
    queryFn: () => issuerOfAsset(reader(), (testAsset as { sac: string }).sac, account as string),
    enabled: account !== null && testAsset !== undefined,
    refetchInterval: ROLES_REFETCH_MS,
  })

  const markets = new Map<string, MarketRoles>()
  manifest.markets.forEach((market, i) => {
    const data = perMarket[i]?.data
    if (data) markets.set(market.marketId, data)
  })
  return {
    account,
    roles: { markets, shared: shared.data, testAssetIssuer: issuer.data },
    pending: account !== null && (perMarket.some((q) => q.isPending) || shared.isPending || (testAsset !== undefined && issuer.isPending)),
  }
}

/** The fees a market has accrued in SY shares: the pool's plus the manager's. */
export function useAccruedFees(marketId: string) {
  const manifest = useManifest()
  const market = manifest.markets.find((m) => m.marketId === marketId)
  return useQuery({
    queryKey: ["manage", manifest.network, "fees", marketId],
    queryFn: () => accruedFees(createRpcReader(manifest), market as NonNullable<typeof market>),
    enabled: market !== undefined,
    refetchInterval: FEES_REFETCH_MS,
  })
}
