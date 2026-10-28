import { activeManifest } from "@/lib/protocol/manifest-source"
import { networkLabel } from "./network"

/** Always visible on `/app/**` while the manifest points at a test network. */
export function TestnetBanner() {
  const { network } = activeManifest()
  if (network !== "testnet" && network !== "local") return null
  return (
    <div
      role="status"
      className="border-b border-line bg-coupon-wash px-4 py-2 text-center font-mono text-xs/5 text-ink"
    >
      {networkLabel(network)} — test assets only, no real value.
    </div>
  )
}
