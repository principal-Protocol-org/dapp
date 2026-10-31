import "server-only"

/**
 * `/api/markets` (spec 0002 §1).
 *
 * - `GET`: the markets clients see — the manifest seeds and the valid registry rows; the seeds
 *   alone when the database is down. Read from the cached verdicts, never validated inline (R2-36).
 * - `POST { pool }`: the wizard's step 7. The pool is validated first (topology, wiring, pinned
 *   Wasm); only a valid market is written, as `published`, so it lists at the next page load. An
 *   invalid pool is 422 with the reason, an unverifiable one (the RPC failed) 503; nothing is
 *   written for either. Same-origin JSON only, a 1 KiB body, rate-limited per IP and per instance
 *   (the faucet's approach, R42/R42c).
 *
 * `connection()` keeps GET out of the build's prerender: without it a database that is down at
 * build time would bake the seeds into a static response.
 */
import { StrKey } from "@stellar/stellar-sdk"
import { connection } from "next/server"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer } from "@/lib/protocol/stellar"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { PUBLISH_WINDOW_MS, publishMarket, resolvedMarkets, sqlRegistryStore, takePublishSlot } from "@/lib/server/registry"
import { clientIp, isCrossSite, isJson, readBody } from "@/lib/server/request"

// ~40 simulations and ledger-entry reads for one pool.
export const maxDuration = 30

/** `{ "pool": "C…" }` is about 70 bytes. */
const MAX_BODY_BYTES = 1_024
const RETRY_AFTER_SECONDS = PUBLISH_WINDOW_MS / 1_000

type ErrorCode =
  | "cross_site"
  | "invalid_content_type"
  | "request_too_large"
  | "invalid_pool"
  | "rate_limited"
  | "invalid_market"
  | "unverified"
  | "not_configured"
  | "failed"

const STATUS: Record<ErrorCode, number> = {
  cross_site: 403,
  invalid_content_type: 415,
  request_too_large: 413,
  invalid_pool: 400,
  rate_limited: 429,
  invalid_market: 422,
  unverified: 503,
  not_configured: 503,
  failed: 500,
}

const MESSAGES: Record<ErrorCode, string> = {
  cross_site: "Markets can only be published from this app's own pages.",
  invalid_content_type: "The request must be sent as application/json.",
  request_too_large: `The request body is larger than ${MAX_BODY_BYTES} bytes; send only { "pool": "C…" }.`,
  invalid_pool: 'The request must be JSON with a pool contract address (C…) in "pool".',
  rate_limited: `Too many markets were published from this connection, or from this server, in the last minute. Try again in ${RETRY_AFTER_SECONDS} seconds.`,
  invalid_market: "This pool is not a market this app can list. The reason says what to fix.",
  unverified: "The network could not be read to check this pool. Try again in a minute.",
  not_configured: "Publishing markets is not set up on this server (no database).",
  failed: "Publishing failed. Try again in a minute.",
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } })

function refuse(error: ErrorCode, extra: { reason?: string } = {}): Response {
  const retry = error === "rate_limited" || error === "unverified" ? { "Retry-After": String(RETRY_AFTER_SECONDS) } : undefined
  return json({ error, message: MESSAGES[error], ...extra }, STATUS[error], retry)
}

function poolFrom(text: string): string | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const pool = (body as Record<string, unknown>).pool
  return typeof pool === "string" && StrKey.isValidContract(pool) ? pool : null
}

export async function GET(): Promise<Response> {
  await connection()
  const manifest = activeManifest()
  const markets = await resolvedMarkets({ store: sqlRegistryStore(sql), manifest })
  return json({ markets })
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) return refuse("cross_site")
  if (!isJson(request)) return refuse("invalid_content_type")
  const body = await readBody(request, MAX_BODY_BYTES)
  if (body === "too_large") return refuse("request_too_large")
  const pool = body === "unreadable" ? null : poolFrom(body.text)
  if (!pool) return refuse("invalid_pool")
  // Taken before any read: a refused request costs no RPC call.
  if (!takePublishSlot(clientIp(request), Date.now())) return refuse("rate_limited")

  const manifest = activeManifest()
  try {
    const outcome = await publishMarket(
      { store: sqlRegistryStore(sql), reader: createRpcReader(manifest), rpc: createRpcServer(manifest.rpcUrl), manifest },
      pool,
    )
    if (outcome.status === "valid") return json({ market: outcome.market })
    if (outcome.status === "invalid") return refuse("invalid_market", { reason: outcome.reason })
    return refuse("unverified", { reason: outcome.reason })
  } catch (error) {
    if (error instanceof DatabaseConfigError) return refuse("not_configured")
    console.error("markets route: publish failed:", error instanceof Error ? error.name : "unknown")
    return refuse("failed")
  }
}
