"use client"

import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useWallet } from "@/hooks/use-wallet"
import { appendLog } from "@/lib/app/local-log"
import type { ActionInput } from "@/lib/protocol/actions"
import { activeManifest } from "@/lib/protocol/manifest-source"
import {
  executeRestore as executeRestoreTx,
  executeReview,
  prepareRestore as prepareRestoreTx,
  prepareReview,
  type RestoreReview,
  type Review,
  type SignTransaction,
  type TxResult,
} from "@/lib/protocol/review"
import type { ContractInvocation } from "@/lib/protocol/stellar"

export type Execute = {
  /** Builds and RPC-prepares the exact transaction for `input` (R29 checks inside). */
  prepare(input: ActionInput): Promise<Review>
  /** Signs, checks, submits and polls the exact `review` object `prepare` returned (R31). */
  execute(review: Review): Promise<TxResult>
  prepareRestore(p: { source: string; invocation: ContractInvocation }): Promise<RestoreReview>
  executeRestore(restore: RestoreReview): Promise<TxResult>
  /** A signature or submission is in flight. */
  pending: boolean
}

/**
 * The transaction pipeline for the panels. Every submitted transaction is appended to the local
 * log (any status: a pending one should show at once) and refreshes the market and account reads.
 * A refusal before submission throws and is not logged: nothing reached the network.
 */
export function useExecute(): Execute {
  const queryClient = useQueryClient()
  const { sign: walletSign } = useWallet()
  const [inFlight, setInFlight] = useState(0)

  // The signer the transaction was prepared for goes to the wallet, which refuses another live
  // account before Freighter opens and has Freighter enforce it; executeReview/executeRestore then
  // check the signed envelope against it again. The passphrase is the manifest's, in the wallet.
  const sign = useCallback<SignTransaction>((xdr, _networkPassphrase, expectedSigner) => walletSign(xdr, expectedSigner), [walletSign])

  const refresh = useCallback(() => {
    const { network } = activeManifest()
    void queryClient.invalidateQueries({ queryKey: ["market", network] })
    void queryClient.invalidateQueries({ queryKey: ["account", network] })
  }, [queryClient])

  const track = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    setInFlight((n) => n + 1)
    try {
      return await run()
    } finally {
      setInFlight((n) => n - 1)
    }
  }, [])

  const prepare = useCallback((input: ActionInput) => prepareReview({ manifest: activeManifest(), input }), [])

  const execute = useCallback(
    (review: Review) =>
      track(async () => {
        const result = await executeReview({ review, manifest: activeManifest(), sign })
        const { action, marketId, source } = review.input
        appendLog({ hash: result.hash, action, marketId, account: source, at: Date.now(), status: result.status })
        refresh()
        return result
      }),
    [track, sign, refresh],
  )

  const prepareRestore = useCallback(
    (p: { source: string; invocation: ContractInvocation }) => prepareRestoreTx({ manifest: activeManifest(), ...p }),
    [],
  )

  const executeRestore = useCallback(
    (restore: RestoreReview) =>
      track(async () => {
        const result = await executeRestoreTx({ restore, manifest: activeManifest(), sign })
        refresh()
        return result
      }),
    [track, sign, refresh],
  )

  return { prepare, execute, prepareRestore, executeRestore, pending: inFlight > 0 }
}
