/**
 * The oracle page's read model (D-17): value, freshness against ledger time, policy, sources with
 * their preimages, the update path and the last rejection. Reads `manifest.shared.oracle` only.
 */
import { parseRejection, parseSource, type OracleRejection } from "../market-state"
import { allLive, readLive, toBigint, toBool, unavailable, type ContractReader } from "../reader"
import type { Live, Manifest } from "../types"

export type Freshness = "fresh" | "warning" | "stale" | "unavailable"

/** A source id (hex) and, when the manifest knows it, the human-readable preimage it hashes. */
export type OracleSourceView = { hash: Live<string | null>; preimage?: string }

/** The operations the protocol refuses while the oracle is stale (the gates: mint, trades, single-sided liquidity, redemption). */
export const BLOCKED_WHEN_STALE = ["mint", "trade", "single-sided liquidity", "redemption"] as const

export type OracleView = {
  contractId: string
  value: Live<bigint>
  timestamp: Live<bigint>
  /** `is_available()`: the contract's own freshness at the read's ledger. */
  available: Live<boolean>
  freshness: Freshness
  /** Seconds until operations block, `timestamp + maxStale − ledgerTime`; negative once blocked. */
  timeToBlock: Live<number>
  maxStale: Live<bigint>
  deviationBps: Live<bigint>
  /** `value_bounds()`: the sane range; null when none is set. */
  bounds: Live<{ min: bigint; max: bigint } | null>
  sources: { primary: OracleSourceView; fallback: OracleSourceView; active: OracleSourceView }
  /** `last_update_was_feed()`, or unsupported when this oracle's code has no such view. */
  path: Live<"push" | "feed"> | { status: "unsupported" }
  lastRejection: Live<OracleRejection | null>
  blockedWhenStale: typeof BLOCKED_WHEN_STALE
}

/** The host's answer when the called function does not exist in the contract's wasm (665bb67 has no feed views). */
const MISSING_FUNCTION = /HostError:\s*Error\(WasmVm,\s*MissingValue\)/

function parseBounds(raw: unknown): { min: bigint; max: bigint } | null {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error("value_bounds did not return a pair")
  return { min: toBigint(raw[0]), max: toBigint(raw[1]) }
}

/**
 * Seconds until `is_fresh` turns false at ledger time `ledgerTime`. The contract counts a value
 * fresh while `now − timestamp <= max_stale` (665bb67 `oracle_adapter:363-375`), so operations
 * block only when this is negative.
 */
function timeToBlockAt(timestamp: Live<bigint>, maxStale: Live<bigint>, ledgerTime: number | null): Live<number> {
  if (ledgerTime === null) return unavailable("the ledger time is not known yet")
  return allLive([timestamp, maxStale] as const, ([ts, max]) => Number(ts + max - BigInt(Math.floor(ledgerTime))))
}

/**
 * Fresh, Warning (age ≥ 75% of `max_stale`), Stale (age > `max_stale`: operations block), or
 * Unavailable. Age is measured in ledger time, never the browser clock. A ledger time behind the
 * oracle's timestamp (the clock read before the latest update) counts as age 0: the contract
 * refuses future timestamps, so it cannot mean stale. The contract's own `is_available() = false`
 * wins, since it was evaluated at the read's ledger.
 */
function freshnessOf(timestamp: Live<bigint>, maxStale: Live<bigint>, available: Live<boolean>, ledgerTime: number | null): Freshness {
  if (available.status === "live" && !available.value) return "stale"
  if (ledgerTime === null || timestamp.status !== "live" || maxStale.status !== "live") return "unavailable"
  const raw = BigInt(Math.floor(ledgerTime)) - timestamp.value
  const age = raw < 0n ? 0n : raw
  const max = maxStale.value
  if (age > max) return "stale"
  if (age * 4n >= max * 3n) return "warning"
  return "fresh"
}

function sourceView(hash: Live<string | null>, preimages: Map<string, string>): OracleSourceView {
  const preimage = hash.status === "live" && hash.value !== null ? preimages.get(hash.value) : undefined
  return preimage === undefined ? { hash } : { hash, preimage }
}

export async function fetchOracleView(reader: ContractReader, manifest: Manifest, ledgerTime: number | null): Promise<OracleView> {
  const oracle = manifest.shared.oracle
  const big = (fn: string) => readLive<unknown, bigint>(reader, { contractId: oracle, functionName: fn }, toBigint)
  const source = (fn: string) => readLive<unknown, string | null>(reader, { contractId: oracle, functionName: fn }, parseSource)

  const [value, timestamp, available, maxStale, deviationBps, bounds, primary, fallback, active, wasFeed, lastRejection] = await Promise.all([
    big("get_reference_value"),
    big("get_reference_timestamp"),
    readLive<unknown, boolean>(reader, { contractId: oracle, functionName: "is_available" }, toBool),
    big("max_stale_seconds"),
    big("max_deviation_bps"),
    readLive<unknown, { min: bigint; max: bigint } | null>(reader, { contractId: oracle, functionName: "value_bounds" }, parseBounds),
    source("get_primary_source"),
    source("get_fallback_source"),
    source("get_active_source"),
    readLive<unknown, boolean>(reader, { contractId: oracle, functionName: "last_update_was_feed" }, toBool),
    readLive<unknown, OracleRejection | null>(reader, { contractId: oracle, functionName: "last_rejection" }, parseRejection),
  ])

  const path: OracleView["path"] =
    wasFeed.status === "unavailable"
      ? MISSING_FUNCTION.test(wasFeed.error)
        ? { status: "unsupported" }
        : wasFeed
      : { ...wasFeed, value: wasFeed.value ? "feed" : "push" }

  const preimages = new Map((manifest.oracleSources ?? []).map((s) => [s.hash.toLowerCase(), s.preimage]))

  return {
    contractId: oracle,
    value,
    timestamp,
    available,
    freshness: freshnessOf(timestamp, maxStale, available, ledgerTime),
    timeToBlock: timeToBlockAt(timestamp, maxStale, ledgerTime),
    maxStale,
    deviationBps,
    bounds,
    sources: {
      primary: sourceView(primary, preimages),
      fallback: sourceView(fallback, preimages),
      active: sourceView(active, preimages),
    },
    path,
    lastRejection,
    blockedWhenStale: BLOCKED_WHEN_STALE,
  }
}
