import localJson from "@/config/manifests/local.json"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "./manifest"
import type { Manifest } from "./types"

/**
 * Parsed manifests, by network. Components call `activeManifest()` in render, and re-render every
 * second with the ledger clock: each manifest is parsed (and validated) once per module instance.
 */
const parsed = new Map<string, Manifest>()

// Both files are imported statically so the bundler includes them. Only the active one is parsed.
export function activeManifest(): Manifest {
  const network = process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK ?? "testnet"
  const cached = parsed.get(network)
  if (cached) return cached
  let manifest: Manifest
  if (network === "testnet") manifest = parseManifest(testnetJson)
  else if (network === "local") manifest = parseManifest(localJson)
  else throw new Error(`NEXT_PUBLIC_PRINCIPAL_NETWORK must be "testnet" or "local", got "${network}".`)
  parsed.set(network, manifest)
  return manifest
}
