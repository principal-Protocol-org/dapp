import { createRpcServer, failedTransactionReason, pollTransactionStatus } from "./stellar"
import type { Manifest } from "./types"

/**
 * One look at a sent transaction by its hash (spec 0005 M-21): the route runner re-checks a step
 * whose result is not known with it, and a single action's panel its pending entry. Framework-free.
 */

/**
 * What one look found. A success carries its return value as RPC decoded it (or why it could not be
 * decoded): the caller knows the action and reads its output. A NOT_FOUND is `final` once the network
 * can no longer include the transaction and RPC's history shows it never did; `lost` once it can no
 * longer be included but the history does not reach back far enough to tell.
 */
export type Lookup =
  | { status: "SUCCESS"; returnValue?: unknown; decodeError?: string }
  | { status: "FAILED"; reason: string }
  | { status: "NOT_FOUND"; final: boolean; lost: boolean }

type PollServer = NonNullable<Parameters<typeof pollTransactionStatus>[0]["server"]>

/**
 * The one RPC call a look makes: `createRpcServer` satisfies it, tests inject a fake. Its answer
 * carries the close times of the newest and the oldest ledger RPC keeps, which bound what it can show.
 */
export type PollRpcServer = {
  getTransaction(
    hash: string,
  ): Promise<Awaited<ReturnType<PollServer["getTransaction"]>> & { latestLedgerCloseTime?: unknown; oldestLedgerCloseTime?: unknown }>
}

/** Slack for the interpolated ledger clock when deciding a transaction cannot have landed before `sentAt`. */
const CLOCK_SLACK_S = 60

/**
 * A ledger close time as RPC passes it through from its JSON: a number or a decimal string (as
 * `getLedgerClock` reads `closeTime`). Anything else is unknown, so it can never prove a step lost.
 */
function closeTimeOf(value: unknown): number | undefined {
  if (typeof value === "string" ? value.trim() === "" : typeof value !== "number") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * One look at a sent transaction by its hash, through the 0001 poll helper. A NOT_FOUND is `final`
 * only when the network can no longer include it (its ledger close time passed the transaction's time
 * bound, `validUntil`) and RPC's history reaches back to before it was sent (`sentAt`, unix seconds);
 * `lost` when the time bound passed but the history does not reach that far. A transaction with no
 * recorded time bound (a route step logged before it was kept) is never final, and lost at once.
 * Rejects when RPC cannot be asked: the caller keeps waiting.
 */
export async function lookupTransaction(
  manifest: Manifest,
  tx: { hash: string; validUntil?: number; sentAt?: number },
  opts: { server?: PollRpcServer } = {},
): Promise<Lookup> {
  const { rpcUrl } = manifest
  const rpc: PollRpcServer = opts.server ?? createRpcServer(rpcUrl)
  let window: { latest?: number; oldest?: number } = {}
  const server: PollServer = {
    getTransaction: async (hash) => {
      const res = await rpc.getTransaction(hash)
      window = { latest: closeTimeOf(res.latestLedgerCloseTime), oldest: closeTimeOf(res.oldestLedgerCloseTime) }
      return res
    },
  }
  const polled = await pollTransactionStatus({ rpcUrl, hash: tx.hash, attempts: 1, server })
  if (polled.status === "SUCCESS") {
    return {
      status: "SUCCESS",
      ...(polled.returnValue === undefined ? {} : { returnValue: polled.returnValue }),
      ...(polled.decodeError === undefined ? {} : { decodeError: polled.decodeError }),
    }
  }
  if (polled.status === "FAILED") return { status: "FAILED", reason: failedTransactionReason(polled.failure) }
  const { latest, oldest } = window
  const pastLimit = tx.validUntil !== undefined && latest !== undefined && latest > tx.validUntil
  const covered = tx.sentAt !== undefined && oldest !== undefined && oldest <= tx.sentAt - CLOCK_SLACK_S
  const final = pastLimit && covered
  return { status: "NOT_FOUND", final, lost: !final && (tx.validUntil === undefined || pastLimit) }
}
