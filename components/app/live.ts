import type { Live } from "@/lib/protocol/types"

export const UNAVAILABLE = "Unavailable"

/** Formats a live value, or says it is unavailable. Never a zero or a dash in its place. */
export function showLive<T>(value: Live<T> | undefined, format: (v: T) => string): string {
  return value && value.status === "live" ? format(value.value) : UNAVAILABLE
}

/** "3d 4h 5m", "2h 5m 9s", "45s". Whole seconds in, display only. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}
