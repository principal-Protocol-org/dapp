"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"

const KEY = "pp-settings"

export const DEFAULT_SLIPPAGE_BPS = 50
export const DEFAULT_DEADLINE_SECONDS = 300
export const SLIPPAGE_RANGE = { min: 1, max: 500 } as const
export const DEADLINE_RANGE = { min: 60, max: 1800 } as const

export const SLIPPAGE_MESSAGE = `Slippage must be a whole number of basis points between ${SLIPPAGE_RANGE.min} and ${SLIPPAGE_RANGE.max}.`
export const DEADLINE_MESSAGE = `Deadline must be a whole number of seconds between ${DEADLINE_RANGE.min} and ${DEADLINE_RANGE.max}.`

type Field = "slippageBps" | "deadlineSeconds"
export type SettingsPatch = Partial<Record<Field, number>>
export type SetSettingsResult = { ok: true } | { ok: false; field: Field; message: string }

const inRange = (n: unknown, r: { min: number; max: number }): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= r.min && n <= r.max

// Storage can be missing, blocked or full. Keep an in-memory copy so the session still works.
let memory: string | null = null
let writeFailed = false
const listeners = new Set<() => void>()

function readRaw(): string | null {
  if (writeFailed) return memory
  try {
    return localStorage.getItem(KEY)
  } catch {
    return memory
  }
}

function writeRaw(raw: string) {
  memory = raw
  try {
    localStorage.setItem(KEY, raw)
    writeFailed = false
  } catch {
    writeFailed = true
  }
  listeners.forEach((l) => l())
}

/** Test seam: forget the in-memory fallback so each test starts from `localStorage` alone. */
export function resetSettingsStoreForTests() {
  memory = null
  writeFailed = false
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

function parse(raw: string | null): { slippageBps: number; deadlineSeconds: number } {
  let slippageBps = DEFAULT_SLIPPAGE_BPS
  let deadlineSeconds = DEFAULT_DEADLINE_SECONDS
  if (raw) {
    try {
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === "object") {
        const v = value as Record<string, unknown>
        if (inRange(v.slippageBps, SLIPPAGE_RANGE)) slippageBps = v.slippageBps
        if (inRange(v.deadlineSeconds, DEADLINE_RANGE)) deadlineSeconds = v.deadlineSeconds
      }
    } catch {
      // malformed JSON: defaults
    }
  }
  return { slippageBps, deadlineSeconds }
}

/** Whole-number text to a number; anything else is NaN (so it fails validation). */
export const parseWhole = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN)

export function useSettings(): {
  slippageBps: bigint
  deadlineSeconds: number
  set(patch: SettingsPatch): SetSettingsResult
} {
  const raw = useSyncExternalStore(subscribe, readRaw, () => null)
  const current = useMemo(() => parse(raw), [raw])

  const set = useCallback((patch: SettingsPatch): SetSettingsResult => {
    if (patch.slippageBps !== undefined && !inRange(patch.slippageBps, SLIPPAGE_RANGE)) {
      return { ok: false, field: "slippageBps", message: SLIPPAGE_MESSAGE }
    }
    if (patch.deadlineSeconds !== undefined && !inRange(patch.deadlineSeconds, DEADLINE_RANGE)) {
      return { ok: false, field: "deadlineSeconds", message: DEADLINE_MESSAGE }
    }
    writeRaw(JSON.stringify({ ...parse(readRaw()), ...patch }))
    return { ok: true }
  }, [])

  return { slippageBps: BigInt(current.slippageBps), deadlineSeconds: current.deadlineSeconds, set }
}
