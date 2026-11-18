import { StrKey } from "@stellar/stellar-sdk"
import { userErrorMessage } from "./errors"
import { createRpcServer, simulateContractRead, type ContractReadResult, type ScArg } from "./stellar"
import type { Live, Manifest, ReadSource } from "./types"

export type ContractReader = (<T>(call: {
  contractId: string
  functionName: string
  args?: ScArg[]
}) => Promise<ContractReadResult<T>>) & {
  /** The RPC this reader calls; lets a failed read still say where it was attempted. */
  rpcUrl?: string
}

const TRANSIENT_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"])

/**
 * Whether a failed read says nothing about the contract, only about the endpoint (spec 0004 D-6): a
 * network failure (fetch's `TypeError`, a socket error code, or the SDK's HTTP-client error with no
 * HTTP answer), a timeout, an HTTP 5xx or 429, or the RPC's busy answer (`-32004`). Another endpoint may answer it. A simulation's own error (a contract
 * error, an archived entry, a read that needs auth) is the contract's answer: final everywhere.
 */
export function isTransientRpcError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const e = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; isAxiosError?: unknown; response?: { status?: unknown } | null; cause?: { code?: unknown } }
  if (e.code === -32004) return true
  const status = e.response?.status ?? e.status
  if (typeof status === "number") return status >= 500 || status === 429
  // SDK 17's HTTP client wraps a failed request (in Node, "fetch failed") with no HTTP answer at all.
  if (e.isAxiosError === true && !e.response) return true
  if (e.name === "TimeoutError" || e.name === "AbortError") return true
  if (typeof e.message === "string" && /^timeout of \d+ms exceeded$/.test(e.message)) return true
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true
  if (typeof e.cause?.code === "string" && TRANSIENT_CODES.has(e.cause.code)) return true
  return error instanceof TypeError
}

type ReadServer = NonNullable<Parameters<typeof simulateContractRead>[0]["server"]>

/**
 * The app's contract reader: a simulation on the manifest's `rpcUrl`, then, on a transient failure
 * only (`isTransientRpcError`), on each of `rpcFallbackUrls` in order (D-6). The answer's `rpcUrl`
 * names the endpoint that answered, and `viaFallback` marks one that was not the first. A contract's
 * own error is never asked again elsewhere. `serverFor` is a test hook.
 */
export function createRpcReader(m: Manifest, opts: { serverFor?: (rpcUrl: string) => ReadServer } = {}): ContractReader {
  const urls = [m.rpcUrl, ...(m.rpcFallbackUrls ?? [])]
  const servers = new Map<string, ReadServer>()
  const serverFor = (url: string) => {
    let server = servers.get(url)
    if (!server) {
      server = opts.serverFor ? opts.serverFor(url) : createRpcServer(url)
      servers.set(url, server)
    }
    return server
  }
  const read = async <T>(call: { contractId: string; functionName: string; args?: ScArg[] }): Promise<ContractReadResult<T>> => {
    const invocation = { contractId: call.contractId, functionName: call.functionName, args: call.args ?? [] }
    for (let i = 0; ; i++) {
      try {
        const result = await simulateContractRead<T>({ rpcUrl: urls[i], networkPassphrase: m.networkPassphrase, server: serverFor(urls[i]), invocation })
        return i === 0 ? result : { ...result, viaFallback: true }
      } catch (error) {
        if (i === urls.length - 1 || !isTransientRpcError(error)) throw error
      }
    }
  }
  return Object.assign(read, { rpcUrl: m.rpcUrl })
}

/** `value` with every bigint, at any depth (a struct's fields, an enum's value), as its decimal string. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  return value
}

/** The call's arguments as plain, JSON-safe data (bigints as decimal strings, at any depth), in their `ScArg` shape. */
function plainArgs(args: ScArg[] | undefined): unknown[] {
  return (args ?? []).map(plain)
}

/**
 * A reader that makes each distinct call (contract, function, arguments) once for as long as it lives,
 * and hands every later caller the same answer, or the same failure. A sweep over many markets wrapped
 * in one reads the views of the contracts they share (oracle, RiskControl) once, not once per market.
 * Make a new one per refresh: it never expires, so a refresh that reused it would read nothing new.
 */
export function dedupeReads(reader: ContractReader): ContractReader {
  const answers = new Map<string, Promise<ContractReadResult<unknown>>>()
  const read = <T>(call: { contractId: string; functionName: string; args?: ScArg[] }) => {
    // Bigints at any depth (a struct argument's fields) as tagged text: plain JSON would throw on them.
    const key = JSON.stringify([call.contractId, call.functionName, call.args ?? []], (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v))
    let answer = answers.get(key)
    if (!answer) {
      answer = reader<unknown>(call)
      answers.set(key, answer)
    }
    return answer as Promise<ContractReadResult<T>>
  }
  return Object.assign(read, { rpcUrl: reader.rpcUrl })
}

export function liveValue<T>(value: T, ledger: number): Extract<Live<T>, { status: "live" }> {
  return { status: "live", value, ledger }
}

const MAX_ERROR_LENGTH = 160

/**
 * The failure as shown to the user: its first line, capped. A Soroban simulation error carries the
 * whole diagnostic event log after its `HostError: Error(...)` line; that log is for debugging and,
 * shown in a panel, floods it with long unbreakable contract IDs. `isContractError` reads only the
 * first line, so it still works on the summary. An overloaded RPC reads `RPC_BUSY_MESSAGE`, never
 * its raw text (`userErrorMessage`); it is no contract error.
 */
function summarizeError(error: unknown): string {
  const text = userErrorMessage(error)
  const first = text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "unknown error"
  return first.length <= MAX_ERROR_LENGTH ? first : `${first.slice(0, MAX_ERROR_LENGTH - 1)}…`
}

export function unavailable(error: unknown, source?: Omit<ReadSource, "rawXdr" | "ledger">): Live<never> {
  return source ? { status: "unavailable", error: summarizeError(error), source } : { status: "unavailable", error: summarizeError(error) }
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
  const base = { contractId: call.contractId, fn: call.functionName, args: plainArgs(call.args), rpcUrl: reader.rpcUrl ?? "" }
  try {
    const result = await reader<T>(call)
    const live = liveValue(map ? map(result.value) : (result.value as unknown as U), result.latestLedger)
    const source = { ...base, rawXdr: result.rawXdr, ledger: result.latestLedger, rpcUrl: result.rpcUrl, ...(result.viaFallback ? { viaFallback: true } : {}) }
    return { ...live, source }
  } catch (error) {
    return unavailable(error, base)
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
  let min = Infinity
  let max = 0
  const values: unknown[] = []
  const sources: ReadSource[] = []
  for (const input of inputs) {
    if (input.status === "unavailable") return input
    values.push(input.value)
    // A combined input is already at its max ledger; its spread says where it started.
    min = Math.min(min, input.ledgerSpread?.min ?? input.ledger)
    max = Math.max(max, input.ledgerSpread?.max ?? input.ledger)
    // An input that is itself a combination already lists its reads.
    if (input.sources) sources.push(...input.sources)
    else if (input.source) sources.push(input.source)
  }
  try {
    const live = liveValue(combine(values as never), max)
    if (sources.length > 0) live.sources = sources
    if (min !== max) live.ledgerSpread = { min, max }
    return live
  } catch (error) {
    return unavailable(error)
  }
}

/**
 * True only when the simulation shows the contract itself trapped or rejected the call (a Soroban
 * HostError of type Contract, WasmVm, Auth, Value or Object). Storage, Budget and Context errors,
 * archival ("requires restoring"), transport and rate-limit failures are not answers.
 */
export function isContractError(error: string): boolean {
  return /HostError:\s*Error\((Contract|WasmVm|Auth|Value|Object)\b/.test(error)
}

/** Strict strkey check: a valid account (G...) or contract (C...) address. */
export function toAddress(value: unknown): string {
  if (typeof value === "string" && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value))) return value
  throw new Error("expected a valid Stellar address")
}
