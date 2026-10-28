import { ACTION_META, type ActionId } from "@/lib/protocol/actions"
import type { TxStatus } from "@/lib/protocol/review"

/**
 * Transactions submitted from this browser, per account, so a just-sent or still-pending action
 * shows at once (spec §8) before the RPC event window has it. Stored under `pp-txlog` as
 * `{ [account]: LogEntry[] }`, newest first. Display only: nothing here is trusted for a decision.
 */
export const LOG_KEY = "pp-txlog"

/** Entries kept per account; older ones are dropped. */
export const LOG_LIMIT = 50

export type LogEntry = {
  hash: string
  action: ActionId
  marketId: string
  account: string
  /** When it was submitted, in browser milliseconds. */
  at: number
  status: TxStatus
}

type Store = Record<string, LogEntry[]>

const STATUSES: readonly TxStatus[] = ["SUCCESS", "FAILED", "NOT_FOUND"]

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

function isEntry(value: unknown, account: string): value is LogEntry {
  if (!value || typeof value !== "object") return false
  const e = value as Record<string, unknown>
  return (
    typeof e.hash === "string" &&
    typeof e.action === "string" &&
    Object.hasOwn(ACTION_META, e.action) &&
    typeof e.marketId === "string" &&
    e.account === account &&
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    STATUSES.includes(e.status as TxStatus)
  )
}

function load(storage: Storage | undefined): Store {
  try {
    const raw = storage?.getItem(LOG_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Store
  } catch {
    return {}
  }
}

/** The account's entries, newest first. Malformed storage or entries are skipped, never thrown. */
export function readLog(account: string, storage: Storage | undefined = defaultStorage()): LogEntry[] {
  const list = load(storage)[account]
  return Array.isArray(list) ? list.filter((e) => isEntry(e, account)) : []
}

/** Adds (or, for a hash already logged, replaces) an entry at the top of its account's list. */
export function appendLog(entry: LogEntry, storage: Storage | undefined = defaultStorage()): void {
  const store = load(storage)
  const kept = readLog(entry.account, storage).filter((e) => e.hash !== entry.hash)
  store[entry.account] = [{ ...entry }, ...kept].slice(0, LOG_LIMIT)
  try {
    storage?.setItem(LOG_KEY, JSON.stringify(store))
  } catch {
    // storage full or blocked: the log just won't persist
  }
}
