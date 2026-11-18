/**
 * The oracle page's read model (D-17): value, freshness against ledger time, policy, sources with
 * their preimages, the update path, the last rejection and, for code that has it (principal
 * 3af9388), the feed side: the SEP-40 feed the oracle reads, its minimum interval and the feed's own
 * price. Reads the one OracleAdapter it is given (each market has its own on Mainnet).
 */
import { StrKey } from "@stellar/stellar-sdk"
import { parseRejection, parseSource, type OracleRejection } from "../market-state"
import { allLive, readLive, toBigint, toBool, unavailable, type ContractReader } from "../reader"
import type { ScArg } from "../stellar"
import type { Live, Manifest, ReadSource } from "../types"

export type Freshness = "fresh" | "warning" | "stale" | "unavailable"

/** A source id (hex) and, when the manifest knows it, the human-readable preimage it hashes. */
export type OracleSourceView = { hash: Live<string | null>; preimage?: string }

/** The operations the protocol refuses while the oracle is stale (the gates: mint, trades, single-sided liquidity, redemption). */
export const BLOCKED_WHEN_STALE = ["mint", "trade", "single-sided liquidity", "redemption"] as const

/** A view this oracle's code does not have; `source` is the call attempted, so a reader can repeat it and see the host's MissingValue answer. */
export type UnsupportedRead = { status: "unsupported"; source?: Omit<ReadSource, "rawXdr" | "ledger"> }

/** The SEP-40 asset the oracle asks its feed for (3af9388 `Sep40Asset`: `Stellar(Address)` or `Other(Symbol)`). */
export type Sep40Asset = { kind: "Stellar"; address: string } | { kind: "Other"; symbol: string }

/** `feed_source()`: the feed contract and the asset asked of it. */
export type OracleFeed = { contract: string; asset: Sep40Asset }

/** The feed's latest price for the asset, raw in the feed's `decimals`, and `value`, rescaled to 7 decimals as the oracle does. */
export type FeedPrice = { raw: bigint; decimals: number; value: bigint; timestamp: bigint }

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
  /**
   * `last_update_was_feed()`, or unsupported when this oracle's code has no such view; `source` is
   * the call attempted, so a reader can repeat it and see the host's MissingValue answer.
   */
  path: Live<"push" | "feed"> | UnsupportedRead
  lastRejection: Live<OracleRejection | null>
  blockedWhenStale: typeof BLOCKED_WHEN_STALE
  /** `feed_source()`: null until `set_feed_source`; unsupported when this oracle's code has no such view (665bb67). */
  feed: Live<OracleFeed | null> | UnsupportedRead
  /** `feed_min_interval_seconds()`: the least time between two accepted feed updates (300 unless set); unsupported as `feed`. */
  feedMinInterval: Live<bigint> | UnsupportedRead
  /**
   * The feed's `decimals()` and `lastprice(asset)`, read only when a feed is set: null when none is
   * (or the code has no feed), unavailable when a feed is set but either read fails, or the feed has
   * no price for the asset; unavailable as `feed` when `feed_source()` itself could not be read.
   */
  feedPrice: Live<FeedPrice> | null
}

/** The host's answer when the called function does not exist in the contract's wasm (665bb67 has no feed views). */
const MISSING_FUNCTION = /HostError:\s*Error\(WasmVm,\s*MissingValue\)/

/** A read whose function the oracle's code lacks is unsupported, not unavailable: older code is no failure. */
function orUnsupported<T>(live: Live<T>): Live<T> | UnsupportedRead {
  if (live.status !== "unavailable" || !MISSING_FUNCTION.test(live.error)) return live
  return live.source ? { status: "unsupported", source: live.source } : { status: "unsupported" }
}

/** `Sep40Asset` from its native form (`["Stellar", "C…"]` or `["Other", "USDY"]`); any other shape throws, so the read is unavailable. */
function parseSep40Asset(raw: unknown): Sep40Asset {
  if (Array.isArray(raw) && raw.length === 2) {
    const [variant, value] = raw
    if (variant === "Stellar" && typeof value === "string" && (StrKey.isValidContract(value) || StrKey.isValidEd25519PublicKey(value))) {
      return { kind: "Stellar", address: value }
    }
    if (variant === "Other" && typeof value === "string" && value !== "") return { kind: "Other", symbol: value }
  }
  throw new Error("feed_source named an asset this dashboard does not recognize (expected Stellar(address) or Other(symbol))")
}

/** `feed_source()`'s `Option<(Address, Sep40Asset)>`: null for None. */
function parseFeedSource(raw: unknown): OracleFeed | null {
  if (raw === null || raw === undefined) return null
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error("feed_source did not return a (feed, asset) pair")
  const [contract, asset] = raw
  if (typeof contract !== "string" || !StrKey.isValidContract(contract)) throw new Error("feed_source did not name a feed contract")
  return { contract, asset: parseSep40Asset(asset) }
}

/** The asset as the feed's `lastprice` takes it: the contract enum. */
function assetArg(asset: Sep40Asset): ScArg {
  return asset.kind === "Stellar"
    ? { type: "enum", variant: "Stellar", value: { type: "address", value: asset.address } }
    : { type: "enum", variant: "Other", value: { type: "symbol", value: asset.symbol } }
}

function toU32(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff) return value
  throw new Error(`expected a u32, got ${typeof value === "number" ? value : typeof value}`)
}

const NO_FEED_PRICE = "The feed has no price for this asset."

/** `lastprice`'s `Option<PriceData { price: i128, timestamp: u64 }>`; None throws `NO_FEED_PRICE`, so the price is unavailable, saying why. */
function parsePriceData(raw: unknown): { price: bigint; timestamp: bigint } {
  if (raw === null || raw === undefined) throw new Error(NO_FEED_PRICE)
  if (typeof raw !== "object") throw new Error("lastprice did not return a price")
  const { price, timestamp } = raw as Record<string, unknown>
  return { price: toBigint(price), timestamp: toBigint(timestamp) }
}

const PROTOCOL_DECIMALS = 7
const I128_MIN = -(2n ** 127n)
const I128_MAX = 2n ** 127n - 1n
/** 10^38 is the largest power of ten an i128 holds. */
const MAX_I128_POWER_OF_TEN = 38
const NOT_RESCALABLE = "The feed's price could not be converted to 7 decimals"

/**
 * A feed price in the feed's `decimals`, rescaled to the protocol's 7 as the oracle does (principal
 * 3af9388 `rescale_to_protocol_decimals`): equal decimals unchanged; fewer multiplied by
 * 10^(7 − decimals); more divided by 10^(decimals − 7), truncating toward zero (i128 division).
 * Throws where the contract gets None and rejects with `rescale`: a power of ten or a product past
 * i128. `decimals` is the feed's u32.
 */
export function rescaleTo7(raw: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 0xffff_ffff) throw new RangeError(`decimals must be a u32, got ${decimals}`)
  if (decimals === PROTOCOL_DECIMALS) return raw
  const exponent = Math.abs(decimals - PROTOCOL_DECIMALS)
  if (exponent > MAX_I128_POWER_OF_TEN) throw new RangeError(NOT_RESCALABLE)
  const factor = 10n ** BigInt(exponent)
  if (decimals > PROTOCOL_DECIMALS) return raw / factor // BigInt division truncates toward zero, as i128's does.
  const scaled = raw * factor
  if (scaled < I128_MIN || scaled > I128_MAX) throw new RangeError(NOT_RESCALABLE)
  return scaled
}

/** The feed's price for the oracle's asset: two reads on the feed contract, combined. */
async function readFeedPrice(reader: ContractReader, feed: OracleFeed): Promise<Live<FeedPrice>> {
  const [decimals, last] = await Promise.all([
    readLive<unknown, number>(reader, { contractId: feed.contract, functionName: "decimals" }, toU32),
    readLive<unknown, { price: bigint; timestamp: bigint }>(reader, { contractId: feed.contract, functionName: "lastprice", args: [assetArg(feed.asset)] }, parsePriceData),
  ])
  return allLive([decimals, last] as const, ([d, p]) => ({ raw: p.price, decimals: d, value: rescaleTo7(p.price, d), timestamp: p.timestamp }))
}

/** The feed price follows `feed_source()`: read only when it names a feed. */
function feedPriceFor(reader: ContractReader, feed: Live<OracleFeed | null> | UnsupportedRead): Promise<OracleView["feedPrice"]> {
  if (feed.status === "unsupported") return Promise.resolve(null)
  // Whether a feed is set is not known: say so rather than show "no feed".
  if (feed.status === "unavailable") return Promise.resolve(feed)
  return feed.value === null ? Promise.resolve(null) : readFeedPrice(reader, feed.value)
}

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

/**
 * The view of `oracle` (an OracleAdapter id; source preimages still come from `manifest.oracleSources`).
 * Thirteen reads of the oracle, then, only when `feed_source()` names a feed, two of the feed
 * (`decimals`, `lastprice`), sent as soon as the feed is known.
 */
export async function fetchOracleView(reader: ContractReader, manifest: Manifest, oracle: string, ledgerTime: number | null): Promise<OracleView> {
  const big = (fn: string) => readLive<unknown, bigint>(reader, { contractId: oracle, functionName: fn }, toBigint)
  const source = (fn: string) => readLive<unknown, string | null>(reader, { contractId: oracle, functionName: fn }, parseSource)
  const feedRead = readLive<unknown, OracleFeed | null>(reader, { contractId: oracle, functionName: "feed_source" }, parseFeedSource).then(orUnsupported)

  const [value, timestamp, available, maxStale, deviationBps, bounds, primary, fallback, active, wasFeed, lastRejection, feed, feedMinInterval, feedPrice] = await Promise.all([
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
    feedRead,
    big("feed_min_interval_seconds").then(orUnsupported),
    feedRead.then((f) => feedPriceFor(reader, f)),
  ])

  const wasFeedOrUnsupported = orUnsupported(wasFeed)
  const path: OracleView["path"] =
    wasFeedOrUnsupported.status === "live" ? { ...wasFeedOrUnsupported, value: wasFeedOrUnsupported.value ? "feed" : "push" } : wasFeedOrUnsupported

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
    feed,
    feedMinInterval,
    feedPrice,
  }
}
