"use client"

import { useId, useState } from "react"
import type { Range, Series } from "@/lib/app/history-types"
import { pathOf, runs } from "./geometry"

export type ChartSeries = {
  id: string
  label: string
  /** pt = navy (principal, fixed); yt = gold (yield, variable); muted = neutral. */
  color: "pt" | "yt" | "muted"
  points: Series
}

const COLORS = { pt: "var(--par)", yt: "var(--coupon)", muted: "var(--line-strong)" } as const
const RANGE_LABELS: [Range, string][] = [
  ["7d", "7 d"],
  ["30d", "30 d"],
  ["90d", "90 d"],
  ["all", "All"],
]
const W = 640
const H = 240
const M = { l: 48, r: 12, t: 12, b: 24 }

function fmt(unit: "percent" | "amount", v: number): string {
  if (unit === "percent") return `${(v * 100).toFixed(2)}%`
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

/**
 * Hand-rolled SVG line chart. Null points are gaps (the line breaks). The plot is keyboard
 * focusable: focus shows the latest point, arrow keys step through the others. With two series
 * the tooltip also shows the spread of the first over the second as "Fixed premium".
 * `now` (ms) is injected so the stale banner is deterministic.
 */
export function LineChart({
  series,
  range,
  onRangeChange,
  stale,
  latestAt,
  now,
  unit = "percent",
  spread: spreadPair,
}: {
  series: ChartSeries[]
  range: Range
  onRangeChange: (range: Range) => void
  stale: boolean
  latestAt: number | null
  now: number
  unit?: "percent" | "amount"
  /** Names the pair whose difference the tooltip shows as "Fixed premium" (APY charts only). */
  spread?: { fixed: string; variable: string }
}) {
  const tipId = useId()
  const [active, setActive] = useState<number | null>(null)

  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.at)))].sort((a, b) => a - b)
  const all = series.flatMap((s) => s.points.flatMap((p) => (p.value === null ? [] : [p.value])))
  const empty = all.length === 0

  const t0 = times[0] ?? 0
  const t1 = times[times.length - 1] ?? 0
  let lo = Math.min(...all)
  let hi = Math.max(...all)
  if (unit === "amount") lo = Math.min(lo, 0)
  // A flat series is padded symmetrically for drawing only; the axis then shows just the real value.
  const flat = hi === lo
  if (flat) {
    const pad = unit === "percent" ? 0.005 : Math.max(1, Math.abs(lo) * 0.01)
    lo -= pad
    hi += pad
  }
  const flatValue = (lo + hi) / 2
  const x = (at: number) => (t1 === t0 ? M.l : M.l + ((at - t0) / (t1 - t0)) * (W - M.l - M.r))
  const y = (v: number) => H - M.b - ((v - lo) / (hi - lo)) * (H - M.t - M.b)

  const valueAt = (s: ChartSeries, at: number) => s.points.find((p) => p.at === at)?.value ?? null
  const latestIdx = (() => {
    for (let i = times.length - 1; i >= 0; i--) if (series.some((s) => valueAt(s, times[i]) !== null)) return i
    return times.length - 1
  })()
  const idx = active ?? latestIdx
  const at = times[idx]

  const ageH = latestAt === null ? 0 : Math.max(0, Math.floor((now / 1000 - latestAt) / 3600))
  const label = empty
    ? "Chart: no history yet"
    : `Chart, latest: ${series
        .map((s) => {
          const v = valueAt(s, times[latestIdx])
          return `${s.label} ${v === null ? "n/a" : fmt(unit, v)}`
        })
        .join(", ")}`

  const fixedSeries = spreadPair && unit === "percent" ? series.find((s) => s.id === spreadPair.fixed) : undefined
  const variableSeries = spreadPair && unit === "percent" ? series.find((s) => s.id === spreadPair.variable) : undefined
  const spread =
    fixedSeries && variableSeries && at !== undefined
      ? (() => {
          const a = valueAt(fixedSeries, at)
          const b = valueAt(variableSeries, at)
          return a === null || b === null ? null : (a - b) * 100
        })()
      : null

  const ticks = flat ? [flatValue] : [lo, (lo + hi) / 2, hi]
  const tipLeft = at === undefined ? 0 : Math.min(Math.max(((x(at)) / W) * 100, 18), 82)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4" style={{ background: COLORS[s.color] }} />
              {s.label}
            </span>
          ))}
        </div>
        <div className="flex gap-1" role="group" aria-label="Range">
          {RANGE_LABELS.map(([value, text]) => (
            <button
              key={value}
              type="button"
              aria-pressed={range === value}
              onClick={() => onRangeChange(value)}
              className="rounded-md border border-border px-2 py-1 text-xs aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {stale && !empty && latestAt !== null ? (
        <p role="status" className="rounded-md bg-accent px-3 py-2 text-xs text-accent-foreground">
          {`History is ${ageH} h old`}
        </p>
      ) : null}
      {empty ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No history yet</p>
      ) : (
        <div className="relative min-w-0">
          <svg
            data-testid="chart-plot"
            role="img"
            aria-label={label}
            aria-describedby={tipId}
            tabIndex={0}
            viewBox={`0 0 ${W} ${H}`}
            className="block h-auto w-full max-w-full rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]"
            onFocus={() => setActive((a) => a ?? latestIdx)}
            onBlur={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
            onPointerMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect()
              if (box.width === 0 || times.length === 0) return
              const vx = ((e.clientX - box.left) / box.width) * W
              let best = 0
              for (let i = 1; i < times.length; i++) if (Math.abs(x(times[i]) - vx) < Math.abs(x(times[best]) - vx)) best = i
              setActive(best)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") setActive(Math.max(0, idx - 1))
              else if (e.key === "ArrowRight") setActive(Math.min(times.length - 1, idx + 1))
              else if (e.key === "Home") setActive(0)
              else if (e.key === "End") setActive(times.length - 1)
              else return
              e.preventDefault()
            }}
          >
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={M.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="var(--ink-muted)">
                  {fmt(unit, t)}
                </text>
              </g>
            ))}
            {series.map((s) =>
              runs(s.points, x, y).map((run, i) =>
                run.length === 1 ? (
                  <circle key={`${s.id}${i}`} cx={run[0].x} cy={run[0].y} r={2} fill={COLORS[s.color]} />
                ) : (
                  <path
                    key={`${s.id}${i}`}
                    data-series={s.id}
                    d={pathOf(run)}
                    fill="none"
                    stroke={COLORS[s.color]}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ),
              ),
            )}
            {active !== null && at !== undefined ? (
              <g pointerEvents="none">
                <line x1={x(at)} x2={x(at)} y1={M.t} y2={H - M.b} stroke="var(--line-strong)" strokeDasharray="3 3" />
                {series.map((s) => {
                  const v = valueAt(s, at)
                  return v === null ? null : <circle key={s.id} cx={x(at)} cy={y(v)} r={3.5} fill={COLORS[s.color]} />
                })}
              </g>
            ) : null}
          </svg>
          <div
            id={tipId}
            role="tooltip"
            hidden={active === null}
            className="pointer-events-none absolute top-0 z-10 w-max max-w-[min(14rem,80%)] -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            style={{ left: `${tipLeft}%` }}
          >
            {at !== undefined ? (
              <>
                <p className="mb-1 text-muted-foreground">
                  {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(at * 1000))}{" UTC"}
                </p>
                {series.map((s) => {
                  const v = valueAt(s, at)
                  return (
                    <p key={s.id} className="flex justify-between gap-4">
                      <span>{s.label}</span>
                      <span className="tabular-nums">{v === null ? "no data" : fmt(unit, v)}</span>
                    </p>
                  )
                })}
                {spread !== null ? (
                  <p className="mt-1 flex justify-between gap-4 border-t border-border pt-1">
                    <span>Fixed premium</span>
                    <span className="tabular-nums">{`${spread >= 0 ? "+" : "-"}${Math.abs(spread).toFixed(2)} pts`}</span>
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
