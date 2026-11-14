import "server-only"

/**
 * `GET` or `POST /api/cron/index`: the event indexer (spec 0004 D-13 to D-15), scheduled every
 * 5 minutes. Same callers and checks as `cron/record`: Vercel Cron (`Authorization: Bearer
 * $CRON_SECRET`) or an Upstash QStash schedule (`Upstash-Signature`, `POST` by default); any other
 * caller gets 401 and nothing runs. The answer is the `IndexResult`: rows inserted, each group's
 * indexed-through ledger, gap and completeness, and the RecoveryEscrow reconciliation. A group the
 * RPC failed answers 500 so the scheduler alerts; a missing `DATABASE_URL` answers 503.
 *
 * It reads the request and touches the network, so under Cache Components it runs at request time
 * and is never prerendered. No `runtime` export: the default Node.js runtime.
 */
import { activeManifest } from "@/lib/protocol/manifest-source"
import { createRpcServer } from "@/lib/protocol/stellar"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { cronAuthorized, cronJson as json } from "@/lib/server/cron-auth"
import { indexEvents } from "@/lib/server/indexer"
import { resolvedMarkets, sqlRegistryStore } from "@/lib/server/registry"

// Pages of 200 events per group until the deadline, then one record_count read per escrow.
export const maxDuration = 60

/** The indexer's budget: no page starts after it, leaving time to answer within `maxDuration`. */
const BUDGET_MS = 50_000
/** The registry read may wait for a cold database (as the recorder's does), or new markets would lag. */
const ROWS_TIMEOUT_MS = 10_000

export async function GET(request: Request) {
  if (!(await cronAuthorized(request))) return json({ error: "unauthorized" }, 401)

  const deadline = Date.now() + BUDGET_MS
  const manifest = activeManifest()
  try {
    const markets = await resolvedMarkets({ store: sqlRegistryStore(sql), manifest, timeoutMs: ROWS_TIMEOUT_MS })
    const result = await indexEvents({ sql, rpc: createRpcServer(manifest.rpcUrl), manifest, markets }, { deadline })
    return json(result, result.groups.some((g) => g.error) ? 500 : 200)
  } catch (error) {
    if (error instanceof DatabaseConfigError) return json({ error: "not_configured" }, 503)
    // Only the error's name: RPC and database text may carry a provider URL.
    console.error("index route failed:", error instanceof Error ? error.name : "unknown")
    return json({ error: "failed" }, 500)
  }
}

/** QStash schedules call with POST unless told otherwise: the same handler, the same checks. */
export const POST = GET
