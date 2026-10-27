import { createRpcServer, simulateContractRead, type ContractReadResult, type ScArg } from "./stellar"
import type { Live, Manifest } from "./types"

export type ContractReader = <T>(call: {
  contractId: string
  functionName: string
  args?: ScArg[]
}) => Promise<ContractReadResult<T>>

export function createRpcReader(m: Manifest): ContractReader {
  const server = createRpcServer(m.rpcUrl)
  return <T>(call: { contractId: string; functionName: string; args?: ScArg[] }) =>
    simulateContractRead<T>({
      rpcUrl: m.rpcUrl,
      networkPassphrase: m.networkPassphrase,
      server,
      invocation: { contractId: call.contractId, functionName: call.functionName, args: call.args ?? [] },
    })
}

export function liveValue<T>(value: T, ledger: number): Live<T> {
  return { status: "live", value, ledger }
}

export function unavailable(error: unknown): Live<never> {
  return { status: "unavailable", error: error instanceof Error ? error.message : String(error) }
}

/**
 * Reads one contract view into a `Live`. A failed read, or a value `map` rejects (it may throw),
 * is `unavailable`: it is never turned into a zero or a default.
 */
export async function readLive<T, U = T>(
  reader: ContractReader,
  call: { contractId: string; functionName: string; args?: ScArg[] },
  map?: (value: T) => U,
): Promise<Live<U>> {
  try {
    const result = await reader<T>(call)
    return liveValue(map ? map(result.value) : (result.value as unknown as U), result.latestLedger)
  } catch (error) {
    return unavailable(error)
  }
}

/** Strict conversion of a decoded i128/u64/u32: anything else throws, so the read is unavailable. */
export function toBigint(value: unknown): bigint {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isInteger(value)) return BigInt(value)
  throw new Error(`expected an integer, got ${typeof value}`)
}

export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value
  throw new Error(`expected a boolean, got ${typeof value}`)
}

/** Combines reads into one `Live`; unavailable if any input is, naming the first failure. */
export function allLive<T extends readonly Live<unknown>[], U>(
  inputs: T,
  combine: (values: { [K in keyof T]: T[K] extends Live<infer V> ? V : never }) => U,
): Live<U> {
  let ledger = 0
  const values: unknown[] = []
  for (const input of inputs) {
    if (input.status === "unavailable") return input
    values.push(input.value)
    ledger = Math.max(ledger, input.ledger)
  }
  try {
    return liveValue(combine(values as never), ledger)
  } catch (error) {
    return unavailable(error)
  }
}

/**
 * True when a read failed because the contract itself trapped or rejected the call (a Soroban
 * HostError from the simulation), as opposed to a transport, rate-limit or archival failure.
 * Only the former may be read as an answer ("not authorized", "not verified").
 */
export function isContractError(error: string): boolean {
  return /HostError|Error\((Contract|WasmVm|Auth|Value|Object|Storage|Context|Budget)/.test(error)
}
