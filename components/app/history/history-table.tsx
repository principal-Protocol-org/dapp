"use client"

import { useEffect, useState } from "react"
import { useHistory, type HistoryData, type HistoryRow } from "@/hooks/use-history"
import { useWallet } from "@/hooks/use-wallet"
import { ACTION_META } from "@/lib/protocol/actions"
import Link from "next/link"
import { readLog, subscribeLog, type LogEntry } from "@/lib/app/local-log"
import { firstOpen, holdsFunds, isDone, readRoutes, subscribeRoutes, type RouteRun, type RouteStep } from "@/lib/app/route-log"
import { describeHoldings, routeHoldings, type RouteKind } from "@/lib/protocol/routes"
import { explorerTxUrl } from "@/lib/app/tx-notice"
import { shorten } from "@/lib/protocol/format"
import { useManifest } from "@/components/app/manifest-provider"
import { TX_TIMEOUT_SECONDS } from "@/lib/protocol/review"
import type { Network } from "@/lib/protocol/types"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { UNAVAILABLE } from "@/components/app/live"

const SECONDS_PER_LEDGER = 5

/**
 * A NOT_FOUND entry this long after submission can no longer land (M10): its time bound closed
 * TX_TIMEOUT_SECONDS after it was prepared, which was before it was submitted. The margin covers
 * the device clock drifting from the network's in between.
 */
const EXPIRED_AFTER_MS = (TX_TIMEOUT_SECONDS + 60) * 1000
/** How often the page re-checks whether a pending entry has expired. */
const EXPIRY_CHECK_MS = 15_000
const EXPIRED_LINE = "Its time window closed before the network showed it, so it can no longer land. Look it up by its hash to be sure."

const KIND_LABEL: Record<HistoryRow["kind"], string> = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  mint: "Mint",
  buy_pt: "Buy PT",
  sell_pt: "Sell PT",
  buy_yt: "Buy YT",
  sell_yt: "Sell YT",
  add_liquidity: "Add liquidity",
  remove_liquidity: "Remove liquidity",
  recombine: "Recombine",
  claim: "Claim yield",
  redeem: "Redeem",
  transfer: "Transfer",
  other: "Other",
}

const ROUTE_LABEL: Record<RouteKind, string> = {
  buy_pt: "Buy PT",
  sell_pt: "Sell PT",
  buy_yt: "Buy YT",
  sell_yt: "Sell YT",
  lp_keep_yt: "Add liquidity, keep YT",
  lp_only: "Add liquidity",
  lp_withdraw: "Withdraw liquidity",
  split: "Split into PT + YT",
  recombine: "Recombine",
}

/**
 * Where the market page resumes a route of this kind: the host that shows its kind (R2-77), which
 * `&route=<id>` then points at this very run. A recombine runs in its Quick action dialog (R2-72),
 * which `?quick=recombine` opens with its form and the run. A split is one step and never a route.
 */
const ROUTE_LINK: Partial<Record<RouteKind, string>> = {
  buy_pt: "tab=pt&side=buy",
  sell_pt: "tab=pt&side=sell",
  buy_yt: "tab=yt&side=buy",
  sell_yt: "tab=yt&side=sell",
  lp_keep_yt: "tab=lp&side=deposit",
  lp_only: "tab=lp&side=deposit",
  lp_withdraw: "tab=lp&side=withdraw",
  recombine: "quick=recombine",
}
/** Something moved, or may have: a route with no sent step left nothing to show. */
const started = (r: RouteRun) => r.steps.some((s) => s.hash !== undefined || s.status !== "pending")

function windowText(w: { oldestLedger: number; latestLedger: number }): string {
  const seconds = Math.max(0, w.latestLedger - w.oldestLedger) * SECONDS_PER_LEDGER
  const days = Math.round(seconds / 86400)
  const span = days >= 1 ? `${days} ${days === 1 ? "day" : "days"}` : `${Math.max(1, Math.round(seconds / 3600))} h`
  return `Showing activity from ledger ${w.oldestLedger} to ${w.latestLedger}, about ${span}. Older activity is not available from the network.`
}

const when = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC"

function TxHash({ hash, network }: { hash: string; network: Network }) {
  const url = explorerTxUrl(network, hash)
  if (!url) return <span className="break-all font-mono text-xs">{hash}</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      aria-label={`View transaction ${hash} on stellar.expert`}
      className="font-mono text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {shorten(hash, 8, 8)}
    </a>
  )
}

type Row = { hash: string; when: string; label: string; lines: string[]; status: string; market: string }

type StepRow = { key: string; label: string; status: string; hash?: string; lines: string[] }
type RouteRow = {
  id: string
  at: number
  label: string
  market: string
  status: string
  holdings?: string
  continueHref?: string
  steps: StepRow[]
}

export function HistoryTable() {
  const m = useManifest()
  const { state } = useWallet()
  const history = useHistory()
  const account = state.status === "connected" ? state.publicKey : null

  // The local log lives in localStorage: read it after mount (no server/client mismatch) and again
  // on every change and every history refresh. The browser clock is read here too, never in render:
  // it only decides whether a pending entry's time window has closed (the window is set by it).
  const [log, setLog] = useState<LogEntry[]>([])
  const [routes, setRoutes] = useState<RouteRun[]>([])
  const [now, setNow] = useState<number | null>(null)
  const refreshedAt = history.dataUpdatedAt
  useEffect(() => {
    const read = () => {
      setLog(account ? readLog(account) : [])
      setRoutes(account ? readRoutes(account) : [])
      setNow(Date.now())
    }
    read()
    const timer = setInterval(() => setNow(Date.now()), EXPIRY_CHECK_MS)
    const unsubscribeLog = subscribeLog(read)
    const unsubscribeRoutes = subscribeRoutes(read)
    return () => {
      clearInterval(timer)
      unsubscribeLog()
      unsubscribeRoutes()
    }
  }, [account, refreshedAt])

  if (!account) {
    return <p className="text-ink-muted">Connect your wallet to see your history.</p>
  }

  // A failed refetch keeps the old data in the query; it is not shown as current (R35).
  const data = history.stale ? undefined : (history.data as HistoryData | undefined)
  const seen = new Set(data?.entries.map((e) => e.hash))
  const name = (id: string) => m.markets.find((x) => x.marketId === id)?.displayName ?? id

  // Local-log entries stay "Pending" until their hash shows up in the events, or until their time
  // window has closed (M10).
  const expired = (e: LogEntry) => e.status === "NOT_FOUND" && now !== null && now - e.at > EXPIRED_AFTER_MS
  // A route's steps are ordinary transactions: they are listed under the route, never twice.
  const routeHashes = new Set(routes.flatMap((r) => r.steps.flatMap((s) => (s.hash ? [s.hash] : []))))
  const pending: Row[] = log
    .filter((e) => !seen.has(e.hash) && !routeHashes.has(e.hash))
    .map((e) => ({
      hash: e.hash,
      when: when(new Date(e.at).toISOString()),
      label: ACTION_META[e.action].label,
      // A failed transaction emits no events, so its cause (R49) is all there is to show.
      lines: e.reason ? [e.reason] : expired(e) ? [EXPIRED_LINE] : [],
      status: e.status === "SUCCESS" ? "Confirmed" : e.status === "FAILED" ? "Failed" : expired(e) ? "Not found — expired" : "Pending",
      market: name(e.marketId),
    }))
  const confirmed: Row[] = (data?.entries ?? []).filter((e) => !routeHashes.has(e.hash)).map((e) => ({
    hash: e.hash,
    when: when(e.at),
    label: KIND_LABEL[e.kind],
    lines: e.lines,
    status: "Confirmed",
    market: name(e.marketId),
  }))
  const routeRows = routes.filter(started).map((r) => toRouteRow(r, { m, name, seen, log, data, expired }))
  const rows = [...pending, ...confirmed]
  const total = rows.length + routeRows.length

  const failed = history.isError || (!history.isPending && !data)
  return (
    <div className="grid gap-4">
      {data && <p className="text-sm text-ink-muted">{windowText(data.window)}</p>}
      {data?.truncated && (
        <p role="status" className="text-sm text-ink-muted">
          This history was too long to load in full. Older entries may be missing.
        </p>
      )}
      {failed && (
        <p role="alert" className="text-ink">
          {UNAVAILABLE} — could not load history
        </p>
      )}
      {history.isPending && !failed && <Skeleton className="h-24 w-full" />}
      {total > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Transaction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {routeRows.map((r) => (
              <RouteTableRow key={r.id} row={r} network={m.network} />
            ))}
            {rows.map((r) => (
              <TableRow key={r.hash}>
                <TableCell>{r.when}</TableCell>
                <TableCell className="font-sans text-ink">
                  <div>{r.label}</div>
                  <div className="text-xs text-ink-muted">{r.market}</div>
                </TableCell>
                <TableCell>
                  {r.lines.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </TableCell>
                <TableCell>{r.status}</TableCell>
                <TableCell>
                  <TxHash hash={r.hash} network={m.network} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && total === 0 && <p className="text-ink-muted">No activity in this window.</p>}
    </div>
  )
}

function toRouteRow(
  r: RouteRun,
  ctx: {
    m: { markets: { marketId: string; underlying: { code: string; decimals: number } }[] }
    name: (id: string) => string
    seen: Set<string>
    log: LogEntry[]
    data: HistoryData | undefined
    expired: (e: LogEntry) => boolean
  },
): RouteRow {
  const entry = (h: string) => ctx.log.find((e) => e.hash === h)
  const stepRow = (s: RouteStep, i: number): StepRow => {
    const logged = s.hash ? entry(s.hash) : undefined
    const events = s.hash ? (ctx.data?.entries.find((e) => e.hash === s.hash)?.lines ?? []) : []
    let status: string
    if (s.status === "confirmed" || (s.hash && ctx.seen.has(s.hash))) status = "Confirmed"
    else if (s.status === "failed" || logged?.status === "FAILED") status = "Failed"
    else if (logged?.status === "SUCCESS") status = "Confirmed"
    else if (s.status === "unknown") status = "Not known yet"
    else status = s.hash ? (logged && ctx.expired(logged) ? "Not found — expired" : "Pending") : "Not started"
    const lines = events.length > 0 ? events : logged?.reason ? [logged.reason] : []
    return { key: `${i}`, label: ACTION_META[s.action].label, status, hash: s.hash, lines }
  }
  const done = isDone(r)
  const waiting = r.steps.some((s) => s.status === "unknown" || (s.status === "pending" && s.hash !== undefined))
  // Continue only where there is something to continue (M5): a step confirmed or not known yet. A
  // run closed anyway while it held funds is dismissed, not closed, so it keeps Continue (R2-76).
  const funded = holdsFunds(r)
  const link = ROUTE_LINK[r.kind]
  const market = ctx.m.markets.find((x) => x.marketId === r.marketId)
  // What the confirmed steps left; an older run closed with funds (before R2-76) still says so.
  const held = !done && market && firstOpen(r) > 0 ? routeHoldings(r.request, r.plans, r.outputs, firstOpen(r)) : undefined
  const status = done
    ? r.unwound
      ? "Returned to USDY"
      : "Completed"
    : funded
      ? waiting
        ? "Waiting for the network"
        : "Interrupted"
      : "Stopped"
  return {
    id: r.id,
    at: r.startedAt,
    label: `${ROUTE_LABEL[r.kind]} · ${r.steps.length} ${r.steps.length === 1 ? "step" : "steps"}`,
    market: ctx.name(r.marketId),
    status,
    holdings: held && market ? describeHoldings(held, market.underlying) : undefined,
    continueHref: funded && link ? `/app/markets/${r.marketId}?${link}&route=${encodeURIComponent(r.id)}` : undefined,
    steps: r.steps.map(stepRow),
  }
}

function RouteTableRow({ row, network }: { row: RouteRow; network: Network }) {
  return (
    <TableRow>
      <TableCell>{when(new Date(row.at).toISOString())}</TableCell>
      <TableCell className="font-sans text-ink">
        <div>{row.label}</div>
        <div className="text-xs text-ink-muted">{row.market}</div>
      </TableCell>
      <TableCell>
        <details>
          <summary className="cursor-pointer font-sans text-ink">Steps</summary>
          <ol className="mt-2 grid gap-2">
            {row.steps.map((s, i) => (
              <li key={s.key} className="grid gap-0.5">
                <div>
                  {i + 1}. {s.label} · {s.status}
                </div>
                {s.lines.map((line) => (
                  <div key={line} className="text-ink-muted">
                    {line}
                  </div>
                ))}
                {s.hash ? <TxHash hash={s.hash} network={network} /> : null}
              </li>
            ))}
          </ol>
        </details>
        {row.holdings ? <p className="mt-2 font-sans text-ink">{row.holdings}</p> : null}
      </TableCell>
      <TableCell>{row.status}</TableCell>
      <TableCell>
        {row.continueHref ? (
          <Link
            href={row.continueHref}
            className="font-sans text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Continue
          </Link>
        ) : null}
      </TableCell>
    </TableRow>
  )
}
