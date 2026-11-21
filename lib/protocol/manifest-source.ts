import localJson from "@/config/manifests/local.json"
import mainnetJson from "@/config/manifests/mainnet.json"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "./manifest"
import type { Manifest, Network } from "./types"

/**
 * Parsed manifests, by network. Components call `activeManifest()` in render, and re-render every
 * second with the ledger clock: each manifest is parsed (and validated) once per module instance.
 */
const parsed = new Map<string, Manifest>()

const FILES: Record<Network, unknown> = { local: localJson, testnet: testnetJson, mainnet: mainnetJson }

/**
 * The network `NEXT_PUBLIC_PRINCIPAL_NETWORK` names (`testnet` by default), without parsing its
 * manifest: what the static shell (the banner, the dashboard's badge) needs.
 */
export function activeNetwork(): Network {
  const network = process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK ?? "testnet"
  if (network === "testnet" || network === "local" || network === "mainnet") return network
  throw new Error(`NEXT_PUBLIC_PRINCIPAL_NETWORK must be "testnet", "local" or "mainnet", got "${network}".`)
}

/**
 * The active network's manifest. Every file is imported statically so the bundler includes it; only
 * the active one is parsed. A failure is thrown every time, never cached. A file whose `network` is
 * not the one asked for is refused, so a wrong file under `mainnet` never shows another network's
 * data without its banner.
 */
export function activeManifest(): Manifest {
  const network = activeNetwork()
  const cached = parsed.get(network)
  if (cached) return cached
  const manifest = parseManifest(FILES[network])
  if (manifest.network !== network) throw new Error(`config/manifests/${network}.json is for "${manifest.network}", not "${network}"`)
  parsed.set(network, manifest)
  return manifest
}
