/** Helpers every live suite shares, with no dependency on the server code (`tests/integration/local-stack.ts` re-exports them). */

/** Secret keys (S + 55 base32 characters) never reach a log or an error. */
export const redact = (text: unknown) => String(text ?? "").replace(/S[A-Z2-7]{55}/g, "S…[redacted]")

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `read` until `done` holds (Horizon trails RPC by a ledger or two). */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(1_000)
  }
}

/** JSON that survives bigints (results and outcomes carry them). */
export const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))
