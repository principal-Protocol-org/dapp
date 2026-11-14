/**
 * Client-visible alert types (no `server-only`), shared by the alerts API (spec 0004 D-20, Task 9) and
 * the dashboard. The API answers `GET /api/dashboard/alerts` with at least `{ open: Alert[] }`.
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

/** The part of `GET /api/dashboard/alerts` the dashboard reads. */
export type OpenAlertsAnswer = { open: Alert[] }

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

/** The open alerts of an answer; throws when it is not in that shape, so a count is never guessed. */
export function parseOpenAlerts(body: unknown): OpenAlertsAnswer {
  if (!isRecord(body) || !Array.isArray(body.open) || !body.open.every(isAlert)) throw new Error("the alerts answer is not in the expected shape")
  return { open: body.open }
}
