"use client"

import { useQuery } from "@tanstack/react-query"
import { useWallet } from "@/hooks/use-wallet"
import { fetchAccountHistory, type HistoryEntry, type OracleUpdate } from "@/lib/protocol/events"
import { useManifest } from "@/components/app/manifest-provider"
import { createRpcServer } from "@/lib/protocol/stellar"

export const HISTORY_REFETCH_MS = 60_000

export type HistoryRow = HistoryEntry & { marketId: string }

export type HistoryData = {
  /** Every market's entries, newest first. */
  entries: HistoryRow[]
  window: { oldestLedger: number; latestLedger: number }
  /** Oracle `ref_set` updates per market id, oldest first (entry APY, Task 20). */
  oracleUpdates: Record<string, OracleUpdate[]>
  /** True when any market's event list was cut at the page cap. */
  truncated: boolean
}

/**
 * The connected account's event history across the manifest's markets (spec §8). Disabled without
 * a connected wallet. One failing market fails the whole query: a partial list would read as
 * "no activity". After a failed refetch `stale` is true and callers must not show the old data.
 */
export function useHistory() {
  const m = useManifest()
  const { state } = useWallet()
  const address = state.status === "connected" ? state.publicKey : null
  const query = useQuery({
    queryKey: ["history", m.network, address],
    queryFn: async (): Promise<HistoryData> => {
      const server = createRpcServer(m.rpcUrl)
      const health = await server.getHealth() // once per refresh, shared by every market
      const window = { oldestLedger: health.oldestLedger, latestLedger: health.latestLedger }
      const results = await Promise.all(
        m.markets.map((mk) =>
          fetchAccountHistory({ manifest: m, marketId: mk.marketId, account: address as string, server, window }),
        ),
      )
      const entries = results
        .flatMap((r, i) => r.entries.map((e) => ({ ...e, marketId: m.markets[i].marketId })))
        .sort((a, b) => b.ledger - a.ledger)
      const oracleUpdates: Record<string, OracleUpdate[]> = {}
      results.forEach((r, i) => {
        oracleUpdates[m.markets[i].marketId] = r.oracleUpdates
      })
      return {
        entries,
        window,
        oracleUpdates,
        truncated: results.some((r) => r.truncated),
      }
    },
    enabled: address !== null,
    refetchInterval: HISTORY_REFETCH_MS,
  })
  return { ...query, stale: query.isError }
}
