"use client"

import { Suspense, useId, useState } from "react"
import { useSearchParams } from "next/navigation"
import { useManifest } from "@/components/app/manifest-provider"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { useEventCounts, type IndexedEvent, type IndexGroup } from "@/hooks/use-dashboard"
import { rejectionText } from "@/lib/protocol/dashboard/rejections"
import { contractLabel } from "@/lib/protocol/dashboard/verify"
import type { Manifest } from "@/lib/protocol/types"
import { EventList, type EventRowText } from "./event-list"
import { accountShort, eventSubject, eventWords } from "./event-words"

const GROUPS: { id: IndexGroup; label: string }[] = [
  { id: "market", label: "Markets (SY, manager, pool)" },
  { id: "oracle", label: "Oracle" },
  { id: "risk", label: "RiskControl" },
  { id: "permissioning", label: "Permissioning" },
  { id: "escrow", label: "RecoveryEscrow" },
]

/** Groups whose contracts serve every market: their events carry no market, so a market filter would hide them all. */
const PROTOCOL_WIDE: Partial<Record<IndexGroup, string>> = { oracle: "The oracle", risk: "RiskControl", permissioning: "Permissioning" }

const TOPIC = /^[A-Za-z0-9_]{1,32}$/
const PAGE_SIZE = 50

type Filters = { group: IndexGroup | null; topic: string | null; marketId: string | null }

/** The filters a link names (`?group=&topic=&market=`); a value the page does not know is dropped, never sent. */
function filtersFrom(params: URLSearchParams | null, m: Manifest): Filters {
  const group = params?.get("group") ?? null
  const topic = params?.get("topic") ?? null
  const market = params?.get("market") ?? null
  const g = GROUPS.some((x) => x.id === group) ? (group as IndexGroup) : null
  return {
    group: g,
    topic: topic !== null && TOPIC.test(topic) ? topic : null,
    marketId: market !== null && (!g || !PROTOCOL_WIDE[g]) && m.markets.some((x) => x.marketId === market) ? market : null,
  }
}

/**
 * The filters into the address bar, so the view can be shared as a link. `replaceState` updates
 * `useSearchParams` without a server round trip or a remount (Next's native History API support).
 */
function writeUrl(f: Filters) {
  const params = new URLSearchParams()
  if (f.group) params.set("group", f.group)
  if (f.topic) params.set("topic", f.topic)
  if (f.marketId) params.set("market", f.marketId)
  const query = params.toString()
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`)
}

/** `GET /api/dashboard/events` for the filters, as the list reads it. */
function apiUrl(group: IndexGroup | null, pool: string | null, topic: string | null): string {
  const params = new URLSearchParams()
  if (group) params.set("group", group)
  if (pool) params.set("pool", pool)
  if (topic) params.set("topic", topic)
  params.set("limit", String(PAGE_SIZE))
  return `/api/dashboard/events?${params}`
}

/** A kind's name in the filter: its words, then its topic as the contract emits it. */
function kindLabel(topic: string, count: number | undefined): string {
  // `paused` is worded from its value; as a kind it is both.
  const words = topic === "paused" ? "Paused or unpaused" : eventWords(topic)
  return `${words === topic ? topic : `${words} (${topic})`} · ${count ?? 0}`
}

const SELECT = "h-9 w-full min-w-0 rounded-lg border border-input bg-surface px-2.5 text-sm text-ink disabled:cursor-not-allowed disabled:opacity-60"

/**
 * The public activity feed (`/dashboard/activity`, spec 0004 D-13): every indexed protocol event,
 * newest first, filterable by group or kind and by market, each row with its transaction link,
 * ledger and close time. The list's header says how far the index has read, its lag and any gap.
 * The filters live in the URL, so a filtered view is a link. No wallet is read.
 */
export function ActivityPanel() {
  return (
    <Suspense fallback={<ActivityFallback />}>
      <ActivityView />
    </Suspense>
  )
}

function Heading() {
  return (
    <div className="min-w-0">
      <h1 id="activity-heading" className="font-serif text-3xl text-ink">
        Activity
      </h1>
      <p className="mt-2 max-w-[68ch] text-ink-muted">
        Every protocol event the index holds, newest first: market trades and liquidity, SY deposits, oracle updates and rejections, RiskControl and
        Permissioning changes, RecoveryEscrow seizures. Each row links to its transaction. No wallet is needed.
      </p>
    </div>
  )
}

function ActivityFallback() {
  return (
    <section aria-labelledby="activity-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <Heading />
      <Skeleton className="h-48 w-full" />
    </section>
  )
}

function ActivityView() {
  const m = useManifest()
  const params = useSearchParams()
  const ids = { group: useId(), kind: useId(), market: useId() }
  // Until the reader picks a filter, the link's filters apply.
  const [chosen, setChosen] = useState<Filters | null>(null)
  const filters = chosen ?? filtersFrom(params, m)
  const { group, topic, marketId } = filters
  const market = marketId ? m.markets.find((x) => x.marketId === marketId) : undefined
  const pool = market?.contracts.pool ?? null
  const wide = group ? PROTOCOL_WIDE[group] : undefined

  const counts = useEventCounts(group ?? undefined, pool ?? undefined)
  const held = counts.data && !counts.stale ? counts.data.counts : {}
  const topics = [...new Set([...Object.keys(held), ...(topic ? [topic] : [])])].sort((a, b) => kindLabel(a, 0).localeCompare(kindLabel(b, 0)))

  const change = (next: Filters) => {
    setChosen(next)
    writeUrl(next)
  }

  const marketName = (p: string | null) => (p ? m.markets.find((x) => x.contracts.pool === p)?.displayName : undefined)
  const describe = (r: IndexedEvent): EventRowText => {
    const who = eventSubject(r.topic, r.data)
    const title = r.topic === "ref_rej" && typeof r.data.reason === "string" ? `${eventWords(r.topic)}: ${rejectionText(r.data.reason)}` : eventWords(r.topic, r.data)
    const where = [contractLabel(m, r.contractId), marketName(r.pool)].filter(Boolean).join(" · ")
    return {
      title,
      detail: (
        <>
          <span className="whitespace-nowrap">{where}</span>
          {who ? (
            <>
              {" · "}
              <span title={who} className="whitespace-nowrap">
                {accountShort(who)}
              </span>
            </>
          ) : null}
        </>
      ),
    }
  }

  const filtered = group !== null || topic !== null || pool !== null
  const url = apiUrl(group, pool, topic)

  return (
    <section aria-labelledby="activity-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <Heading />

      <div role="group" aria-label="Filters" className="grid grid-cols-[minmax(0,1fr)] gap-4 rounded-lg border border-line bg-surface p-5 min-[720px]:grid-cols-3">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={ids.group}>Group</Label>
          <select
            id={ids.group}
            value={group ?? ""}
            onChange={(e) => {
              const next = (e.target.value || null) as IndexGroup | null
              // A new group has other kinds; a protocol-wide one has no market.
              change({ group: next, topic: null, marketId: next && PROTOCOL_WIDE[next] ? null : marketId })
            }}
            className={SELECT}
          >
            <option value="">All groups</option>
            {GROUPS.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={ids.kind}>Kind</Label>
          <select id={ids.kind} value={topic ?? ""} onChange={(e) => change({ ...filters, topic: e.target.value || null })} className={SELECT}>
            <option value="">All kinds</option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {kindLabel(t, held[t])}
              </option>
            ))}
          </select>
          {counts.isError ? <p className="text-xs/5 text-ink-muted">The kinds could not be counted: {counts.error?.message ?? "unknown error"}</p> : null}
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={ids.market}>Market</Label>
          <select id={ids.market} value={wide ? "" : (marketId ?? "")} disabled={wide !== undefined} onChange={(e) => change({ ...filters, marketId: e.target.value || null })} className={SELECT}>
            <option value="">All markets</option>
            {m.markets.map((x) => (
              <option key={x.marketId} value={x.marketId}>
                {x.displayName}
              </option>
            ))}
          </select>
          {wide ? <p className="text-xs/5 text-ink-muted">{wide} is protocol-wide: no market filter</p> : null}
        </div>
      </div>

      <div className="grid min-w-0 gap-3">
        <EventList
          key={url}
          label="Activity"
          group={group ?? undefined}
          pool={pool ?? undefined}
          topics={topic ? [topic] : undefined}
          describe={describe}
          empty={filtered ? "No event indexed for these filters" : "No event indexed yet"}
          pageSize={PAGE_SIZE}
        />
        <p className="text-xs/5 text-ink-muted">
          The same list, as JSON:{" "}
          <a href={url} className="font-mono underline decoration-line-strong underline-offset-4 wrap-anywhere hover:decoration-ink">
            {url}
          </a>
        </p>
      </div>
    </section>
  )
}
