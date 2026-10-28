"use client"

import { useState } from "react"
import { SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  DEADLINE_MESSAGE,
  SLIPPAGE_MESSAGE,
  parseWhole,
  useSettings,
} from "@/hooks/use-settings"

type Field = "slippageBps" | "deadlineSeconds"

export function SettingsPopover() {
  const { slippageBps, deadlineSeconds, set } = useSettings()
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})

  const value = (field: Field) =>
    draft[field] ?? (field === "slippageBps" ? slippageBps.toString() : deadlineSeconds.toString())

  function change(field: Field, text: string) {
    setDraft((d) => ({ ...d, [field]: text }))
    // Typing clears a stale message; validity is judged on commit.
    setErrors((e) => ({ ...e, [field]: undefined }))
  }

  /** Stores the draft of `field` only when valid; an invalid draft is shown as an error, never stored. */
  function commit(field: Field): boolean {
    const text = draft[field]
    if (text === undefined) return true
    const result = set({ [field]: parseWhole(text) })
    if (result.ok) {
      setDraft((d) => ({ ...d, [field]: undefined }))
      return true
    }
    setErrors((e) => ({ ...e, [field]: field === "slippageBps" ? SLIPPAGE_MESSAGE : DEADLINE_MESSAGE }))
    return false
  }

  const commitProps = (field: Field) => ({
    onBlur: () => {
      commit(field)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") commit(field)
    },
  })

  return (
    <Popover
      onOpenChange={(open) => {
        // Valid drafts are committed on close; invalid ones are discarded, restoring the stored value.
        if (!open) {
          commit("slippageBps")
          commit("deadlineSeconds")
          setDraft({})
          setErrors({})
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="toggle" size="toggle" aria-label="Settings">
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-4 p-4">
        <p className="font-serif text-base text-ink">Transaction settings</p>
        <div className="grid gap-1.5">
          <Label htmlFor="pp-slippage">Slippage tolerance (bps)</Label>
          <Input
            id="pp-slippage"
            inputMode="numeric"
            autoComplete="off"
            className="font-mono"
            value={value("slippageBps")}
            aria-invalid={errors.slippageBps ? true : undefined}
            aria-describedby="pp-slippage-help"
            onChange={(e) => change("slippageBps", e.target.value)}
            {...commitProps("slippageBps")}
          />
          <p id="pp-slippage-help" className="text-xs/5 text-ink-muted">
            100 bps is 1%. Default 50, allowed 1 to 500.
          </p>
          {errors.slippageBps ? (
            <p role="alert" className="text-xs/5 text-negative">
              {errors.slippageBps}
            </p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pp-deadline">Deadline (seconds)</Label>
          <Input
            id="pp-deadline"
            inputMode="numeric"
            autoComplete="off"
            className="font-mono"
            value={value("deadlineSeconds")}
            aria-invalid={errors.deadlineSeconds ? true : undefined}
            aria-describedby="pp-deadline-help"
            onChange={(e) => change("deadlineSeconds", e.target.value)}
            {...commitProps("deadlineSeconds")}
          />
          <p id="pp-deadline-help" className="text-xs/5 text-ink-muted">
            A transaction not included by then is rejected. Default 300, allowed 60 to 1800.
          </p>
          {errors.deadlineSeconds ? (
            <p role="alert" className="text-xs/5 text-negative">
              {errors.deadlineSeconds}
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
