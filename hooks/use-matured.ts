"use client"

import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { getMarket } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"

/**
 * Whether the market has matured by ledger time (never the browser clock), against the manifest's
 * maturity; null until the ledger time loads. For display choices only (which tab opens first):
 * the gates decide with the on-chain maturity, and the topology check holds the two equal.
 */
export function useMatured(marketId: string): boolean | null {
  const { ledgerTime } = useLedgerClock()
  const maturity = getMarket(activeManifest(), marketId)?.maturity
  if (ledgerTime === null || maturity === undefined) return null
  return ledgerTime >= maturity
}
