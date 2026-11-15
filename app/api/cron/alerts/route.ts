import "server-only"

/**
 * `GET` or `POST /api/cron/alerts`: the alert check (spec 0004 D-12, D-20), scheduled every 5 minutes.
 * Same callers and checks as the other cron routes (`cronAuthorized`); any other caller gets 401 and
 * nothing runs.
 *
 * Each run reads the oracle at the latest ledger time, RiskControl, every pause, the keeper's runs,
 * the indexed rejections, the index cursors and the keeper signer's XLM, then opens and closes the
 * alerts in the `alerts` table (each opens once and closes once) and posts every opening and close to
 * `ALERT_WEBHOOK_URL` (5 s per post; a failed post is sent again by the next run). It answers 500
 * while a critical alert is open (`oracle_stale`, `oracle_unavailable` once a run 120 s or more after it opened confirms it,
 * `keeper_unhealthy`, `risk_exhausted`, `indexer_gap`), so the scheduler's own failure alert fires
 * too; 200 otherwise.
 *
 * `?test=1` only sends a clearly marked test alert, stores it (`test = true`, resolved at once: the
 * alert-test evidence) and answers 200 when the webhook took it, 502 when it did not.
 *
 * 503 `not_configured` without `ALERT_WEBHOOK_URL` (an http or https URL) or `DATABASE_URL`, and
 * while the Mainnet manifest is the pending stub (D-24). The
 * webhook URL is never logged or answered: the poster keeps it in its closure, errors are logged by
 * name, and the answer carries post failures as a count.
 */
import { runAlertCheck, sendTestAlert, webhookPoster } from "@/lib/server/alerts"
import { cronAuthorized, cronJson as json } from "@/lib/server/cron-auth"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { deployedManifest } from "@/lib/server/mainnet-pending"

// About 25 contract reads, a Horizon read and a few queries side by side (all done by 30 s), the
// state written, then posts that all end by 50 s (alerts.ts READ_BUDGET_MS, POST_DEADLINE_MS).
export const maxDuration = 60

/** The webhook URL when it is an http(s) URL; never logged. */
function webhookUrl(): string | null {
  const raw = process.env.ALERT_WEBHOOK_URL?.trim()
  if (!raw) return null
  try {
    const { protocol } = new URL(raw)
    return protocol === "https:" || protocol === "http:" ? raw : null
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  // The run's clock starts here: the reads and the posts are budgeted from it (maxDuration 60 s).
  const startedAt = Date.now()
  if (!(await cronAuthorized(request))) return json({ error: "unauthorized" }, 401)

  const url = webhookUrl()
  const database = Boolean(process.env.DATABASE_URL?.trim())
  if (!url || !database) {
    const missing = [!url && "ALERT_WEBHOOK_URL (an http or https URL)", !database && "DATABASE_URL"].filter(Boolean).join(" and ")
    console.error(`alert check: not configured: set ${missing}`)
    return json({ error: "not_configured" }, 503)
  }
  const test = new URL(request.url).searchParams.get("test") === "1"

  try {
    const manifest = deployedManifest()
    if (manifest instanceof Response) return manifest
    const post = webhookPoster(url)
    if (test) {
      const sent = await sendTestAlert(sql, manifest.network, post, Date.now())
      return json({ test: sent }, sent.delivered ? 200 : 502)
    }
    const result = await runAlertCheck({ sql, manifest, env: process.env, post, startedAt })
    if (result.unread.length > 0) console.warn(`alert check: could not read ${result.unread.join(", ")}; their alerts are kept as they were`)
    return json(result, result.critical ? 500 : 200)
  } catch (error) {
    if (error instanceof DatabaseConfigError) return json({ error: "not_configured" }, 503)
    // Only the error's name: RPC, Horizon and database text may carry a URL.
    console.error("alert check failed:", error instanceof Error ? error.name : "unknown")
    return json({ error: "failed" }, 500)
  }
}

/** QStash schedules call with POST unless told otherwise: the same handler, the same checks. */
export const POST = GET
