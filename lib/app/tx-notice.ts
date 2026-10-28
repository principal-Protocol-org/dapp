import type { TxResult } from "@/lib/protocol/review"
import { SubmissionRejectedError } from "@/lib/protocol/stellar"
import type { Network } from "@/lib/protocol/types"

/** What the UI says about a transaction attempt: a toast and the panel's last-result line. */
export type TxNotice = {
  tone: "success" | "warning" | "error"
  title: string
  detail?: string
  /** Kept for every transaction that reached the network, whatever its outcome. */
  hash?: string
  url?: string | null
}

/** stellar.expert page of a Testnet transaction; no explorer exists for a local network. */
export function explorerTxUrl(network: Network, hash: string): string | null {
  return network === "testnet" ? `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}` : null
}

export function noticeForResult(label: string, result: TxResult, network: Network): TxNotice {
  const link = { hash: result.hash, url: explorerTxUrl(network, result.hash) }
  switch (result.status) {
    case "SUCCESS":
      return result.decodeError
        ? { tone: "success", title: `${label} confirmed.`, detail: result.decodeError, ...link }
        : { tone: "success", title: `${label} confirmed.`, ...link }
    case "FAILED":
      return {
        tone: "error",
        title: `${label} failed on-chain.`,
        detail: "It was included in a ledger but did not go through, and the network fee was charged. To see why, look it up by its hash.",
        ...link,
      }
    case "NOT_FOUND":
      return {
        tone: "warning",
        title: `${label}: result not known yet.`,
        detail:
          result.pollError ??
          "The transaction was submitted, but the network does not show it yet. It may still land, so look it up by its hash before trying again.",
        ...link,
      }
  }
}

/** An attempt that threw: refused by the network (with its hash), or stopped before submission. */
export function noticeForError(label: string, error: unknown, network: Network): TxNotice {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof SubmissionRejectedError && error.hash) {
    return { tone: "error", title: `${label} was not accepted by the network.`, detail, hash: error.hash, url: explorerTxUrl(network, error.hash) }
  }
  return { tone: "error", title: `${label} was not sent.`, detail }
}
