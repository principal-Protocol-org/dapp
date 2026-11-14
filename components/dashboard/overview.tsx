"use client"

import Link from "next/link"
import { formatDuration } from "@/components/app/live"
import { UnavailableTip } from "@/components/app/info-tip"
import { useManifest } from "@/components/app/manifest-provider"
import { Metric } from "@/components/app/market/metric"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DASHBOARD_AGGREGATE_MS,
  DASHBOARD_LIVE_MS,
  secondsToBlockNow,
  useComplianceEvents,
  useIndexStatus,
  useOpenAlerts,
  useOracleView,
  usePauses,
  useProtocolState,
  useRiskView,
  type IndexedEvents,
} from "@/hooks/use-dashboard"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import type { OracleView } from "@/lib/protocol/dashboard/oracle"
import { TVL_LABEL } from "@/lib/protocol/dashboard/protocol-state"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { explorerUrl } from "@/lib/protocol/explorer"
import { formatAmountFixed } from "@/lib/protocol/format"
import { allLive, unavailable } from "@/lib/protocol/reader"
import type { Live, Manifest, Network } from "@/lib/protocol/types"
import { AsOf, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { accountShort, ago, complianceEventWords, eventSubject, txShort } from "./event-words"
import { decimalsScale, Figure, verifiable, type FigureSpec } from "./figure"
import { Panel, Row } from "./panel"

type QueryLike<D> = { data?: D; stale: boolean; error: Error | null; dataUpdatedAt: number }

/**
 * A figure from a query: undefined while the first read is pending; Unavailable, with the reason,
 * after a failed refresh (the old value is never shown as current); else the picked read.
 */
function current<D, T>(q: QueryLike<D>, pick: (data: D) => Live<T>, blocked?: string): Live<T> | undefined {
  if (q.stale) return unavailable(`the last refresh failed: ${q.error?.message ?? "unknown error"}`)
  if (q.data !== undefined) return pick(q.data)
  return blocked ? unavailable(blocked) : undefined
}

/** The one underlying every market holds, for amounts; null when they differ (amount totals are then unavailable anyway). */
function singleUnderlying(m: Manifest): { code: string; decimals: number } | null {
  const first = m.markets[0]?.underlying ?? m.testAsset
  if (!first) return null
  return m.markets.every((x) => x.underlying.sac === m.markets[0].underlying.sac) ? { code: first.code, decimals: first.decimals } : null
}

const list = (words: readonly string[]) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`)

/**
 * The oracle line: freshness and the countdown until operations block, following the ledger clock
 * between reads. Stale (or past the countdown) says what is blocked; Warning is age ≥ 75% of `max_stale`.
 */
function oracleLine(view: OracleView, secondsLeft: number): string {
  if (view.freshness === "stale" || secondsLeft < 0) return `Stale · ${list(view.blockedWhenStale)} are blocked`
  const max = view.maxStale.status === "live" ? Number(view.maxStale.value) : null
  const warning = max !== null ? (max - secondsLeft) * 4 >= max * 3 : view.freshness === "warning"
  return `${warning ? "Warning" : "Fresh"} · operations block in ${formatDuration(secondsLeft)} without an update`
}

/** A figure, or a skeleton while its first read is pending. */
function Shown<T>(spec: FigureSpec<T>) {
  return spec.live ? <Figure {...spec} /> : <Skeleton className="inline-block h-5 w-32 max-w-full align-middle" />
}


function TxLink({ network, hash }: { network: Network; hash: string }) {
  const url = explorerUrl(network, "tx", hash)
  if (!url) return <span className="font-mono text-xs wrap-anywhere">{txShort(hash)}</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`View transaction ${hash} on stellar.expert`}
      className="font-mono text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {txShort(hash)}
    </a>
  )
}

function ComplianceEvents({ network, ledgerTime }: { network: Network; ledgerTime: number | null }) {
  const q = useComplianceEvents(5)
  const data = q.stale ? undefined : q.data
  let body: React.ReactNode
  if (q.isError)
    body = <UnavailableTip label="Latest compliance events" reason={q.error?.message ?? "the event index could not be read"} className="text-sm text-ink" />
  else if (!data) body = <Skeleton className="h-24 w-full" />
  else if (data.rows.length === 0) body = <p className="text-sm text-ink-muted">No compliance events indexed yet.</p>
  else
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="max-[520px]:px-3">Event</TableHead>
            <TableHead className="text-right max-[520px]:hidden">Ledger</TableHead>
            <TableHead className="max-[520px]:px-3">Transaction</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((r) => {
            const who = eventSubject(r.topic, r.data)
            const closed = Date.parse(r.closeTime) / 1000
            return (
              <TableRow key={r.id}>
                <TableCell className="font-sans text-ink max-[520px]:px-3">
                  <span className="block">{complianceEventWords(r.topic)}</span>
                  <span className="block font-mono text-xs text-ink-muted">
                    {/* Below 520 px the Ledger column folds into this line. */}
                    <span className="whitespace-nowrap min-[520px]:hidden">ledger {r.ledger} · </span>
                    {who ? (
                      <span title={who} className="whitespace-nowrap">
                        {accountShort(who)} ·{" "}
                      </span>
                    ) : null}
                    <span className="whitespace-nowrap">{ledgerTime !== null ? ago(ledgerTime - closed) : r.closeTime}</span>
                  </span>
                </TableCell>
                <TableCell className="text-right max-[520px]:hidden">{r.ledger}</TableCell>
                <TableCell className="max-[520px]:px-3">
                  <TxLink network={network} hash={r.txHash} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    )
  return (
    <Panel title="Latest compliance events" meta={<p className="text-xs/5 text-ink-muted">RecoveryEscrow and Permissioning, from the event index · refreshes every 1 min</p>}>
      {body}
      <Link href="/dashboard/compliance" className="w-fit text-sm font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
        Compliance details
      </Link>
    </Panel>
  )
}

/** How far behind ledger time the index is: from the indexed-through ledger's close time and the ledger clock, never the cached lag. */
function lagText(index: IndexedEvents, ledgerTime: number | null): { text: string; late: boolean } | null {
  const closed = index.indexedThroughCloseTime ? Date.parse(index.indexedThroughCloseTime) / 1000 : null
  const seconds = closed !== null && ledgerTime !== null ? Math.max(0, ledgerTime - closed) : index.lagSeconds
  if (seconds === null) return null
  return { text: `${formatDuration(seconds)} behind ledger time`, late: seconds > 3600 }
}

function IndexStatus({ ledgerTime }: { ledgerTime: number | null }) {
  const q = useIndexStatus()
  const data = q.stale ? undefined : q.data
  let body: React.ReactNode
  if (q.isError)
    body = <UnavailableTip label="Event index" reason={q.error?.message ?? "the event index could not be read"} className="text-sm text-ink" />
  else if (!data) body = <Skeleton className="h-24 w-full" />
  else {
    const lag = lagText(data, ledgerTime)
    const checks = data.reconcile?.results ?? []
    body = (
      <dl className="grid gap-3">
        <Row label="Indexed through ledger">{data.indexedThrough > 0 ? data.indexedThrough : "Not indexed yet"}</Row>
        <Row label="Lag">
          {lag ? <span className={lag.late ? "text-negative" : undefined}>{lag.text}</span> : "Not known yet"}
          {lag?.late ? <span className="block text-negative">Over 1 hour behind</span> : null}
        </Row>
        <Row label="Gaps">
          {data.gaps.length === 0
            ? "No gaps"
            : data.gaps.map((g) => (
                <span key={`${g.group}-${g.from}`} className="block text-negative">
                  {g.group}: ledgers {g.from}–{g.to} are not indexed
                </span>
              ))}
        </Row>
        <Row label="RecoveryEscrow check">
          {checks.length === 0
            ? "Not run yet"
            : checks.map((c) =>
                c.ok ? (
                  <span key={c.escrow} className="block">
                    RecoveryEscrow records match the index ({c.indexed} of {c.recordCount})
                  </span>
                ) : (
                  <span key={c.escrow} className="block text-negative">
                    {c.recordCount === null
                      ? `${accountShort(c.escrow)}: record_count could not be read`
                      : `${accountShort(c.escrow)}: record_count ${c.recordCount}, indexed ${c.indexed}`}
                  </span>
                ),
              )}
        </Row>
      </dl>
    )
  }
  return (
    <Panel title="Event index" meta={<p className="text-xs/5 text-ink-muted">The history behind the activity views · refreshes every 1 min</p>}>
      {body}
      <Link href="/dashboard/activity" className="w-fit text-sm font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
        All activity
      </Link>
    </Panel>
  )
}

function OpenAlerts() {
  const q = useOpenAlerts()
  if (q.isError) return <UnavailableTip label="Open alerts" reason={q.error?.message ?? "the alerts could not be read"} />
  if (!q.data) return <Skeleton className="inline-block h-5 w-24 align-middle" />
  return <>{q.data.open === 0 ? "None open" : `${q.data.open} open`}</>
}

/**
 * The public overview (`/dashboard`): protocol totals, a safety summary (RiskControl, pauses, the
 * oracle with its countdown, open alerts), the latest compliance events and the event index. No
 * wallet is read. Every contract figure opens its How-to-verify drawer, and the page's figures copy
 * as one evidence table.
 */
export function Overview() {
  const m = useManifest()
  const { ledgerTime, isError: clockFailed } = useLedgerClock()
  const protocol = useProtocolState()
  const oracle = useOracleView()
  const risk = useRiskView()
  const pauses = usePauses()

  const noClock = clockFailed && ledgerTime === null ? "the ledger time could not be read" : undefined
  const unit = singleUnderlying(m)
  const decimals = unit?.decimals ?? 7
  const amount = (v: bigint) => (unit ? `${formatAmountFixed(v, unit.decimals)} ${unit.code}` : `${v} (raw units)`)
  const scale = unit ? decimalsScale(unit.decimals, unit.code) : undefined

  const tvl: FigureSpec<bigint> = { label: "TVL", live: current(protocol, (d) => d.totals.tvl), format: amount, scale }
  const tvlReference: FigureSpec<bigint> = {
    label: "TVL, reference value",
    live: current(protocol, (d) => d.totals.tvlReference),
    format: (v) => formatAmountFixed(v, decimals),
    scale: `${decimals} decimals; TVL × the oracle's reference value ÷ 10,000,000`,
  }
  const liquidity: FigureSpec<bigint> = { label: "Pool liquidity", live: current(protocol, (d) => d.totals.liquidity), format: amount, scale }
  const riskCapacity: FigureSpec<{ limit: bigint; volume: bigint }> = {
    label: "RiskControl capacity",
    live: current(risk, (r) => allLive([r.limit, r.volume] as const, ([limit, volume]) => ({ limit, volume })), noClock),
    format: ({ limit, volume }) => (limit <= 0n ? "No limit (disabled)" : `${amount(limit > volume ? limit - volume : 0n)} left of ${amount(limit)}`),
    scale,
  }
  const contractPauses: FigureSpec<string[]> = {
    label: "Contract pauses",
    live: current(pauses, (p) => p.paused),
    format: (names) => (names.length === 0 ? "None paused" : `Paused: ${names.join(", ")}`),
  }
  const view = oracle.stale ? undefined : oracle.data
  const oracleFreshness: FigureSpec<number> = {
    label: "Oracle freshness",
    live: current(oracle, (o) => o.view.timeToBlock, noClock),
    format: (seconds) => (view ? oracleLine(view.view, secondsToBlockNow(view.view.timeToBlock, view.ledgerTime, ledgerTime) ?? seconds) : String(seconds)),
    scale: "Seconds: the oracle timestamp + max_stale_seconds − ledger time",
  }

  const contractFigures = [tvl, tvlReference, liquidity, riskCapacity, contractPauses, oracleFreshness] as FigureSpec<unknown>[]
  const figures = contractFigures.map(verifiable).filter((f): f is VerifiableFigure => f !== null)
  const lives = contractFigures.map((f) => f.live)
  const newestUpdate = Math.max(0, ...[protocol, oracle, risk, pauses].map((q) => (q.stale ? 0 : q.dataUpdatedAt)))
  const fallbacks = m.rpcFallbackUrls ?? []

  return (
    <section aria-labelledby="dashboard-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 id="dashboard-heading" className="font-serif text-3xl text-ink">
              Protocol overview
            </h1>
            <p className="mt-2 max-w-[68ch] text-ink-muted">
              The state of the Principal protocol, read from its contracts as you watch. No wallet is needed. Each figure&apos;s info button shows the
              contract call behind it and a command to repeat it.
            </p>
          </div>
          <CopyEvidence figures={figures} />
        </div>
        <AsOf sources={readsOf(lives)} updatedAt={newestUpdate || null} cadenceMs={DASHBOARD_LIVE_MS} />
        <p className="flex flex-wrap gap-x-2 font-mono text-xs/5 text-ink-muted">
          <span className="wrap-anywhere">RPC {m.rpcUrl}</span>
          <span aria-hidden="true">·</span>
          <span>{fallbacks.length > 0 ? `Fallback ${fallbacks.join(", ")}` : "No fallback RPC configured"}</span>
        </p>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 min-[900px]:grid-cols-2">
        <Panel
          title="Protocol totals"
          meta={<AsOf sources={readsOf([tvl.live, tvlReference.live, liquidity.live])} updatedAt={protocol.stale ? null : protocol.dataUpdatedAt || null} cadenceMs={DASHBOARD_AGGREGATE_MS} />}
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-5 min-[420px]:grid-cols-2">
            <Metric label="TVL">
              <Shown {...tvl} />
            </Metric>
            <Metric label="TVL, reference value">
              <Shown {...tvlReference} />
            </Metric>
            <Metric label="Markets">{m.markets.length}</Metric>
            <Metric label="Pool liquidity">
              <Shown {...liquidity} />
            </Metric>
          </dl>
          <ul className="grid gap-1 text-xs/5 text-ink-muted">
            <li>TVL: {TVL_LABEL.charAt(0).toLowerCase() + TVL_LABEL.slice(1)}.</li>
            <li>Reference value: TVL × the oracle&apos;s reference value.</li>
            <li>Pool liquidity: each pool&apos;s PT and SY reserves, valued at the pool price.</li>
            <li>Markets: those listed in the registry. A total is Unavailable when any market&apos;s figure is.</li>
          </ul>
        </Panel>

        <Panel
          title="Safety"
          meta={
            <AsOf
              sources={readsOf([riskCapacity.live, contractPauses.live, oracleFreshness.live])}
              updatedAt={Math.max(0, ...[oracle, risk, pauses].map((q) => (q.stale ? 0 : q.dataUpdatedAt))) || null}
              cadenceMs={DASHBOARD_LIVE_MS}
            />
          }
        >
          <dl className="grid gap-3">
            <Row label="RiskControl capacity">
              <Shown {...riskCapacity} />
            </Row>
            <Row label="Pauses">
              <Shown {...contractPauses} />
            </Row>
            <Row label="Oracle">
              <Shown {...oracleFreshness} />
            </Row>
            <Row label="Open alerts">
              <OpenAlerts />
            </Row>
          </dl>
        </Panel>

        <ComplianceEvents network={m.network} ledgerTime={ledgerTime} />
        <IndexStatus ledgerTime={ledgerTime} />
      </div>
    </section>
  )
}
