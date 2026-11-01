"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UNAVAILABLE } from "@/components/app/live"
import { maxText } from "@/lib/app/amounts"
import type { Live } from "@/lib/protocol/types"
import type { FieldSpec } from "@/components/app/actions/panel-config"

/**
 * One amount input with its balance and MAX. `balance` is undefined without a connected wallet,
 * and MAX is off unless the balance is live: it never fills a guess.
 */
export function AmountField({
  id,
  spec,
  text,
  error,
  balance,
  decimals,
  onChange,
  onBlur,
  picker,
}: {
  id: string
  spec: FieldSpec
  text: string
  /** Shown inline and marks the input invalid. */
  error?: string
  balance?: Live<bigint> | null
  decimals: number
  onChange(text: string): void
  onBlur(): void
  /** A token picker shown under the label (the trade tabs' "You pay" field). */
  picker?: React.ReactNode
}) {
  const errorId = `${id}-error`
  const balanceId = `${id}-balance`
  const usable = balance?.status === "live" ? balance.value : undefined
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{spec.label}</Label>
        {balance ? (
          <span id={balanceId} className="font-mono text-xs text-ink-muted tabular-nums">
            {usable !== undefined ? `Balance: ${maxText(usable, decimals)} ${spec.unit}` : `Balance: ${UNAVAILABLE}`}
          </span>
        ) : null}
      </div>
      {picker ? <div className="flex min-w-0 flex-wrap items-center gap-2">{picker}</div> : null}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0.0"
            className="pr-14 font-mono tabular-nums"
            value={text}
            aria-invalid={error ? true : undefined}
            aria-describedby={[error ? errorId : null, balance ? balanceId : null].filter(Boolean).join(" ") || undefined}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
          />
          <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-xs text-ink-muted">
            {spec.unit}
          </span>
        </div>
        <Button
          type="button"
          variant="toggle"
          size="toggle"
          aria-label={`Max ${spec.label}`}
          title={usable === undefined ? "Your balance is not available" : undefined}
          disabled={usable === undefined}
          onClick={() => usable !== undefined && onChange(maxText(usable, decimals))}
        >
          Max
        </Button>
      </div>
      {error ? (
        <p id={errorId} className="text-sm text-negative wrap-anywhere">
          {error}
        </p>
      ) : null}
    </div>
  )
}
