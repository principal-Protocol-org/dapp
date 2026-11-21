/**
 * The oracle pages' pure rules (plan 0009, Task 11): an oracle's state now on the ledger clock, the
 * manifest's oracles as a page lists them, and the stored value against the feed's price. No
 * framework here: the dashboard's components and hooks read these.
 */
import { assetCodes, manifestOracles } from "../manifest"
import { allLive, unavailable } from "../reader"
import type { Live, Manifest, ReadSource } from "../types"
import type { FeedPrice, Freshness, OracleView } from "./oracle"

/** An oracle's view and the ledger time it was computed at. */
export type OracleViewAt = { view: OracleView; ledgerTime: number }

/** What a page holds of one oracle's query: its last answer, whether its last refresh failed, and why. */
export type OracleQueryState = { data?: OracleViewAt; stale: boolean; error: Error | null }

export const FRESHNESS_WORD: Record<Freshness, string> = { fresh: "Fresh", warning: "Warning", stale: "Stale", unavailable: "Unavailable" }

/** The badge status of each state (`components/ui/badge`): the word carries the meaning, the dot only reinforces it. */
export const FRESHNESS_BADGE: Record<Freshness, "live" | "soon" | "paused" | "neutral"> = { fresh: "live", warning: "soon", stale: "paused", unavailable: "neutral" }

/** Worst first: an unread oracle, then a stale one, then one in its warning window. */
export const FRESHNESS_RANK: Record<Freshness, number> = { fresh: 0, warning: 1, stale: 2, unavailable: 3 }

/**
 * Seconds until operations block, now: the read's `timeToBlock` less the ledger time elapsed since
 * it was computed. It follows the ledger clock (ledger time plus elapsed seconds), never the
 * browser's wall clock alone. Null without a ledger time or a time to block.
 */
export function secondsToBlockNow(timeToBlock: Live<number>, readLedgerTime: number, ledgerTimeNow: number | null): number | null {
  if (timeToBlock.status !== "live" || ledgerTimeNow === null) return null
  // `fetchOracleView` floors the ledger time it is given; whole seconds left, rounded down.
  return Math.floor(timeToBlock.value + Math.floor(readLedgerTime) - ledgerTimeNow)
}

/**
 * Freshness now, on the ledger clock: from the seconds left until operations block (`secondsToBlockNow`),
 * as the contract counts it (fresh while age ≤ `max_stale`). Warning from 75% of `max_stale`. The
 * contract's own `is_available() = false` reads Stale.
 */
export function freshnessNow(view: OracleView, left: number | null): { state: Freshness; age: number | null; max: number | null } {
  const max = view.maxStale.status === "live" ? Number(view.maxStale.value) : null
  if (view.available.status === "live" && !view.available.value) return { state: "stale", age: max !== null && left !== null ? max - left : null, max }
  if (view.freshness === "unavailable" || left === null || max === null) return { state: view.freshness, age: null, max }
  // A ledger clock behind the oracle's timestamp counts as age 0 (the contract refuses future timestamps).
  const age = Math.max(0, max - left)
  if (left < 0) return { state: "stale", age, max }
  return { state: age * 4 >= max * 3 ? "warning" : "fresh", age, max }
}

/**
 * One oracle now, as its Freshness figure reads it: the state on the ledger clock, the seconds until
 * operations block, and the reads behind both (`timeToBlock` and `is_available`). Unavailable when
 * any of them is, with that read's reason in `live`; `live` undefined while the first read is pending.
 */
export type OracleNow = { state: Freshness; left: number | null; live: Live<number> | undefined }

/**
 * The reads behind an oracle's state, as the dashboard's `current` gives a figure: Unavailable, with
 * the reason, after a failed refresh (the old read is never shown as current); undefined while the
 * first read is pending, or Unavailable with `blocked` when it cannot start.
 */
function stateReads(q: OracleQueryState, blocked?: string): Live<number> | undefined {
  if (q.stale) return unavailable(`the last refresh failed: ${q.error?.message ?? "unknown error"}`)
  if (q.data !== undefined) return allLive([q.data.view.timeToBlock, q.data.view.available] as const, ([seconds]) => seconds)
  return blocked ? unavailable(blocked) : undefined
}

export function oracleNow(q: OracleQueryState, nowSeconds: number | null, blocked?: string): OracleNow {
  const live = stateReads(q, blocked)
  if (!live || live.status === "unavailable" || q.stale || !q.data) return { state: "unavailable", left: null, live }
  const left = secondsToBlockNow(q.data.view.timeToBlock, q.data.ledgerTime, nowSeconds)
  return { state: freshnessNow(q.data.view, left).state, left, live }
}

/** One oracle of the manifest: its id and the underlying codes of the markets that use it. */
export type OracleEntry = { oracle: string; asset: string }

/** The oracles a dashboard page shows: the manifest's, in market order; the shared oracle when no market is listed. */
export function oracleEntries(m: Pick<Manifest, "markets" | "shared">): OracleEntry[] {
  const oracles = manifestOracles(m)
  return oracles.length > 0 ? oracles.map((o) => ({ oracle: o.oracle, asset: assetCodes(o.markets) })) : [{ oracle: m.shared.oracle, asset: "OracleAdapter" }]
}

/** The call a read made, without its answer: what an unavailable figure keeps so its command can be repeated. */
export function callOf(source: ReadSource | Omit<ReadSource, "rawXdr" | "ledger"> | undefined): Omit<ReadSource, "rawXdr" | "ledger"> | undefined {
  if (!source) return undefined
  const { contractId, fn, args, rpcUrl, viaFallback } = source
  return viaFallback ? { contractId, fn, args, rpcUrl, viaFallback } : { contractId, fn, args, rpcUrl }
}

/** A read's value through `f`, keeping its provenance. */
export function mapLive<T, U>(live: Live<T>, f: (value: T) => U): Live<U> {
  return live.status === "live" ? { ...live, value: f(live.value) } : live
}

/** Of a figure built from several reads, only the read of `fn`: the one its value comes from. */
export function onlyRead<T>(live: Live<T>, fn: string): Live<T> {
  const source = live.status === "live" ? live.sources?.find((s) => s.fn === fn) : undefined
  return live.status === "live" && source ? { status: "live", value: live.value, ledger: source.ledger, source } : live
}

/** The comparison when the feed's price is zero or negative: `sync_from_feed` rejects it (`bad_price`). */
export const FEED_NOT_POSITIVE = "The feed's price is not positive: the oracle would refuse it."

/** Why a stored value of zero or below has no comparison. */
export const STORED_NOT_POSITIVE = "The stored value is not positive, so it has no ratio to the feed's price."

/**
 * The stored value against the feed's, both at 7 decimals, in integer math only: "Equal"; below a
 * factor of 2, the difference as a percent of the smaller, rounded down to 0.01 % ("less than
 * 0.01 %" when that is zero); from a factor of 2, the larger over the smaller (`larger × 1000 /
 * smaller`, floored) to the nearest 0.1. A feed price of zero or below is the oracle's `bad_price`:
 * no comparison. A stored value of zero or below has no ratio: that throws.
 */
export function storedAgainstFeed(stored: bigint, feed: bigint): string {
  if (feed <= 0n) return FEED_NOT_POSITIVE
  if (stored === feed) return "Equal"
  if (stored <= 0n) throw new RangeError(STORED_NOT_POSITIVE)
  const [larger, smaller] = stored > feed ? [stored, feed] : [feed, stored]
  if (larger >= 2n * smaller) {
    const tenths = ((larger * 1000n) / smaller + 50n) / 100n
    return `Differs by a factor of ${tenths / 10n}.${tenths % 10n}`
  }
  const hundredths = ((larger - smaller) * 10_000n) / smaller
  if (hundredths === 0n) return "Differs by less than 0.01 %"
  return `Differs by ${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")} %`
}

/**
 * The comparison as a figure, built from both reads (the stored value's and the feed's two). A stored
 * value of zero or below is Unavailable with the `get_reference_value` call, so the reader can repeat
 * the read that makes it so.
 */
export function storedAgainstFeedLive(stored: Live<bigint>, feed: Live<FeedPrice>): Live<string> {
  if (stored.status === "live" && feed.status === "live" && feed.value.value > 0n && stored.value <= 0n) return unavailable(STORED_NOT_POSITIVE, callOf(stored.source))
  return allLive([stored, feed] as const, ([s, p]) => storedAgainstFeed(s, p.value))
}
