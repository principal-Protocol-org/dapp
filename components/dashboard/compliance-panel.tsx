"use client"

import { useId, type ReactNode } from "react"
import { UnavailableTip } from "@/components/app/info-tip"
import { useManifest } from "@/components/app/manifest-provider"
import { Metric } from "@/components/app/market/metric"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DASHBOARD_AGGREGATE_MS,
  useAllEvents,
  useAssetCompliance,
  useEscrowRecords,
  useEventCounts,
  type IndexedEvent,
  type IndexedEvents,
} from "@/hooks/use-dashboard"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import {
  joinEscrowRecords,
  type AssetCompliance,
  type EscrowRow,
  type IndexedEscrowEvent,
  type RecoveryRecord,
  type RecoveryRecordFields,
} from "@/lib/protocol/dashboard/compliance"
import { contractLabel, type VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { explorerUrl } from "@/lib/protocol/explorer"
import { formatAmountFixed } from "@/lib/protocol/format"
import { unavailable } from "@/lib/protocol/reader"
import type { Live, Manifest, Network } from "@/lib/protocol/types"
import { AsOf, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { EventList, IndexLine, TxLink, type EventRowText } from "./event-list"
import { accountShort, closeTimeText, eventSubject } from "./event-words"
import { decimalsScale, verifiable, type FigureSpec } from "./figure"
import { Panel, Row } from "./panel"
import { readOf, Shown } from "./query-figures"

/** The note the Permissioning counts carry (spec 0004: `acc_batch` carries its caller alone). */
export const BATCH_NOTE = "Batch grants (acc_batch) carry only their caller, so their members are not counted."

const ESCROW_TOPICS = ["recovery", "finalize"] as const

function AccountLink({ network, id }: { network: Network; id: string }) {
  const url = explorerUrl(network, id.startsWith("C") ? "contract" : "account", id)
  if (!url)
    return (
      <span title={id} className="font-mono">
        {accountShort(id)}
      </span>
    )
  return (
    <a href={url} target="_blank" rel="noreferrer" title={id} className="font-mono underline decoration-line-strong underline-offset-4 hover:decoration-ink">
      {accountShort(id)}
    </a>
  )
}

const yesNo = (v: boolean) => (v ? "Yes" : "No")

/** Label-over-value cells side by side (no row rules, which only suit one column), one per line at 375 px. */
const CELLS = "grid grid-cols-1 gap-x-6 gap-y-4 min-[420px]:grid-cols-2"
const CELL = "min-w-0 text-sm wrap-anywhere"
const failedRefresh = (error: Error | null) => unavailable(`the last refresh failed: ${error?.message ?? "unknown error"}`)

/** One underlying asset: `admin()` as a figure, and the issuer's flags (a Horizon account read, linked). */
function AssetBlock({ a, admin, network }: { a: AssetCompliance; admin: FigureSpec<string>; network: Network }) {
  const model = a.model
  let flags: ReactNode
  if (model.status === "unavailable") flags = <UnavailableTip label="Issuer flags" reason={model.error} className="text-sm text-ink" />
  else if (model.value.kind === "sep57")
    flags = (
      <p className="text-sm text-ink">
        The underlying is a SEP-57 token. It has no issuer flags (authorization required, revocable, clawback) and no administrator address: the issuer acts
        through a role.
      </p>
    )
  else
    flags = (
      <dl className={CELLS}>
        <Metric label="Authorization required" valueClassName={CELL}>
          {yesNo(model.value.authRequired)}
        </Metric>
        <Metric label="Authorization revocable" valueClassName={CELL}>
          {yesNo(model.value.authRevocable)}
        </Metric>
        <Metric label="Clawback enabled" valueClassName={CELL}>
          {yesNo(model.value.clawbackEnabled)}
        </Metric>
      </dl>
    )
  const sep57 = model.status === "live" && model.value.kind === "sep57"
  return (
    <div className="grid gap-3">
      <p className="font-mono text-xs/5 text-ink-muted">
        {a.code} · SAC <span title={a.sac}>{accountShort(a.sac)}</span> · {a.marketIds.join(", ")}
      </p>
      {sep57 ? null : (
        <dl className="grid gap-3">
          <Row label="Administrator">
            <Shown {...admin} render={(v) => <AccountLink network={network} id={v} />} />
          </Row>
        </dl>
      )}
      {flags}
      {model.status === "live" && model.value.kind === "sac" ? (
        <a href={a.flagsUrl} target="_blank" rel="noreferrer" className="w-fit text-xs/5 text-ink-muted underline decoration-line-strong underline-offset-4 hover:text-ink">
          Flags read from the issuer&apos;s account on Horizon ({accountShort(a.issuer)})
        </a>
      ) : null}
    </div>
  )
}

type Units = { decimals: number; code: string }

/** The figures of one live record, each backed by its own `get_record --id N` read (D-7). */
function recordFigures(id: bigint, record: Live<RecoveryRecordFields>, u: Units, read: FigureSpec<unknown>["read"]) {
  const scale = decimalsScale(u.decimals, u.code)
  const amount = (unit: string) => (v: bigint) => `${formatAmountFixed(v, u.decimals)} ${unit}`
  const field = (label: string, pick: (r: RecoveryRecordFields) => bigint, unit: string): FigureSpec<bigint> => ({
    label: `Record ${id} ${label}`,
    live: record.status === "live" ? { ...record, value: pick(record.value) } : record,
    format: amount(unit),
    scale,
    read,
  })
  return {
    sy: field("SY shares seized", (r) => r.syShares, "SY"),
    fromSy: field("underlying from SY", (r) => r.underlyingFromSy, u.code),
    lp: field("LP seized", (r) => r.lpAmount, "LP"),
    fromLp: field("underlying from LP", (r) => r.underlyingFromLp, u.code),
    pt: field("PT held", (r) => r.ptAmount, "PT"),
    yt: field("YT held", (r) => r.ytAmount, "YT"),
    ytYield: field("YT yield at seizure", (r) => r.ytYieldAtSeize, u.code),
    fromPt: field("underlying from PT", (r) => r.underlyingFromPt, u.code),
    fromYt: field("underlying from YT", (r) => r.underlyingFromYt, u.code),
  }
}

const seconds = (ts: bigint) => closeTimeText(new Date(Number(ts) * 1000).toISOString())

/** Where an event sits: its ledger, its close time and its transaction. */
function EventRef({ network, event }: { network: Network; event: IndexedEscrowEvent }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 font-mono text-xs/5 text-ink-muted">
      <TxLink network={network} hash={event.txHash} />
      <span className="whitespace-nowrap">ledger {event.ledger}</span>
      <span className="whitespace-nowrap">{closeTimeText(event.closeTime)}</span>
    </span>
  )
}

function TxRow({ label, network, event, indexError }: { label: string; network: Network; event: IndexedEscrowEvent | null; indexError: string | null }) {
  return (
    <Row label={label}>
      {event ? (
        <EventRef network={network} event={event} />
      ) : indexError ? (
        <UnavailableTip label={label} reason={indexError} />
      ) : (
        <span className="font-sans text-ink-muted">Not in the event index yet</span>
      )}
    </Row>
  )
}

const indexedAmount = (raw: unknown, u: Units, unit: string) => {
  if (typeof raw !== "string" && typeof raw !== "number") return "Not in the event"
  try {
    return `${formatAmountFixed(BigInt(raw), u.decimals)} ${unit}`
  } catch {
    return String(raw)
  }
}

function RecordCard({ row, u, network, figures }: { row: EscrowRow; u: Units; network: Network; figures?: ReturnType<typeof recordFigures> }) {
  const title = `Record ${row.id}`
  const titleId = useId()
  let body: ReactNode
  let badge: ReactNode = null
  if (row.kind === "unavailable") {
    body = <UnavailableTip label={title} reason={row.reason} className="text-sm text-ink" />
  } else if (row.kind === "indexed") {
    const d = row.seizure.data
    badge = <Badge status="dev">Archived</Badge>
    body = (
      <>
        <p className="text-sm text-ink">Archived on-chain; shown from the index</p>
        <dl className={CELLS}>
          <Metric label="Account" valueClassName={CELL}>
            {typeof d.account === "string" ? <AccountLink network={network} id={d.account} /> : "Not in the event"}
          </Metric>
          <Metric label="SY shares seized" valueClassName={CELL}>
            {indexedAmount(d.sy_shares, u, "SY")}
          </Metric>
          <Metric label="LP seized" valueClassName={CELL}>
            {indexedAmount(d.lp_amount, u, "LP")}
          </Metric>
          <Metric label="PT held" valueClassName={CELL}>
            {indexedAmount(d.pt_amount, u, "PT")}
          </Metric>
          <Metric label="YT held" valueClassName={CELL}>
            {indexedAmount(d.yt_amount, u, "YT")}
          </Metric>
        </dl>
        <dl className="grid gap-3">
          <TxRow label="Seizure transaction" network={network} event={row.seizure} indexError={null} />
          {row.finalization ? <TxRow label="Finalization transaction" network={network} event={row.finalization} indexError={null} /> : null}
        </dl>
      </>
    )
  } else if (figures) {
    const r = row.record.status === "live" ? row.record.value : null
    badge = r ? <Badge status={r.finalized ? "neutral" : "soon"}>{r.finalized ? "Finalized" : "Held in escrow"}</Badge> : null
    body = (
      <>
        {r ? (
          <p className="flex flex-wrap gap-x-2 font-mono text-xs/5 text-ink-muted">
            <AccountLink network={network} id={r.account} />
            <span className="whitespace-nowrap">seized at ledger {r.ledger}</span>
            <span className="whitespace-nowrap">{seconds(r.timestamp)}</span>
          </p>
        ) : null}
        <dl className={CELLS}>
          <Metric label="SY shares seized" valueClassName={CELL}>
            <Shown {...figures.sy} />
          </Metric>
          <Metric label="Underlying from SY" valueClassName={CELL}>
            <Shown {...figures.fromSy} />
          </Metric>
          <Metric label="LP seized" valueClassName={CELL}>
            <Shown {...figures.lp} />
          </Metric>
          <Metric label="Underlying from LP" valueClassName={CELL}>
            <Shown {...figures.fromLp} />
          </Metric>
          <Metric label="PT held" valueClassName={CELL}>
            <Shown {...figures.pt} />
          </Metric>
          <Metric label="YT held" valueClassName={CELL}>
            <Shown {...figures.yt} />
          </Metric>
          <Metric label="YT yield at seizure" valueClassName={CELL}>
            <Shown {...figures.ytYield} />
          </Metric>
          {r?.finalized ? (
            <>
              <Metric label="Underlying from PT" valueClassName={CELL}>
                <Shown {...figures.fromPt} />
              </Metric>
              <Metric label="Underlying from YT" valueClassName={CELL}>
                <Shown {...figures.fromYt} />
              </Metric>
            </>
          ) : null}
        </dl>
        <dl className="grid gap-3">
          <TxRow label="Seizure transaction" network={network} event={row.seizure} indexError={row.indexError} />
          {r?.finalized ? <TxRow label="Finalization transaction" network={network} event={row.finalization} indexError={row.indexError} /> : null}
        </dl>
      </>
    )
  }
  return (
    <article aria-labelledby={titleId} className="grid min-w-0 gap-3 rounded-md border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="font-medium text-ink">
          {title}
        </h3>
        {badge}
      </div>
      {body}
    </article>
  )
}

/** The reconcile line of one escrow (D-15): the last check of `record_count` against the indexed `recovery` count. */
function ReconcileLine({ index, escrow }: { index: { data?: IndexedEvents; isError: boolean; error: Error | null }; escrow: string }) {
  if (index.isError) return <UnavailableTip label="Reconciliation" reason={index.error?.message ?? "the event index could not be read"} className="text-xs text-ink" />
  const check = index.data?.reconcile
  const result = check?.results.find((r) => r.escrow === escrow)
  if (!index.data) return null
  if (!check || !result) return <p className="font-mono text-xs/5 text-ink-muted">Reconciliation: not run yet</p>
  const text =
    result.recordCount === null
      ? "record_count could not be read at the last check"
      : `record_count ${result.recordCount}, indexed ${result.indexed}: ${result.ok ? "they match" : "they differ"}`
  return (
    <p className="flex flex-wrap gap-x-2 font-mono text-xs/5 text-ink-muted">
      <span>Reconciliation</span>
      <span className={result.ok ? "text-ink" : "font-semibold text-negative"}>{text}</span>
      <span>checked {closeTimeText(check.at)}</span>
    </p>
  )
}

/** The underlying units of an escrow's markets (they share one asset per escrow on every deployment so far). */
function unitsFor(m: Manifest, marketIds: readonly string[]): Units | { refused: string } {
  const underlyings = m.markets.filter((x) => marketIds.includes(x.marketId)).map((x) => x.underlying)
  if (underlyings.length === 0) return { refused: "no market lists this escrow" }
  if (new Set(underlyings.map((x) => x.decimals)).size > 1) return { refused: "mixed decimals: this escrow's markets use different decimals" }
  return { decimals: underlyings[0].decimals, code: underlyings[0].code }
}

const PERMISSIONING_COUNTS: [label: string, topic: string][] = [
  ["Account grants", "acc_grant"],
  ["Account revokes", "acc_rev"],
  ["Asset grants", "ast_grant"],
  ["Asset revokes", "ast_rev"],
  ["Batch grants", "acc_batch"],
]

/**
 * The public compliance page (`/dashboard/compliance`): each underlying asset's administrator and
 * issuer flags, the RecoveryEscrow records read live (D-16) with the transaction hashes from the
 * index (an archived record shown from it, labelled), the index's reconciliation, and the
 * Permissioning counts and history. No wallet is read.
 */
export function CompliancePanel() {
  const m = useManifest()
  const { ledgerTime } = useLedgerClock()
  const assets = useAssetCompliance()
  const escrows = useEscrowRecords()
  const escrowEvents = useAllEvents({ group: "escrow", topics: ESCROW_TOPICS })
  const counts = useEventCounts("permissioning")

  const assetRead = readOf(assets, DASHBOARD_AGGREGATE_MS)
  const assetList = assets.data ?? []
  const adminFigures: FigureSpec<string>[] = assetList.map((a) => ({
    label: `${a.code} administrator`,
    live: assets.stale ? failedRefresh(assets.error) : a.admin,
    format: (v) => v,
    read: assetRead,
  }))

  const recordsRead = readOf(escrows, DASHBOARD_AGGREGATE_MS)
  const index: { events: IndexedEscrowEvent[] } | { error: string } | null = escrowEvents.isError
    ? { error: escrowEvents.error?.message ?? "the event index could not be read" }
    : escrowEvents.data
      ? { events: escrowEvents.data.rows }
      : null

  type EscrowBlock = {
    escrow: string
    marketIds: string[]
    list: FigureSpec<RecoveryRecord[]>
    units: Units | { refused: string }
    rows: { row: EscrowRow; figures?: ReturnType<typeof recordFigures> }[] | null
  }
  const blocks: EscrowBlock[] = (escrows.data ?? []).map((e) => {
    const live = escrows.stale ? failedRefresh(escrows.error) : e.records
    const units = unitsFor(m, e.marketIds)
    const list: FigureSpec<RecoveryRecord[]> = {
      label: `RecoveryEscrow records ${accountShort(e.escrow)}`,
      live,
      format: (records) => `${records.length} record${records.length === 1 ? "" : "s"}`,
      read: recordsRead,
    }
    const rows =
      live.status === "live" && index && !("refused" in units)
        ? joinEscrowRecords(e.escrow, live, index).map((row) => ({
            row,
            figures: row.kind === "live" ? recordFigures(row.id, row.record, units, recordsRead) : undefined,
          }))
        : null
    return { escrow: e.escrow, marketIds: e.marketIds, list, units, rows }
  })

  const recordSpecs = blocks.flatMap((b) => (b.rows ?? []).flatMap((r) => (r.figures ? Object.values(r.figures) : [])))
  const all = [...adminFigures, ...blocks.map((b) => b.list), ...recordSpecs] as FigureSpec<unknown>[]
  const figures = all.map(verifiable).filter((f): f is VerifiableFigure => f !== null)
  const newestUpdate = Math.max(0, ...[assets, escrows].map((q) => (q.stale ? 0 : q.dataUpdatedAt)))

  const describeEscrow = (r: IndexedEvent): EventRowText => {
    const who = eventSubject(r.topic, r.data)
    const id = typeof r.data.id === "string" || typeof r.data.id === "number" ? String(r.data.id) : "?"
    return {
      title: r.topic === "recovery" ? `Position seized into RecoveryEscrow (record ${id})` : r.topic === "finalize" ? `Recovery record ${id} finalized` : r.topic,
      detail: who ? (
        <span title={who} className="whitespace-nowrap">
          {accountShort(who)}
        </span>
      ) : undefined,
    }
  }

  let assetBody: ReactNode
  if (assets.isError && !assets.data)
    assetBody = <UnavailableTip label="Underlying asset" reason={assets.error?.message ?? "the asset could not be read"} className="text-sm text-ink" />
  else if (!assets.data) assetBody = <Skeleton className="h-24 w-full" />
  else if (assetList.length === 0) assetBody = <p className="text-sm text-ink-muted">No market lists an asset yet.</p>
  else assetBody = assetList.map((a, i) => <AssetBlock key={a.sac} a={assets.stale ? { ...a, model: failedRefresh(assets.error) } : a} admin={adminFigures[i]} network={m.network} />)

  let recordsBody: ReactNode
  if (escrows.isError && !escrows.data)
    recordsBody = <UnavailableTip label="RecoveryEscrow records" reason={escrows.error?.message ?? "the records could not be read"} className="text-sm text-ink" />
  else if (!escrows.data) recordsBody = <Skeleton className="h-24 w-full" />
  else
    recordsBody = blocks.map((b) => (
      <div key={b.escrow} className="grid gap-3">
        <p className="font-mono text-xs/5 text-ink-muted">
          <span title={b.escrow}>{contractLabel(m, b.escrow)}</span> · {b.marketIds.join(", ")}
        </p>
        <ReconcileLine index={escrowEvents} escrow={b.escrow} />
        {b.list.live?.status === "unavailable" ? (
          <Shown {...b.list} className="text-sm" />
        ) : "refused" in b.units ? (
          <UnavailableTip label="RecoveryEscrow records" reason={b.units.refused} className="text-sm text-ink" />
        ) : b.list.live?.status === "live" && b.list.live.value.length === 0 ? (
          <p className="text-sm text-ink-muted">No seizure recorded yet</p>
        ) : !b.rows ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid gap-3">
            {b.rows.map(({ row, figures: f }) => (
              <RecordCard key={String(row.id)} row={row} u={b.units as Units} network={m.network} figures={f} />
            ))}
          </div>
        )}
      </div>
    ))

  let countsBody: ReactNode
  if (counts.isError) countsBody = <UnavailableTip label="Permissioning counts" reason={counts.error?.message ?? "the event index could not be read"} className="text-sm text-ink" />
  else if (!counts.data) countsBody = <Skeleton className="h-16 w-full" />
  else {
    const c = counts.data.counts
    countsBody = (
      <>
        <IndexLine index={counts.data} ledgerTime={ledgerTime} />
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 min-[520px]:grid-cols-3">
          {PERMISSIONING_COUNTS.map(([label, topic]) => (
            <Metric key={topic} label={label} valueClassName={CELL}>
              {c[topic] ?? 0}
            </Metric>
          ))}
        </dl>
        <p className="text-xs/5 text-ink-muted">{BATCH_NOTE}</p>
      </>
    )
  }

  return (
    <section aria-labelledby="compliance-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 id="compliance-heading" className="font-serif text-3xl text-ink">
              Compliance
            </h1>
            <p className="mt-2 max-w-[68ch] text-ink-muted">
              Who administers the underlying asset and what its issuer may do, every RecoveryEscrow record read live, and Permissioning changes from the
              event index. No wallet is needed.
            </p>
          </div>
          <CopyEvidence figures={figures} />
        </div>
        <AsOf sources={readsOf(all.map((f) => f.live))} updatedAt={newestUpdate || null} cadenceMs={DASHBOARD_AGGREGATE_MS} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 min-[900px]:grid-cols-2">
        <Panel title="Underlying asset" meta={<p className="text-xs/5 text-ink-muted">admin() on the asset contract, and the issuer&apos;s flags · refreshes every 1 min</p>}>
          {assetBody}
        </Panel>

        <Panel title="Permissioning" meta={<p className="text-xs/5 text-ink-muted">Grants and revokes, counted from the event index · refreshes every 1 min</p>}>
          {countsBody}
        </Panel>

        <Panel
          title="RecoveryEscrow records"
          meta={
            <p className="text-xs/5 text-ink-muted">
              Read live with get_record(0..record_count); the transactions come from the event index. A record archived on-chain is shown from the index.
              Refreshes every 1 min.
            </p>
          }
          className="min-[900px]:col-span-2"
        >
          {recordsBody}
        </Panel>

        <Panel title="Seizure history" meta={<p className="text-xs/5 text-ink-muted">Every indexed recovery and finalize event, newest first</p>} className="min-[900px]:col-span-2">
          <EventList label="Seizure history" group="escrow" topics={ESCROW_TOPICS} describe={describeEscrow} empty="No seizure or finalization indexed yet" />
        </Panel>

        <Panel title="Permissioning changes" meta={<p className="text-xs/5 text-ink-muted">Every indexed grant and revoke, newest first</p>} className="min-[900px]:col-span-2">
          <EventList label="Permissioning changes" group="permissioning" empty="No Permissioning change indexed yet" />
        </Panel>
      </div>
    </section>
  )
}
