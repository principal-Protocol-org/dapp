"use client"

import type { ComponentProps, ReactNode } from "react"
import { InfoIcon } from "lucide-react"
import { cn } from "cn"
import { UNAVAILABLE } from "@/components/app/live"
import type { UnreadInput, VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import type { Live } from "@/lib/protocol/types"
import { VerifyDrawer } from "./verify-drawer"

/** What a dashboard figure is: its name, its read, how its value reads, and (for the drawer) the raw value's scale. */
export type FigureSpec<T> = {
  label: string
  live: Live<T> | undefined
  format: (value: T) => string
  /** The raw value's scale in words, e.g. "7 decimals: 10,000,000 = 1 USDY". */
  scale?: string
  /** When the reads arrived (ms, React Query's `dataUpdatedAt`) and their refresh cadence: the drawer and the evidence say "read Xs ago", and Stale past 2 × the cadence. */
  read?: { at: number; cadenceMs: number }
  /** Inputs it could not read (one oracle among several): the drawer and the evidence give each one's reason and attempted call. */
  unread?: UnreadInput[]
}

/** The figure's text: its formatted value, or "Unavailable". Never a zero or a dash in its place. */
export function figureDisplay<T>(live: Live<T> | undefined, format: (value: T) => string): string {
  return live && live.status === "live" ? format(live.value) : UNAVAILABLE
}

/** The figure as a row of the evidence table; null while it has not been read. */
export function verifiable<T>(spec: FigureSpec<T>): VerifiableFigure | null {
  if (!spec.live) return null
  const figure: VerifiableFigure = { label: spec.label, display: figureDisplay(spec.live, spec.format), live: spec.live }
  return withExtras(figure, spec)
}

/** The figure, with its read time and its unread inputs when it has them. */
function withExtras(figure: VerifiableFigure, spec: Pick<FigureSpec<unknown>, "read" | "unread">): VerifiableFigure {
  return { ...figure, ...(spec.read ? { read: spec.read } : {}), ...(spec.unread && spec.unread.length > 0 ? { unread: spec.unread } : {}) }
}

/** "7 decimals: 10,000,000 = 1 USDY": how a raw amount reads. */
export function decimalsScale(decimals: number, code: string): string {
  return `${decimals} decimals: ${(10n ** BigInt(decimals)).toLocaleString("en-US")} = 1 ${code}`
}

/** How a live value shows on the page when plain text is not enough (a link): `format` still gives the evidence and the drawer their text. */
export type FigureRender<T> = (value: T, display: string) => ReactNode

/**
 * A dashboard figure (D-7): the formatted value, or "Unavailable", and an info button that opens
 * the How-to-verify drawer. For a failed read the drawer says why, and still gives the call that was
 * attempted, so the reader can try it. `live` undefined (not read yet) shows "Unavailable" with no
 * button: callers show a skeleton while the first read is pending. `render` replaces the visible
 * value only, e.g. a shortened address that links to the explorer.
 */
export function Figure<T>({ label, live, format, scale, read, unread, className, render }: FigureSpec<T> & { className?: string; render?: FigureRender<T> }) {
  if (!live) return <span className={className}>{UNAVAILABLE}</span>
  const display = figureDisplay(live, format)
  const down = live.status === "unavailable"
  const figure = withExtras({ label, display, live }, { read, unread })
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5", className)}>
      <span className="min-w-0 wrap-anywhere">{render && live.status === "live" ? render(live.value, display) : display}</span>
      <VerifyDrawer figure={figure} scale={scale} trigger={<VerifyButton name={down ? `Why ${label} is unavailable, and how to verify it` : `How to verify ${label}`} />} />
    </span>
  )
}

/** The info button that opens a How-to-verify drawer, named for assistive tech by `name`. */
export function VerifyButton({ name, ...props }: { name: string } & Omit<ComponentProps<"button">, "type" | "aria-label" | "className" | "children">) {
  return (
    <button
      type="button"
      aria-label={name}
      // A 24 px target (M11) around the 14 px icon, as InfoTip; the negative margin keeps the line's height.
      className="-m-[5px] inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      {...props}
    >
      <InfoIcon aria-hidden="true" className="size-3.5" />
    </button>
  )
}
