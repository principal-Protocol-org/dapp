"use client"

import type { MouseEvent } from "react"
import { formatDuration } from "@/components/app/live"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { FRESHNESS_BADGE, FRESHNESS_WORD, oracleNow, type OracleEntry, type OracleNow, type OracleViewAt } from "@/lib/protocol/dashboard/oracle-state"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { unavailable } from "@/lib/protocol/reader"
import { accountShort } from "./event-words"
import { verifiable, type FigureSpec } from "./figure"
import { LINK, PATH_UNSUPPORTED, unsupportedFigure, UnsupportedValue } from "./oracle-shared"
import { current, readOf, Shown, type QueryLike } from "./query-figures"

/** One row of the Oracles table: the oracle, its state now, and its three figures, labelled with its asset so the evidence table tells rows apart. */
export type OracleRow = {
  entry: OracleEntry
  now: OracleNow
  state: FigureSpec<number>
  countdown: FigureSpec<number>
  path: FigureSpec<"push" | "feed">
  /** The path when the oracle's code has no `last_update_was_feed`: "Not supported", with the call that shows it. */
  pathUnsupported: VerifiableFigure | null
}

const STATE_SCALE = "Fresh while age ≤ max_stale_seconds (the contract's is_fresh) and is_available(); Warning from 75%; age is ledger time − the oracle timestamp"
const COUNTDOWN_SCALE = "Seconds: the oracle timestamp + max_stale_seconds − ledger time; counts down on the ledger clock"

/**
 * One oracle's row, from its query: the state and the countdown from its timestamp, max_stale and is_available reads; the path from last_update_was_feed.
 * `cadenceMs` is the query's refresh (`dashboardLiveMs`), for the read's age.
 */
export function oracleRow(entry: OracleEntry, q: QueryLike<OracleViewAt>, nowSeconds: number | null, cadenceMs: number, blocked?: string): OracleRow {
  const now = oracleNow(q, nowSeconds, blocked)
  const read = readOf(q, cadenceMs)
  const named = (name: string) => `${name} · ${entry.asset}`
  const path = !q.stale ? q.data?.view.path : undefined
  return {
    entry,
    now,
    state: { label: named("Freshness"), live: now.live, format: () => FRESHNESS_WORD[now.state], scale: STATE_SCALE, read },
    countdown: {
      label: named("Time until operations block"),
      live: now.live,
      format: (seconds) => (now.state === "stale" ? "Stale" : formatDuration(now.left ?? seconds)),
      scale: COUNTDOWN_SCALE,
      read,
    },
    path: {
      label: named("Update path"),
      live: current(q, (d) => (d.view.path.status === "unsupported" ? unavailable(PATH_UNSUPPORTED) : d.view.path), blocked),
      format: (p) => (p === "feed" ? "Feed" : "Push"),
      scale: "last_update_was_feed(): Feed when the value was read from the oracle's feed (sync_from_feed), Push when its admin set it",
      read,
    },
    pathUnsupported: path?.status === "unsupported" ? unsupportedFigure(named("Update path"), "last_update_was_feed", path.source, read) : null,
  }
}

/** Every row's figures, for the page's evidence table. */
export function oracleRowFigures(rows: OracleRow[]): VerifiableFigure[] {
  return rows.flatMap((r) => [verifiable(r.state), verifiable(r.countdown), r.pathUnsupported ?? verifiable(r.path)]).filter((f): f is VerifiableFigure => f !== null)
}

function PathValue({ row }: { row: OracleRow }) {
  return row.pathUnsupported ? <UnsupportedValue figure={row.pathUnsupported} text="Not supported" /> : <Shown {...row.path} className="font-sans" />
}

/**
 * Every oracle of the manifest, one row each: its asset and short id, its state now, the time until
 * operations block, and how its value was last set, each figure with its How-to-verify drawer. Each
 * row links to `?oracle=<id>`, its detail below. Below 520 px the countdown, and below 720 px the
 * path, fold under the oracle's name, so the table never scrolls inside its card.
 */
export function OraclesTable({ rows, selected, onChoose }: { rows: OracleRow[]; selected: string; onChoose: (event: MouseEvent<HTMLAnchorElement>, oracle: string) => void }) {
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
        {rows.map((row) => {
          const { entry, now } = row
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
                    <span className="whitespace-nowrap">
                      <Shown {...row.countdown} />
                    </span>
                  </span>
                  <span className="min-[720px]:hidden">
                    {" · "}
                    <span className="whitespace-nowrap">
                      <PathValue row={row} />
                    </span>
                  </span>
                </span>
              </TableCell>
              <TableCell className="max-[520px]:px-3">
                <Shown {...row.state} render={(_, display) => <Badge status={FRESHNESS_BADGE[now.state]}>{display}</Badge>} />
              </TableCell>
              <TableCell className="max-[520px]:hidden">
                <Shown {...row.countdown} />
              </TableCell>
              <TableCell className="font-sans max-[720px]:hidden">
                <PathValue row={row} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
