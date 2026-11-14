import type { ContractReader } from "../../reader"
import type { ScArg } from "../../stellar"

export type Handler = unknown | ((args: ScArg[]) => unknown)
export type Calls = { key: string; args: ScArg[] }[]

export const RPC = "https://rpc.test"

/**
 * A reader answering from `table`, keyed `<contractId>.<fn>`. A handler may be a value, an Error (the
 * read fails with it) or a function of the call's arguments. Every read is at `ledger`.
 */
export function fakeReader(table: Record<string, Handler>, calls: Calls = [], ledger = 777): ContractReader {
  const read = async <T,>({ contractId, functionName, args = [] }: { contractId: string; functionName: string; args?: ScArg[] }) => {
    const key = `${contractId}.${functionName}`
    calls.push({ key, args })
    if (!(key in table)) throw new Error(`no fixture for ${key}`)
    const h = table[key]
    const value = typeof h === "function" ? (h as (a: ScArg[]) => unknown)(args) : h
    if (value instanceof Error) throw value
    return { value: value as T, latestLedger: ledger, minResourceFee: "100", rawXdr: `raw:${key}`, rpcUrl: RPC }
  }
  return Object.assign(read, { rpcUrl: RPC }) as ContractReader
}
