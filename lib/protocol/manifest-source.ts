import localJson from "@/config/manifests/local.json"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "./manifest"
import type { Manifest } from "./types"

// Both files are imported statically so the bundler includes them. Only the active one is parsed.
export function activeManifest(): Manifest {
  const network = process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK ?? "testnet"
  if (network === "testnet") return parseManifest(testnetJson)
  if (network === "local") return parseManifest(localJson)
  throw new Error(`NEXT_PUBLIC_PRINCIPAL_NETWORK must be "testnet" or "local", got "${network}".`)
}
