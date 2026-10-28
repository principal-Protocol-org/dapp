"use client"

import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { formatDuration, UNAVAILABLE } from "@/components/app/live"

/** Time to (or since) maturity, ticking from the ledger clock, not the browser clock. */
export function Countdown({ maturity }: { maturity: bigint | null }) {
  const { ledgerTime } = useLedgerClock()
  if (maturity === null || ledgerTime === null) return <span>{UNAVAILABLE}</span>
  const seconds = Number(maturity) - Math.floor(ledgerTime)
  return seconds > 0 ? (
    <span>Matures in {formatDuration(seconds)}</span>
  ) : (
    <span>Matured {formatDuration(-seconds)} ago</span>
  )
}
