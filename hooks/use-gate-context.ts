"use client"

import { useAccountState } from "@/hooks/use-account-state"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useManifestFindings } from "@/hooks/use-manifest-findings"
import { useMarketCompliance } from "@/hooks/use-market-compliance"
import { useMarketState } from "@/hooks/use-market-state"
import { useWallet } from "@/hooks/use-wallet"
import type { AccountState } from "@/lib/protocol/account-state"
import { evaluateAccountCompliance } from "@/lib/protocol/compliance"
import type { Blocker, GateContext } from "@/lib/protocol/gates"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { MarketState } from "@/lib/protocol/market-state"
import type { WalletState } from "@/lib/protocol/types"

export const STALE = "Unavailable — last update failed"

/** The connected account's data: no wallet connected, still loading, unreadable or stale, or live. */
export type AccountStatus = "disconnected" | "loading" | "unavailable" | "live"

export type GateInputs = {
  /** Every `GateContext` field but the simulation; null while any of it cannot be trusted. */
  base: Omit<GateContext, "simulation"> | null
  /** Why `base` is null: the gates are not evaluated at all then (R32, R35). Signing stays off. */
  unavailable: Blocker[]
  wallet: WalletState
  /** Live market state; undefined while loading, unreadable or stale (R35). */
  ms?: MarketState
  marketStatus: "loading" | "live" | "stale" | "error"
  /** The connected account's state; undefined unless it was read for that address and is not stale. */
  account?: AccountState
  /** Why `account` is absent, if it is: a line that needs it says "loading", never "connect" (V6). */
  accountStatus: AccountStatus
  ledgerTime: number | null
}

/**
 * Assembles what `evaluateGates` needs for one market, from the same hooks the market page uses.
 * Account data comes from `useAccountState`, whose query key carries the connected address: data
 * read for another address is never returned for this one.
 */
export function useGateContext(marketId: string): GateInputs {
  const manifest = useManifest()
  const findings = useManifestFindings()
  const { state: wallet } = useWallet()
  const { ledgerTime } = useLedgerClock()
  const market = useMarketState(marketId)
  const accountQuery = useAccountState(marketId)
  const compliance = useMarketCompliance(marketId)
  const managerId = getMarket(manifest, marketId)?.contracts.manager

  const ms = market.stale ? undefined : market.data
  const connected = wallet.status === "connected"
  const account = connected && !accountQuery.stale ? accountQuery.data : undefined

  const unavailable: Blocker[] = []
  if (ledgerTime === null) {
    unavailable.push({
      code: "unavailable",
      message:
        "Waiting for the network clock: the latest ledger time has not loaded, so maturity and deadlines cannot be checked. Signing turns on once it loads.",
    })
  }
  if (market.stale) {
    unavailable.push({
      code: "unavailable",
      message: `${STALE}: this market's on-chain data could not be refreshed, so nothing can be checked. Signing stays off until it loads again.`,
    })
  } else if (!market.data) {
    unavailable.push({
      code: "unavailable",
      message: market.isError
        ? `This market's on-chain data could not be read (${market.error?.message ?? "unknown error"}). Signing stays off until it loads.`
        : "Loading this market's on-chain data. Signing turns on once it has loaded.",
    })
  }
  if (connected && accountQuery.stale) {
    unavailable.push({
      code: "unavailable",
      message: `${STALE}: your account data could not be refreshed, so your balances and checks cannot be trusted. Signing stays off until it loads again.`,
    })
  }
  if (managerId === undefined) {
    unavailable.push({ code: "manifest", message: `Market "${marketId}" is not in the deployment manifest.` })
  }

  let base: GateInputs["base"] = null
  if (unavailable.length === 0 && ms && ledgerTime !== null && managerId !== undefined) {
    const model = compliance.data
    const kind = !compliance.isError && model?.status === "live" ? model.value.kind : null
    const kindError =
      model?.status === "unavailable" ? model.error : compliance.isError ? "the last update of the compliance model failed" : undefined
    base = {
      findings,
      wallet,
      market: ms,
      account,
      compliance: account ? evaluateAccountCompliance(account, kind, kindError) : [],
      ledgerTime,
      managerId,
    }
  }

  const marketStatus = market.stale ? "stale" : market.data ? "live" : market.isError ? "error" : "loading"
  const accountStatus: AccountStatus = !connected ? "disconnected" : account ? "live" : accountQuery.isError ? "unavailable" : "loading"
  return { base, unavailable, wallet, ms, marketStatus, account, accountStatus, ledgerTime }
}
