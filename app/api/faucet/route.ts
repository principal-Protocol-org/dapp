import "server-only"

/**
 * `POST /api/faucet` with `{ account }`: Testnet onboarding (spec §9), the app's only server route.
 * POST handlers are never cached or prerendered (Next 16 route-handler docs), so this always runs
 * at request time; `dynamic` is not exported, as Cache Components removes it.
 *
 * Answers are plain error codes with short messages. Nothing from the chain or the RPC is echoed,
 * and server logs redact anything shaped like a secret key. Only same-origin JSON requests are
 * served: a cross-site page cannot make a visitor's browser trigger a run (minor 5).
 */
import { StrKey } from "@stellar/stellar-sdk"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { FaucetErrorCode, FaucetResponse, FaucetStep } from "@/lib/protocol/onboarding"
import { sql } from "@/lib/server/db"
import { FAUCET_RATE_LIMIT_MS, FaucetConfigError, FaucetStepError, runFaucet } from "@/lib/server/faucet"
import { resolvedMarkets, sqlRegistryStore } from "@/lib/server/registry"
import { clientIp, isCrossSite, isJson, readBody, redact } from "@/lib/server/request"

// No `runtime` export: Cache Components runs route handlers on the default Node.js runtime and
// refuses the option. Up to five transactions, each confirmed before the next: allow for a slow ledger.
export const maxDuration = 120

/** `{ "account": "G…" }` is about 70 bytes; anything much larger is not a faucet request. */
const MAX_BODY_BYTES = 1_024
const RETRY_AFTER_SECONDS = FAUCET_RATE_LIMIT_MS / 1_000

const STATUS: Record<FaucetErrorCode, number> = {
  invalid_account: 400,
  cross_site: 403,
  invalid_content_type: 415,
  request_too_large: 413,
  network: 403,
  no_trustline: 409,
  rate_limited: 429,
  busy: 503,
  failed: 502,
  not_configured: 503,
}

const MESSAGES: Record<FaucetErrorCode, string> = {
  invalid_account: "The request must be JSON with a Stellar account address (G…) in \"account\".",
  request_too_large: `The request body is larger than ${MAX_BODY_BYTES} bytes; send only { "account": "G…" }.`,
  invalid_content_type: "The request must be sent as application/json.",
  cross_site: "Get test tokens can only be requested from this app's own pages.",
  network: "Get test tokens runs only on Testnet or a local network.",
  no_trustline: "The account does not exist or has no trustline to the test asset yet. Fund it and add the trustline first.",
  rate_limited: `Get test tokens was used for this account or from this connection less than a minute ago, or is busy with other requests. Try again in ${RETRY_AFTER_SECONDS} seconds.`,
  busy: "The faucet is busy — try again in a minute.",
  // Neutral: a failed read or a timeout is not necessarily a refused transaction (minor 6).
  failed: "The faucet could not finish — try again in a minute. Steps already done are kept.",
  not_configured: "Get test tokens is not set up on this server.",
}

function reply(body: FaucetResponse, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })
}

function refuse(error: FaucetErrorCode, extra: { step?: FaucetStep } = {}): Response {
  const body: FaucetResponse = { error, message: MESSAGES[error], ...extra }
  if (error === "rate_limited" || error === "busy") {
    return reply({ ...body, retryAfterSeconds: RETRY_AFTER_SECONDS }, STATUS[error], { "Retry-After": String(RETRY_AFTER_SECONDS) })
  }
  return reply(body, STATUS[error])
}

/** The account from a small JSON body, or null for anything else. */
function accountFrom(text: string): string | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const account = (body as Record<string, unknown>).account
  return typeof account === "string" && StrKey.isValidEd25519PublicKey(account) ? account : null
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) return refuse("cross_site")
  if (!isJson(request)) return refuse("invalid_content_type")
  const body = await readBody(request, MAX_BODY_BYTES)
  if (body === "too_large") return refuse("request_too_large")
  const account = body === "unreadable" ? null : accountFrom(body.text)
  if (!account) return refuse("invalid_account")

  try {
    // The faucet grants every listed market's PT and YT, and the dialog checks every listed market
    // (R44): both read the same resolved list (seeds when the database is down).
    const manifest = activeManifest()
    const markets = await resolvedMarkets({ store: sqlRegistryStore(sql), manifest })
    const result = await runFaucet({ account, manifest: { ...manifest, markets }, ip: clientIp(request), now: Date.now() })
    if ("error" in result) return refuse(result.error)
    return reply({ performed: result.performed })
  } catch (error) {
    if (error instanceof FaucetConfigError) {
      console.error(`faucet: not configured: ${redact(error.message)}`)
      return refuse("not_configured")
    }
    const step = error instanceof FaucetStepError ? error.step : undefined
    console.error(`faucet: failed${step ? ` at ${step}` : ""}: ${redact(error instanceof Error ? error.message : String(error))}`)
    return refuse("failed", step ? { step } : {})
  }
}
