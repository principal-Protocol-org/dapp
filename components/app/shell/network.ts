import type { Network } from "@/lib/protocol/types"

export function networkLabel(network: Network): string {
  if (network === "testnet") return "Stellar Testnet"
  if (network === "local") return "Local network"
  return "Stellar Mainnet"
}
