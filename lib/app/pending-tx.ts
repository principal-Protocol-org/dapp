import { ACTION_META, type ActionId } from "@/lib/protocol/actions"

/**
 * Single actions sent from this browser whose result was not known when the polls stopped (spec 0005
 * M-21), per account. Until each settles or its time bound passes on the ledger, its panel keeps
 * checking it by its hash and refuses a second send. Stored under `pp-pending` as
 * `{ [account]: PendingTx[] }`, newest first, apart from the route log (`pp-routes`) and the local
 * log (`pp-txlog`).
 */
export const PENDING_KEY = "pp-pending"

export type PendingTx = {
  hash: string
  action: ActionId
  marketId: string
  account: string
  /** The transaction's own time bound (unix seconds): after it, the network can never include it. */
  validUntil: number
  /** When the transaction was prepared (unix seconds): it cannot have landed before. */
  sentAt: number
}

type Store = Record<string, unknown>

/**
 * This tab's copy, per storage, from the first write that failed (storage blocked, or full) until one
 * succeeds again; and the copy used when there is no storage at all. While a copy is in use it is
 * what is read, so a pending action still guards its panel in this tab.
 */
const copies = new WeakMap<Storage, Store>()
let withoutStorage: Store = {}

const listeners = new Set<() => void>()

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

function isEntry(value: unknown, account: string): value is PendingTx {
  if (!value || typeof value !== "object") return false
  const e = value as Record<string, unknown>
  return (
    typeof e.hash === "string" &&
    typeof e.action === "string" &&
    Object.hasOwn(ACTION_META, e.action) &&
    typeof e.marketId === "string" &&
    e.account === account &&
    finite(e.validUntil) &&
    finite(e.sentAt)
  )
}

function load(storage: Storage | undefined): Store {
  if (!storage) return withoutStorage
  const copy = copies.get(storage)
  if (copy) return copy
  let raw: string | null
  try {
    raw = storage.getItem(PENDING_KEY)
  } catch {
    return {}
  }
  try {
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

function save(store: Store, storage: Storage | undefined): void {
  if (!storage) {
    withoutStorage = store
  } else {
    try {
      storage.setItem(PENDING_KEY, JSON.stringify(store))
      // Written: storage is what is read again.
      copies.delete(storage)
    } catch {
      copies.set(storage, store)
    }
  }
  listeners.forEach((fn) => fn())
}

/** The account's pending actions, newest first. Malformed storage or entries are skipped, never thrown. */
export function readPending(account: string, storage: Storage | undefined = defaultStorage()): PendingTx[] {
  const list = load(storage)[account]
  return Array.isArray(list) ? list.filter((e) => isEntry(e, account)) : []
}

/** Calls `fn` after every change in this tab, and when another tab changes the pending actions. */
export function subscribePending(fn: () => void): () => void {
  listeners.add(fn)
  const onStorage = (e: StorageEvent) => {
    if (e.key === PENDING_KEY || e.key === null) fn()
  }
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(fn)
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

/** Adds (or, for a hash already pending, replaces) an entry at the top of its account's list. */
export function addPending(tx: PendingTx, storage: Storage | undefined = defaultStorage()): void {
  const store = load(storage)
  const kept = readPending(tx.account, storage).filter((e) => e.hash !== tx.hash)
  save({ ...store, [tx.account]: [{ ...tx }, ...kept] }, storage)
}

/** Removes the account's entry with this hash. True when there was one: only that caller acts on how it settled. */
export function removePending(account: string, hash: string, storage: Storage | undefined = defaultStorage()): boolean {
  const list = readPending(account, storage)
  const kept = list.filter((e) => e.hash !== hash)
  if (kept.length === list.length) return false
  save({ ...load(storage), [account]: kept }, storage)
  return true
}
