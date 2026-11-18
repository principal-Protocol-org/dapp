import type { Network } from "./types"

/** A stellar.expert page for a transaction, contract or account; a local network has no explorer. */
export function explorerUrl(network: Network, kind: "tx" | "contract" | "account", id: string): string | null {
  if (network === "local") return null
  const net = network === "testnet" ? "testnet" : "public"
  return `https://stellar.expert/explorer/${net}/${kind}/${encodeURIComponent(id)}`
}
