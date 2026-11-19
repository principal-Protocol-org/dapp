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
import { DASHBOARD_LIVE_MS, useOracleTicks, useOracleViews, type IndexedEvent, type KeeperHealth, type RecordedTick } from "@/hooks/use-dashboard"
import { LEDGER_CLOCK_REFETCH_MS, useLedgerClock } from "@/hooks/use-ledger-clock"
import type { Freshness, OracleSourceView, OracleView } from "@/lib/protocol/dashboard/oracle"
import { FRESHNESS_BADGE, FRESHNESS_WORD, freshnessNow, oracleEntries, secondsToBlockNow, type OracleEntry } from "@/lib/protocol/dashboard/oracle-state"
import { isSignificantRejection, lastRejectionNote, rejectionText } from "@/lib/protocol/dashboard/rejections"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { formatBps, formatWindow } from "@/lib/protocol/format"
import type { OracleRejection } from "@/lib/protocol/market-state"
import { allLive, unavailable } from "@/lib/protocol/reader"
import type { Live, Network } from "@/lib/protocol/types"
import { AsOf, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { EventList, TxLink, type EventRowText } from "./event-list"
import { accountShort, ago, closeTimeText } from "./event-words"
import { verifiable, type FigureSpec } from "./figure"
import { feedFigures, FeedPanel } from "./oracle-feed"
import { ORACLE_SCALE, oracleValue, PATH_UNSUPPORTED, timestampText, unsupportedFigure, UnsupportedRow, utc } from "./oracle-shared"
import { oracleRow, oracleRowFigures, OraclesTable } from "./oracles-table"
import { Panel, Row } from "./panel"
import { current, readOf, Shown } from "./query-figures"

/** The operations the protocol refuses while the oracle is stale (D-17), as the page states them. */
export const BLOCKED_WHEN_STALE_LINE = "Operations blocked when stale: mint, trades, single-sided liquidity, redemption"

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
        Each market&apos;s OracleAdapter, read live against ledger time: its reference value and freshness, its policy, its sources and, when its code
        supports one, the price feed it reads. Pick an oracle in the list to see it in detail. Its update and rejection history comes from the event index, and the keeper&apos;s
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
  const tableRows = oracles.map((o, i) => oracleRow(o, views[i], nowSeconds, noClock))
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
  const pathFigure: VerifiableFigure | null = pathUnsupported ? unsupportedFigure("Update path", "last_update_was_feed", pathUnsupported.source, read) : null

  // The Feed card (3af9388): what feed_source() says decides which rows it has.
  const feed = feedFigures(oracle, read, nowSeconds, noClock)

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
    ...feed.specs,
    maxStale,
    deviation,
    bounds,
    primary,
    fallback,
    ...(pathIsFeed ? [] : [active]),
    pathSpec,
    lastRejection,
  ] as FigureSpec<unknown>[]
  // The table's figures first (every oracle, labelled with its asset), then the selected oracle's.
  const figures = [...oracleRowFigures(tableRows), ...[...specs.map(verifiable), feed.unsupported, pathFigure].filter((f): f is VerifiableFigure => f !== null)]
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

        <FeedPanel network={m.network} feed={feed} />

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
