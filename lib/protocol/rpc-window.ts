/**
 * The RPC's ledger window (its oldest and latest ledger).
 *
 * `getHealth` is asked first. A keyed provider may not offer it (dRPC answers HTTP 400 through the SDK,
 * JSON-RPC -32601 "the method getHealth does not exist/is not available"); only then the window comes
 * from `getLedgers`, whose answer carries `oldestLedger` and `latestLedger`. Any other `getHealth`
 * failure is thrown as it is.
 */

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
    return windowOf(await rpc.getLedgers({ startLedger: sequence, pagination: { limit: 1 } }))
  }
}
