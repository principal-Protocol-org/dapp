"use client"

import { SCALE } from "@/lib/protocol/math"
import { formatPercent } from "@/lib/protocol/format"
import { impliedApy } from "@/lib/protocol/yield"
import type { Live } from "@/lib/protocol/types"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { UNAVAILABLE } from "@/components/app/live"

/**
 * The pool's implied rate is an APR; the Fixed APY compounds it over the time left.
 * Time left comes from the ledger clock, never the browser clock.
 */
export function FixedApy({
  impliedRate,
  maturity,
  ledgerTime,
  poolSeeded,
}: {
  impliedRate: Live<bigint> | undefined
  maturity: Live<bigint> | undefined
  ledgerTime: number | null
  poolSeeded?: Live<boolean> | undefined
}) {
  if (!maturity || maturity.status === "unavailable" || ledgerTime === null) return <>{UNAVAILABLE}</>
  const seconds = maturity.value - BigInt(Math.floor(ledgerTime))
  if (seconds <= 0n) return <>Matured</>
  if (poolSeeded?.status === "unavailable") return <>{UNAVAILABLE}</>
  if (poolSeeded?.status === "live" && !poolSeeded.value) return <>No liquidity yet</>
  if (!impliedRate || impliedRate.status === "unavailable") return <>{UNAVAILABLE}</>
  const apy = impliedApy(impliedRate.value, seconds)
  if (!Number.isFinite(apy)) return <>{UNAVAILABLE}</>
  const apr = Number(impliedRate.value) / Number(SCALE)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="cursor-help underline decoration-dotted underline-offset-4">
          {formatPercent(apy)}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {`APR ${formatPercent(apr)}: the pool's simple annual rate. Fixed APY compounds it over the time left.`}
      </TooltipContent>
    </Tooltip>
  )
}
