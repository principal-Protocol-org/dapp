"use client"

import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useWallet } from "@/hooks/use-wallet"
import { appendLog } from "@/lib/app/local-log"
import type { ActionInput } from "@/lib/protocol/actions"
import { useManifest } from "@/components/app/manifest-provider"
import type { ManagerCall } from "@/lib/protocol/manager-calls"
import {
  executeRestore as executeRestoreTx,
  executeReview,
  prepareManagerReview,
  prepareRestore as prepareRestoreTx,
  prepareReview,
  type AnyReview,
  type ManagerReview,
  type RestoreReview,
  type Review,
  type SignTransaction,
  type TxResult,
} from "@/lib/protocol/review"
import type { ContractInvocation } from "@/lib/protocol/stellar"

export type Execute = {
  /** Builds and RPC-prepares the exact transaction for `input` (R29 checks inside). */
  prepare(input: ActionInput): Promise<Review>
  /** Builds and RPC-prepares a manager call (0002 §5) under the same R29 checks; it has no floor. */
  prepareManager(call: ManagerCall): Promise<ManagerReview>
  /** Signs, checks, submits and polls the exact `review` object `prepare` or `prepareManager` returned (R31). */
  execute(review: AnyReview): Promise<TxResult>
  prepareRestore(p: { source: string; invocation: ContractInvocation }): Promise<RestoreReview>
  executeRestore(restore: RestoreReview): Promise<TxResult>
  /** A signature or submission is in flight. */
  pending: boolean
}

/**
 * The transaction pipeline for the panels and the manager view. Every submitted action is appended
 * to the local log (any status: a pending one should show at once); every submitted transaction
 * refreshes the market and account reads. A manager call is not logged: the log lists the user's
 * actions, and the manager view reads the call's effect back from the chain. A refusal before
 * submission throws and is not logged: nothing reached the network.
 */
export function useExecute(): Execute {
  const manifest = useManifest()
  const queryClient = useQueryClient()
  const { sign: walletSign } = useWallet()
  const [inFlight, setInFlight] = useState(0)

  // The signer the transaction was prepared for goes to the wallet, which refuses another live
  // account before Freighter opens and tells Freighter which account must sign; executeReview and
  // executeRestore then check the signed envelope against it again. The passphrase is the
  // manifest's, in the wallet.
  const sign = useCallback<SignTransaction>((xdr, _networkPassphrase, expectedSigner) => walletSign(xdr, expectedSigner), [walletSign])

  const refresh = useCallback(() => {
    const { network } = manifest
    void queryClient.invalidateQueries({ queryKey: ["market", network] })
    void queryClient.invalidateQueries({ queryKey: ["account", network] })
  }, [queryClient, manifest])

  const track = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    setInFlight((n) => n + 1)
    try {
      return await run()
    } finally {
      setInFlight((n) => n - 1)
    }
  }, [])

  const prepare = useCallback((input: ActionInput) => prepareReview({ manifest, input }), [manifest])

  const prepareManager = useCallback((call: ManagerCall) => prepareManagerReview({ manifest, call }), [manifest])

  const execute = useCallback(
    (review: AnyReview) =>
      track(async () => {
        const result = await executeReview({ review, manifest, sign })
        if (review.origin.type === "action") {
          const { action, marketId, source } = review.origin.input
          appendLog({
            hash: result.hash,
            action,
            marketId,
            account: source,
            at: Date.now(),
            status: result.status,
            ...(result.reason ? { reason: result.reason } : {}),
          })
        }
        refresh()
        return result
      }),
    [track, sign, refresh, manifest],
  )

  const prepareRestore = useCallback(
    (p: { source: string; invocation: ContractInvocation }) => prepareRestoreTx({ manifest, ...p }),
    [manifest],
  )

  const executeRestore = useCallback(
    (restore: RestoreReview) =>
      track(async () => {
        const result = await executeRestoreTx({ restore, manifest, sign })
        refresh()
        return result
      }),
    [track, sign, refresh, manifest],
  )

  return { prepare, prepareManager, execute, prepareRestore, executeRestore, pending: inFlight > 0 }
}
