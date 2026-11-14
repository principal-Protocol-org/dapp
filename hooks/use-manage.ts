"use client"

import { useQueries, useQuery } from "@tanstack/react-query"
import { usePathname } from "next/navigation"
import { useManifest } from "@/components/app/manifest-provider"
import { useWallet } from "@/hooks/use-wallet"
import { createRpcReader } from "@/lib/protocol/reader"
import { accruedFees, issuerOfAsset, rolesOf, sharedRolesOf, type AccountRoles, type MarketRoles } from "@/lib/protocol/roles"

/** The role views are polled at this pace only while the manage view (`/app/manage*`) is open... */
export const ROLES_REFETCH_MANAGE_MS = 30_000
/** ...and refreshed at this one elsewhere (D-26 item 3): about 7 views per market per connected wallet. */
export const ROLES_REFETCH_MS = 120_000
const FEES_REFETCH_MS = 15_000

/** How often the connected account's roles are read again on `pathname`. */
export function rolesRefetchMs(pathname: string | null): number {
  return pathname === "/app/manage" || pathname?.startsWith("/app/manage/") ? ROLES_REFETCH_MANAGE_MS : ROLES_REFETCH_MS
}

/**
 * The connected account's roles on every listed market, the shared contracts' admins and the
 * issuer of the test asset. Every query key carries the address, so a wallet switch never shows
 * the previous account's roles; `["manage", network]` is what a manager transaction refreshes.
 * `pending` while any read is still on its first answer. The header reads them on every page, so
 * they are polled every 30 s only on the manage view, and every 120 s elsewhere (`rolesRefetchMs`).
 */
export function useMyRoles(): { account: string | null; roles: AccountRoles; pending: boolean } {
  const manifest = useManifest()
  const refetchInterval = rolesRefetchMs(usePathname())
  const { state } = useWallet()
  const account = state.status === "connected" ? state.publicKey : null
  const { network } = manifest
  const reader = () => createRpcReader(manifest)

  const perMarket = useQueries({
    queries: manifest.markets.map((market) => ({
      queryKey: ["manage", network, "roles", account, market.marketId],
      queryFn: () => rolesOf(reader(), market, account as string),
      enabled: account !== null,
      refetchInterval,
    })),
  })
  const shared = useQuery({
    queryKey: ["manage", network, "shared-roles", account],
    queryFn: () => sharedRolesOf(reader(), manifest, account as string),
    enabled: account !== null,
    refetchInterval,
  })
  const testAsset = manifest.testAsset
  const issuer = useQuery({
    queryKey: ["manage", network, "test-issuer", account, testAsset?.sac],
    queryFn: () => issuerOfAsset(reader(), (testAsset as { sac: string }).sac, account as string),
    enabled: account !== null && testAsset !== undefined,
    refetchInterval,
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
