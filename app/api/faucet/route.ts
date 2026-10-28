import "server-only"

/**
 * `POST /api/faucet` with `{ account }`: Testnet onboarding (spec §9), the app's only server route.
 * POST handlers are never cached or prerendered (Next 16 route-handler docs), so this always runs
 * at request time; `dynamic` is not exported, as Cache Components removes it.
 *
 * Answers are plain error codes with short messages. Nothing from the chain or the RPC is echoed,
 * and server logs redact anything shaped like a secret key.
 */
import { StrKey } from "@stellar/stellar-sdk"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { FaucetErrorCode, FaucetResponse, FaucetStep } from "@/lib/protocol/onboarding"
import { FAUCET_RATE_LIMIT_MS, FaucetConfigError, FaucetStepError, runFaucet } from "@/lib/server/faucet"

// No `runtime` export: Cache Components runs route handlers on the default Node.js runtime and
// refuses the option. Up to five transactions, each confirmed before the next: allow for a slow ledger.
export const maxDuration = 120

/** `{ "account": "G…" }` is about 70 bytes; anything much larger is not a faucet request. */
const MAX_BODY_BYTES = 1_024
const FALLBACK_IP = "unknown"
const RETRY_AFTER_SECONDS = FAUCET_RATE_LIMIT_MS / 1_000

const STATUS: Record<FaucetErrorCode, number> = {
  invalid_account: 400,
  network: 403,
  no_trustline: 409,
  rate_limited: 429,
  failed: 502,
  not_configured: 503,
}

const MESSAGES: Record<FaucetErrorCode, string> = {
  invalid_account: "The request must be JSON with a Stellar account address (G…) in \"account\".",
  network: "Get test tokens runs only on Testnet or a local network.",
  no_trustline: "The account does not exist or has no trustline to the test asset yet. Fund it and add the trustline first.",
  rate_limited: `Get test tokens was used for this account or from this connection less than a minute ago. Try again in ${RETRY_AFTER_SECONDS} seconds.`,
  failed: "Get test tokens could not finish: a network transaction did not go through. Steps already done are kept; try again in a minute.",
  not_configured: "Get test tokens is not set up on this server.",
}

function reply(body: FaucetResponse, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })
}

function refuse(error: FaucetErrorCode, extra: { step?: FaucetStep } = {}): Response {
  const body: FaucetResponse = { error, message: MESSAGES[error], ...extra }
  if (error === "rate_limited") {
    return reply({ ...body, retryAfterSeconds: RETRY_AFTER_SECONDS }, STATUS[error], { "Retry-After": String(RETRY_AFTER_SECONDS) })
  }
  return reply(body, STATUS[error])
}

/** The account from a small JSON body, or null for anything else. */
async function accountFrom(request: Request): Promise<string | null> {
  // Refuse a declared oversize body before reading it; the length is checked again once read.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null
  let text: string
  try {
    text = await request.text()
  } catch {
    return null
  }
  if (text.length > MAX_BODY_BYTES) return null
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

/** The first `x-forwarded-for` hop (set by the platform's proxy), else one shared fallback key. */
function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return first ? first.slice(0, 64) : FALLBACK_IP
}

/** Server logs only: a Stellar secret key (S…) is never written, whatever an error carries. */
function redact(text: string): string {
  return text.replace(/S[A-Z2-7]{55}/g, "[redacted]")
}

export async function POST(request: Request): Promise<Response> {
  const account = await accountFrom(request)
  if (!account) return refuse("invalid_account")

  try {
    const result = await runFaucet({ account, manifest: activeManifest(), ip: clientIp(request), now: Date.now() })
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
