"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { createRpcServer, getLedgerClock } from "@/lib/protocol/stellar"

const REFETCH_MS = 6_000
const TICK_MS = 1_000

/**
 * Latest ledger close time from RPC, refetched every 6 s and advanced locally in between.
 * `ledgerTime` (unix seconds) is null until the first read succeeds, and stays null if RPC has
 * never answered, so gates can refuse instead of falling back to the browser clock.
 * The browser clock is only used for the elapsed seconds since the last read.
 */
export function useLedgerClock(): {
  ledgerTime: number | null
  sequence: number | null
  isError: boolean
} {
  const { rpcUrl } = activeManifest()
  const query = useQuery({
    queryKey: ["ledger-clock", rpcUrl],
    queryFn: () => getLedgerClock(createRpcServer(rpcUrl)),
    refetchInterval: REFETCH_MS,
    refetchIntervalInBackground: false,
  })

  // Client-only tick: nothing reads the browser clock during render or prerender.
  const [nowMs, setNowMs] = useState<number | null>(null)
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [])

  const data = query.data
  if (!data) return { ledgerTime: null, sequence: null, isError: query.isError }
  const elapsedSeconds = nowMs === null ? 0 : Math.max(0, (nowMs - data.readAtMs) / 1000)
  return {
    ledgerTime: data.closeTime + elapsedSeconds,
    sequence: data.sequence,
    isError: query.isError,
  }
}
