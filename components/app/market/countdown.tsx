"use client"

import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { formatDuration, UNAVAILABLE } from "@/components/app/live"

/** Time to (or since) maturity, ticking from the ledger clock, not the browser clock. */
export function Countdown({ maturity }: { maturity: bigint | null }) {
  const { ledgerTime, isError } = useLedgerClock()
  if (maturity === null) return <span>{UNAVAILABLE}</span>
  // "Loading" while the clock is on its first read; "Unavailable" only once that read has failed.
  if (ledgerTime === null) return <span>{isError ? UNAVAILABLE : "Loading"}</span>
  const seconds = Number(maturity) - Math.floor(ledgerTime)
  return seconds > 0 ? (
    <span>Matures in {formatDuration(seconds)}</span>
  ) : (
    <span>Matured {formatDuration(-seconds)} ago</span>
  )
}
