import "server-only"

/**
 * Who may run a cron route (`/api/cron/*`): Vercel Cron (`Authorization: Bearer $CRON_SECRET`) or an
 * Upstash QStash schedule (`Upstash-Signature`). Any other caller is refused and nothing runs.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import { Receiver } from "@upstash/qstash"

const sha256 = (value: string) => createHash("sha256").update(value).digest()

/** Constant-time: both sides are hashed to equal length before `timingSafeEqual`. */
function bearerMatches(header: string | null): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret || !header?.startsWith("Bearer ")) return false
  return timingSafeEqual(sha256(header.slice("Bearer ".length)), sha256(secret))
}

/**
 * A QStash signature is bound to the URL it was sent to, so it is checked against the URL this
 * request came in on (R2-29, amended): a signature issued for another destination of the same QStash
 * account fails. On Vercel the platform sets the host, and a request reaches this deployment only
 * through one of its own domains, so Production, testnet and previews all work with no variable to
 * set. Off Vercel (`VERCEL` unset), a proxy could pass a client's Host header through and let the
 * caller choose that URL, so the QStash path refuses there; the Bearer path still works.
 * It reads the request body.
 */
async function signatureValid(request: Request): Promise<boolean> {
  const signature = request.headers.get("upstash-signature")
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY
  if (process.env.VERCEL !== "1" || !signature || !currentSigningKey || !nextSigningKey) return false
  try {
    return await new Receiver({ currentSigningKey, nextSigningKey }).verify({
      signature,
      body: await request.text(),
      url: request.url,
    })
  } catch {
    return false
  }
}

/** Whether a scheduler sent this request: a matching bearer secret or a valid QStash signature. */
export async function cronAuthorized(request: Request): Promise<boolean> {
  return bearerMatches(request.headers.get("authorization")) || (await signatureValid(request))
}

/** A cron route's JSON answer, never cached. */
export const cronJson = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })
