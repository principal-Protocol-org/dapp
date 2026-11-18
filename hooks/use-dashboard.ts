"use client"

import { useEffect, useState } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useManifest } from "@/components/app/manifest-provider"
import { parseOpenAlerts, type OpenAlertsAnswer } from "@/lib/app/alert-types"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { fetchAssetCompliance, fetchEscrowRecords } from "@/lib/protocol/dashboard/compliance"
import { fetchOracleView, type OracleView } from "@/lib/protocol/dashboard/oracle"
import { fetchPauses } from "@/lib/protocol/dashboard/pauses"
import { fetchPausers, indexedPausers } from "@/lib/protocol/dashboard/pausers"
import { createHorizon } from "@/lib/protocol/horizon"
import { fetchMarketDashboard, fetchProtocolState, pendingClaim, type MarketDashboard } from "@/lib/protocol/dashboard/protocol-state"
import { getMarket } from "@/lib/protocol/manifest"
import { fetchRiskView } from "@/lib/protocol/dashboard/risk"
import { createRpcReader } from "@/lib/protocol/reader"
import type { Live } from "@/lib/protocol/types"
import type { IndexedEvent, IndexedEvents, IndexGroup } from "@/lib/server/indexer"
import type { KeeperHealth, RecordedTick } from "@/lib/server/oracle-ticks"

/** Live widgets (oracle, RiskControl, pauses) refresh every 15 s (D-6, TRANCHE_2_3 l.1077). */
export const DASHBOARD_LIVE_MS = 15_000
/** Aggregates (the every-market sweep and its totals) and history (the index) refresh every 60 s. */
export const DASHBOARD_AGGREGATE_MS = 60_000

export type { IndexedEvent, IndexedEvents, IndexGroup, KeeperHealth, RecordedTick }

/**
 * The query, plus `stale`: a failed refetch keeps the old `data`, and `stale` tells callers not to
 * show it as current (as `useMarketState` does, R35).
 */
function withStale<Q extends { isError: boolean }>(query: Q): Q & { stale: boolean } {
  return { ...query, stale: query.isError }
}

const idsOf = (ids: readonly string[]) => ids.join(",")

/**
 * Every listed market's dashboard figures and the protocol totals (`fetchProtocolState`), every 60 s:
 * the sweep reads each market's whole state, so it refreshes at the aggregate cadence.
 */
export function useProtocolState(marketIds?: readonly string[]) {
  const m = useManifest()
  const ids = marketIds ?? m.markets.map((market) => market.marketId)
  return withStale(
    useQuery({
      queryKey: ["dashboard", "protocol", m.network, idsOf(ids)],
      queryFn: () => fetchProtocolState(createRpcReader(m), m, ids),
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

/**
 * One market's dashboard figures (`fetchMarketDashboard`), for its detail page: one batch of reads every
 * 15 s, the live cadence, since the page watches that one market. An id the manifest does not list is an
 * error, never a read (the route shows the not-found page before this runs).
 */
export function useMarketDashboard(marketId: string) {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "market", m.network, marketId],
      queryFn: () => {
        const market = getMarket(m, marketId)
        if (!market) throw new Error(`Unknown market "${marketId}"`)
        return fetchMarketDashboard(createRpcReader(m), m, market)
      },
      refetchInterval: DASHBOARD_LIVE_MS,
    }),
  )
}

/**
 * What `account` would be paid by claiming its YT yield now, net of the YT fee (`pendingClaim`, D-9),
 * every 15 s. It reads nothing until an address has been looked up (`account`, already validated) and
 * the market's state (`ms`) is in: the net needs its fee, exchange rate and oracle value. No wallet.
 */
export function usePendingClaim(marketId: string, account: string | null, ms: MarketDashboard | undefined) {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "pending", m.network, marketId, account],
      queryFn: () => {
        const market = getMarket(m, marketId)
        if (!market) throw new Error(`Unknown market "${marketId}"`)
        return pendingClaim(createRpcReader(m), market, account as string, ms as MarketDashboard)
      },
      enabled: account !== null && ms !== undefined,
      refetchInterval: DASHBOARD_LIVE_MS,
    }),
  )
}

/**
 * The oracle `oracle` (an OracleAdapter id; `fetchOracleView`) every 15 s, with the ledger time its
 * freshness and time to block were computed at, so a countdown can follow the ledger clock between
 * reads (`secondsToBlockNow`). It waits for the first ledger time: a view read without one would
 * have no time to block. Each oracle has its own query.
 */
export function useOracleView(oracle: string) {
  const m = useManifest()
  const { ledgerTime } = useLedgerClock()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "oracle", m.network, oracle],
      queryFn: async (): Promise<{ view: OracleView; ledgerTime: number }> => {
        const at = ledgerTime as number
        return { view: await fetchOracleView(createRpcReader(m), m, oracle, at), ledgerTime: at }
      },
      enabled: ledgerTime !== null,
      refetchInterval: DASHBOARD_LIVE_MS,
    }),
  )
}

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
 * RiskControl (`fetchRiskView`) every 15 s. It is given the ledger clock's sequence, for the lapsed
 * window, which is deliberately not in the key (it would refetch on every ledger).
 */
export function useRiskView() {
  const m = useManifest()
  const { sequence } = useLedgerClock()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "risk", m.network],
      queryFn: () => fetchRiskView(createRpcReader(m), m, sequence as number),
      enabled: sequence !== null,
      refetchInterval: DASHBOARD_LIVE_MS,
    }),
  )
}

/** Every pausable contract's `is_paused` (`fetchPauses`), every 15 s. */
export function usePauses() {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "pauses", m.network, idsOf(m.markets.map((market) => market.marketId))],
      queryFn: () => fetchPauses(createRpcReader(m), m),
      refetchInterval: DASHBOARD_LIVE_MS,
    }),
  )
}

/** Why a dashboard API answer could not be used, worded for the "Unavailable" tip. */
type Reasons = { notFound: string; notConfigured: string; unavailable: string }

const INDEX_REASONS: Reasons = {
  notFound: "the event index is not available on this server",
  notConfigured: "the event index is not configured on this server",
  unavailable: "the event index could not be read",
}

/** Why the alerts cannot be read while their route does not exist (404): a page may say there is no alert data yet. */
export const ALERTS_NOT_AVAILABLE = "alerts not available yet"

const ALERTS_REASONS: Reasons = {
  notFound: ALERTS_NOT_AVAILABLE,
  notConfigured: "alerts are not configured on this server",
  unavailable: "the alerts could not be read",
}

/** An answer that asking again will not change: a missing route (404) or a body not in the expected shape. */
class FinalError extends Error {}

/**
 * GETs one of the app's dashboard routes. The status is checked before the body: a route that does
 * not exist answers Next's 404 HTML page, not JSON.
 */
async function getJson<T>(url: string, reasons: Reasons): Promise<T> {
  const res = await fetch(url)
  if (res.status === 404) throw new FinalError(reasons.notFound)
  if (res.status === 503) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null
    throw new Error(body?.error === "not_configured" ? reasons.notConfigured : reasons.unavailable)
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return (await res.json()) as T
}

/** How far the index has read, its lag, gaps and last reconciliation, over every group, every 60 s. */
export function useIndexStatus() {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "index-status", m.network],
      queryFn: () => getJson<IndexedEvents>("/api/dashboard/events?limit=1", INDEX_REASONS),
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

/** Newest first, as the index orders them: by ledger, then by event id (fixed-width, so it sorts as the chain does). */
const newestFirst = (a: IndexedEvent, b: IndexedEvent) => b.ledger - a.ledger || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/**
 * Two group answers as one: the rows merged newest first, and the index state of the slower group
 * (lower indexed-through ledger, older close time, longer lag), with both groups' gaps.
 */
function mergeAnswers(answers: IndexedEvents[], limit: number): IndexedEvents {
  const closeTimes = answers.map((a) => a.indexedThroughCloseTime)
  const lags = answers.map((a) => a.lagSeconds)
  return {
    rows: answers.flatMap((a) => a.rows).sort(newestFirst).slice(0, limit),
    indexedThrough: Math.min(...answers.map((a) => a.indexedThrough)),
    indexedThroughCloseTime: closeTimes.some((t) => t === null) ? null : [...(closeTimes as string[])].sort()[0],
    lagSeconds: lags.some((l) => l === null) ? null : Math.max(...(lags as number[])),
    gaps: answers.flatMap((a) => a.gaps),
    // An answer from a server before this field has none.
    pendingGroups: answers.flatMap((a) => a.pendingGroups ?? []),
    reconcile: answers.find((a) => a.reconcile)?.reconcile ?? null,
  }
}

/** The groups whose events are compliance history: RecoveryEscrow seizures and Permissioning changes. */
const COMPLIANCE_GROUPS = ["escrow", "permissioning"] as const

/**
 * The latest `limit` compliance events (RecoveryEscrow and Permissioning), every 60 s. Both groups
 * are read; one failing fails the list, which is never shown partial.
 */
export function useComplianceEvents(limit = 5) {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "compliance-events", m.network, limit],
      queryFn: async () =>
        mergeAnswers(
          await Promise.all(COMPLIANCE_GROUPS.map((g) => getJson<IndexedEvents>(`/api/dashboard/events?group=${g}&limit=${limit}`, INDEX_REASONS))),
          limit,
        ),
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

/**
 * The open alerts, from `GET /api/dashboard/alerts` (`{ open, recent, lastTest }`, `lib/app/alert-types`),
 * every 60 s, with the last 7 days of alerts (open and closed) in `recent`. A server without the route
 * answers 404: an error worded `ALERTS_NOT_AVAILABLE`, not retried. An answer not in that shape is
 * refused, never read as zero.
 */
export function useOpenAlerts() {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "alerts", m.network],
      queryFn: async (): Promise<OpenAlertsAnswer> => {
        const body = await getJson<unknown>("/api/dashboard/alerts", ALERTS_REASONS)
        try {
          return parseOpenAlerts(body)
        } catch (error) {
          throw new FinalError(error instanceof Error ? error.message : String(error))
        }
      },
      // As the app's default (one retry), except for a missing route or a malformed answer.
      retry: (failures, error) => !(error instanceof FinalError) && failures < 1,
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

const TICK_REASONS: Reasons = {
  notFound: "the keeper telemetry is not available on this server",
  notConfigured: "the keeper telemetry is not configured on this server",
  unavailable: "the keeper telemetry could not be read",
}

/** `GET /api/dashboard/oracle-ticks`: the keeper's recent runs, its health and its schedule. */
export type OracleTicksAnswer = { ticks: RecordedTick[]; health: KeeperHealth; intervalSeconds: number }

const isText = (v: unknown) => typeof v === "string"
const isTextOrNull = (v: unknown) => v === null || typeof v === "string"
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0

/** The answer, checked field by field: anything else is refused, never read as a healthy keeper. */
export function parseOracleTicks(body: unknown): OracleTicksAnswer {
  const b = body as Partial<OracleTicksAnswer> | null
  const h = b?.health as Partial<KeeperHealth> | undefined
  const ticksOk =
    Array.isArray(b?.ticks) &&
    b.ticks.every(
      (t) =>
        t !== null &&
        typeof t === "object" &&
        isText(t.id) &&
        isText(t.at) &&
        isText(t.oracle) &&
        isText(t.mode) &&
        isText(t.decision) &&
        [t.value, t.reason, t.txHash, t.signer].every(isTextOrNull),
    )
  const healthOk =
    h !== undefined &&
    h !== null &&
    typeof h.healthy === "boolean" &&
    isTextOrNull(h.lastSuccessAt) &&
    isTextOrNull(h.lastTickAt) &&
    isCount(h.rejected24h) &&
    isCount(h.failures24h)
  if (!ticksOk || !healthOk || !isCount(b?.intervalSeconds) || (b?.intervalSeconds as number) <= 0)
    throw new Error("the keeper telemetry answered in an unexpected shape")
  return b as OracleTicksAnswer
}

/** The keeper's telemetry (spec 0004 D-19): its `limit` latest runs and its health, every 60 s (history). */
export function useOracleTicks(limit = 20) {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "oracle-ticks", m.network, limit],
      queryFn: async (): Promise<OracleTicksAnswer> => {
        const body = await getJson<unknown>(`/api/dashboard/oracle-ticks?limit=${limit}`, TICK_REASONS)
        try {
          return parseOracleTicks(body)
        } catch (error) {
          throw new FinalError(error instanceof Error ? error.message : String(error))
        }
      },
      retry: (failures, error) => !(error instanceof FinalError) && failures < 1,
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

/**
 * Which indexed events a list shows: one group (every group when omitted), one pool, one contract
 * (one oracle's history), some topics.
 */
export type EventQuery = { group?: IndexGroup; pool?: string; contract?: string; topics?: readonly string[] }

/** `GET /api/dashboard/events` for `q`, plus the extra parameters (`limit`, `before`, `counts`). */
function eventsUrl(q: EventQuery, extra: Record<string, string>): string {
  const params = new URLSearchParams()
  if (q.group) params.set("group", q.group)
  if (q.pool) params.set("pool", q.pool)
  if (q.contract) params.set("contract", q.contract)
  if (q.topics && q.topics.length > 0) params.set("topic", q.topics.join(","))
  for (const [k, v] of Object.entries(extra)) params.set(k, v)
  return `/api/dashboard/events?${params}`
}

const queryKeyOf = (q: EventQuery) => [q.group ?? "all", q.pool ?? "all", (q.topics ?? []).join(","), q.contract ?? "all"] as const

/**
 * One indexed-event list, newest first, `pageSize` rows a page (`EventList`). `fetchNextPage` reads
 * the rows older than the last one shown (`before`); a page shorter than `pageSize` is the last.
 * Every loaded page refreshes every 60 s (history).
 */
export function useEventPages(q: EventQuery, pageSize: number) {
  const m = useManifest()
  return withStale(
    useInfiniteQuery({
      queryKey: ["dashboard", "events", m.network, ...queryKeyOf(q), pageSize],
      queryFn: ({ pageParam }: { pageParam: string | null }) =>
        getJson<IndexedEvents>(eventsUrl(q, { limit: String(pageSize), ...(pageParam ? { before: pageParam } : {}) }), INDEX_REASONS),
      initialPageParam: null as string | null,
      getNextPageParam: (last: IndexedEvents) => (last.rows.length === pageSize ? last.rows[last.rows.length - 1].id : null),
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

/** Pages of 200 (the API's most) read at most this many times by `useAllEvents`. */
export const MAX_EVENT_PAGES = 25
const ALL_PAGE = 200

/** Every indexed event of `q`, newest first, with the first page's index state. */
async function fetchAllEvents(q: EventQuery): Promise<IndexedEvents> {
  const first = await getJson<IndexedEvents>(eventsUrl(q, { limit: String(ALL_PAGE) }), INDEX_REASONS)
  const rows = [...first.rows]
  let last = first.rows
  for (let page = 1; last.length === ALL_PAGE; page++) {
    // The last page read was full: there may be no more, or more; either way this page does not show them all.
    if (page >= MAX_EVENT_PAGES)
      throw new FinalError(`the event index holds ${(MAX_EVENT_PAGES * ALL_PAGE).toLocaleString("en-US")} or more rows for this list, more than this page reads`)
    last = (await getJson<IndexedEvents>(eventsUrl(q, { limit: String(ALL_PAGE), before: last[last.length - 1].id }), INDEX_REASONS)).rows
    rows.push(...last)
  }
  return { ...first, rows }
}

/**
 * Every indexed event of `q` (not one page), every 60 s: what a page derives a state from (the
 * pausers, the RecoveryEscrow join). A history longer than `MAX_EVENT_PAGES` pages is refused, never
 * shown in part.
 */
export function useAllEvents(q: EventQuery) {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "events-all", m.network, ...queryKeyOf(q)],
      queryFn: () => fetchAllEvents(q),
      retry: (failures, error) => !(error instanceof FinalError) && failures < 1,
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

export type IndexedCounts = IndexedEvents & { counts: Record<string, number> }

/**
 * How many events the index holds per topic (every row, `?counts=1`), in `group` (every group when
 * omitted) and `pool` (every market when omitted), with the index state, every 60 s.
 */
export function useEventCounts(group?: IndexGroup, pool?: string) {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "event-counts", m.network, group ?? "all", pool ?? "all"],
      queryFn: async (): Promise<IndexedCounts> => {
        const body = await getJson<IndexedEvents & { counts?: unknown }>(eventsUrl({ group, pool }, { counts: "1", limit: "1" }), INDEX_REASONS)
        const counts = body.counts
        if (!counts || typeof counts !== "object" || Array.isArray(counts) || !Object.values(counts).every((n) => Number.isInteger(n)))
          throw new FinalError("the event index answered without counts")
        return { ...body, counts: counts as Record<string, number> }
      },
      retry: (failures, error) => !(error instanceof FinalError) && failures < 1,
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

const PAUSER_TOPICS = ["add_psr", "rm_psr"] as const

/**
 * RiskControl's pausers: `indexed`, from every indexed `add_psr`/`rm_psr` (60 s), and `live`, each
 * of them confirmed with `is_pauser`, plus the admin (`fetchPausers`, 15 s). `events` is the index query.
 */
export function usePausers() {
  const m = useManifest()
  const events = useAllEvents({ group: "risk", topics: PAUSER_TOPICS })
  const indexed = events.data && !events.stale ? indexedPausers(events.data.rows, m.shared.riskControl) : []
  const accounts = indexed.map((p) => p.account)
  const live = withStale(
    useQuery({
      queryKey: ["dashboard", "pausers", m.network, accounts.join(",")],
      queryFn: () => fetchPausers(createRpcReader(m), m, accounts),
      // The admin is read whatever the index says; the accounts wait for it.
      enabled: events.data !== undefined || events.isError,
      refetchInterval: DASHBOARD_LIVE_MS,
    }),
  )
  return { events, indexed, live }
}

/** Every market's RecoveryEscrow (deduplicated), with the markets that use it. */
function escrowsOf(m: ReturnType<typeof useManifest>): { escrow: string; marketIds: string[] }[] {
  const byEscrow = new Map<string, string[]>()
  for (const market of m.markets) {
    const ids = byEscrow.get(market.contracts.recoveryEscrow)
    if (ids) ids.push(market.marketId)
    else byEscrow.set(market.contracts.recoveryEscrow, [market.marketId])
  }
  return [...byEscrow].map(([escrow, marketIds]) => ({ escrow, marketIds }))
}

/** Every RecoveryEscrow's records read live (`fetchEscrowRecords`, D-16), every 60 s (history). */
export function useEscrowRecords() {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "escrow-records", m.network, idsOf(m.markets.map((market) => market.marketId))],
      queryFn: () => {
        const reader = createRpcReader(m)
        return Promise.all(escrowsOf(m).map(async (e) => ({ ...e, records: await fetchEscrowRecords(reader, e.escrow) })))
      },
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

/** Every underlying asset's administrator and flags (`fetchAssetCompliance`), every 60 s, as /app reads them. */
export function useAssetCompliance() {
  const m = useManifest()
  return withStale(
    useQuery({
      queryKey: ["dashboard", "assets", m.network, idsOf(m.markets.map((market) => market.marketId))],
      queryFn: () => fetchAssetCompliance(createHorizon(m.horizonUrl), m.horizonUrl, createRpcReader(m), m),
      refetchInterval: DASHBOARD_AGGREGATE_MS,
    }),
  )
}

/**
 * The browser's clock, ticking every `intervalMs`, for elapsed-time displays ("12s ago"). Null until
 * the first tick after mount: nothing reads the clock during render or prerender (Cache Components).
 */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, intervalMs)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [intervalMs])
  return now
}
