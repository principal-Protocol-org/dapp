/**
 * One retry at the step level for a failure from outside the code under test (plan 0007, Global
 * Constraints): Friendbot, the RPC's transport and its 5xx / 429 answers, a stale sequence number.
 * A step runs a second time only when nothing of the first run landed, so nothing is ever signed
 * twice; any other failure, and a second failure, is the result. No assertion is skipped: the
 * second run makes every check of the first again.
 */
import { redact, sleep } from "./util"

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
  // The app's gates, when a read or the simulation could not reach the RPC.
  /The simulation could not run/,
  /could not be checked right now/,
  /Could not read .+\(.+\)\. Signing stays off/,
]

/** Everything a failure says: its message and, for an assertion, the value it received. */
function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
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
