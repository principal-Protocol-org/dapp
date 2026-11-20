/**
 * The read load on one RPC (spec 0005 M-20, ruling R9-4). A third-party gateway answers "busy" or 429
 * to a burst, from a browser tab and from a server job alike, so every simulation goes through one
 * limiter: at most `RPC_CONCURRENCY` at a time, the rest queued in arrival order. The state is this
 * module's own, so there is one limiter per browser tab and one per server process. Identical reads
 * in flight share one request (`shareInFlight`). Framework-free: browser and Node.
 */

/** At most this many RPC requests at a time, per tab in the browser and per process on the server. */
export const RPC_CONCURRENCY = 6

let running = 0
/** Runs waiting for a slot, first come first served; each is handed the slot of the run that ends. */
const waiting: (() => void)[] = []

function acquire(): Promise<void> | undefined {
  if (running < RPC_CONCURRENCY) {
    running++
    return undefined
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function release(): void {
  const next = waiting.shift()
  // The slot passes straight to the next in line, so a newcomer cannot take it first.
  if (next) next()
  else running--
}

/**
 * `run`, once fewer than `RPC_CONCURRENCY` limited runs are in progress; the others wait in arrival
 * order. A run that rejects (or throws) frees its slot like one that resolves.
 */
export async function limitRpc<T>(run: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await run()
  } finally {
    release()
  }
}

const inFlight = new Map<string, Promise<unknown>>()

/**
 * `run`, unless an identical request (same `key`) is still in flight: then that request's answer, or
 * its failure. The key is forgotten as soon as the request settles, so a later read asks afresh. Put
 * it outside `limitRpc`, so a duplicate shares a request still waiting for its slot.
 */
export function shareInFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const shared = inFlight.get(key)
  if (shared) return shared as Promise<T>
  const request = (async () => run())()
  const forget = () => {
    if (inFlight.get(key) === request) inFlight.delete(key)
  }
  // Forget on either outcome; the callers handle the outcome itself.
  request.then(forget, forget)
  inFlight.set(key, request)
  return request
}

/**
 * A write boundary: call it once a transaction has landed, before refreshing reads. A read sent
 * before the write may answer with the state from before it, so no later read joins one: those
 * still in flight keep answering the callers that already joined them, and the next identical read
 * makes its own request.
 */
export function forgetInFlight(): void {
  inFlight.clear()
}

/**
 * A request's identity as text, for `shareInFlight`: the RPC URL, then what makes the call (contract,
 * function, arguments, a simulation's source). Bigints at any depth (a struct argument's fields) are
 * tagged, so they neither throw nor equal the same digits as a string.
 */
export function requestKey(...parts: unknown[]): string {
  return JSON.stringify(parts, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))
}
