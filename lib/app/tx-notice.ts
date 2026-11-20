import { userErrorMessage } from "@/lib/protocol/errors"
import { explorerUrl } from "@/lib/protocol/explorer"
import { formatUnixTime } from "@/lib/protocol/format"
import type { TxResult } from "@/lib/protocol/review"
import { SubmissionRejectedError } from "@/lib/protocol/stellar"
import type { Lookup } from "@/lib/protocol/tx-lookup"
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

/**
 * `message` is what the action did, decoded from its return value (spec §6 step 7, the panel
 * config's `result`); a success without one reads "<label> confirmed.".
 */
export function noticeForResult(label: string, result: TxResult, network: Network, message?: string): TxNotice {
  const link = { hash: result.hash, url: explorerUrl(network, "tx", result.hash) }
  switch (result.status) {
    case "SUCCESS": {
      const title = message?.trim() ? message.trim() : `${label} confirmed.`
      return result.decodeError ? { tone: "success", title, detail: result.decodeError, ...link } : { tone: "success", title, ...link }
    }
    case "FAILED":
      return {
        tone: "error",
        title: `${label} failed on-chain.`,
        // R49: the cause, when the result names one; the hash is kept either way.
        detail: result.reason
          ? `${result.reason} Look it up by its hash for the details.`
          : "It was included in a ledger but did not go through, and the network fee was charged. To see why, look it up by its hash.",
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
  const detail = userErrorMessage(error)
  if (error instanceof SubmissionRejectedError && error.hash) {
    return { tone: "error", title: `${label} was not accepted by the network.`, detail, hash: error.hash, url: explorerUrl(network, "tx", error.hash) }
  }
  return { tone: "error", title: `${label} was not sent.`, detail }
}

/**
 * A sent action whose result is not known yet (M-21): its panel keeps checking it by its hash and
 * refuses a second send until the ledger passes its time bound, `validUntil` (unix seconds).
 */
export function noticeForPending(label: string, tx: { hash: string; validUntil: number }, network: Network): TxNotice {
  return {
    tone: "warning",
    title: `Your last ${label} was sent but is not confirmed yet.`,
    detail: `Checking… It can still land until ${formatUnixTime(tx.validUntil)}.`,
    hash: tx.hash,
    url: explorerUrl(network, "tx", tx.hash),
  }
}

/**
 * How a pending action settled (M-21): confirmed or failed on-chain, as a direct result reads; past
 * its time bound and never included; or past it with the network no longer able to tell.
 */
export function noticeForSettled(label: string, hash: string, lookup: Lookup, network: Network): TxNotice {
  const link = { hash, url: explorerUrl(network, "tx", hash) }
  if (lookup.status === "SUCCESS") return noticeForResult(label, { hash, status: "SUCCESS" }, network)
  if (lookup.status === "FAILED") return noticeForResult(label, { hash, status: "FAILED", reason: lookup.reason }, network)
  if (lookup.final) {
    return {
      tone: "warning",
      title: `${label} did not land.`,
      detail: "Its time limit passed before the network included it, so it moved nothing and charged no fee. You can review it again.",
      ...link,
    }
  }
  if (lookup.lost) {
    return {
      tone: "warning",
      title: `${label}: the network can no longer say whether it landed.`,
      detail:
        "Its time limit has passed, so it can no longer land, but the network no longer shows that far back. Look it up by its hash and check your balances before sending it again.",
      ...link,
    }
  }
  return noticeForResult(label, { hash, status: "NOT_FOUND" }, network)
}
