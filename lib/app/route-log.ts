import { ACTION_META, type ActionId } from "@/lib/protocol/actions"
import type { ActionOutput } from "@/lib/protocol/guards"
import type { RouteKind, RouteRequest, StepPlan } from "@/lib/protocol/routes"

/**
 * Multi-step routes started from this browser, per account (spec 0002 §4 "Progress"): a reload
 * resumes an interrupted route from here, without planning it again, and History groups its steps.
 * Stored under `pp-routes` as `{ [account]: RouteRun[] }`, newest first. Bigints are written as
 * `{ "$bigint": "<decimal>" }`. Every read and write is guarded: a missing, blocked, full or
 * malformed storage never throws, and a run that does not parse is skipped.
 *
 * Never trusted for a decision on its own: a resumed step is still re-checked by its hash, gated,
 * simulated and prepared again before anything is signed.
 */
export const ROUTES_KEY = "pp-routes"

/** Runs kept per account; older ones are dropped. */
export const ROUTES_LIMIT = 20

export type RouteStepStatus = "pending" | "confirmed" | "failed" | "unknown"

export type RouteStep = {
  action: ActionId
  status: RouteStepStatus
  /** Set once the step was handed to the wallet: the hash its signed transaction must have. */
  hash?: string
  /** The transaction's own time bound (unix seconds): after it, the network can never include it. */
  validUntil?: number
  /** Ledger time (unix seconds) when the step was prepared: it cannot have landed before. */
  sentAt?: number
}

export type RouteRun = {
  id: string
  account: string
  marketId: string
  kind: RouteKind
  request: RouteRequest
  /** The plans themselves (plain data), so a reload resumes without planning again. */
  plans: StepPlan[]
  /** Decoded output of each confirmed step, by index; null when it could not be read. */
  outputs: (ActionOutput | null)[]
  steps: RouteStep[]
  /** Browser milliseconds. */
  startedAt: number
  /** The remaining steps were replaced by the single call back to USDY. */
  unwound?: boolean
  /** The user closed it, or started a new route over one where nothing had moved: never resumed. */
  closed?: boolean
}

type Store = Record<string, unknown[]>

const KINDS: readonly RouteKind[] = [
  "buy_pt",
  "sell_pt",
  "buy_yt",
  "sell_yt",
  "lp_keep_yt",
  "lp_only",
  "lp_withdraw",
  "split",
  "recombine",
]
const STATUSES: readonly RouteStepStatus[] = ["pending", "confirmed", "failed", "unknown"]

function defaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? { $bigint: value.toString() } : value)

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>
    if (Object.keys(v).length === 1 && typeof v.$bigint === "string" && /^-?\d+$/.test(v.$bigint)) return BigInt(v.$bigint)
  }
  return value
}

const isAction = (a: unknown): a is ActionId => typeof a === "string" && Object.hasOwn(ACTION_META, a)
const isTime = (t: unknown) => t === undefined || (typeof t === "number" && Number.isFinite(t))

function isStep(value: unknown): value is RouteStep {
  if (!value || typeof value !== "object") return false
  const s = value as Record<string, unknown>
  return (
    isAction(s.action) &&
    STATUSES.includes(s.status as RouteStepStatus) &&
    // Every status but pending is written with the hash it is re-checked by.
    (s.status === "pending" ? s.hash === undefined || typeof s.hash === "string" : typeof s.hash === "string") &&
    isTime(s.validUntil) &&
    isTime(s.sentAt)
  )
}

/** The shape a resumed route relies on; the plans' amounts are checked again when a step resolves. */
function isRun(value: unknown, account: string): value is RouteRun {
  if (!value || typeof value !== "object") return false
  const r = value as Record<string, unknown>
  const req = r.request as Record<string, unknown> | null
  return (
    typeof r.id === "string" &&
    r.account === account &&
    typeof r.marketId === "string" &&
    KINDS.includes(r.kind as RouteKind) &&
    !!req &&
    typeof req === "object" &&
    req.kind === r.kind &&
    typeof req.amount === "bigint" &&
    Array.isArray(r.plans) &&
    r.plans.length > 0 &&
    r.plans.every((p) => !!p && typeof p === "object" && isAction((p as Record<string, unknown>).action)) &&
    Array.isArray(r.steps) &&
    r.steps.length === r.plans.length &&
    r.steps.every(isStep) &&
    r.steps.every((s, i) => (s as RouteStep).action === (r.plans as StepPlan[])[i].action) &&
    Array.isArray(r.outputs) &&
    r.outputs.every((o) => o === null || (!!o && typeof o === "object" && typeof (o as Record<string, unknown>).kind === "string")) &&
    typeof r.startedAt === "number" &&
    Number.isFinite(r.startedAt) &&
    (r.unwound === undefined || typeof r.unwound === "boolean") &&
    (r.closed === undefined || typeof r.closed === "boolean")
  )
}

function load(storage: Storage | undefined): Store {
  try {
    const raw = storage?.getItem(ROUTES_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw, reviver)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as Store
  } catch {
    return {}
  }
}

/** The account's runs, newest first. Malformed storage or runs are skipped, never thrown. */
export function readRoutes(account: string, storage: Storage | undefined = defaultStorage()): RouteRun[] {
  const list = load(storage)[account]
  return Array.isArray(list) ? list.filter((r) => isRun(r, account)) : []
}

const listeners = new Set<() => void>()

/** Calls `fn` after every `writeRoute` in this tab and when another tab changes the log. */
export function subscribeRoutes(fn: () => void): () => void {
  listeners.add(fn)
  const onStorage = (e: StorageEvent) => {
    if (e.key === ROUTES_KEY || e.key === null) fn()
  }
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(fn)
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage)
  }
}

/** Adds the run, or replaces the one with its id, keeping the account's 20 most recent (by start). */
export function writeRoute(run: RouteRun, storage: Storage | undefined = defaultStorage()): void {
  const store = load(storage)
  const kept = readRoutes(run.account, storage).filter((r) => r.id !== run.id)
  store[run.account] = [run, ...kept].sort((a, b) => b.startedAt - a.startedAt).slice(0, ROUTES_LIMIT)
  try {
    storage?.setItem(ROUTES_KEY, JSON.stringify(store, replacer))
  } catch {
    // storage full or blocked: the route just won't survive a reload
  }
  listeners.forEach((fn) => fn())
}
