"use client"

import { Skeleton } from "@/components/ui/skeleton"
import { unavailable } from "@/lib/protocol/reader"
import type { Live, Manifest } from "@/lib/protocol/types"
import { Figure, type FigureRender, type FigureSpec } from "./figure"

/**
 * Helpers the dashboard pages share to turn a React Query result into figures: what is current, how
 * amounts read, and a skeleton while the first read is pending.
 */

export type QueryLike<D> = { data?: D; stale: boolean; error: Error | null; dataUpdatedAt: number }

/**
 * A figure from a query: undefined while the first read is pending; Unavailable, with the reason,
 * after a failed refresh (the old value is never shown as current); else the picked read.
 */
export function current<D, T>(q: QueryLike<D>, pick: (data: D) => Live<T>, blocked?: string): Live<T> | undefined {
  if (q.stale) return unavailable(`the last refresh failed: ${q.error?.message ?? "unknown error"}`)
  if (q.data !== undefined) return pick(q.data)
  return blocked ? unavailable(blocked) : undefined
}

export const MIXED_DECIMALS = "mixed decimals: the markets' underlying assets use different decimals"

/**
 * How amounts read: the decimals every market's underlying shares, and its code when they all hold
 * the same asset (else "underlying units"). Markets whose decimals differ give no unit at all: an
 * amount is then refused, never formatted with a guessed scale. With no market, the test asset.
 */
export function unitsOf(m: Manifest): { decimals: number; code: string | null } | { refused: string } {
  const underlyings = m.markets.length > 0 ? m.markets.map((x) => x.underlying) : m.testAsset ? [m.testAsset] : []
  if (underlyings.length === 0) return { refused: "no markets" }
  if (new Set(underlyings.map((u) => u.decimals)).size > 1) return { refused: MIXED_DECIMALS }
  return { decimals: underlyings[0].decimals, code: new Set(underlyings.map((u) => u.sac)).size === 1 ? underlyings[0].code : null }
}

/** `live`, or Unavailable with `reason` when its value cannot be shown (a figure is never formatted with a guessed scale). */
export function refuse<T>(live: Live<T> | undefined, reason: string | null): Live<T> | undefined {
  return reason && live && live.status === "live" ? unavailable(reason) : live
}

/** When a query's reads arrived and their cadence, for "read Xs ago"; none before the first answer or after a failed refresh. */
export const readOf = (q: { dataUpdatedAt: number; stale: boolean }, cadenceMs: number) =>
  q.dataUpdatedAt > 0 && !q.stale ? { at: q.dataUpdatedAt, cadenceMs } : undefined

/** A figure, or a skeleton while its first read is pending. */
export function Shown<T>(spec: FigureSpec<T> & { className?: string; render?: FigureRender<T> }) {
  return spec.live ? <Figure {...spec} /> : <Skeleton className="inline-block h-5 w-32 max-w-full align-middle" />
}

export const NO_LIQUIDITY = "No liquidity yet"

/**
 * Whether every listed pool is still unseeded (`poolSeeded` read false): pool liquidity then reads
 * "No liquidity yet", as in /app, never 0. False while any pool's seeding is unread or unreadable.
 */
export function noPoolSeeded(poolsSeeded: readonly Live<boolean>[]): boolean {
  return poolsSeeded.length > 0 && poolsSeeded.every((s) => s.status === "live" && !s.value)
}
