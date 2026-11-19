"use client"

import { Suspense, useState, type MouseEvent, type ReactNode } from "react"
import { useSearchParams } from "next/navigation"
import { formatDuration } from "@/components/app/live"
import { UnavailableTip } from "@/components/app/info-tip"
import { useManifest } from "@/components/app/manifest-provider"
import { Metric } from "@/components/app/market/metric"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DASHBOARD_LIVE_MS,
  secondsToBlockNow,
  useOracleTicks,
  useOracleViews,
  type IndexedEvent,
  type KeeperHealth,
  type OracleViewAt,
  type RecordedTick,
} from "@/hooks/use-dashboard"
import { LEDGER_CLOCK_REFETCH_MS, useLedgerClock } from "@/hooks/use-ledger-clock"
import type { FeedPrice, Freshness, OracleFeed, OracleSourceView, OracleView, Sep40Asset } from "@/lib/protocol/dashboard/oracle"
import { isSignificantRejection, lastRejectionNote, rejectionText } from "@/lib/protocol/dashboard/rejections"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { explorerUrl } from "@/lib/protocol/explorer"
import { formatAmountFixed, formatBps, formatWindow } from "@/lib/protocol/format"
import { assetCodes, manifestOracles } from "@/lib/protocol/manifest"
import type { OracleRejection } from "@/lib/protocol/market-state"
import { allLive, unavailable } from "@/lib/protocol/reader"
import type { Live, Manifest, Network } from "@/lib/protocol/types"
import { AsOf, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { EventList, TxLink, type EventRowText } from "./event-list"
import { accountShort, ago, closeTimeText } from "./event-words"
import { verifiable, VerifyButton, type FigureSpec } from "./figure"
import { Panel, Row } from "./panel"
import { current, readOf, Shown, type QueryLike } from "./query-figures"
import { VerifyDrawer } from "./verify-drawer"

/** The operations the protocol refuses while the oracle is stale (D-17), as the page states them. */
export const BLOCKED_WHEN_STALE_LINE = "Operations blocked when stale: mint, trades, single-sided liquidity, redemption"

/** What an unsupported view reads: the oracle's code has no `last_update_was_feed` (or `feed_source`) view. */
export const PATH_UNSUPPORTED = "Not supported by this oracle's code"

/** The Feed card when `feed_source()` is None. */
export const NO_FEED_SOURCE = "No feed source set: updated by push only."

/** The comparison when the feed's price is zero or negative: `sync_from_feed` rejects it (`bad_price`). */
export const FEED_NOT_POSITIVE = "The feed's price is not positive: the oracle would refuse it."

/** The oracle's 7-decimal fixed point (`SCALE`), every digit shown: the value as the contract stores it. */
const oracleValue = (v: bigint) => formatAmountFixed(v, 7, 7)
const ORACLE_SCALE = "7 decimals: 10,000,000 = 1.0000000 (US dollars per unit of the underlying, oracle units)"

const LINK =
  "font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"

/** "2027-01-15 07:48:00 UTC": a unix-seconds timestamp; shown as the raw seconds when it is no date. */
function utc(seconds: bigint | number): string {
  const ms = Number(seconds) * 1000
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? closeTimeText(new Date(ms).toISOString()) : `${seconds} (unix seconds)`
}

/** A timestamp and, once the ledger clock has passed it, its age on that clock. */
function timestampText(ts: bigint, nowSeconds: number | null): string {
  const age = nowSeconds !== null ? nowSeconds - Number(ts) : null
  return age !== null && age >= 0 ? `${utc(ts)} · ${formatDuration(age)} ago on the ledger clock` : utc(ts)
}

/** A stored decimal string (an event's `value`) as the oracle value; as stored when it is no integer, never guessed. */
function storedValue(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "not decoded"
  try {
    return oracleValue(BigInt(raw))
  } catch {
    return `${raw} (raw value)`
  }
}

/** A stored timestamp (an event's `timestamp`, unix seconds). */
function storedTime(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "not decoded"
  try {
    return utc(BigInt(raw))
  } catch {
    return `${raw} (raw value)`
  }
}

/** Single quotes for a shell: the preimage as one argument, whatever it holds. */
const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/** A read's value through `f`, keeping its provenance. */
function mapLive<T, U>(live: Live<T>, f: (value: T) => U): Live<U> {
  return live.status === "live" ? { ...live, value: f(live.value) } : live
}

/** Of a figure built from several reads, only the read of `fn`: the one its value comes from. */
function onlyRead<T>(live: Live<T>, fn: string): Live<T> {
  const source = live.status === "live" ? live.sources?.find((s) => s.fn === fn) : undefined
  return live.status === "live" && source ? { status: "live", value: live.value, ledger: source.ledger, source } : live
}

/**
 * Freshness now, on the ledger clock: from the seconds left until operations block (`secondsToBlockNow`),
 * as the contract counts it (fresh while age ≤ `max_stale`). Warning from 75% of `max_stale`. The
 * contract's own `is_available() = false` reads Stale.
 */
function freshnessNow(view: OracleView, left: number | null): { state: Freshness; age: number | null; max: number | null } {
  const max = view.maxStale.status === "live" ? Number(view.maxStale.value) : null
  if (view.available.status === "live" && !view.available.value) return { state: "stale", age: max !== null && left !== null ? max - left : null, max }
  if (view.freshness === "unavailable" || left === null || max === null) return { state: view.freshness, age: null, max }
  // A ledger clock behind the oracle's timestamp counts as age 0 (the contract refuses future timestamps).
  const age = Math.max(0, max - left)
  if (left < 0) return { state: "stale", age, max }
  return { state: age * 4 >= max * 3 ? "warning" : "fresh", age, max }
}

export const FRESHNESS_WORD: Record<Freshness, string> = { fresh: "Fresh", warning: "Warning", stale: "Stale", unavailable: "Unavailable" }
export const FRESHNESS_BADGE: Record<Freshness, "live" | "soon" | "paused" | "neutral"> = { fresh: "live", warning: "soon", stale: "paused", unavailable: "neutral" }

/**
 * One oracle now, as its Freshness figure reads it: the state on the ledger clock, the seconds until
 * operations block, and the reads behind both (`timeToBlock` and `is_available`). Unavailable when
 * any of them is, with that read's reason in `live`; `live` undefined while the first read is pending.
 */
export type OracleNow = { state: Freshness; left: number | null; live: Live<number> | undefined }

export function oracleNow(q: QueryLike<OracleViewAt>, nowSeconds: number | null, blocked?: string): OracleNow {
  const live = current(q, (d) => allLive([d.view.timeToBlock, d.view.available] as const, ([seconds]) => seconds), blocked)
  if (!live || live.status === "unavailable" || q.stale || !q.data) return { state: "unavailable", left: null, live }
  const left = secondsToBlockNow(q.data.view.timeToBlock, q.data.ledgerTime, nowSeconds)
  return { state: freshnessNow(q.data.view, left).state, left, live }
}

function freshnessDetail(f: { state: Freshness; age: number | null; max: number | null }, available: boolean): string {
  if (!available) return "is_available() reads false"
  if (f.age === null || f.max === null) return ""
  const window = formatWindow(BigInt(f.max))
  if (f.state === "stale") return `age ${formatDuration(f.age)}, past ${window}`
  if (f.state === "warning") return `age ${formatDuration(f.age)} of ${window}, 75% or more`
  return `age ${formatDuration(f.age)} of ${window}`
}

function countdownText(left: number, available: boolean): string {
  if (!available) return "Blocked now: is_available() reads false"
  return left < 0 ? `Blocked for ${formatDuration(-left)}` : formatDuration(left)
}

const sourceText = (v: string | null) => (v === null ? "None set" : v)

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
  if (stored <= 0n) throw new RangeError("the stored value is not positive, so it has no ratio to the feed's price")
  const [larger, smaller] = stored > feed ? [stored, feed] : [feed, stored]
  if (larger >= 2n * smaller) {
    const tenths = ((larger * 1000n) / smaller + 50n) / 100n
    return `Differs by a factor of ${tenths / 10n}.${tenths % 10n}`
  }
  const hundredths = ((larger - smaller) * 10_000n) / smaller
  if (hundredths === 0n) return "Differs by less than 0.01 %"
  return `Differs by ${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")} %`
}

const COMPARISON_SCALE =
  "get_reference_value against the feed's lastprice at 7 decimals, in integer math: Equal; below a factor of 2, the difference as a percent of the smaller value, rounded down to 0.01 %; from a factor of 2, the larger over the smaller, to the nearest 0.1"

const assetKey = (a: Sep40Asset) => (a.kind === "Stellar" ? `Stellar ${accountShort(a.address)}` : `Other ${a.symbol}`)

/** A contract outside the manifest (a feed): its short id, linking to stellar.expert when the network has it. */
function ContractLink({ network, label, id }: { network: Network; label: string; id: string }) {
  const url = explorerUrl(network, "contract", id)
  if (!url) return <span title={id}>{accountShort(id)}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" title={id} aria-label={`${label} ${id} on stellar.expert`} className={LINK}>
      {accountShort(id)}
    </a>
  )
}

/** One source: its id (with its drawer) and, when the manifest knows it, the preimage and the command that hashes it. */
function SourceRow({ label, spec, view }: { label: string; spec: FigureSpec<string | null>; view: OracleSourceView | undefined }) {
  const hash = view?.hash.status === "live" ? view.hash.value : null
  return (
    <Row label={label}>
      <Shown {...spec} />
      {view?.preimage ? (
        <span className="mt-1 grid gap-1 font-mono text-xs/5 text-ink-muted">
          <span className="wrap-anywhere">Preimage {view.preimage}</span>
          <span className="font-sans">sha256 of the preimage is the id; check it with:</span>
          <code className="rounded-md border border-line bg-surface-sunk p-2 text-ink wrap-anywhere">{`printf %s ${shellQuote(view.preimage)} | shasum -a 256`}</code>
        </span>
      ) : hash !== null ? (
        <span className="mt-1 block font-sans text-xs/5 text-ink-muted">No preimage in the manifest</span>
      ) : null}
    </Row>
  )
}

/** A figure the oracle's code does not have: the sentence, and a drawer giving the call that shows the host's MissingValue. */
function UnsupportedRow({ label, figure }: { label: string; figure: VerifiableFigure }) {
  return (
    <Row label={label}>
      <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
        <span className="min-w-0 font-sans wrap-anywhere">{PATH_UNSUPPORTED}</span>
        <VerifyDrawer figure={figure} trigger={<VerifyButton name={`How to verify ${figure.label}`} />} />
      </span>
    </Row>
  )
}

const DECISION_WORD: Record<string, string> = { pushed: "Pushed", synced: "Synced from the feed" }

/** The keeper's own reason for an oracle with no feed source (`NO_FEED_REASON` in lib/server/oracle-keeper.ts). */
const NO_FEED_REASON = "no_feed"

/**
 * A run that changed nothing, by its reason: no feed source; the oracle's minimum interval
 * (`throttle`); otherwise the feed had nothing newer (`stale_ts`, `no_data`). A push run with no
 * reason found the value already current: push mode has no feed.
 */
function skippedWords(t: RecordedTick): string {
  if (t.reason === NO_FEED_REASON) return "Skipped: no feed source"
  if (t.reason === "throttle") return "Skipped: too soon after the last accepted update"
  if (t.mode === "push" && !t.reason) return "Skipped: the value was already current"
  return "Skipped: the feed had nothing newer"
}

/**
 * What a recorded run did, in words: a rejection with its reason's words, a skip with its reason
 * (D-21), an error with what the run recorded.
 */
function tickWords(t: RecordedTick): string {
  if (t.decision === "rejected") return `Rejected: ${t.reason ? rejectionText(t.reason) : "no reason recorded"}`
  if (t.decision === "skipped") return skippedWords(t)
  if (t.decision === "error") {
    const reason = t.reason ?? ""
    if (reason.startsWith("not_configured: ")) return `Not configured: ${reason.slice("not_configured: ".length)}`
    if (reason.startsWith("failed: ")) return `Failed: ${reason.slice("failed: ".length)}`
    return `Failed: ${reason || "no reason recorded"}`
  }
  return DECISION_WORD[t.decision] ?? t.decision
}

function TickTable({ network, ticks }: { network: Network; ticks: RecordedTick[] }) {
  return (
    <Table aria-label="Recent keeper runs">
      <TableHeader>
        <TableRow>
          <TableHead className="max-[520px]:px-3">Run</TableHead>
          <TableHead className="text-right max-[520px]:hidden">Value</TableHead>
          <TableHead className="max-[720px]:hidden">At (UTC)</TableHead>
          <TableHead className="max-[520px]:hidden">Transaction</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ticks.map((t) => {
          const value = t.value === null ? "—" : storedValue(t.value)
          return (
            <TableRow key={t.id}>
              <TableCell className="font-sans text-ink whitespace-normal max-[520px]:px-3">
                <span className="block wrap-anywhere">{tickWords(t)}</span>
                {/* Each piece stays whole; the separators between them are where the line may wrap. */}
                <span className="block font-mono text-xs text-ink-muted">
                  <span className="whitespace-nowrap">{t.mode}</span>
                  {" · "}
                  {t.signer ? (
                    <span title={t.signer} className="whitespace-nowrap">
                      signer {accountShort(t.signer)}
                    </span>
                  ) : (
                    <span className="whitespace-nowrap">no signer</span>
                  )}
                  <span className="min-[520px]:hidden">
                    {" · "}
                    <span className="whitespace-nowrap">value {value}</span>
                  </span>
                  <span className="min-[720px]:hidden">
                    {" · "}
                    <span className="whitespace-nowrap">{closeTimeText(t.at)}</span>
                  </span>
                </span>
                {t.txHash ? (
                  <span className="block min-[520px]:hidden">
                    <TxLink network={network} hash={t.txHash} />
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-right max-[520px]:hidden">{value}</TableCell>
              <TableCell className="text-xs max-[720px]:hidden">{closeTimeText(t.at)}</TableCell>
              <TableCell className="max-[520px]:hidden">{t.txHash ? <TxLink network={network} hash={t.txHash} /> : <span className="text-xs text-ink-muted">No transaction</span>}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/**
 * Healthy now (D-19, M-15): the last run that did not fail (`lastOkAt`) is younger than 2 × the
 * interval, its age measured on the ledger clock here (the browser's copy of `keeperHealth`'s rule).
 * The API's own `healthy` was computed when its answer was, and that answer is cached for minutes: it
 * is used only until the ledger clock is read.
 */
export function keeperHealthyNow(health: Pick<KeeperHealth, "healthy" | "lastOkAt">, intervalSeconds: number, ledgerTime: number | null): boolean {
  if (health.lastOkAt === null) return false
  if (ledgerTime === null) return health.healthy
  return ledgerTime - Date.parse(health.lastOkAt) / 1000 < 2 * intervalSeconds
}

/**
 * The keeper's health and recent runs (D-19) for `oracle`, from its recorded ticks
 * (`GET /api/dashboard/oracle-ticks?oracle=`). No run recorded is a neutral state: "No keeper run
 * recorded yet", neither healthy nor unhealthy.
 */
function KeeperPanel({ network, oracle, ledgerTime }: { network: Network; oracle: string; ledgerTime: number | null }) {
  const q = useOracleTicks(oracle, 20)
  const agoText = (iso: string) => (ledgerTime !== null ? ` · ${ago(ledgerTime - Date.parse(iso) / 1000)}` : "")
  const entry = q.data?.oracles.find((o) => o.oracle === oracle)
  const raw = `/api/dashboard/oracle-ticks?oracle=${encodeURIComponent(oracle)}&limit=100`
  let body: ReactNode
  if (q.isError) body = <UnavailableTip label="Keeper health" reason={q.error?.message ?? "the keeper telemetry could not be read"} className="text-sm text-ink" />
  else if (!q.data) body = <Skeleton className="h-24 w-full" />
  else if (!entry) body = <UnavailableTip label="Keeper health" reason="the keeper telemetry has no entry for this oracle" className="text-sm text-ink" />
  else {
    const { intervalSeconds } = q.data
    const { health, ticks } = entry
    const none = health.lastTickAt === null
    const healthy = keeperHealthyNow(health, intervalSeconds, ledgerTime)
    body = (
      <>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 min-[420px]:grid-cols-2 min-[900px]:grid-cols-4">
          <Metric label="Health" valueClassName="min-w-0 text-sm">
            {none ? (
              <span className="font-sans text-ink-muted">No keeper run recorded yet</span>
            ) : (
              <Badge status={healthy ? "live" : "paused"}>{healthy ? "Healthy" : "Unhealthy"}</Badge>
            )}
          </Metric>
          <Metric label="Last successful update" valueClassName="min-w-0 text-sm wrap-anywhere">
            {health.lastSuccessAt ? `${closeTimeText(health.lastSuccessAt)}${agoText(health.lastSuccessAt)}` : "None recorded"}
          </Metric>
          <Metric label="Rejected runs (24 h)" valueClassName="text-sm">
            {String(health.rejected24h)}
          </Metric>
          <Metric label="Failed runs (24 h)" valueClassName="text-sm">
            {String(health.failures24h)}
          </Metric>
        </dl>
        <p className="text-xs/5 text-ink-muted">
          Healthy while the last run that did not fail is under {formatWindow(BigInt(2 * intervalSeconds))} old: twice the keeper&apos;s schedule, every{" "}
          {formatWindow(BigInt(intervalSeconds))}. A skipped or rejected run counts, since the feed may have no new price; a failed run includes one that could not start.
        </p>
        {/* With no run recorded, the health line already says so. */}
        {ticks.length > 0 ? <TickTable network={network} ticks={ticks} /> : null}
        <p className="text-xs/5 text-ink-muted">
          Raw telemetry, as JSON:{" "}
          <a href={raw} className="font-mono underline decoration-line-strong underline-offset-4 wrap-anywhere hover:decoration-ink">
            {raw}
          </a>
        </p>
      </>
    )
  }
  return (
    <Panel
      title="Keeper"
      className="min-[900px]:col-span-2"
      meta={
        <p className="text-xs/5 text-ink-muted">
          Each run of the app&apos;s oracle keeper (cron/oracle) records its outcome for this oracle: the value, the reason, the transaction and the
          signer&apos;s public key. Refreshes every 1 min.
        </p>
      }
    >
      {body}
    </Panel>
  )
}

/** One oracle of the manifest: its id and the underlying codes of the markets that use it. */
export type OracleEntry = { oracle: string; asset: string }

/** The oracles a dashboard page shows: the manifest's, in market order; the shared oracle when no market is listed. */
export function oracleEntries(m: Manifest): OracleEntry[] {
  const oracles = manifestOracles(m)
  return oracles.length > 0 ? oracles.map((o) => ({ oracle: o.oracle, asset: assetCodes(o.markets) })) : [{ oracle: m.shared.oracle, asset: "OracleAdapter" }]
}

/** "Push", "Feed", "Not supported", or why the path is not known; null while the first read is pending. */
function pathWord(q: QueryLike<OracleViewAt>): { text: string } | { reason: string } | null {
  if (q.stale) return { reason: `the last refresh failed: ${q.error?.message ?? "unknown error"}` }
  if (!q.data) return null
  const path = q.data.view.path
  if (path.status === "unsupported") return { text: "Not supported" }
  if (path.status === "unavailable") return { reason: path.error }
  return { text: path.value === "feed" ? "Feed" : "Push" }
}

const CELL_SKELETON = <Skeleton className="inline-block h-4 w-14 max-w-full align-middle" />

/**
 * Every oracle of the manifest, one row each: its asset and short id, its state now, the time until
 * operations block, and how its value was last set. Each row links to `?oracle=<id>`, its detail
 * below. Below 520 px the countdown, and below 720 px the path, fold under the oracle's name, so
 * the table never scrolls inside its card.
 */
function OraclesTable({
  rows,
  selected,
  onChoose,
}: {
  rows: { entry: OracleEntry; now: OracleNow; path: ReturnType<typeof pathWord> }[]
  selected: string
  onChoose: (event: MouseEvent<HTMLAnchorElement>, oracle: string) => void
}) {
  return (
    <Table aria-label="Oracles">
      <TableHeader>
        <TableRow>
          <TableHead className="max-[520px]:px-3">Oracle</TableHead>
          <TableHead className="max-[520px]:px-3">State</TableHead>
          <TableHead className="max-[520px]:hidden">Blocks in</TableHead>
          <TableHead className="max-[720px]:hidden">Update path</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(({ entry, now, path }) => {
          const label = `${entry.asset} oracle`
          const loading = now.live === undefined
          let countdown: ReactNode
          if (loading) countdown = CELL_SKELETON
          else if (now.state === "stale") countdown = "Stale"
          else if (now.state === "unavailable" || now.left === null)
            countdown = <UnavailableTip label={label} reason={now.live?.status === "unavailable" ? now.live.error : "the ledger time is not known yet"} />
          else countdown = formatDuration(now.left)
          const pathText = path === null ? CELL_SKELETON : "text" in path ? path.text : <UnavailableTip label={`${label} update path`} reason={path.reason} />
          const isSelected = entry.oracle === selected
          return (
            <TableRow key={entry.oracle} className={isSelected ? "bg-surface-sunk" : undefined}>
              <TableCell className="font-sans text-ink whitespace-normal max-[520px]:px-3">
                <a
                  href={`/dashboard/oracle?oracle=${encodeURIComponent(entry.oracle)}`}
                  aria-current={isSelected ? "true" : undefined}
                  onClick={(event) => onChoose(event, entry.oracle)}
                  className={LINK}
                >
                  {entry.asset}
                </a>
                {/* Each piece stays whole; the separators between them are where the line may wrap. */}
                <span className="block font-mono text-xs text-ink-muted">
                  <span title={entry.oracle} className="whitespace-nowrap">
                    {accountShort(entry.oracle)}
                  </span>
                  <span className="min-[520px]:hidden">
                    {" · "}
                    <span className="whitespace-nowrap">{countdown}</span>
                  </span>
                  <span className="min-[720px]:hidden">
                    {" · "}
                    <span className="whitespace-nowrap">{pathText}</span>
                  </span>
                </span>
              </TableCell>
              <TableCell className="max-[520px]:px-3">{loading ? CELL_SKELETON : <Badge status={FRESHNESS_BADGE[now.state]}>{FRESHNESS_WORD[now.state]}</Badge>}</TableCell>
              <TableCell className="max-[520px]:hidden">{countdown}</TableCell>
              <TableCell className="font-sans max-[720px]:hidden">{pathText}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** The oracle a link names (`?oracle=`): one of the manifest's, else the first, silently. */
function selectedFrom(params: URLSearchParams | null, oracles: readonly OracleEntry[]): string {
  const asked = params?.get("oracle") ?? null
  return asked !== null && oracles.some((o) => o.oracle === asked) ? asked : oracles[0].oracle
}

/**
 * The selection into the address bar, so the view can be shared as a link. `replaceState` updates
 * `useSearchParams` without a server round trip or a remount (Next's native History API support).
 */
function writeUrl(oracle: string) {
  const params = new URLSearchParams({ oracle })
  window.history.replaceState(null, "", `${window.location.pathname}?${params}${window.location.hash}`)
}

function Heading() {
  return (
    <div className="min-w-0">
      <h1 id="oracle-heading" className="font-serif text-3xl text-ink">
        Oracle
      </h1>
      <p className="mt-2 max-w-[68ch] text-ink-muted">
        Each market&apos;s OracleAdapter, read live against ledger time: its reference value and freshness, its policy, its sources and the price feed
        it can read. Pick an oracle in the list to see it in detail. Its update and rejection history comes from the event index, and the keeper&apos;s
        health from its recorded runs. No wallet is needed.
      </p>
    </div>
  )
}

function OracleFallback() {
  return (
    <section aria-labelledby="oracle-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <Heading />
      <Skeleton className="h-48 w-full" />
    </section>
  )
}

/**
 * The public oracle page (`/dashboard/oracle`, D-17; plan 0009): every oracle of the manifest in a
 * table, then the one picked (`?oracle=`, the first by default): the OracleAdapter's value and
 * timestamp, its freshness and the time until operations block (on the ledger clock, ticking every
 * second), the feed it reads and the feed's price beside the stored value, its policy and bounds,
 * its sources with their preimages, the update path, the last rejection (D-18), the keeper's health
 * (D-19) and the rejection and update history from the index. No wallet is read; every contract
 * figure has its How-to-verify drawer. The selection lives in the URL, read inside `<Suspense>`.
 */
export function OraclePanel() {
  return (
    <Suspense fallback={<OracleFallback />}>
      <OraclesView />
    </Suspense>
  )
}

function OraclesView() {
  const m = useManifest()
  const params = useSearchParams()
  const { ledgerTime, isError: clockFailed, sinceReadSeconds } = useLedgerClock()
  const oracles = oracleEntries(m)
  // Until the reader picks an oracle, the link's applies.
  const [chosen, setChosen] = useState<string | null>(null)
  const selected = chosen !== null && oracles.some((o) => o.oracle === chosen) ? chosen : selectedFrom(params, oracles)
  const index = oracles.findIndex((o) => o.oracle === selected)
  const entry = oracles[index]
  // One query per oracle: the table reads them all, and the detail is the selected one's.
  const views = useOracleViews(oracles.map((o) => o.oracle))
  const oracle = views[index]

  const choose = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    // A new tab or window opens the link as it is.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    setChosen(id)
    writeUrl(id)
  }

  // One rounding for every age on the page: whole seconds of ledger time, floored.
  const nowSeconds = ledgerTime === null ? null : Math.floor(ledgerTime)
  // The clock's time is extrapolated between reads; past 2 × its cadence without a new read, say so.
  const clockLag = sinceReadSeconds != null && sinceReadSeconds > (2 * LEDGER_CLOCK_REFETCH_MS) / 1000 ? Math.floor(sinceReadSeconds) : null

  const noClock = clockFailed && ledgerTime === null ? "the ledger time could not be read" : undefined
  const tableRows = oracles.map((o, i) => ({ entry: o, now: oracleNow(views[i], nowSeconds, noClock), path: pathWord(views[i]) }))
  const read = readOf(oracle, DASHBOARD_LIVE_MS)
  const view = oracle.stale ? undefined : oracle.data
  const pick = <T,>(f: (v: OracleView) => Live<T>) => current(oracle, (d) => f(d.view), noClock)

  const left = view ? secondsToBlockNow(view.view.timeToBlock, view.ledgerTime, nowSeconds) : null
  const available = !(view?.view.available.status === "live" && !view.view.available.value)
  const fresh = view ? freshnessNow(view.view, left) : null

  const value: FigureSpec<bigint> = { label: "Reference value", live: pick((v) => v.value), format: oracleValue, scale: ORACLE_SCALE, read }
  const timestamp: FigureSpec<bigint> = {
    label: "Oracle timestamp",
    live: pick((v) => v.timestamp),
    format: (ts) => timestampText(ts, nowSeconds),
    scale: "Unix seconds (UTC)",
    read,
  }
  const freshness: FigureSpec<boolean> = {
    label: "Freshness",
    live: pick((v) => allLive([v.timestamp, v.maxStale, v.available] as const, () => true)),
    format: () => {
      if (!fresh) return "Unavailable"
      const detail = freshnessDetail(fresh, available)
      return detail ? `${FRESHNESS_WORD[fresh.state]} · ${detail}` : FRESHNESS_WORD[fresh.state]
    },
    scale: "Fresh while age ≤ max_stale_seconds (the contract's is_fresh); Warning from 75%; age is ledger time − the oracle timestamp",
    read,
  }
  const timeToBlock: FigureSpec<number> = {
    label: "Time until operations block",
    live: pick((v) => v.timeToBlock),
    format: (seconds) => countdownText(left ?? seconds, available),
    scale: "Seconds: the oracle timestamp + max_stale_seconds − ledger time; counts down on the ledger clock",
    read,
  }
  const maxStale: FigureSpec<bigint> = { label: "Max stale", live: pick((v) => v.maxStale), format: (s) => `${s.toLocaleString("en-US")} s (${formatWindow(s)})`, scale: "Seconds", read }
  const deviation: FigureSpec<bigint> = {
    label: "Deviation cap",
    live: pick((v) => v.deviationBps),
    format: (bps) => `${formatBps(bps)} per update (${bps} bps)`,
    scale: "Basis points: 10,000 = 100%",
    read,
  }
  const bounds: FigureSpec<{ min: bigint; max: bigint } | null> = {
    label: "Value bounds",
    live: pick((v) => v.bounds),
    format: (b) => (b === null ? "None set" : `${oracleValue(b.min)} to ${oracleValue(b.max)}`),
    scale: ORACLE_SCALE,
    read,
  }
  const sourceSpec = (label: string, f: (v: OracleView) => OracleSourceView): FigureSpec<string | null> => ({
    label,
    live: pick((v) => f(v).hash),
    format: sourceText,
    scale: "32 bytes, hex: sha256 of the source's preimage",
    read,
  })
  const primary = sourceSpec("Primary source", (v) => v.sources.primary)
  const fallback = sourceSpec("Fallback source", (v) => v.sources.fallback)
  const active = sourceSpec("Active source", (v) => v.sources.active)

  const path = view?.view.path
  const pathUnsupported = !oracle.stale && path?.status === "unsupported" ? path : null
  // After a feed sync, get_active_source still names the last push source: it is shown only when the value was not set from the feed.
  const pathIsFeed = path?.status === "live" && path.value === "feed"
  const pathSpec: FigureSpec<"push" | "feed"> = {
    label: "Update path",
    live: pathUnsupported ? undefined : pick((v) => (v.path.status === "unsupported" ? unavailable(PATH_UNSUPPORTED) : v.path)),
    format: (p) => (p === "feed" ? "Feed: the oracle read its feed (sync_from_feed)" : "Push: the value was set by the oracle's admin (set_reference_value)"),
    read,
  }
  // Not supported is a definite answer, not a failed read: its drawer gives the call that shows the host's MissingValue.
  const pathFigure: VerifiableFigure | null = pathUnsupported
    ? {
        label: "Update path",
        display: PATH_UNSUPPORTED,
        live: unavailable(`${PATH_UNSUPPORTED}: last_update_was_feed answers HostError: Error(WasmVm, MissingValue)`, pathUnsupported.source),
        ...(read ? { read } : {}),
      }
    : null

  // The Feed card (3af9388): what feed_source() says decides which rows it has. Not known (a failed refresh, no clock): every row, each Unavailable.
  const feedRead = view?.view.feed
  const feedState: "loading" | "unsupported" | "none" | "set" =
    oracle.stale || (!view && noClock) ? "set" : !view || !feedRead ? "loading" : feedRead.status === "unsupported" ? "unsupported" : feedRead.status === "live" && feedRead.value === null ? "none" : "set"
  const feedLive = (v: OracleView): Live<OracleFeed | null> => (v.feed.status === "unsupported" ? unavailable(PATH_UNSUPPORTED, v.feed.source) : v.feed)
  const noFeedPrice = (v: OracleView): Live<FeedPrice> => v.feedPrice ?? unavailable("no feed source is set")
  const feedSource: FigureSpec<OracleFeed | null> = {
    label: feedState === "none" ? "Feed source" : "Feed contract",
    live: pick(feedLive),
    format: (f) => (f === null ? NO_FEED_SOURCE : f.contract),
    scale: "feed_source(): the SEP-40 price feed this oracle reads and the asset it asks for; None until set_feed_source",
    read,
  }
  const assetSpec: FigureSpec<Sep40Asset | null> = {
    label: "Asset key",
    live: pick((v) => mapLive(feedLive(v), (f) => f?.asset ?? null)),
    format: (a) => (a === null ? NO_FEED_SOURCE : assetKey(a)),
    scale: "Sep40Asset, the key the oracle passes to the feed's lastprice: Stellar(address) or Other(symbol)",
    read,
  }
  const minInterval: FigureSpec<bigint> = {
    label: "Minimum interval between feed updates",
    live: pick((v) =>
      v.feedMinInterval.status === "unsupported"
        ? unavailable(`${PATH_UNSUPPORTED}: feed_min_interval_seconds answers HostError: Error(WasmVm, MissingValue)`, v.feedMinInterval.source)
        : v.feedMinInterval,
    ),
    format: (s) => (s === 0n ? "No minimum" : `${s.toLocaleString("en-US")} s`),
    scale: "Seconds: sync_from_feed refuses (throttle) a feed update sooner than this after the last accepted one; 300 unless set",
    read,
  }
  const feedPrice: FigureSpec<FeedPrice> = {
    label: "Feed price",
    live: pick(noFeedPrice),
    format: (p) => oracleValue(p.value),
    scale: `The feed's lastprice in its own decimals (decimals()), rescaled to 7 as the oracle does, truncated: ${ORACLE_SCALE}`,
    read,
  }
  const feedAge: FigureSpec<bigint> = {
    label: "Feed tick age",
    live: pick((v) => onlyRead(mapLive(noFeedPrice(v), (p) => p.timestamp), "lastprice")),
    format: (ts) => timestampText(ts, nowSeconds),
    scale: "Unix seconds (UTC): the timestamp of the feed's lastprice; its age is ledger time − that timestamp",
    read,
  }
  const comparison: FigureSpec<string> = {
    label: "Stored value against feed",
    live: pick((v) => allLive([v.value, noFeedPrice(v)] as const, ([stored, p]) => storedAgainstFeed(stored, p.value))),
    format: (text) => text,
    scale: COMPARISON_SCALE,
    read,
  }
  const feedUnsupported = !oracle.stale && feedRead?.status === "unsupported" ? feedRead : null
  const feedFigure: VerifiableFigure | null = feedUnsupported
    ? {
        label: "Feed source",
        display: PATH_UNSUPPORTED,
        live: unavailable(`${PATH_UNSUPPORTED}: feed_source answers HostError: Error(WasmVm, MissingValue)`, feedUnsupported.source),
        ...(read ? { read } : {}),
      }
    : null
  const feedSpecs: FigureSpec<unknown>[] =
    feedState === "set" ? ([feedSource, assetSpec, minInterval, feedPrice, feedAge, comparison] as FigureSpec<unknown>[]) : feedState === "none" ? [feedSource as FigureSpec<unknown>] : []

  const lastRejection: FigureSpec<OracleRejection | null> = {
    label: "Last rejection",
    live: pick((v) => v.lastRejection),
    format: (r) => (r === null ? "None recorded" : `${rejectionText(r.reason)} · value ${oracleValue(r.value)} · dated ${utc(r.timestamp)}`),
    scale: "last_rejection(): reason (a symbol), value (7 decimals), timestamp (unix seconds)",
    read,
  }
  const rejection = view?.view.lastRejection.status === "live" ? view.view.lastRejection.value : null

  const specs = [
    value,
    timestamp,
    freshness,
    timeToBlock,
    ...feedSpecs,
    maxStale,
    deviation,
    bounds,
    primary,
    fallback,
    ...(pathIsFeed ? [] : [active]),
    pathSpec,
    lastRejection,
  ] as FigureSpec<unknown>[]
  const figures = [...specs.map(verifiable), feedFigure, pathFigure].filter((f): f is VerifiableFigure => f !== null)
  const freshState = fresh?.state ?? "unavailable"

  const describeRejection = (r: IndexedEvent): EventRowText => ({
    title: typeof r.data.reason === "string" ? rejectionText(r.data.reason) : "Rejection, reason not decoded",
    detail: `value ${storedValue(r.data.value)} · dated ${storedTime(r.data.timestamp)} · reason ${typeof r.data.reason === "string" ? r.data.reason : "not decoded"}`,
  })
  const describeUpdate = (r: IndexedEvent): EventRowText => ({ title: `Value set to ${storedValue(r.data.value)}`, detail: `dated ${storedTime(r.data.timestamp)}` })

  return (
    <section aria-labelledby="oracle-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <Heading />
          <CopyEvidence figures={figures} />
        </div>
        <AsOf sources={readsOf(specs.map((f) => f.live))} updatedAt={oracle.stale ? null : oracle.dataUpdatedAt || null} cadenceMs={DASHBOARD_LIVE_MS} />
      </div>

      <Panel title="Oracles" meta={<p className="text-xs/5 text-ink-muted">One per market, each read live every 15 s. Pick one to see it in detail below.</p>}>
        <OraclesTable rows={tableRows} selected={selected} onChoose={choose} />
      </Panel>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 min-[900px]:grid-cols-2">
        <Panel
          title="Reference value"
          meta={
            <p className="text-xs/5 text-ink-muted">
              <span title={selected}>OracleAdapter {accountShort(selected)}</span> ({entry.asset}) · refreshes every 15 s; the countdown follows the ledger clock
            </p>
          }
        >
          <dl className="grid gap-3">
            <Row label="Value">
              <Shown {...value} />
            </Row>
            <Row label="Timestamp">
              <Shown {...timestamp} />
            </Row>
            <Row label="Freshness">
              <Shown
                {...freshness}
                render={(_, display) => {
                  const [word, ...rest] = display.split(" · ")
                  return (
                    <>
                      <Badge status={FRESHNESS_BADGE[freshState]}>{word}</Badge> <span className="font-mono text-sm">{rest.join(" · ")}</span>
                    </>
                  )
                }}
              />
            </Row>
            <Row label="Time until operations block">
              <Shown {...timeToBlock} className={freshState === "stale" ? "text-negative" : undefined} />
              {clockLag !== null ? (
                <span className="mt-1 block font-sans text-xs/5 font-semibold text-negative">
                  Ledger clock not refreshed for {formatDuration(clockLag)}: the countdown runs on the last read plus elapsed time
                </span>
              ) : null}
            </Row>
          </dl>
          <p className="text-sm text-ink">{BLOCKED_WHEN_STALE_LINE}</p>
        </Panel>

        <Panel
          title="Feed"
          meta={<p className="text-xs/5 text-ink-muted">feed_source(): the SEP-40 price feed this oracle reads (sync_from_feed), and the feed&apos;s latest price beside the stored value</p>}
        >
          <dl className="grid gap-3">
            {feedState === "loading" ? (
              <Row label="Feed contract">
                <Shown {...feedSource} />
              </Row>
            ) : feedState === "unsupported" && feedFigure ? (
              <UnsupportedRow label="Feed source" figure={feedFigure} />
            ) : feedState === "none" ? (
              <Row label="Feed source">
                <Shown {...feedSource} className="font-sans" />
              </Row>
            ) : (
              <>
                <Row label="Feed contract">
                  <Shown {...feedSource} render={(f, display) => (f === null ? display : <ContractLink network={m.network} label="Feed contract" id={f.contract} />)} />
                </Row>
                <Row label="Asset key">
                  <Shown {...assetSpec} render={(a, display) => (a?.kind === "Stellar" ? <span title={a.address}>{display}</span> : display)} />
                </Row>
                <Row label="Minimum interval between feed updates">
                  <Shown {...minInterval} />
                </Row>
                <Row label="Feed price">
                  <Shown {...feedPrice} />
                </Row>
                <Row label="Feed tick age">
                  <Shown {...feedAge} />
                </Row>
                <Row label="Stored value against feed">
                  <Shown {...comparison} className="font-sans" />
                </Row>
              </>
            )}
          </dl>
          {feedState === "unsupported" ? (
            <p className="text-xs/5 text-ink-muted">This oracle&apos;s code has no feed_source view: the read answers HostError: Error(WasmVm, MissingValue).</p>
          ) : null}
        </Panel>

        <Panel title="Policy" meta={<p className="text-xs/5 text-ink-muted">How old the value may be, how far one update may move it, and the range it must stay in</p>}>
          <dl className="grid gap-3">
            <Row label="Max stale">
              <Shown {...maxStale} />
            </Row>
            <Row label="Deviation cap">
              <Shown {...deviation} />
            </Row>
            <Row label="Value bounds">
              <Shown {...bounds} />
            </Row>
          </dl>
        </Panel>

        <Panel title="Sources" meta={<p className="text-xs/5 text-ink-muted">Who may set the value: each source is a 32-byte id, the sha256 of a readable preimage</p>}>
          <dl className="grid gap-3">
            <SourceRow label="Primary source" spec={primary} view={view?.view.sources.primary} />
            <SourceRow label="Fallback source" spec={fallback} view={view?.view.sources.fallback} />
            {pathIsFeed ? null : <SourceRow label="Active source" spec={active} view={view?.view.sources.active} />}
          </dl>
        </Panel>

        <Panel title="Update path" meta={<p className="text-xs/5 text-ink-muted">How the current value was set: pushed by the admin, or read from the oracle&apos;s feed (last_update_was_feed)</p>}>
          <dl className="grid gap-3">
            {pathFigure ? (
              <UnsupportedRow label="Last update" figure={pathFigure} />
            ) : (
              <Row label="Last update">
                <Shown {...pathSpec} />
              </Row>
            )}
          </dl>
          {pathFigure ? (
            <p className="text-xs/5 text-ink-muted">
              This oracle&apos;s code has no last_update_was_feed view: the read answers HostError: Error(WasmVm, MissingValue). The update history below
              lists every value set.
            </p>
          ) : null}
        </Panel>

        <Panel title="Last rejection" meta={<p className="text-xs/5 text-ink-muted">last_rejection(): the latest update the oracle refused, read live</p>}>
          <dl className="grid gap-3">
            <Row label="Last rejection">
              <Shown {...lastRejection} />
              {rejection ? (
                <span className="mt-1 block font-mono text-xs/5 text-ink-muted">
                  reason {rejection.reason} · {isSignificantRejection(rejection.reason) ? "significant" : "routine"}
                </span>
              ) : null}
            </Row>
          </dl>
          <p className="max-w-[80ch] text-xs/5 text-ink-muted">{lastRejectionNote(m.wasmHashes.oracle ?? "")}</p>
        </Panel>

        <KeeperPanel network={m.network} oracle={selected} ledgerTime={ledgerTime} />

        <Panel title="Rejection history" className="min-[900px]:col-span-2" meta={<p className="text-xs/5 text-ink-muted">Every indexed ref_rej of this oracle, newest first: each refused update with its reason and transaction</p>}>
          <EventList key={selected} label="Rejection history" group="oracle" contract={selected} topics={REJECTION_TOPICS} describe={describeRejection} empty="No rejection indexed yet" />
        </Panel>

        <Panel title="Update history" className="min-[900px]:col-span-2" meta={<p className="text-xs/5 text-ink-muted">Every indexed ref_set of this oracle, newest first: each value set, the time it is dated, and its transaction</p>}>
          <EventList key={selected} label="Update history" group="oracle" contract={selected} topics={UPDATE_TOPICS} describe={describeUpdate} empty="No update indexed yet" />
        </Panel>
      </div>
    </section>
  )
}

const REJECTION_TOPICS = ["ref_rej"] as const
const UPDATE_TOPICS = ["ref_set"] as const
