"use client"

import { useRef, type KeyboardEvent } from "react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"

export type PayToken = "underlying" | "sy"

/** Arrow keys and the step they move the choice by (WAI-ARIA radio group). */
const STEP: Record<string, 1 | -1> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * Which token pays (or is received): the underlying asset, or its SY. Two options in a row, so
 * both are visible at once; the SY option carries a badge, like Pendle's picker.
 *
 * A radio group (M11): one tab stop, the checked option (roving tabindex); the arrow keys move the
 * choice and the focus to the next or previous option, wrapping around.
 */
export function TokenPicker({
  value,
  onChange,
  options,
  code = "USDY",
  label = "Token",
}: {
  value: PayToken
  onChange: (value: PayToken) => void
  options: readonly PayToken[]
  /** The underlying's asset code. */
  code?: string
  /** The group's accessible name, e.g. "Pay with" on a "You pay" field. */
  label?: string
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  // The checked option is the group's tab stop; with none checked, the first is.
  const current = Math.max(0, options.indexOf(value))
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = STEP[event.key]
    if (!step || options.length === 0) return
    event.preventDefault()
    const next = (i + step + options.length) % options.length
    onChange(options[next])
    buttons.current[next]?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full gap-1 rounded-md border border-line p-0.5">
      {options.map((option, i) => {
        const selected = option === value
        return (
          <button
            key={option}
            ref={(el) => {
              buttons.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={i === current ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, i)}
            onClick={() => onChange(option)}
            className={cn(
              "inline-flex min-h-8 items-center gap-1.5 rounded-sm px-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
              selected ? "bg-surface-sunk text-ink" : "text-ink-muted hover:text-ink",
            )}
          >
            {code}
            {option === "sy" ? <Badge className="px-1.5 py-0 text-[10px]/4 before:hidden">SY</Badge> : null}
          </button>
        )
      })}
    </div>
  )
}
