"use client"

import { useEffect, useState } from "react"
import { useHistory, type HistoryData, type HistoryRow } from "@/hooks/use-history"
import { useWallet } from "@/hooks/use-wallet"
import { ACTION_META } from "@/lib/protocol/actions"
import { readLog, subscribeLog, type LogEntry } from "@/lib/app/local-log"
import { shorten } from "@/lib/protocol/format"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { UNAVAILABLE } from "@/components/app/live"

const SECONDS_PER_LEDGER = 5

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

function windowText(w: { oldestLedger: number; latestLedger: number }): string {
  const seconds = Math.max(0, w.latestLedger - w.oldestLedger) * SECONDS_PER_LEDGER
  const days = Math.round(seconds / 86400)
  const span = days >= 1 ? `${days} ${days === 1 ? "day" : "days"}` : `${Math.max(1, Math.round(seconds / 3600))} h`
  return `Showing activity from ledger ${w.oldestLedger} to ${w.latestLedger}, about ${span}. Older activity is not available from the network.`
}

const when = (iso: string) => iso.slice(0, 16).replace("T", " ") + " UTC"

function TxHash({ hash, network }: { hash: string; network: string }) {
  if (network !== "testnet") return <span className="break-all font-mono text-xs">{hash}</span>
  return (
    <a
      href={`https://stellar.expert/explorer/testnet/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {shorten(hash, 8, 8)}
    </a>
  )
}

type Row = { hash: string; when: string; label: string; lines: string[]; status: string; market: string }

export function HistoryTable() {
  const m = activeManifest()
  const { state } = useWallet()
  const history = useHistory()
  const account = state.status === "connected" ? state.publicKey : null

  // The local log lives in localStorage: read it after mount (no server/client mismatch) and again
  // on every change and every history refresh.
  const [log, setLog] = useState<LogEntry[]>([])
  const refreshedAt = history.dataUpdatedAt
  useEffect(() => {
    const read = () => setLog(account ? readLog(account) : [])
    read()
    return subscribeLog(read)
  }, [account, refreshedAt])

  if (!account) {
    return <p className="text-ink-muted">Connect your wallet to see your history.</p>
  }

  // A failed refetch keeps the old data in the query; it is not shown as current (R35).
  const data = history.stale ? undefined : (history.data as HistoryData | undefined)
  const seen = new Set(data?.entries.map((e) => e.hash))
  const name = (id: string) => m.markets.find((x) => x.marketId === id)?.displayName ?? id

  // Local-log entries stay "Pending" until their hash shows up in the events.
  const pending: Row[] = log
    .filter((e) => !seen.has(e.hash))
    .map((e) => ({
      hash: e.hash,
      when: when(new Date(e.at).toISOString()),
      label: ACTION_META[e.action].label,
      lines: [],
      status: e.status === "SUCCESS" ? "Confirmed" : e.status === "FAILED" ? "Failed" : "Pending",
      market: name(e.marketId),
    }))
  const confirmed: Row[] = (data?.entries ?? []).map((e) => ({
    hash: e.hash,
    when: when(e.at),
    label: KIND_LABEL[e.kind],
    lines: e.lines,
    status: "Confirmed",
    market: name(e.marketId),
  }))
  const rows = [...pending, ...confirmed]

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
      {rows.length > 0 && (
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
      {data && rows.length === 0 && <p className="text-ink-muted">No activity in this window.</p>}
    </div>
  )
}
