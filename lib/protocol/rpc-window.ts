/**
 * The RPC's ledger window (its oldest and latest ledger).
 *
 * `getHealth` is asked first. A keyed provider may not offer it (dRPC answers HTTP 400 through the SDK,
 * JSON-RPC -32601 "the method getHealth does not exist/is not available"); only then the window comes
 * from `getLedgers`, whose answer carries `oldestLedger` and `latestLedger`. Any other `getHealth`
 * failure is thrown as it is.
 */

/**
 * `getLedgers` is asked a little behind `getLatestLedger`: behind a load balancer the ledger just
 * reported may not be stored on the backend that answers ("Unknown block"), which refuses it.
 */
const LEDGERS_BEHIND = 20

export type RpcWindow = { oldestLedger: number; latestLedger: number }

/** The calls `readRpcWindow` makes: the SDK's `rpc.Server` satisfies it, tests inject a fake. */
export type RpcWindowSource = {
  getHealth(): Promise<RpcWindow>
  getLatestLedger?(): Promise<{ sequence: number }>
  getLedgers?(req: { startLedger: number; pagination: { limit: number } }): Promise<RpcWindow & { ledgers?: unknown[] }>
}

/** True when the RPC does not offer the method: HTTP 400 or JSON-RPC -32601. */
export function isMethodUnsupported(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown; data?: { error?: { code?: unknown } } }; message?: unknown } | null
  if (!e || typeof e !== "object") return false
  if (e.response?.status === 400 || e.status === 400) return true
  if (e.code === -32601 || e.response?.data?.error?.code === -32601) return true
  return typeof e.message === "string" && (/-32601/.test(e.message) || /does not exist\/is not available/.test(e.message))
}

function windowOf(r: { oldestLedger?: unknown; latestLedger?: unknown }): RpcWindow {
  const { oldestLedger, latestLedger } = r
  if (!Number.isInteger(oldestLedger) || !Number.isInteger(latestLedger)) throw new Error("the RPC's ledger window could not be read")
  return { oldestLedger: oldestLedger as number, latestLedger: latestLedger as number }
}

export async function readRpcWindow(rpc: RpcWindowSource): Promise<RpcWindow> {
  try {
    return await rpc.getHealth()
  } catch (error) {
    if (!isMethodUnsupported(error) || !rpc.getLedgers || !rpc.getLatestLedger) throw error
    const { sequence } = await rpc.getLatestLedger()
    return windowOf(await rpc.getLedgers({ startLedger: Math.max(1, sequence - LEDGERS_BEHIND), pagination: { limit: 1 } }))
  }
}

/** The refusal of a start before the oldest ledger: Stellar's, which names the range, and dRPC's, which names the first available state. */
const PRUNED_RANGE = /startLedger must be within the ledger range:\s*(\d+)\s*-\s*(\d+)/
const FIRST_STATE = /First available state is (\d+)/

/**
 * The oldest ledger a refusal of a too-old start names, or undefined for any other failure. The text
 * is searched in the error's message and in the JSON-RPC error the HTTP answer carries (a 400 from
 * dRPC says only "Request failed with status code 400" in its message).
 */
export function prunedOldestOf(error: unknown): number | undefined {
  const e = error as { message?: unknown; response?: { data?: { error?: { message?: unknown } } } } | null
  const texts = [typeof error === "string" ? error : e?.message, e?.response?.data?.error?.message].filter((t): t is string => typeof t === "string")
  for (const text of texts) {
    const range = PRUNED_RANGE.exec(text)
    if (range) return Number(range[1])
    const state = FIRST_STATE.exec(text)
    if (state) return Number(state[1])
  }
  return undefined
}
