import type { AccountState } from "@/lib/protocol/account-state"
import type { ComplianceItem } from "@/lib/protocol/compliance"
import type { MarketState } from "@/lib/protocol/market-state"
import type { Live } from "@/lib/protocol/types"

const isTrue = (v: Live<boolean>) => v.status === "live" && v.value
/** A window limit with no room left. A limit of 0 means the limit is off; an unreadable value is not a warning. */
const used = (limit: Live<bigint>, volume: Live<bigint>) =>
  limit.status === "live" && volume.status === "live" && limit.value > 0n && volume.value >= limit.value

/**
 * How many problems the Safety tab reports: each paused contract (SY wrapper, pool, risk control), a
 * stale oracle, an exhausted protocol-wide breaker window, an exhausted per-asset breaker window and the
 * account's used-up deposit cap. Derived from the data the Safety rows already read; an unreadable value
 * is not counted (the row itself says Unavailable). `undefined` when the market state is not known
 * (unavailable or stale), never a made-up 0.
 */
export function safetyIssues(ms: MarketState | undefined, account: AccountState | undefined): number | undefined {
  if (!ms) return undefined
  const flags = [
    isTrue(ms.syPaused),
    isTrue(ms.poolPaused),
    isTrue(ms.riskPaused),
    ms.oracleFresh.status === "live" && !ms.oracleFresh.value,
    used(ms.cb.limit, ms.cb.volume),
    used(ms.cb.assetLimit, ms.cb.assetVolume),
    !!account && used(account.depositCap, account.netDeposited),
  ]
  return flags.filter(Boolean).length
}

/**
 * How many of the connected account's compliance items are not OK. `undefined` when no wallet is
 * connected or the items cannot be read fresh (`items` is null).
 */
export function complianceIssues(connected: boolean, items: ComplianceItem[] | null): number | undefined {
  if (!connected || !items) return undefined
  return items.filter((i) => i.status !== "ok").length
}
