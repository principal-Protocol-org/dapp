/**
 * The RiskControl page's read model (D-10, D-11): the protocol-wide circuit breaker, its window,
 * the per-asset limits, the pause, and the effective wrap-and-mint capacity under double-reporting.
 */
import { allLive, readLive, toBigint, toBool, type ContractReader } from "../reader"
import type { ScArg } from "../stellar"
import type { Live, Manifest } from "../types"

/** Room left under a window limit (underlying units); null when the limit is 0, which turns it off. */
export type Remaining = bigint | null

export type AssetLimitView = { asset: string; limit: Live<bigint>; volume: Live<bigint>; remaining: Live<Remaining> }

export type RiskView = {
  contractId: string
  limit: Live<bigint>
  /** Volume in the current window; the contract reports 0 once the window has lapsed. */
  volume: Live<bigint>
  remaining: Live<Remaining>
  /**
   * What one wrap-and-mint can still use: `remaining / 2n`, since SYWrapper.deposit and
   * PrincipalManager.mint each report the same underlying amount when both are consumers. Null
   * (not double-reported) unless `is_consumer(sy)` and `is_consumer(manager)` are true for every
   * market; unavailable when any of those reads fails. Its value is null when the limit is off.
   */
  effectiveWrapAndMint: Live<Remaining> | null
  /** The `is_consumer` reads behind `effectiveWrapAndMint`, per market. */
  consumers: Record<string, { sy: Live<boolean>; manager: Live<boolean> }>
  /**
   * `get_window_start` keeps the stored start after the window lapses (only a counted deposit
   * rewrites it), so `lapsed` (`ledger − start ≥ length`) says the next counted deposit opens a new window.
   */
  window: { start: Live<number>; length: Live<number>; lapsed: Live<boolean> }
  assetLimits: AssetLimitView[]
  paused: Live<boolean>
}

/** A u32 view (`get_window_start`, `get_window_ledgers`) decodes to a number. */
function toU32(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value
  if (typeof value === "bigint" && value >= 0n && value <= 0xffff_ffffn) return Number(value)
  throw new Error(`expected a u32, got ${typeof value}`)
}

function remainingOf(limit: Live<bigint>, volume: Live<bigint>): Live<Remaining> {
  return allLive([limit, volume] as const, ([l, v]) => (l <= 0n ? null : l > v ? l - v : 0n))
}

export async function fetchRiskView(reader: ContractReader, manifest: Manifest, ledger: number): Promise<RiskView> {
  const risk = manifest.shared.riskControl
  const address = (value: string): ScArg => ({ type: "address", value })
  const big = (fn: string, args?: ScArg[]) => readLive<unknown, bigint>(reader, { contractId: risk, functionName: fn, args }, toBigint)
  const u32 = (fn: string) => readLive<unknown, number>(reader, { contractId: risk, functionName: fn }, toU32)
  const bool = (fn: string, args?: ScArg[]) => readLive<unknown, boolean>(reader, { contractId: risk, functionName: fn, args }, toBool)

  const assets = [...new Set(manifest.markets.map((m) => m.underlying.sac))]

  const [limit, volume, start, length, paused, consumerPairs, assetLimits] = await Promise.all([
    big("get_cb_limit"),
    big("get_cb_volume"),
    u32("get_window_start"),
    u32("get_window_ledgers"),
    bool("is_paused"),
    Promise.all(
      manifest.markets.map(async (m) => {
        const [sy, mgr] = await Promise.all([
          bool("is_consumer", [address(m.contracts.sy)]),
          bool("is_consumer", [address(m.contracts.manager)]),
        ])
        return [m.marketId, { sy, manager: mgr }] as const
      }),
    ),
    Promise.all(
      assets.map(async (asset): Promise<AssetLimitView> => {
        const [assetLimit, assetVolume] = await Promise.all([
          big("get_asset_limit", [address(asset)]),
          big("get_asset_volume", [address(asset)]),
        ])
        return { asset, limit: assetLimit, volume: assetVolume, remaining: remainingOf(assetLimit, assetVolume) }
      }),
    ),
  ])

  const remaining = remainingOf(limit, volume)
  const consumers = Object.fromEntries(consumerPairs)

  const reads = consumerPairs.flatMap(([, c]) => [c.sy, c.manager])
  let effectiveWrapAndMint: Live<Remaining> | null
  const down = reads.find((r) => r.status === "unavailable")
  if (down?.status === "unavailable") effectiveWrapAndMint = down
  else if (reads.length > 0 && reads.every((r) => r.status === "live" && r.value)) {
    effectiveWrapAndMint = allLive([remaining, ...reads] as const, ([left]) => (left === null ? null : left / 2n))
  } else effectiveWrapAndMint = null

  // `ledger` is the caller's ledger clock, not a read: only the two window reads carry provenance.
  const lapsed = allLive([start, length] as const, ([s, len]) => ledger - s >= len)

  return {
    contractId: risk,
    limit,
    volume,
    remaining,
    effectiveWrapAndMint,
    consumers,
    window: { start, length, lapsed },
    assetLimits,
    paused,
  }
}
