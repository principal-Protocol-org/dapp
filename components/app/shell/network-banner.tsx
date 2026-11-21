import { activeNetwork } from "@/lib/protocol/manifest-source"
import { networkLabel } from "./network"

/**
 * Always visible on `/app/**` and `/dashboard/**`: the network, and what its assets are. A test
 * network has test assets only; Mainnet's markets run on mock assets issued by Principal (plan 0009).
 * It reads only the network, as the static shell.
 */
export function NetworkBanner() {
  const network = activeNetwork()
  const text =
    network === "testnet" || network === "local"
      ? `${networkLabel(network)} — test assets only, no real value.`
      : `${networkLabel(network)} · These markets use mock assets issued by Principal for testing.`
  return (
    <div
      role="status"
      className="border-b border-line bg-coupon-wash px-4 py-2 text-center font-mono text-xs/5 text-ink"
    >
      {text}
    </div>
  )
}
