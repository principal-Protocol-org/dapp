"use client"

import Link from "next/link"
import { formatDuration } from "@/components/app/live"
import { InfoTip, UnavailableTip } from "@/components/app/info-tip"
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
} from "@/hooks/use-dashboard"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { alertTitle, countsAsCritical, type Alert } from "@/lib/app/alert-types"
import type { OracleView } from "@/lib/protocol/dashboard/oracle"
import { TVL_LABEL } from "@/lib/protocol/dashboard/protocol-state"
import type { Remaining } from "@/lib/protocol/dashboard/risk"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { formatAmountFixed } from "@/lib/protocol/format"
import { allLive } from "@/lib/protocol/reader"
import type { Network } from "@/lib/protocol/types"
import { AsOf, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { lagText, TxLink } from "./event-list"
import { accountShort, ago, complianceEventWords, eventSubject } from "./event-words"
import { decimalsScale, verifiable, type FigureSpec } from "./figure"
import { Panel, Row } from "./panel"
import { current, NO_LIQUIDITY, noPoolSeeded, readOf, refuse, Shown, unitsOf } from "./query-figures"
import { WrapAndMintRow, wrapAndMintSpec } from "./risk-panel"

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
            <TableHead className="max-[520px]:hidden">Transaction</TableHead>
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
                  {/* Each piece stays whole; the separators between them are where the line may wrap. */}
                  <span className="block font-mono text-xs text-ink-muted">
                    <span className="min-[520px]:hidden">
                      <span className="whitespace-nowrap">ledger {r.ledger}</span>
                      {" · "}
                    </span>
                    {who ? (
                      <>
                        <span title={who} className="whitespace-nowrap">
                          {accountShort(who)}
                        </span>
                        {" · "}
                      </>
                    ) : null}
                    <span className="whitespace-nowrap">{ledgerTime !== null ? ago(ledgerTime - closed) : r.closeTime}</span>
                  </span>
                  {/* Below 520 px the Ledger and Transaction columns fold under the event. */}
                  <span className="block min-[520px]:hidden">
                    <TxLink network={network} hash={r.txHash} />
                  </span>
                </TableCell>
                <TableCell className="text-right max-[520px]:hidden">{r.ledger}</TableCell>
                <TableCell className="max-[520px]:hidden">
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
          {lag ? <span className={lag.late ? "text-negative" : undefined}>{lag.text} behind ledger time</span> : "Not known yet"}
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

/** The open alerts' kinds in words, critical first, each with its count when it has several subjects. */
function openKinds(open: readonly Alert[]): string {
  const counts = new Map<string, { n: number; critical: boolean }>()
  for (const a of open) {
    const c = counts.get(a.kind) ?? { n: 0, critical: false }
    counts.set(a.kind, { n: c.n + 1, critical: c.critical || countsAsCritical(a) })
  }
  return [...counts.entries()]
    .sort(([, a], [, b]) => Number(b.critical) - Number(a.critical))
    .map(([kind, c]) => (c.n > 1 ? `${alertTitle(kind)} (${c.n})` : alertTitle(kind)))
    .join(", ")
}

function OpenAlerts() {
  const q = useOpenAlerts()
  if (q.isError) return <UnavailableTip label="Open alerts" reason={q.error?.message ?? "the alerts could not be read"} />
  if (!q.data) return <Skeleton className="inline-block h-5 w-24 align-middle" />
  const n = q.data.open.length
  // An oracle read that failed once is open but not critical until a second check confirms it.
  const critical = q.data.open.filter(countsAsCritical).length
  if (n === 0) return <>None open</>
  return (
    <>
      <span className="block">{`${n} open${critical > 0 ? ` · ${critical} critical` : ""}`}</span>
      <span className="block font-sans text-xs/5 text-ink-muted">{openKinds(q.data.open)}</span>
    </>
  )
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
  const units = unitsOf(m)
  const refused = "refused" in units ? units.refused : null
  const fixed = (v: bigint) => ("refused" in units ? String(v) : formatAmountFixed(v, units.decimals))
  const amount = (v: bigint) => ("refused" in units ? String(v) : `${fixed(v)} ${units.code ?? "(underlying units)"}`)
  const scale = "refused" in units ? undefined : decimalsScale(units.decimals, units.code ?? "underlying unit")
  const aggregateRead = readOf(protocol, DASHBOARD_AGGREGATE_MS)

  const tvl: FigureSpec<bigint> = { label: "TVL", live: refuse(current(protocol, (d) => d.totals.tvl), refused), format: amount, scale, read: aggregateRead }
  // The oracle counts in US dollars ("oracle units", as /app says it).
  const tvlUsd: FigureSpec<bigint> = {
    label: "TVL in USD",
    live: refuse(current(protocol, (d) => d.totals.tvlReference), refused),
    format: (v) => `${fixed(v)} USD (oracle units)`,
    scale: "refused" in units ? undefined : `${units.decimals} decimals; TVL × the oracle value ÷ 10,000,000, in US dollars (oracle units)`,
    read: aggregateRead,
  }
  // As /app: while no pool is seeded, pool liquidity is "No liquidity yet", never 0.
  const unseeded = !protocol.stale && protocol.data !== undefined && noPoolSeeded(Object.values(protocol.data.markets).map((d) => d.poolSeeded))
  const liquidity: FigureSpec<bigint> = {
    label: "Pool liquidity",
    live: refuse(current(protocol, (d) => d.totals.liquidity), refused),
    format: (v) => (unseeded ? NO_LIQUIDITY : amount(v)),
    scale,
    read: aggregateRead,
  }

  // D-10: the raw room left (null when the limit is off) and, when a market double-reports, what one wrap-and-mint can use.
  const riskData = risk.stale ? undefined : risk.data
  const riskRead = readOf(risk, DASHBOARD_LIVE_MS)
  const limit = riskData?.limit.status === "live" ? riskData.limit.value : null
  const riskRemaining: FigureSpec<Remaining> = {
    label: "RiskControl capacity",
    live: refuse(current(risk, (r) => r.remaining, noClock), refused),
    format: (left) => (left === null ? "No limit (disabled)" : limit !== null ? `${amount(left)} left of ${amount(limit)}` : `${amount(left)} left`),
    scale,
    read: riskRead,
  }
  // Kept, Unavailable with the reason, when the risk refresh fails (it never vanishes then).
  const effective = wrapAndMintSpec(risk, { format: (left) => (left === null ? "No limit (disabled)" : amount(left)), scale, read: riskRead }, refused)

  const contractPauses: FigureSpec<string[]> = {
    label: "Contract pauses",
    live: current(pauses, (p) => p.paused),
    format: (names) => (names.length === 0 ? "None paused" : `Paused: ${names.join(", ")}`),
    read: readOf(pauses, DASHBOARD_LIVE_MS),
  }
  const view = oracle.stale ? undefined : oracle.data
  // As the oracle page's Freshness: is_available() can turn the line Stale (or, unread, Unavailable), so its read is listed too.
  const oracleFreshness: FigureSpec<number> = {
    label: "Oracle freshness",
    live: current(oracle, (o) => allLive([o.view.timeToBlock, o.view.available] as const, ([seconds]) => seconds), noClock),
    format: (seconds) => (view ? oracleLine(view.view, secondsToBlockNow(view.view.timeToBlock, view.ledgerTime, ledgerTime) ?? seconds) : String(seconds)),
    scale: "Seconds: the oracle timestamp + max_stale_seconds − ledger time",
    read: readOf(oracle, DASHBOARD_LIVE_MS),
  }

  const contractFigures = [tvl, tvlUsd, liquidity, riskRemaining, ...(effective ? [effective] : []), contractPauses, oracleFreshness] as FigureSpec<unknown>[]
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
          meta={<AsOf sources={readsOf([tvl.live, tvlUsd.live, liquidity.live])} updatedAt={protocol.stale ? null : protocol.dataUpdatedAt || null} cadenceMs={DASHBOARD_AGGREGATE_MS} />}
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-5 min-[420px]:grid-cols-2">
            <Metric label="TVL">
              <Shown {...tvl} />
            </Metric>
            <Metric label="TVL in USD">
              <Shown {...tvlUsd} />
            </Metric>
            <Metric label="Markets">
              <span className="inline-flex items-center gap-1.5">
                {m.markets.length}
                <InfoTip label="Markets">Counted from the registry: markets discovered from the Router and published by the app.</InfoTip>
              </span>
            </Metric>
            <Metric label="Pool liquidity">
              <Shown {...liquidity} />
            </Metric>
          </dl>
          <ul className="grid gap-1 text-xs/5 text-ink-muted">
            <li>TVL: {TVL_LABEL.charAt(0).toLowerCase() + TVL_LABEL.slice(1)}.</li>
            <li>TVL in USD: TVL × the oracle value. The oracle counts in US dollars (oracle units), as the app does.</li>
            <li>Pool liquidity: each pool&apos;s PT and SY reserves, valued at the pool price.</li>
            <li>Markets: those listed in the registry. A total is Unavailable when any market&apos;s figure is.</li>
          </ul>
        </Panel>

        <Panel
          title="Safety"
          meta={
            <AsOf
              sources={readsOf([riskRemaining.live, effective?.live, contractPauses.live, oracleFreshness.live])}
              updatedAt={Math.max(0, ...[oracle, risk, pauses].map((q) => (q.stale ? 0 : q.dataUpdatedAt))) || null}
              cadenceMs={DASHBOARD_LIVE_MS}
            />
          }
        >
          <dl className="grid gap-3">
            <Row label="RiskControl capacity">
              <Shown {...riskRemaining} />
            </Row>
            {effective ? <WrapAndMintRow spec={effective} doubleReporting={riskData?.doubleReporting ?? []} /> : null}
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
