"use client"

import Link from "next/link"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketState } from "@/hooks/use-market-state"
import { formatUnixTime } from "@/lib/protocol/format"
import { useManifest } from "@/components/app/manifest-provider"
import type { MarketState } from "@/lib/protocol/market-state"
import type { Market } from "@/lib/protocol/types"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { liquidityText } from "@/components/app/market/liquidity"
import { FixedApy } from "@/components/app/market/fixed-apy"
import { showLive, UNAVAILABLE } from "@/components/app/live"
import { StatusBadge, type MarketStatus } from "@/components/app/markets/status-badge"

export type { MarketStatus }

/**
 * Paused (SY, pool or RiskControl) wins; then settled; then matured; else live.
 * Needs the ledger clock and the fields it reads: anything missing is "unavailable", never a guess.
 */
export function marketStatus(ms: MarketState, ledgerTime: number | null): MarketStatus {
  if (ledgerTime === null) return "unavailable"
  const pauses = [ms.syPaused, ms.poolPaused, ms.riskPaused]
  if (pauses.some((p) => p.status === "live" && p.value)) return "paused"
  if (pauses.some((p) => p.status === "unavailable")) return "unavailable"
  if (ms.maturity.status === "unavailable" || ms.settledRate.status === "unavailable") return "unavailable"
  if (ms.settledRate.value !== null) return "settled"
  if (BigInt(Math.floor(ledgerTime)) >= ms.maturity.value) return "matured"
  return "live"
}

function daysLeft(ms: MarketState, ledgerTime: number | null): string {
  if (ledgerTime === null || ms.maturity.status === "unavailable") return UNAVAILABLE
  const seconds = ms.maturity.value - BigInt(Math.floor(ledgerTime))
  if (seconds <= 0n) return "Matured"
  if (seconds >= 86400n) return `${seconds / 86400n} d`
  return seconds >= 3600n ? `${seconds / 3600n} h` : "<1 h"
}

function MarketRow({ market, ledgerTime }: { market: Market; ledgerTime: number | null }) {
  const { data, isPending, stale } = useMarketState(market.marketId)
  // After a failed refetch the old data is not shown as current.
  const ms = stale ? undefined : data
  const decimals = market.underlying.decimals
  return (
    <TableRow>
      <TableCell className="font-sans text-ink">
        <Link
          href={`/app/markets/${market.marketId}`}
          className="font-semibold underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {market.displayName}
        </Link>
      </TableCell>
      {ms ? (
        <>
          <TableCell>{showLive(ms.maturity, (v) => formatUnixTime(Number(v)))}</TableCell>
          <TableCell>{daysLeft(ms, ledgerTime)}</TableCell>
          <TableCell>
            <FixedApy impliedRate={ms.impliedRate} maturity={ms.maturity} ledgerTime={ledgerTime} poolSeeded={ms.poolSeeded} />
          </TableCell>
          <TableCell>{liquidityText(ms, decimals, market.underlying.code)}</TableCell>
          <TableCell>
            <StatusBadge status={marketStatus(ms, ledgerTime)} />
          </TableCell>
        </>
      ) : isPending ? (
        <TableCell colSpan={5}>
          <Skeleton className="h-5 w-full" />
        </TableCell>
      ) : (
        <TableCell colSpan={5}>
          {stale ? "Unavailable — last update failed." : `${UNAVAILABLE}: this market could not be read right now.`}
        </TableCell>
      )}
    </TableRow>
  )
}

export function MarketsTable() {
  const { markets } = useManifest()
  const { ledgerTime } = useLedgerClock()
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Market</TableHead>
            <TableHead>Maturity</TableHead>
            <TableHead>Days left</TableHead>
            <TableHead>Fixed APY</TableHead>
            <TableHead>Liquidity (est., PT at pool price)</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {markets.map((market) => (
            <MarketRow key={market.marketId} market={market} ledgerTime={ledgerTime} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
