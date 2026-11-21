"use client"

import { useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useManifest } from "@/components/app/manifest-provider"
import { appendLog, readLog } from "@/lib/app/local-log"
import { readPending, removePending, subscribePending, type PendingTx } from "@/lib/app/pending-tx"
import type { ActionId } from "@/lib/protocol/actions"
import { forgetInFlight } from "@/lib/protocol/rpc-limiter"
import { lookupTransaction, type Lookup } from "@/lib/protocol/tx-lookup"

/** A pending action is looked up again this long after the previous look answered. */
export const PENDING_RECHECK_MS = 5_000

/** How a pending action settled: its last look, once SUCCESS, FAILED, or NOT_FOUND past its time bound. */
export type PendingSettled = { tx: PendingTx; lookup: Lookup }

/** The look settles the entry: it landed, failed, or can no longer land (`final`, or `lost`). */
const settles = (found: Lookup) => found.status !== "NOT_FOUND" || found.final || found.lost

/** The local log entry `useExecute` wrote for this send, now with its outcome; logged afresh if it is gone. */
function logOutcome(tx: PendingTx, found: Extract<Lookup, { status: "SUCCESS" | "FAILED" }>): void {
  const logged = readLog(tx.account).find((e) => e.hash === tx.hash)
  appendLog({
    hash: tx.hash,
    action: tx.action,
    marketId: tx.marketId,
    account: tx.account,
    at: logged?.at ?? tx.sentAt * 1000,
    status: found.status,
    ...(found.status === "FAILED" ? { reason: found.reason } : {}),
  })
}

/**
 * The account's pending action on this market (spec 0005 M-21): one whose result was not known when
 * it was sent, kept until the ledger passes its time bound. It is looked up by its hash at once and
 * then every 5 s, one look at a time. SUCCESS or FAILED removes it, updates the local log entry and
 * refreshes the market and account reads (ending read sharing first, as after any landed write); a
 * NOT_FOUND past the time bound removes it as well, `final` (it never landed) or `lost` (the network
 * can no longer tell). Only the caller that removed the entry acts on how it settled, then tells
 * `onSettled`: two panels on the same entry toast once, and one that finds it gone does nothing. A
 * look that fails keeps the entry for the next one.
 */
export function usePendingTx(
  account: string | null,
  marketId: string,
  action: ActionId,
  onSettled?: (settled: PendingSettled) => void,
): PendingTx | null {
  const manifest = useManifest()
  const queryClient = useQueryClient()
  const [entry, setEntry] = useState<PendingTx | null>(null)
  const onSettledRef = useRef(onSettled)
  useEffect(() => {
    onSettledRef.current = onSettled
  })

  // Read after mount (storage is the browser's), and again on every change here or in another tab.
  // The same pending send keeps its object, so its checks are not restarted by unrelated changes.
  useEffect(() => {
    const read = () => {
      const next = account ? (readPending(account).find((e) => e.marketId === marketId && e.action === action) ?? null) : null
      setEntry((prev) => (prev && next && prev.hash === next.hash ? prev : next))
    }
    read()
    return subscribePending(read)
  }, [account, marketId, action])

  useEffect(() => {
    if (!entry) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      let found: Lookup | undefined
      try {
        found = await lookupTransaction(manifest, entry)
      } catch {
        // RPC did not answer: the entry stays, and is looked up again.
      }
      if (stopped) return
      if (found && settles(found)) {
        // Another panel or tab that already removed it has acted on it.
        if (!removePending(entry.account, entry.hash)) return
        if (found.status !== "NOT_FOUND") {
          logOutcome(entry, found)
          // It landed: no refetch may join a read sent before it.
          forgetInFlight()
          void queryClient.invalidateQueries({ queryKey: ["market", manifest.network] })
          void queryClient.invalidateQueries({ queryKey: ["account", manifest.network] })
        }
        onSettledRef.current?.({ tx: entry, lookup: found })
        return
      }
      timer = setTimeout(() => void check(), PENDING_RECHECK_MS)
    }
    void check()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [entry, manifest, queryClient])

  return entry
}
