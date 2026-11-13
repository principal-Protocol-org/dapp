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
