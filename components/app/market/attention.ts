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
 * account's used-up deposit cap. Derived from the data the Safety rows already read.
 *
 * `undefined`, never a made-up count (M3, ruled in 18d), when the market state is not known
 * (unavailable or stale), when any value counted here is unreadable (its row says Unavailable), or
 * when a connected account cannot be read (`account` null). `account` undefined: no wallet, so the
 * deposit cap is not counted (its row asks to connect one).
 */
export function safetyIssues(ms: MarketState | undefined, account: AccountState | null | undefined): number | undefined {
  if (!ms || account === null) return undefined
  const read: Live<unknown>[] = [
    ms.syPaused,
    ms.poolPaused,
    ms.riskPaused,
    ms.oracleFresh,
    ms.cb.limit,
    ms.cb.volume,
    ms.cb.assetLimit,
    ms.cb.assetVolume,
    ...(account ? [account.depositCap, account.netDeposited] : []),
  ]
  if (read.some((v) => v.status !== "live")) return undefined
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
