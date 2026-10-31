import type { MarketHistory } from "@/lib/app/history-types"

const WEEK_SECONDS = 7 * 86_400
const SHORT_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

export type UnderlyingApyFigure =
  | { kind: "value"; value: number; caption: string }
  | { kind: "none"; reason: string }

/**
 * The latest 7-day underlying APY with the window it covers (R2-44): "since <date>" under 7 days,
 * never extrapolated; no history gives the reason instead of a number.
 */
export function underlyingApyOf(data: MarketHistory | undefined): UnderlyingApyFigure {
  if (!data) return { kind: "none", reason: "History could not be read right now." }
  const last = [...data.underlyingApy7d].reverse().find((p) => p.value !== null)
  if (!last || last.value === null || data.underlyingWindowSeconds === null) {
    return { kind: "none", reason: "No oracle snapshots yet: the 7-day average needs at least two." }
  }
  const short = data.underlyingWindowSeconds < WEEK_SECONDS
  return {
    kind: "value",
    value: last.value,
    caption: short ? `since ${SHORT_DATE.format(new Date((last.at - data.underlyingWindowSeconds) * 1000))}` : "7-day average",
  }
}
