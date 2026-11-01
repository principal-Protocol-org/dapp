import type { AccountState } from "@/lib/protocol/account-state"
import type { MarketState } from "@/lib/protocol/market-state"
import type { Live } from "@/lib/protocol/types"

const isTrue = (v: Live<boolean>) => v.status === "live" && v.value
/** A window limit with no room left. A limit of 0 means the limit is off; an unreadable value is not a warning. */
const used = (limit: Live<bigint>, volume: Live<bigint>) =>
  limit.status === "live" && volume.status === "live" && limit.value > 0n && volume.value >= limit.value

/**
 * Whether the Safety tab needs a dot: a contract is paused, the oracle is stale, or a circuit-breaker
 * window or the account's deposit cap is used up. Derived from the data the Safety rows already read.
 * An unreadable value is not a warning here (the row itself says Unavailable).
 */
export function safetyNeedsAttention(ms: MarketState | undefined, account: AccountState | undefined): boolean {
  if (!ms) return false
  if (isTrue(ms.syPaused) || isTrue(ms.poolPaused) || isTrue(ms.riskPaused)) return true
  if (ms.oracleFresh.status === "live" && !ms.oracleFresh.value) return true
  if (used(ms.cb.limit, ms.cb.volume) || used(ms.cb.assetLimit, ms.cb.assetVolume)) return true
  return !!account && used(account.depositCap, account.netDeposited)
}
