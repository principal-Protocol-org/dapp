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
  request_too_large: 413,
  network: 403,
  no_trustline: 409,
  rate_limited: 429,
  failed: 502,
  not_configured: 503,
}

const MESSAGES: Record<FaucetErrorCode, string> = {
  invalid_account: "The request must be JSON with a Stellar account address (G…) in \"account\".",
  request_too_large: `The request body is larger than ${MAX_BODY_BYTES} bytes; send only { "account": "G…" }.`,
  network: "Get test tokens runs only on Testnet or a local network.",
  no_trustline: "The account does not exist or has no trustline to the test asset yet. Fund it and add the trustline first.",
  rate_limited: `Get test tokens was used for this account or from this connection less than a minute ago, or is busy with other requests. Try again in ${RETRY_AFTER_SECONDS} seconds.`,
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

/**
 * The body as text, read as a stream: bytes are counted as they arrive and the stream is cancelled
 * as soon as the total passes `MAX_BODY_BYTES`, so an oversized or endless body is never buffered
 * (R42). A declared oversize `content-length` is refused before reading anything.
 */
async function readBody(request: Request): Promise<{ text: string } | "too_large" | "unreadable"> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return "too_large"
  if (!request.body) return { text: "" }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        return "too_large"
      }
      chunks.push(value)
    }
  } catch {
    return "unreadable"
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
  } catch {
    return "unreadable"
  }
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

/** The rightmost non-empty entry of a comma-separated header: the hop the nearest proxy added. */
function lastHop(value: string | null): string | undefined {
  const hops = (value ?? "").split(",").map((hop) => hop.trim()).filter(Boolean)
  return hops.at(-1)?.slice(0, 64)
}

/**
 * The rate-limit key for the client (R42). Trust assumption: the app is deployed on Vercel (Task 25),
 * whose edge sets `x-vercel-forwarded-for` and `x-real-ip` itself, so a client cannot choose them.
 * Behind another proxy, that proxy must overwrite these headers; the rightmost `x-forwarded-for`
 * hop is then the one the nearest proxy appended (the leftmost is whatever the client sent). With
 * none of them, every request shares one fallback key. The per-instance global cap in `runFaucet`
 * bounds the damage of a spoofed key either way.
 */
function clientIp(request: Request): string {
  const h = request.headers
  return lastHop(h.get("x-vercel-forwarded-for")) ?? lastHop(h.get("x-real-ip")) ?? lastHop(h.get("x-forwarded-for")) ?? FALLBACK_IP
}

/** Server logs only: a Stellar secret key (S…) is never written, whatever an error carries. */
function redact(text: string): string {
  return text.replace(/S[A-Z2-7]{55}/g, "[redacted]")
}

export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request)
  if (body === "too_large") return refuse("request_too_large")
  const account = body === "unreadable" ? null : accountFrom(body.text)
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
