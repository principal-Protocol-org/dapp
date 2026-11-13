/**
 * A readable message for anything a call can reject with: an `Error`, a string, or a plain object
 * such as the JSON-RPC error `{ code, message }` the Stellar SDK rejects with. Never "[object Object]".
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error !== null && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    const { message, code } = error as { message: string; code?: unknown }
    return typeof code === "string" || typeof code === "number" ? `${message} (code ${code})` : message
  }
  try {
    const json = JSON.stringify(error)
    if (typeof json === "string") return json
  } catch {
    // circular or otherwise unserializable: fall through
  }
  return String(error) === "[object Object]" ? "unknown error" : String(error)
}

/** The app's words for an overloaded network: every busy message below, and its recognition, derive from it. */
const BUSY = "Stellar network is busy"

/** What the user is shown, in place of the RPC's own text, when the network is overloaded. */
export const RPC_BUSY_MESSAGE = `The ${BUSY}. Try again in a moment.`

/**
 * The same, as the reason inside a sentence that already says what to do next ("Could not read the
 * pool state (the Stellar network is busy). … try again in a moment."), so nothing is said twice.
 */
export const RPC_BUSY_REASON = `the ${BUSY}`

/** stellar-rpc's own overload answer ("preflight queue full; retry later"), and the SDK's HTTP 429/503. */
const RPC_OVERLOAD_TEXT = /preflight queue full|retry later|status code (429|503)\b/i

/** True when `text` already says, in the app's words, that the network is busy (a message wrapped once already). */
export function saysRpcBusy(text: string): boolean {
  return text.toLowerCase().includes(BUSY.toLowerCase())
}

/**
 * True when the RPC answered that it is overloaded: JSON-RPC -32004 ("preflight queue full; retry
 * later", which the Stellar SDK rejects with as a plain `{ code, message }` object), or HTTP 429 or
 * 503 (the SDK's HTTP client: `response.status`, "Request failed with status code 503"). A message
 * that already says so in the app's words (`saysRpcBusy`) counts too, so a wrapped one is still
 * recognized. It only chooses what the user is told: nothing in the app retries on it.
 */
export function isRpcBusy(error: unknown): boolean {
  if (error !== null && typeof error === "object") {
    const { code, response } = error as { code?: unknown; response?: { status?: unknown } | null }
    if (code === -32004) return true
    const status = response?.status
    if (status === 429 || status === 503) return true
  }
  const text = errorMessage(error)
  return RPC_OVERLOAD_TEXT.test(text) || saysRpcBusy(text)
}

/**
 * `errorMessage` as the user reads it: `RPC_BUSY_MESSAGE` for an overloaded RPC, the readable message
 * otherwise. A message that already says the network is busy is kept as it is, so wrapping twice
 * never drops what the first wrap added ("… Nothing was signed.").
 */
export function userErrorMessage(error: unknown): string {
  const text = errorMessage(error)
  if (saysRpcBusy(text)) return text
  return isRpcBusy(error) ? RPC_BUSY_MESSAGE : text
}

/**
 * The failure as the reason inside a sentence, in parentheses or after a colon: `RPC_BUSY_REASON`
 * for an overloaded RPC (the sentence says what to do next), the readable message otherwise.
 */
export function errorReason(error: unknown): string {
  return isRpcBusy(error) ? RPC_BUSY_REASON : errorMessage(error)
}

/**
 * A sentence about a failure: `RPC_BUSY_MESSAGE` (then `afterBusy`, such as "Nothing was signed.")
 * when the RPC is overloaded, so its raw text never reaches the user; `sentence(errorMessage(error))`,
 * the sentence as it always read, for any other failure. Wrapping a busy message again keeps it, and
 * adds `afterBusy` only if it is not there yet.
 */
export function failureSentence(error: unknown, sentence: (message: string) => string, afterBusy?: string): string {
  const text = errorMessage(error)
  if (!isRpcBusy(error)) return sentence(text)
  const busy = saysRpcBusy(text) ? text : RPC_BUSY_MESSAGE
  return afterBusy && !busy.includes(afterBusy) ? `${busy} ${afterBusy}` : busy
}
