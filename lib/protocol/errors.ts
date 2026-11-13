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

/** What the user is shown, in place of the RPC's own text, when the network is overloaded. */
export const RPC_BUSY_MESSAGE = "The Stellar network is busy. Try again in a moment."

/** stellar-rpc's overload answer, the SDK's HTTP 429/503, and a message that already says so. */
const RPC_BUSY_TEXT = /preflight queue full|retry later|status code (429|503)\b|The Stellar network is busy/i

/**
 * True when the RPC answered that it is overloaded: JSON-RPC -32004 ("preflight queue full; retry
 * later", which the Stellar SDK rejects with as a plain `{ code, message }` object), or HTTP 429 or
 * 503 (the SDK's HTTP client: `response.status`, "Request failed with status code 503"). A message
 * that already reads `RPC_BUSY_MESSAGE` counts too, so a wrapped one is still recognized. It only
 * chooses what the user is told: nothing in the app retries on it.
 */
export function isRpcBusy(error: unknown): boolean {
  if (error !== null && typeof error === "object") {
    const { code, response } = error as { code?: unknown; response?: { status?: unknown } | null }
    if (code === -32004) return true
    const status = response?.status
    if (status === 429 || status === 503) return true
  }
  return RPC_BUSY_TEXT.test(errorMessage(error))
}

/** `errorMessage` as the user reads it: `RPC_BUSY_MESSAGE` for an overloaded RPC, the readable message otherwise. */
export function userErrorMessage(error: unknown): string {
  return isRpcBusy(error) ? RPC_BUSY_MESSAGE : errorMessage(error)
}

/**
 * A sentence about a failure: `RPC_BUSY_MESSAGE` (then `afterBusy`, such as "Nothing was signed.")
 * when the RPC is overloaded, so its raw text never reaches the user; `sentence(errorMessage(error))`,
 * the sentence as it always read, for any other failure.
 */
export function failureSentence(error: unknown, sentence: (message: string) => string, afterBusy?: string): string {
  if (isRpcBusy(error)) return afterBusy ? `${RPC_BUSY_MESSAGE} ${afterBusy}` : RPC_BUSY_MESSAGE
  return sentence(errorMessage(error))
}
