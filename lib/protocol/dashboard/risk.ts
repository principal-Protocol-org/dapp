/**
 * The RiskControl page's read model (D-10, D-11): the protocol-wide circuit breaker, its window,
 * the per-asset limits, the pause, and the effective wrap-and-mint capacity under double-reporting.
 */
import { protocolAbi } from "../manifest"
import { allLive, readLive, toBigint, toBool, unavailable, type ContractReader } from "../reader"
import type { ScArg } from "../stellar"
import type { Live, Manifest } from "../types"

/** Room left under a window limit (underlying units); null when the limit is 0, which turns it off. */
export type Remaining = bigint | null

export type AssetLimitView = { asset: string; limit: Live<bigint>; volume: Live<bigint>; remaining: Live<Remaining> }

export type ConsumerReads = { sy: Live<boolean>; manager: Live<boolean> }

/** How the dashboard labels the effective capacity. */
export const EFFECTIVE_WRAP_AND_MINT_LABEL = "Effective wrap-and-mint capacity, for markets whose SY and manager both report"

/**
 * RiskControl's window. Version 1 (Testnet): a fixed window. `get_window_start` keeps the stored
 * start after it lapses (only a counted deposit rewrites it), so `lapsed` (`ledger − start ≥ length`)
 * says the next counted deposit opens a new one. Version 2 (Mainnet): a sliding window. The volume
 * counted is the current window's plus the previous one's, weighted by how much of it is still in
 * range, so it decays as older deposits leave it; the start is normalized and it never lapses.
 */
export type RiskWindow =
  | { kind: "fixed"; start: Live<number>; length: Live<number>; lapsed: Live<boolean> }
  | { kind: "sliding"; start: Live<number>; length: Live<number> }

/** The window a manifest's contracts count in: sliding from contract version 2. */
export function riskWindowKind(m: Pick<Manifest, "protocolAbi">): RiskWindow["kind"] {
  return protocolAbi(m) === 2 ? "sliding" : "fixed"
}

export type RiskView = {
  contractId: string
  limit: Live<bigint>
  /**
   * The volume the contract counts now: on a fixed window (version 1) 0 once the window has lapsed;
   * on a sliding one (version 2) it decays as older deposits leave the window.
   */
  volume: Live<bigint>
  remaining: Live<Remaining>
  /**
   * What one wrap-and-mint can still use in a double-reporting market (`EFFECTIVE_WRAP_AND_MINT_LABEL`):
   * `remaining / 2n`, since SYWrapper.deposit and PrincipalManager.mint each report the same
   * underlying amount when both are consumers. RiskControl's window is protocol-wide, so it is shown
   * when at least one market double-reports (`doubleReporting`). Null when none does; unavailable
   * only when no market is known to double-report and a failed `is_consumer` read leaves it open.
   * Its value is null when the limit is off.
   */
  effectiveWrapAndMint: Live<Remaining> | null
  /** Markets whose SY and manager are both consumers. */
  doubleReporting: string[]
  /** The `is_consumer` reads behind `effectiveWrapAndMint`, per market. */
  consumers: Record<string, ConsumerReads>
  window: RiskWindow
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

const isTrue = (read: Live<boolean>) => read.status === "live" && read.value
const isFalse = (read: Live<boolean>) => read.status === "live" && !read.value

/**
 * The capacity is shown as soon as one market is known to double-report: the other markets' reads
 * cannot change it. Without such a market, a failed read in a market not already ruled out (no
 * `false` read) is needed, so the capacity is unavailable; otherwise it is null.
 */
function effectiveCapacity(
  remaining: Live<Remaining>,
  pairs: readonly (readonly [string, ConsumerReads])[],
): { effectiveWrapAndMint: Live<Remaining> | null; doubleReporting: string[] } {
  const yes = pairs.filter(([, c]) => isTrue(c.sy) && isTrue(c.manager))
  const doubleReporting = yes.map(([id]) => id)
  if (yes.length > 0) {
    const reads = yes.flatMap(([, c]) => [c.sy, c.manager])
    return { effectiveWrapAndMint: allLive([remaining, ...reads] as const, ([left]) => (left === null ? null : left / 2n)), doubleReporting }
  }
  for (const [id, c] of pairs) {
    if (isFalse(c.sy) || isFalse(c.manager)) continue
    const down = c.sy.status === "unavailable" ? c.sy : c.manager
    if (down.status === "unavailable") {
      return { effectiveWrapAndMint: unavailable(`whether market ${id} double-reports: ${down.error}`, down.source), doubleReporting }
    }
  }
  return { effectiveWrapAndMint: null, doubleReporting }
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

  const { effectiveWrapAndMint, doubleReporting } = effectiveCapacity(remaining, consumerPairs)

  // `ledger` is the caller's ledger clock, not a read: only the two window reads carry provenance.
  // A sliding window never lapses: nothing is worked out from the clock.
  const window: RiskWindow =
    riskWindowKind(manifest) === "sliding"
      ? { kind: "sliding", start, length }
      : { kind: "fixed", start, length, lapsed: allLive([start, length] as const, ([s, len]) => ledger - s >= len) }

  return {
    contractId: risk,
    limit,
    volume,
    remaining,
    effectiveWrapAndMint,
    doubleReporting,
    consumers,
    window,
    assetLimits,
    paused,
  }
}
