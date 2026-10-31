import type { Series } from "@/lib/app/history-types"
import { pathOf, runs } from "./geometry"

const W = 96
const H = 28
const PAD = 3

/**
 * 30-day fixed-APY spark line: one line, no axes. Colour follows the sign of `changePts`
 * (positive / negative tokens; muted when unknown or flat). Gaps stay gaps; nothing is extrapolated.
 */
export function SparkLine({ points, changePts }: { points: Series; changePts: number | null }) {
  const values = points.filter((p) => p.value !== null) as { at: number; value: number }[]
  if (values.length === 0) {
    return <span className="text-xs text-muted-foreground">No history yet</span>
  }
  const trend = changePts === null || changePts === 0 ? "flat" : changePts > 0 ? "up" : "down"
  const stroke = trend === "up" ? "var(--positive)" : trend === "down" ? "var(--negative)" : "var(--line-strong)"
  const t0 = values[0].at
  const t1 = values[values.length - 1].at
  const lo = Math.min(...values.map((p) => p.value))
  const hi = Math.max(...values.map((p) => p.value))
  const x = (at: number) => (t1 === t0 ? W / 2 : PAD + ((at - t0) / (t1 - t0)) * (W - 2 * PAD))
  const y = (v: number) => (hi === lo ? H / 2 : H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD))
  const label =
    changePts === null
      ? "30-day fixed APY"
      : `30-day fixed APY, ${changePts >= 0 ? "up" : "down"} ${Math.abs(changePts).toFixed(2)} points`
  return (
    <svg
      role="img"
      aria-label={label}
      data-trend={trend}
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="block max-w-full"
    >
      {runs(points, x, y).map((run, i) =>
        run.length === 1 ? (
          <circle key={i} cx={run[0].x} cy={run[0].y} r={1.5} fill={stroke} />
        ) : (
          <path key={i} d={pathOf(run)} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        ),
      )}
    </svg>
  )
}
