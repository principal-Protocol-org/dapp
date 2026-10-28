"use client"

import Link from "next/link"
import { useCallback, useState } from "react"
import { useHistory } from "@/hooks/use-history"
import { useWallet } from "@/hooks/use-wallet"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { PositionCard, type CardStatus } from "@/components/app/portfolio/position-card"

/**
 * The connected account's positions, one card per market where it holds anything (spec §7). A card
 * omits itself when the account holds nothing there and reports its status, so the empty state
 * appears only once every market has said it is empty.
 */
export function PortfolioView() {
  const m = activeManifest()
  const { state } = useWallet()
  const history = useHistory()
  const [statuses, setStatuses] = useState<Record<string, CardStatus>>({})
  const report = useCallback((marketId: string, status: CardStatus) => {
    setStatuses((prev) => (prev[marketId] === status ? prev : { ...prev, [marketId]: status }))
  }, [])

  if (state.status !== "connected") {
    return <p className="text-ink-muted">Connect your wallet to see your positions.</p>
  }

  const allEmpty = m.markets.every((mk) => statuses[mk.marketId] === "empty")
  return (
    <div className="grid gap-6">
      {allEmpty ? (
        <div className="rounded-lg border border-line bg-surface p-5">
          <p className="text-ink">You hold nothing in any market yet.</p>
          <p className="mt-2 text-sm text-ink-muted">
            <Link href="/app" className="underline underline-offset-4">
              Browse the markets
            </Link>{" "}
            to deposit and mint.
          </p>
        </div>
      ) : null}
      {m.markets.map((mk) => (
        <PositionCard
          key={mk.marketId}
          marketId={mk.marketId}
          history={{
            // A failed refetch keeps the old data in the query; it is not shown as current (R35).
            data: history.stale ? undefined : history.data,
            pending: history.isPending,
            failed: history.stale || history.isError,
          }}
          onStatus={report}
        />
      ))}
    </div>
  )
}
