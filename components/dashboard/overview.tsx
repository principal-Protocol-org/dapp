"use client"

import Link from "next/link"
import { InfoTip, UnavailableTip } from "@/components/app/info-tip"
import { useManifest, useSeedCount } from "@/components/app/manifest-provider"
import { Metric } from "@/components/app/market/metric"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DASHBOARD_AGGREGATE_MS,
  dashboardLiveMs,
  useComplianceEvents,
  useIndexStatus,
  useOpenAlerts,
  useOracleViews,
  usePauses,
  useProtocolState,
  useRiskView,
} from "@/hooks/use-dashboard"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { alertTitle, countsAsCritical, type Alert } from "@/lib/app/alert-types"
import { BLOCKED_WHEN_STALE, type Freshness } from "@/lib/protocol/dashboard/oracle"
import { FRESHNESS_BADGE, FRESHNESS_RANK, FRESHNESS_WORD, oracleEntries, oracleNow, type OracleNow } from "@/lib/protocol/dashboard/oracle-state"
import { TVL_LABEL } from "@/lib/protocol/dashboard/protocol-state"
import type { Remaining } from "@/lib/protocol/dashboard/risk"
import { hostOf, type UnreadInput, type VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { formatAmountFixed } from "@/lib/protocol/format"
import { allLive, unavailable } from "@/lib/protocol/reader"
import type { Live, Network } from "@/lib/protocol/types"
import { AsOf, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { lagText, TxLink } from "./event-list"
import { accountShort, ago, complianceEventWords, eventSubject } from "./event-words"
import { decimalsScale, verifiable, type FigureSpec } from "./figure"
import { Panel, Row } from "./panel"
import { current, NO_LIQUIDITY, noPoolSeeded, readOf, refuse, Shown, unitsOf } from "./query-figures"
import { WrapAndMintRow, wrapAndMintSpec } from "./risk-panel"

const list = (words: readonly string[]) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`)

/** Every oracle of the manifest now: how many are fresh, the worst state, the read ones that are not fresh, and the ones that could not be read. */
type OraclesSummary = {
  fresh: number
  total: number
  worst: Freshness
  notFresh: { asset: string; state: Freshness }[]
  notRead: { asset: string; reason: string }[]
}

/**
 * The oracle row's figure: "N of M fresh" over every oracle of the manifest, on the ledger clock (as
 * the oracle page's table counts them; Warning is not fresh). Its reads are every readable oracle's
 * timestamp, max_stale and is_available. An oracle that could not be read is named apart, with its
 * reason, makes the worst state Unavailable, and its attempted call is one of the figure's `unread`
 * inputs, so the drawer can give it. Pending while any oracle's first read is. When none can be
 * read: Unavailable, the one oracle's own failure, or, with several, every oracle as unread.
 */
function oraclesFigure(entries: { asset: string; now: OracleNow }[]): { live: Live<OraclesSummary> | undefined; unread: UnreadInput[] } {
  const failed = entries.flatMap((e) => (e.now.live?.status === "unavailable" ? [{ asset: e.asset, live: e.now.live }] : []))
  const unread: UnreadInput[] = failed.map(({ asset, live }) => (live.source ? { name: asset, error: live.error, source: live.source } : { name: asset, error: live.error }))
  if (entries.length === 0 || entries.some((e) => e.now.live === undefined)) return { live: undefined, unread: [] }
  const readable = entries.flatMap((e) => (e.now.live?.status === "live" ? [e.now.live] : []))
  if (readable.length === 0) {
    // One oracle: its own failure and its call, as before. Several: each one's reason and call, as unread inputs.
    if (failed.length === 1) return { live: failed[0].live, unread: [] }
    return { live: unavailable(`none of the ${entries.length} oracles could be read`), unread }
  }
  const read = entries.filter((e) => e.now.live?.status === "live")
  const summary: OraclesSummary = {
    fresh: read.filter((e) => e.now.state === "fresh").length,
    total: entries.length,
    worst: failed.length > 0 ? "unavailable" : read.reduce<Freshness>((w, e) => (FRESHNESS_RANK[e.now.state] > FRESHNESS_RANK[w] ? e.now.state : w), "fresh"),
    notFresh: read.filter((e) => e.now.state !== "fresh").map((e) => ({ asset: e.asset, state: e.now.state })),
    notRead: failed.map(({ asset, live }) => ({ asset, reason: live.error })),
  }
  return { live: allLive(readable, () => summary), unread }
}

/** The lines under the count: the read oracles that are not fresh, the ones not read and why, and what a stale oracle blocks. */
function oraclesLines(s: OraclesSummary): string[] {
  const lines: string[] = []
  if (s.notFresh.length > 0) lines.push(`Not fresh: ${s.notFresh.map((o) => `${o.asset} (${FRESHNESS_WORD[o.state]})`).join(", ")}`)
  if (s.notRead.length > 0) lines.push(`Not read: ${s.notRead.map((o) => `${o.asset} (${o.reason})`).join(", ")}`)
  if (s.notFresh.some((o) => o.state === "stale")) lines.push(`On a stale oracle's markets, ${list(BLOCKED_WHEN_STALE)} are blocked`)
  return lines
}

/** "Unavailable · 3 of 5 fresh · Not fresh: … · Not read: … · On a stale oracle's markets, … are blocked": the badge's word, the count, then the lines. */
const oraclesLine = (s: OraclesSummary) => [FRESHNESS_WORD[s.worst], `${s.fresh} of ${s.total} fresh`, ...oraclesLines(s)].join(" · ")

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
  const seedCount = useSeedCount()
  const { ledgerTime, isError: clockFailed } = useLedgerClock()
  const protocol = useProtocolState()
  const oracles = oracleEntries(m)
  const oracleQueries = useOracleViews(oracles.map((o) => o.oracle))
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
  const liveMs = dashboardLiveMs(m.network)
  const riskRead = readOf(risk, liveMs)
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
    read: readOf(pauses, liveMs),
  }
  // As the oracle page counts them: is_available() can turn an oracle Stale (or, unread, Unavailable), so its read is listed too.
  const nowSeconds = ledgerTime === null ? null : Math.floor(ledgerTime)
  const { live: oraclesLive, unread } = oraclesFigure(oracles.map((o, i) => ({ asset: o.asset, now: oracleNow(oracleQueries[i], nowSeconds, noClock) })))
  const oracleReads = oracleQueries.filter((q) => !q.stale && q.dataUpdatedAt > 0)
  const oracleFreshness: FigureSpec<OraclesSummary> = {
    label: "Oracle freshness",
    live: oraclesLive,
    format: oraclesLine,
    scale: "Each oracle of the manifest: fresh while ledger time − its timestamp ≤ max_stale_seconds and is_available() is true; Warning from 75%, not counted fresh; an oracle that could not be read is named apart",
    unread,
    // The oldest of the oracles' reads: the figure is as old as that.
    read: oracleReads.length === oracleQueries.length && oracleReads.length > 0 ? { at: Math.min(...oracleReads.map((q) => q.dataUpdatedAt)), cadenceMs: liveMs } : undefined,
  }

  const contractFigures = [tvl, tvlUsd, liquidity, riskRemaining, ...(effective ? [effective] : []), contractPauses, oracleFreshness] as FigureSpec<unknown>[]
  const figures = contractFigures.map(verifiable).filter((f): f is VerifiableFigure => f !== null)
  const lives = contractFigures.map((f) => f.live)
  const newestUpdate = Math.max(0, ...[protocol, ...oracleQueries, risk, pauses].map((q) => (q.stale ? 0 : q.dataUpdatedAt)))
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
        <AsOf sources={readsOf(lives)} updatedAt={newestUpdate || null} cadenceMs={liveMs} />
        <p className="flex flex-wrap gap-x-2 font-mono text-xs/5 text-ink-muted">
          <span className="wrap-anywhere">RPC {hostOf(m.rpcUrl)}</span>
          <span aria-hidden="true">·</span>
          <span>{fallbacks.length > 0 ? `Fallback ${fallbacks.map(hostOf).join(", ")}` : "No fallback RPC configured"}</span>
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
                {m.markets.length < seedCount ? `${m.markets.length} of ${seedCount} manifest markets listed` : m.markets.length}
                <InfoTip label="Markets">
                  Counted from the registry: markets discovered from the Router and published by the app.
                  {m.markets.length < seedCount ? ` The manifest names ${seedCount}; a market that fails the registry's checks is not listed.` : null}
                </InfoTip>
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
              updatedAt={Math.max(0, ...[...oracleQueries, risk, pauses].map((q) => (q.stale ? 0 : q.dataUpdatedAt))) || null}
              cadenceMs={liveMs}
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
            <Row label="Oracles">
              <Shown
                {...oracleFreshness}
                render={(s) => {
                  return (
                    <>
                      <Badge status={FRESHNESS_BADGE[s.worst]}>{FRESHNESS_WORD[s.worst]}</Badge> <span>{`${s.fresh} of ${s.total} fresh`}</span>
                      {oraclesLines(s).map((line) => (
                        <span key={line} className="block font-sans text-xs/5 text-ink-muted">
                          {line}
                        </span>
                      ))}
                    </>
                  )
                }}
              />
              <Link href="/dashboard/oracle" className="mt-1 block w-fit font-sans text-xs/5 font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
                Each oracle
              </Link>
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
