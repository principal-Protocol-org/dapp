/**
 * Client-visible alert types (no `server-only`), shared by the alerts API (spec 0004 D-20, Task 9) and
 * the dashboard. The API answers `GET /api/dashboard/alerts` with `{ open, recent, lastTest }`.
 */

export type AlertSeverity = "warning" | "critical"

/** One open alert, as the API lists it. */
export type Alert = {
  /** The condition, e.g. "oracle_stale", "risk_exhausted". */
  kind: string
  /** What it is about: a contract id, a group, a signer. */
  subject: string
  severity: AlertSeverity
  /** ISO time it opened. */
  openedAt: string
  payload: Record<string, unknown>
}

/**
 * Each alert kind in words (the alert check's kinds, `lib/server/alerts`), for the dashboard and the
 * webhook's line. An unknown kind is shown as it is.
 */
const KIND_WORDS: Readonly<Record<string, string>> = {
  oracle_warning: "Oracle value aging",
  oracle_stale: "Oracle stale",
  oracle_unavailable: "Oracle unavailable",
  oracle_rejection: "Oracle rejected an update",
  feed_broken: "Oracle feed broken",
  keeper_unhealthy: "Oracle keeper unhealthy",
  paused: "Contract paused",
  risk_warning: "Circuit breaker near its limit",
  risk_exhausted: "Circuit breaker exhausted",
  signer_low: "Keeper signer low on XLM",
  indexer_lag: "Event index lagging",
  indexer_gap: "Event index gap",
  test: "Test alert",
}

export const alertTitle = (kind: string): string => (Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind] : kind)

/**
 * Kinds that only say "this server's read failed" (`oracle_unavailable`): such an alert opens at once
 * but is posted, and counts as critical, only once a later check confirms it (`payload.confirmedAt`).
 * One that clears before then closes without a word.
 */
export const DEBOUNCED_KINDS: readonly string[] = ["oracle_unavailable"]

/** Whether an open alert counts as critical: its severity, unless it is a debounced kind not confirmed yet. */
export function countsAsCritical(a: Pick<Alert, "kind" | "severity" | "payload">): boolean {
  return a.severity === "critical" && !(DEBOUNCED_KINDS.includes(a.kind) && typeof a.payload.confirmedAt !== "string")
}

/** An alert from the history (`recent`): one that opened, with its close time (null while still open). */
export type RecentAlert = Alert & { resolvedAt: string | null }

/**
 * The part of `GET /api/dashboard/alerts` the dashboard reads: the open alerts and, once the API lists
 * them (Task 9), the recent ones, open or closed (the risk page's exhaustion history, D-12).
 */
export type OpenAlertsAnswer = { open: Alert[]; recent?: RecentAlert[] }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

function isAlert(v: unknown): v is Alert {
  return (
    isRecord(v) &&
    typeof v.kind === "string" &&
    typeof v.subject === "string" &&
    (v.severity === "warning" || v.severity === "critical") &&
    typeof v.openedAt === "string" &&
    isRecord(v.payload)
  )
}

function isRecent(v: unknown): v is RecentAlert {
  if (!isAlert(v)) return false
  const resolvedAt = (v as Record<string, unknown>).resolvedAt
  return resolvedAt === null || typeof resolvedAt === "string"
}

/**
 * The open alerts of an answer; throws when it is not in that shape, so a count is never guessed.
 * `recent` is kept only when every item is a well-formed alert with its close time; otherwise it is
 * left out (the history is then not shown), and the open list still reads.
 */
export function parseOpenAlerts(body: unknown): OpenAlertsAnswer {
  if (!isRecord(body) || !Array.isArray(body.open) || !body.open.every(isAlert)) throw new Error("the alerts answer is not in the expected shape")
  return Array.isArray(body.recent) && body.recent.every(isRecent) ? { open: body.open, recent: body.recent } : { open: body.open }
}
