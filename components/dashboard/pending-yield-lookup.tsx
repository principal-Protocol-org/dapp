"use client"

import { useId, useState, type FormEvent } from "react"
import { Button } from "@/components/ui/button"
import { toAddress } from "@/lib/protocol/reader"
import { accountShort } from "./event-words"
import type { FigureSpec } from "./figure"
import { Shown } from "./query-figures"

export const INVALID_ADDRESS = "Enter a valid Stellar account (G…) or contract (C…) address."

/** A `G…` account or `C…` contract strkey, checked with `StrKey` (`toAddress`). */
export function isStellarAddress(value: string): boolean {
  try {
    toAddress(value)
    return true
  } catch {
    return false
  }
}

/**
 * The pending-yield address lookup (D-9): any account or contract address, checked before anything
 * is read; no wallet. `onLookup` receives a valid address, trimmed. `result` is the figure for the
 * looked-up address (`pendingClaim`, net of the YT fee), shown once there is one.
 */
export function PendingYieldLookup({
  account,
  onLookup,
  result,
  ytFee,
}: {
  account: string | null
  onLookup: (account: string) => void
  result: FigureSpec<bigint> | null
  /** The YT fee as text ("0.20%"), or null while it is not read. */
  ytFee: string | null
}) {
  const id = useId()
  const inputId = `${id}-address`
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const [value, setValue] = useState("")
  const [invalid, setInvalid] = useState(false)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const address = value.trim()
    if (!isStellarAddress(address)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    onLookup(address)
  }

  return (
    <div className="grid gap-4">
      <form onSubmit={submit} noValidate className="grid gap-2">
        <label htmlFor={inputId} className="label">
          Account or contract address
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <input
            id={inputId}
            name="address"
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              if (invalid) setInvalid(false)
            }}
            placeholder="G… or C…"
            aria-invalid={invalid}
            aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}
            className="min-w-0 flex-1 basis-64 rounded-md border border-line-strong bg-surface px-3 py-3 font-mono text-sm/5 text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus aria-invalid:border-negative"
          />
          <Button type="submit" variant="secondary">
            Look up
          </Button>
        </div>
        {invalid ? (
          <p id={errorId} role="alert" className="text-sm text-negative">
            {INVALID_ADDRESS}
          </p>
        ) : null}
        <p id={hintId} className="text-xs/5 text-ink-muted">
          Any Stellar account or contract. Nothing is signed and no wallet is needed.
        </p>
      </form>
      {account && result ? (
        <div className="grid gap-1 border-t border-line pt-3" aria-live="polite">
          <span className="label">
            Pending yield for <span title={account}>{accountShort(account)}</span>
          </span>
          <span className="font-mono text-sm tabular-nums text-ink">
            <Shown {...result} />
          </span>
          <span className="text-xs/5 text-ink-muted">
            What claiming now would pay this address, net of the YT fee{ytFee ? ` (${ytFee})` : ""}, as the app shows it.
          </span>
        </div>
      ) : null}
    </div>
  )
}
