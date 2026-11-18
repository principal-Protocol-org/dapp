"use client"

import type { ReactNode } from "react"
import { formatDuration } from "@/components/app/live"
import { UnavailableTip } from "@/components/app/info-tip"
import { useManifest } from "@/components/app/manifest-provider"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useEventPages, type IndexedEvent, type IndexedEvents, type IndexGroup } from "@/hooks/use-dashboard"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { explorerUrl } from "@/lib/protocol/explorer"
import type { Network } from "@/lib/protocol/types"
import { accountShort, ago, closeTimeText, eventSubject, eventWords, txShort } from "./event-words"

/** A transaction hash, short, linking to stellar.expert (plain text on a local network, which has no explorer). */
export function TxLink({ network, hash }: { network: Network; hash: string }) {
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

/** How far behind ledger time the index is: from the indexed-through ledger's close time and the ledger clock, never the cached lag. */
export function lagText(index: Pick<IndexedEvents, "indexedThroughCloseTime" | "lagSeconds">, ledgerTime: number | null): { text: string; late: boolean } | null {
  const closed = index.indexedThroughCloseTime ? Date.parse(index.indexedThroughCloseTime) / 1000 : null
  const seconds = closed !== null && ledgerTime !== null ? Math.max(0, ledgerTime - closed) : index.lagSeconds
  if (seconds === null) return null
  return { text: formatDuration(seconds), late: seconds > 3600 }
}

/**
 * "Indexed through ledger N · lag M · Refreshes every 1 min", then each stored gap: how far the
 * history a list shows can be trusted. A lag over an hour is marked.
 */
export function IndexLine({ index, ledgerTime }: { index: IndexedEvents; ledgerTime: number | null }) {
  const lag = lagText(index, ledgerTime)
  return (
    <div data-testid="event-list-index" className="grid gap-0.5 font-mono text-xs/5 text-ink-muted">
      <p className="flex flex-wrap gap-x-2">
        <span>{index.indexedThrough > 0 ? `Indexed through ledger ${index.indexedThrough}` : "Not indexed yet"}</span>
        <span aria-hidden="true">·</span>
        <span className={lag?.late ? "font-semibold text-negative" : undefined}>
          {lag ? `lag ${lag.text}${lag.late ? ", over 1 hour behind" : ""}` : "lag not known yet"}
        </span>
        <span aria-hidden="true">·</span>
        <span>Refreshes every 1 min</span>
      </p>
      {index.gaps.map((g) => (
        <p key={`${g.group}-${g.from}`} className="font-semibold text-negative">
          Gap: {g.group} ledgers {g.from}–{g.to} are not indexed
        </p>
      ))}
    </div>
  )
}

/** What one row of an `EventList` says: a first line, and an optional detail under it. */
export type EventRowText = { title: string; detail?: ReactNode }

/** The default row: the topic's words, and the account it is about (shortened, the full id in its title). */
function defaultDescribe(row: IndexedEvent): EventRowText {
  const who = eventSubject(row.topic, row.data)
  return {
    title: eventWords(row.topic, row.data),
    detail: who ? (
      <span title={who} className="whitespace-nowrap">
        {accountShort(who)}
      </span>
    ) : undefined,
  }
}

export type EventListProps = {
  /** Names the table for assistive tech, and the Unavailable tip: "Limit changes". */
  label: string
  /** One index group; every group when omitted. */
  group?: IndexGroup
  /** One market's events (its pool id). */
  pool?: string
  /** Only these topics, filtered by the API so pages stay full. */
  topics?: readonly string[]
  /** What a row says; by default the topic's words (`eventWords`) and the account it is about. */
  describe?: (row: IndexedEvent) => EventRowText
  /** Plain text when the index holds no such event, e.g. "No limit change indexed yet". Never an error. */
  empty: string
  /** Rows per page (20 by default); "Show older events" reads the next page with `before`. */
  pageSize?: number
}

/**
 * A paginated list of indexed events (spec 0004 D-13), newest first, from `GET /api/dashboard/events`:
 * each row with what happened, its ledger, its close time (UTC) and a stellar.expert link to its
 * transaction. The header says how far the index has read, its lag and any gap. History refreshes
 * every 60 s (D-6). It fits 375 px: below 720 px the close time folds under the event, below 520 px
 * the ledger and the transaction too.
 */
export function EventList({ label, group, pool, topics, describe = defaultDescribe, empty, pageSize = 20 }: EventListProps) {
  const m = useManifest()
  const { ledgerTime } = useLedgerClock()
  const q = useEventPages({ group, pool, topics }, pageSize)
  // A failed page of older events keeps the rows shown; a failed refresh does not.
  const failed = q.isError && !q.isFetchNextPageError
  const pages = failed ? undefined : q.data?.pages
  const rows = pages?.flatMap((p) => p.rows) ?? []

  let body: ReactNode
  if (failed) body = <UnavailableTip label={label} reason={q.error?.message ?? "the event index could not be read"} className="text-sm text-ink" />
  else if (!pages) body = <Skeleton className="h-24 w-full" />
  else if (rows.length === 0) body = <p className="text-sm text-ink-muted">{empty}</p>
  else
    body = (
      <Table aria-label={label}>
        <TableHeader>
          <TableRow>
            <TableHead className="max-[520px]:px-3">Event</TableHead>
            <TableHead className="text-right max-[520px]:hidden">Ledger</TableHead>
            <TableHead className="max-[720px]:hidden">Closed (UTC)</TableHead>
            <TableHead className="max-[520px]:hidden">Transaction</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const text = describe(r)
            const closed = Date.parse(r.closeTime) / 1000
            return (
              <TableRow key={r.id}>
                <TableCell className="font-sans text-ink max-[520px]:px-3">
                  <span className="block">{text.title}</span>
                  {/* Each piece stays whole; the separators between them are where the line may wrap. */}
                  <span className="block font-mono text-xs text-ink-muted">
                    {text.detail ? (
                      <>
                        <span>{text.detail}</span>
                        {" · "}
                      </>
                    ) : null}
                    <span className="min-[520px]:hidden">
                      <span className="whitespace-nowrap">ledger {r.ledger}</span>
                      {" · "}
                    </span>
                    <span className="min-[720px]:hidden">
                      <span className="whitespace-nowrap">{closeTimeText(r.closeTime)}</span>
                      {" · "}
                    </span>
                    <span className="whitespace-nowrap">{ledgerTime !== null && Number.isFinite(closed) ? ago(ledgerTime - closed) : closeTimeText(r.closeTime)}</span>
                  </span>
                  <span className="block min-[520px]:hidden">
                    <TxLink network={m.network} hash={r.txHash} />
                  </span>
                </TableCell>
                <TableCell className="text-right max-[520px]:hidden">{r.ledger}</TableCell>
                <TableCell className="text-xs max-[720px]:hidden">{closeTimeText(r.closeTime)}</TableCell>
                <TableCell className="max-[520px]:hidden">
                  <TxLink network={m.network} hash={r.txHash} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    )

  return (
    <div className="grid min-w-0 gap-3">
      {pages && pages.length > 0 ? <IndexLine index={pages[0]} ledgerTime={ledgerTime} /> : null}
      {body}
      {pages && q.hasNextPage ? (
        <Button type="button" variant="secondary" size="toggle" className="w-fit" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? "Reading older events…" : "Show older events"}
        </Button>
      ) : null}
      {q.isFetchNextPageError ? (
        <UnavailableTip label={`Older ${label.toLowerCase()}`} reason={q.error?.message ?? "the event index could not be read"} className="text-sm text-ink" />
      ) : null}
    </div>
  )
}
