import "server-only"

/**
 * `GET /api/dashboard/events`: the indexed protocol events (spec 0004 D-13), public, no wallet.
 *
 * - List: `?group=escrow|oracle|permissioning|risk|market`, `?pool=<C…>`, `?before=<event id>`
 *   (older rows, for paging) and `?limit=1..200` (50 by default). The answer is
 *   `{ rows, indexedThrough, lagSeconds }`, newest first. Rows never carry the raw XDR.
 * - One event: `?id=<event id>` answers `{ event }` with its `rawXdr` (base64 `ScVal`), for the
 *   How-to-verify drawer; 404 when the index does not hold it.
 *
 * Bad input is 400. A database answer is cached 60 s at the edge; errors are never cached (503
 * `not_configured` without `DATABASE_URL`, 503 `unavailable` when the database fails). It reads the
 * request, so under Cache Components it runs at request time.
 */
import { activeManifest } from "@/lib/protocol/manifest-source"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { getIndexedEvent, getIndexedEvents, INDEX_GROUPS, type IndexGroup } from "@/lib/server/indexer"

const CACHED = "public, s-maxage=60, stale-while-revalidate=300"

const json = (body: unknown, status = 200, cache = "no-store") =>
  Response.json(body, { status, headers: { "cache-control": cache } })

const POOL = /^C[A-Z2-7]{55}$/
/** An RPC event id: a 19-digit TOID and a 10-digit event index. */
const EVENT_ID = /^\d{19}-\d{10}$/
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

type ListQuery = { group?: IndexGroup; pool?: string; before?: string; limit: number }

/** The list query, or the 400 error code of its first bad parameter. */
function listQuery(params: URLSearchParams): ListQuery | { error: string } {
  const group = params.get("group")
  const pool = params.get("pool")
  const before = params.get("before")
  const limit = params.get("limit")
  if (group !== null && !INDEX_GROUPS.includes(group as IndexGroup)) return { error: "invalid_group" }
  if (pool !== null && !POOL.test(pool)) return { error: "invalid_pool" }
  if (before !== null && !EVENT_ID.test(before)) return { error: "invalid_before" }
  if (limit !== null && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_LIMIT)) return { error: "invalid_limit" }
  return {
    ...(group !== null ? { group: group as IndexGroup } : {}),
    ...(pool !== null ? { pool } : {}),
    ...(before !== null ? { before } : {}),
    limit: limit === null ? DEFAULT_LIMIT : Number(limit),
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const id = params.get("id")
  if (id !== null && !EVENT_ID.test(id)) return json({ error: "invalid_id" }, 400)
  const query = id === null ? listQuery(params) : null
  if (query && "error" in query) return json({ error: query.error }, 400)

  const network = activeManifest().network
  try {
    if (id !== null) {
      const event = await getIndexedEvent(sql, { network, id })
      return event ? json({ event }, 200, CACHED) : json({ error: "not_found" }, 404)
    }
    return json(await getIndexedEvents(sql, { network, ...(query as ListQuery) }), 200, CACHED)
  } catch (error) {
    if (error instanceof DatabaseConfigError) return json({ error: "not_configured" }, 503)
    console.error("dashboard events route:", error instanceof Error ? error.name : "unknown")
    return json({ error: "unavailable" }, 503)
  }
}
