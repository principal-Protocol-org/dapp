/**
 * Retries for failures from outside the code under test (plan 0007, Global Constraints).
 *
 * - `retryTransient`: a read or a simulation the RPC did not answer because it was overloaded or
 *   unreachable (`isTransientRpcError`) is asked again, with a short backoff, for up to
 *   `RPC_RETRY_BUDGET_MS`. Nothing is submitted by a read, so asking again is always safe.
 * - `retryOnce`: one retry at the step level for a failure from Friendbot, the RPC's transport and
 *   its 5xx / 429 answers, an overloaded RPC, or a stale sequence number. A step runs a second time
 *   only when nothing of the first run landed, so nothing is ever signed twice; any other failure,
 *   and a second failure, is the result. No assertion is skipped: the second run makes every check
 *   of the first again.
 */
import { errorMessage, isRpcBusy } from "@/lib/protocol/errors"
import { redact, sleep } from "./util"

/** HTTP answers of a restarting RPC or of the gateway in front of it (429 and 503 are `isRpcBusy`'s). */
const TRANSIENT_HTTP_STATUSES = new Set([502, 504])
/** A connection reset or a timeout, as Node or undici name it (on the error, or on its `cause`). */
const TRANSIENT_SOCKET_CODE = /^(ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))$/
const TRANSIENT_TEXT = [
  // The SDK's HTTP client: "Request failed with status code 502".
  /status code (502|504)\b/,
  // The SDK's timeout, Node's fetch and sockets.
  /timeout of \d+ms exceeded|fetch failed|socket hang up|network error/i,
  /\b(ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT))\b/,
]

/**
 * True for an RPC that did not answer because it was busy or unreachable for a moment: overloaded
 * (the app's own `isRpcBusy`: JSON-RPC -32004 "preflight queue full; retry later", which the SDK
 * rejects with as a plain `{ code, message }` object, or HTTP 429 or 503), an HTTP 502 or 504, a
 * connection reset or a timeout. Never
 * for an answer: a contract error, an invalid request (-32602), a 4xx or a 500. Node's fetch reports
 * every network failure as "fetch failed" (the code on `cause`), a refused connection or an unknown
 * host included: that counts as transient, so an RPC that is down fails after the budget, with it.
 */
export function isTransientRpcError(error: unknown, depth = 0): boolean {
  if (isRpcBusy(error)) return true
  if (error !== null && typeof error === "object") {
    const e = error as { code?: unknown; name?: unknown; response?: { status?: unknown }; cause?: unknown }
    if (typeof e.code === "string" && TRANSIENT_SOCKET_CODE.test(e.code)) return true
    if (typeof e.response?.status === "number" && TRANSIENT_HTTP_STATUSES.has(e.response.status)) return true
    if (e.name === "TimeoutError") return true
    // Node's fetch rejects with "fetch failed" and the socket's code on `cause`.
    if (e.cause !== undefined && depth < 3 && isTransientRpcError(e.cause, depth + 1)) return true
  }
  const text = errorMessage(error)
  return TRANSIENT_TEXT.some((pattern) => pattern.test(text))
}

/**
 * How long a read or a simulation is asked again while the RPC is overloaded: the overload of run
 * 43511581261 lasted about a minute (-32004 from 21:54:52 to before 21:55:52). Measured on the wall
 * clock, so an attempt that hangs until the SDK's 20 s timeout counts too; the last attempt may end
 * up to that timeout after the budget.
 */
export const RPC_RETRY_BUDGET_MS = 75_000
/** The waits between attempts: 2, 4, 8, then 15 s each (attempts at about 0, 2, 6, 14, 29, 44, 59 and 74 s). */
export const RPC_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000]

/**
 * `run`, asked again after a transient RPC failure (`isTransientRpcError`) with the backoff above,
 * while the next attempt still starts within `budgetMs` of the first. Every retry is logged with the
 * RPC's answer. Any other failure is thrown at once. When the budget is spent, the error names `what`,
 * the RPC's last answer, the attempts and the time: the cause of whatever fails after it.
 * For reads and simulations only: a submission is never repeated here.
 */
export async function retryTransient<T>(p: {
  what: string
  run: () => Promise<T>
  log?: (line: string) => void
  wait?: (ms: number) => Promise<unknown>
  now?: () => number
  budgetMs?: number
}): Promise<T> {
  const now = p.now ?? Date.now
  const budget = p.budgetMs ?? RPC_RETRY_BUDGET_MS
  const started = now()
  for (let attempt = 1; ; attempt++) {
    try {
      return await p.run()
    } catch (error) {
      if (!isTransientRpcError(error)) throw error
      const answer = redact(errorMessage(error)).slice(0, 300)
      const delay = RPC_BACKOFF_MS[Math.min(attempt, RPC_BACKOFF_MS.length) - 1]
      const spent = now() - started
      if (spent + delay > budget) {
        const exhausted = `${p.what}: the RPC still answered "${answer}" after ${attempt} attempts over ${Math.round(spent / 1_000)} s`
        // Logged too: an app layer may show the user's wording ("The Stellar network is busy…") in its place.
        p.log?.(exhausted)
        throw new Error(exhausted, { cause: error })
      }
      p.log?.(`${p.what}: the RPC answered "${answer}" (attempt ${attempt}); asking again in ${delay / 1_000} s`)
      await (p.wait ?? sleep)(delay)
    }
  }
}

const EXTERNAL = [
  // Friendbot (`fundWithFriendbot`): unreachable, or a server-side answer.
  /Friendbot could not be reached/i,
  /Friendbot could not fund your account \(it answered (429|5\d\d)\)/i,
  // The SDK's HTTP client (RPC, Horizon), and Node's fetch / sockets.
  /status code (429|5\d\d)/i,
  /fetch failed|socket hang up|network error|timeout of \d+ms exceeded/i,
  /\b(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR_[A-Z_]+)\b/,
  // The network did not take the transaction, or took another one from the account first.
  /TRY_AGAIN_LATER|network is busy and did not accept/i,
  /txBadSeq|tx_bad_seq|sequence number changed/i,
  // The app's gates, when a read or the simulation could not reach the RPC, or found it overloaded.
  /The simulation could not run/,
  /The Stellar network is busy/,
  /could not be checked right now/,
  /Could not read .+\(.+\)\. Signing stays off/,
]

/**
 * Everything a failure says: its message (a plain `{ code, message }` object too, through
 * `errorMessage`) and, for an assertion, the value it received.
 */
function failureText(error: unknown): string {
  const message = errorMessage(error)
  const actual = error !== null && typeof error === "object" && "actual" in error ? (error as { actual: unknown }).actual : undefined
  if (actual === undefined) return message
  try {
    return `${message} ${JSON.stringify(actual, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`
  } catch {
    return message
  }
}

/** A failure a second try may clear: from Friendbot, the RPC or the network, not from the code under test. */
export function isExternalFailure(error: unknown): boolean {
  if (isTransientRpcError(error)) return true
  const text = failureText(error)
  return EXTERNAL.some((pattern) => pattern.test(text))
}

/**
 * `run`, and once more after an external failure, `delayMs` later, if `nothingLanded()` confirms
 * the first run left nothing on chain (read after the wait). Otherwise, or when that cannot be told,
 * the first failure is thrown.
 */
export async function retryOnce<T>(p: {
  what: string
  run: () => Promise<T>
  nothingLanded: () => Promise<boolean>
  log?: (line: string) => void
  wait?: (ms: number) => Promise<unknown>
  delayMs?: number
}): Promise<T> {
  try {
    return await p.run()
  } catch (error) {
    if (!isExternalFailure(error)) throw error
    await (p.wait ?? sleep)(p.delayMs ?? 10_000)
    const safe = await p.nothingLanded().catch(() => false)
    if (!safe) throw error
    p.log?.(`${p.what}: ${redact(failureText(error)).slice(0, 400)}; nothing of it landed, so it runs once more`)
    return p.run()
  }
}
