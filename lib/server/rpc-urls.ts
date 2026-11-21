import "server-only"

/**
 * The RPC endpoints the server jobs read through. `SERVER_RPC_URL` (server-only, optional) is a
 * secret key separate from the manifest's public `rpcUrl`, which ships in the browser bundle and
 * can be used up by anyone. When it is set, server code asks it first and the manifest's `rpcUrl`,
 * then `rpcFallbackUrls`, follow; when it is not, nothing changes.
 *
 * A value that is not an `http:`/`https:` URL is ignored with one warning that names the variable,
 * never the value (a server variable that only adds capacity does not stop the jobs). The value
 * is never logged, answered or recorded: the reader's answers name the public `rpcUrl` instead of
 * it (`serverReader`), and a log line names a host at most.
 */
import { createRpcReader } from "@/lib/protocol/reader"
import type { ContractReader } from "@/lib/protocol/reader"
import { createRpcServer, type ContractReadResult, type ScArg } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"

export const SERVER_RPC_ENV = "SERVER_RPC_URL"

let warned = false

/** The secret URL, or null when unset or not an http(s) URL. */
export function serverRpcUrl(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env[SERVER_RPC_ENV]?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol === "https:" || url.protocol === "http:") return raw
  } catch {
    // Handled below, without the value.
  }
  if (!warned) {
    warned = true
    console.warn(`${SERVER_RPC_ENV} is not an http(s) URL; it is ignored.`)
  }
  return null
}

export function resetServerRpcWarningForTests(): void {
  warned = false
}

/** `[SERVER_RPC_URL?, rpcUrl, ...rpcFallbackUrls]`, without repeats. */
export function serverRpcUrls(manifest: Manifest, env: Record<string, string | undefined> = process.env): string[] {
  const secret = serverRpcUrl(env)
  return [...new Set([...(secret ? [secret] : []), manifest.rpcUrl, ...(manifest.rpcFallbackUrls ?? [])])]
}

/** The one endpoint a single-endpoint path (sending, lookups, the keeper) uses: the secret URL, else `rpcUrl`. */
export function serverRpcUrlOf(manifest: Manifest, env: Record<string, string | undefined> = process.env): string {
  return serverRpcUrl(env) ?? manifest.rpcUrl
}

export function createServerRpc(manifest: Manifest, env: Record<string, string | undefined> = process.env) {
  return createRpcServer(serverRpcUrlOf(manifest, env))
}

/**
 * The contract reader for server jobs: the secret URL first, then the manifest's endpoints as
 * `createRpcReader` orders them. An answer that came from the secret URL names the manifest's
 * public `rpcUrl` instead, so no read source carries the secret.
 */
export function serverReader(manifest: Manifest, env: Record<string, string | undefined> = process.env): ContractReader {
  const secret = serverRpcUrl(env)
  if (!secret) return createRpcReader(manifest)
  const urls = serverRpcUrls(manifest, env)
  const [, ...rest] = urls
  const inner = createRpcReader({ ...manifest, rpcUrl: secret, rpcFallbackUrls: rest })
  const read = async <T>(call: { contractId: string; functionName: string; args?: ScArg[] }): Promise<ContractReadResult<T>> => {
    const result = await inner<T>(call)
    return result.rpcUrl === secret ? { ...result, rpcUrl: manifest.rpcUrl } : result
  }
  return Object.assign(read, { rpcUrl: manifest.rpcUrl })
}
