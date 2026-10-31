import "server-only"

/**
 * Request guards shared by the app's POST routes (`/api/faucet`, `/api/markets`), moved out of the
 * faucet route unchanged (0001 rulings R42/R42c): same-origin JSON only, a streamed body with a
 * byte cap, the client's IP key, and rolling per-instance budgets taken with no await between the
 * check and the take.
 */

/** The rightmost non-empty entry of a comma-separated header: the hop the nearest proxy added. */
function lastHop(value: string | null): string | undefined {
  const hops = (value ?? "").split(",").map((hop) => hop.trim()).filter(Boolean)
  return hops.at(-1)?.slice(0, 64)
}

const FALLBACK_IP = "unknown"

/**
 * The rate-limit key for the client (R42). Trust assumption: the app is deployed on Vercel (Task 25),
 * whose edge sets `x-vercel-forwarded-for` and `x-real-ip` itself, so a client cannot choose them.
 * Behind another proxy, that proxy must overwrite these headers; the rightmost `x-forwarded-for`
 * hop is then the one the nearest proxy appended (the leftmost is whatever the client sent). With
 * none of them, every request shares one fallback key. A per-instance global cap bounds the
 * damage of a spoofed key either way.
 */
export function clientIp(request: Request): string {
  const h = request.headers
  return lastHop(h.get("x-vercel-forwarded-for")) ?? lastHop(h.get("x-real-ip")) ?? lastHop(h.get("x-forwarded-for")) ?? FALLBACK_IP
}

/** Only `application/json` (parameters such as a charset allowed): a plain HTML form cannot send it. */
export function isJson(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  return type === "application/json"
}

/**
 * Browsers send `Sec-Fetch-Site`; anything but `same-origin` is another site (or a typed URL)
 * driving the visitor's browser. Clients without the header (scripts, tests) are not browsers and
 * meet every other check.
 */
export function isCrossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site")
  return site !== null && site !== "same-origin"
}

/**
 * The body as text, read as a stream: bytes are counted as they arrive and the stream is cancelled
 * as soon as the total passes `maxBytes`, so an oversized or endless body is never buffered (R42).
 * A declared oversize `content-length` is refused before reading anything.
 */
export async function readBody(request: Request, maxBytes: number): Promise<{ text: string } | "too_large" | "unreadable"> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return "too_large"
  if (!request.body) return { text: "" }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
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

/** Server logs only: a Stellar secret key (S…) is never written, whatever an error carries. */
export function redact(text: string): string {
  return text.replace(/S[A-Z2-7]{55}/g, "[redacted]")
}

/**
 * Rolling per-instance budgets in the faucet's style (R42, R42c): at most `perKey` accepted
 * requests per key and `global` in all, in any `windowMs`. `take` checks and records in one
 * synchronous step, so concurrent requests cannot both take the last slot; a refused request does
 * not restart its window. Best effort: one instance only.
 */
export function createRollingLimiter(limits: { windowMs: number; perKey: number; global: number }) {
  let byKey = new Map<string, number[]>()
  let all: number[] = []
  const live = (times: number[], now: number) => times.filter((at) => now - at < limits.windowMs)
  return {
    take(key: string, now: number): boolean {
      all = live(all, now)
      const mine = live(byKey.get(key) ?? [], now)
      if (mine.length >= limits.perKey || all.length >= limits.global) return false
      mine.push(now)
      all.push(now)
      byKey.set(key, mine)
      for (const [k, times] of byKey) if (live(times, now).length === 0) byKey.delete(k)
      return true
    },
    reset(): void {
      byKey = new Map()
      all = []
    },
  }
}
