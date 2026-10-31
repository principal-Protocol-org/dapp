"use client"

import { cn } from "cn"
import { Badge } from "@/components/ui/badge"

export type PayToken = "underlying" | "sy"

/**
 * Which token pays (or is received): the underlying asset, or its SY. Two options in a row, so
 * both are visible at once; the SY option carries a badge, like Pendle's picker.
 */
export function TokenPicker({
  value,
  onChange,
  options,
  code = "USDY",
}: {
  value: PayToken
  onChange: (value: PayToken) => void
  options: readonly PayToken[]
  /** The underlying's asset code. */
  code?: string
}) {
  return (
    <div role="radiogroup" aria-label="Token" className="inline-flex max-w-full gap-1 rounded-md border border-line p-0.5">
      {options.map((option) => {
        const selected = option === value
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
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
