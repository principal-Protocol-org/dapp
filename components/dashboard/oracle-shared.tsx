"use client"

import { formatDuration } from "@/components/app/live"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { formatAmountFixed } from "@/lib/protocol/format"
import { unavailable } from "@/lib/protocol/reader"
import type { ReadSource } from "@/lib/protocol/types"
import { closeTimeText } from "./event-words"
import { VerifyButton } from "./figure"
import { Row } from "./panel"
import { VerifyDrawer } from "./verify-drawer"

/** The oracle page's shared words and pieces: its table, its Feed card and its detail use them. */

/** What an unsupported view reads: the oracle's code has no `last_update_was_feed` (or `feed_source`) view. */
export const PATH_UNSUPPORTED = "Not supported by this oracle's code"

/** The oracle's 7-decimal fixed point (`SCALE`), every digit shown: the value as the contract stores it. */
export const oracleValue = (v: bigint) => formatAmountFixed(v, 7, 7)
export const ORACLE_SCALE = "7 decimals: 10,000,000 = 1.0000000 (US dollars per unit of the underlying, oracle units)"

export const LINK =
  "font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"

/** "2027-01-15 07:48:00 UTC": a unix-seconds timestamp; shown as the raw seconds when it is no date. */
export function utc(seconds: bigint | number): string {
  const ms = Number(seconds) * 1000
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? closeTimeText(new Date(ms).toISOString()) : `${seconds} (unix seconds)`
}

/** A timestamp and, once the ledger clock has passed it, its age on that clock. */
export function timestampText(ts: bigint, nowSeconds: number | null): string {
  const age = nowSeconds !== null ? nowSeconds - Number(ts) : null
  return age !== null && age >= 0 ? `${utc(ts)} · ${formatDuration(age)} ago on the ledger clock` : utc(ts)
}

/**
 * A view the oracle's code does not have, as a figure: not a failed read but a definite answer. Its
 * drawer gives the call attempted (`fn`), which shows the host's MissingValue.
 */
export function unsupportedFigure(label: string, fn: string, source: Omit<ReadSource, "rawXdr" | "ledger"> | undefined, read?: VerifiableFigure["read"]): VerifiableFigure {
  return {
    label,
    display: PATH_UNSUPPORTED,
    live: unavailable(`${PATH_UNSUPPORTED}: ${fn} answers HostError: Error(WasmVm, MissingValue)`, source),
    ...(read ? { read } : {}),
  }
}

/** An unsupported figure inline: `text` (the sentence by default) and its drawer. */
export function UnsupportedValue({ figure, text = PATH_UNSUPPORTED }: { figure: VerifiableFigure; text?: string }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5">
      <span className="min-w-0 font-sans wrap-anywhere">{text}</span>
      <VerifyDrawer figure={figure} trigger={<VerifyButton name={`How to verify ${figure.label}`} />} />
    </span>
  )
}

/** An unsupported figure as a labelled row. */
export function UnsupportedRow({ label, figure }: { label: string; figure: VerifiableFigure }) {
  return (
    <Row label={label}>
      <UnsupportedValue figure={figure} />
    </Row>
  )
}
