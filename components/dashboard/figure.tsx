"use client"

import { InfoIcon } from "lucide-react"
import { cn } from "cn"
import { UNAVAILABLE } from "@/components/app/live"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
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
}

/** The figure's text: its formatted value, or "Unavailable". Never a zero or a dash in its place. */
export function figureDisplay<T>(live: Live<T> | undefined, format: (value: T) => string): string {
  return live && live.status === "live" ? format(live.value) : UNAVAILABLE
}

/** The figure as a row of the evidence table; null while it has not been read. */
export function verifiable<T>(spec: FigureSpec<T>): VerifiableFigure | null {
  if (!spec.live) return null
  const figure: VerifiableFigure = { label: spec.label, display: figureDisplay(spec.live, spec.format), live: spec.live }
  return spec.read ? { ...figure, read: spec.read } : figure
}

/** "7 decimals: 10,000,000 = 1 USDY": how a raw amount reads. */
export function decimalsScale(decimals: number, code: string): string {
  return `${decimals} decimals: ${(10n ** BigInt(decimals)).toLocaleString("en-US")} = 1 ${code}`
}

/**
 * A dashboard figure (D-7): the formatted value, or "Unavailable", and an info button that opens
 * the How-to-verify drawer. For a failed read the drawer says why, and still gives the call that was
 * attempted, so the reader can try it. `live` undefined (not read yet) shows "Unavailable" with no
 * button: callers show a skeleton while the first read is pending.
 */
export function Figure<T>({ label, live, format, scale, read, className }: FigureSpec<T> & { className?: string }) {
  if (!live) return <span className={className}>{UNAVAILABLE}</span>
  const display = figureDisplay(live, format)
  const down = live.status === "unavailable"
  const figure: VerifiableFigure = read ? { label, display, live, read } : { label, display, live }
  return (
    <span className={cn("inline-flex max-w-full min-w-0 items-center gap-1.5", className)}>
      <span className="min-w-0 wrap-anywhere">{display}</span>
      <VerifyDrawer
        figure={figure}
        scale={scale}
        trigger={
          <button
            type="button"
            aria-label={down ? `Why ${label} is unavailable, and how to verify it` : `How to verify ${label}`}
            // A 24 px target (M11) around the 14 px icon, as InfoTip; the negative margin keeps the line's height.
            className="-m-[5px] inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            <InfoIcon aria-hidden="true" className="size-3.5" />
          </button>
        }
      />
    </span>
  )
}
