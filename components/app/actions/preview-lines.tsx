"use client"

import { useEffect, useRef, useState } from "react"
import { SIMULATION_DEBOUNCE_MS } from "@/hooks/use-simulation"
import type { AccountState } from "@/lib/protocol/account-state"
import { ACTION_META } from "@/lib/protocol/actions"
import type { MarketState } from "@/lib/protocol/market-state"
import type { IndicativeContext, PanelConfig, PanelInputs, PreviewLine } from "@/components/app/actions/panel-config"

export function PreviewList({ lines }: { lines: PreviewLine[] }) {
  return (
    <dl className="grid gap-2">
      {lines.map((line, i) => (
        <div key={`${line.label}-${i}`} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-0.5">
          <dt className="text-sm text-ink-muted">{line.label}</dt>
          <dd className="text-right font-mono text-sm text-ink tabular-nums">{line.value}</dd>
          {line.hint ? <dd className="col-span-2 text-xs text-ink-muted">{line.hint}</dd> : null}
        </div>
      ))}
    </dl>
  )
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A config callback that may throw: its failure is a line saying so, never a crash or a guess. */
export function safeLines(compute: () => PreviewLine[]): PreviewLine[] {
  try {
    return compute()
  } catch (error) {
    return [{ label: "Preview unavailable", value: errorText(error) }]
  }
}

const inputsKey = (inputs: PanelInputs) => `${inputs.amount ?? ""}|${inputs.secondaryAmount ?? ""}`

/**
 * The config's async `quote` lines for the current inputs: read 400 ms after the inputs stop
 * changing (spec §11: on demand, debounced, like the exact simulation), re-read when the market data
 * or the account changes, and shown only for the inputs they were read for. An action this release
 * does not offer (R47) is never quoted: it would preview a result it can never give.
 */
export function useQuoteLines(
  config: PanelConfig,
  ms: MarketState | undefined,
  inputs: PanelInputs,
  ctx: IndicativeContext,
): PreviewLine[] | null {
  const key = inputsKey(inputs)
  const [result, setResult] = useState<{ key: string; lines: PreviewLine[] } | null>(null)
  const quote = ACTION_META[config.action].disabled ? undefined : config.quote
  const account: AccountState | undefined = ctx.account
  const accountStatus = ctx.accountStatus
  const { amount, secondaryAmount } = inputs
  // The ledger time ticks every second; a quote is re-read with the market data, not per tick.
  const ledgerTime = useRef(ctx.ledgerTime)
  useEffect(() => {
    ledgerTime.current = ctx.ledgerTime
  })
  useEffect(() => {
    if (!quote || !ms) return
    let cancelled = false
    const values: PanelInputs = {}
    if (amount !== undefined) values.amount = amount
    if (secondaryAmount !== undefined) values.secondaryAmount = secondaryAmount
    const timer = setTimeout(() => {
      quote(ms, values, { account, accountStatus, ledgerTime: ledgerTime.current })
        .then((lines) => !cancelled && setResult({ key, lines }))
        .catch((error: unknown) => !cancelled && setResult({ key, lines: [{ label: "Quote unavailable", value: errorText(error) }] }))
    }, SIMULATION_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [quote, ms, account, accountStatus, amount, secondaryAmount, key])
  return quote && result && result.key === key ? result.lines : null
}
