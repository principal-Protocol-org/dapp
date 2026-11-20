"use client"

import { cn } from "cn"
import { formatDuration } from "@/components/app/live"
import { useNow } from "@/hooks/use-dashboard"
import type { Live, ReadSource } from "@/lib/protocol/types"

/** Every read behind some figures, composite or single, in order; figures not read yet or unavailable add none. */
export function readsOf(lives: readonly (Live<unknown> | undefined)[]): ReadSource[] {
  return lives.flatMap((l) => (l && l.status === "live" ? (l.sources ?? (l.source ? [l.source] : [])) : []))
}

/** An endpoint's host, for "via fallback <host>"; the URL itself when it does not parse. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** A cadence in words: "15 s", "1 min". */
export const cadenceText = (ms: number) => (ms % 60_000 === 0 && ms >= 60_000 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`)

/**
 * "Ledger N · read Xs ago · Refreshes every 15 s" (D-6), for a page or a panel:
 *
 * - N is the newest ledger among `sources` (or `ledger`), the ledgers the RPC answered at.
 * - "Xs ago" is the time since those reads arrived (`updatedAt`, ms, React Query's `dataUpdatedAt`).
 *   A simulation names its ledger but not that ledger's close time, so the age is measured from the
 *   read, on the browser's clock as elapsed time only, never as an absolute time.
 * - Stale (marked) once that age is over 2 × `cadenceMs`: the refresh has not landed for two rounds.
 * - "Read across ledgers X–Y" when the reads answered at different ledgers (D-5).
 * - "via fallback <host>" when any read was answered by one of the manifest's `rpcFallbackUrls`
 *   (`ReadSource.viaFallback`, D-6), because the main RPC failed it.
 *
 * The age is read on the client after mount (`useNow`), never during render or prerender.
 */
export function AsOf({
  sources,
  ledger,
  updatedAt,
  cadenceMs,
  className,
}: {
  sources: readonly ReadSource[]
  ledger?: number
  updatedAt: number | null
  cadenceMs: number
  className?: string
}) {
  const now = useNow()
  const ledgers = sources.map((s) => s.ledger)
  const newest = ledger ?? (ledgers.length > 0 ? Math.max(...ledgers) : null)
  const oldest = ledgers.length > 0 ? Math.min(...ledgers) : null
  const ageMs = now !== null && updatedAt ? Math.max(0, now - updatedAt) : null
  const stale = ageMs !== null && ageMs > 2 * cadenceMs
  const parts: React.ReactNode[] = []
  if (newest === null) parts.push(<span key="none">No figure could be read</span>)
  else parts.push(<span key="ledger">Ledger {newest}{ageMs !== null ? ` · read ${formatDuration(ageMs / 1000)} ago` : ""}</span>)
  parts.push(<span key="cadence">Refreshes every {cadenceText(cadenceMs)}</span>)
  if (oldest !== null && newest !== null && oldest !== newest)
    parts.push(
      <span key="spread">
        Read across ledgers {oldest}–{newest}
      </span>,
    )
  const fallbackHosts = [...new Set(sources.filter((s) => s.viaFallback).map((s) => hostOf(s.rpcUrl)))]
  if (fallbackHosts.length > 0)
    parts.push(
      <span key="fallback" className="wrap-anywhere">
        via fallback {fallbackHosts.join(", ")}
      </span>,
    )
  if (stale)
    parts.push(
      <span key="stale" className="font-semibold text-negative">
        Stale: no new read for over {cadenceText(2 * cadenceMs)}
      </span>,
    )
  return (
    <p
      data-testid="as-of"
      data-stale={stale ? "true" : "false"}
      className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs/5 text-ink-muted", className)}
    >
      {parts.flatMap((part, i) => (i === 0 ? [part] : [<span key={`dot-${i}`} aria-hidden="true">·</span>, part]))}
    </p>
  )
}
