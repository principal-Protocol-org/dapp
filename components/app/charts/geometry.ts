import type { Series } from "@/lib/app/history-types"

export type Pt = { x: number; y: number }

/** Splits a series into runs of consecutive non-null points: a null breaks the line (never interpolated). */
export function runs(points: Series, x: (at: number) => number, y: (v: number) => number): Pt[][] {
  const out: Pt[][] = []
  let cur: Pt[] = []
  for (const p of points) {
    if (p.value === null) {
      if (cur.length) out.push(cur)
      cur = []
    } else cur.push({ x: x(p.at), y: y(p.value) })
  }
  if (cur.length) out.push(cur)
  return out
}

export function pathOf(run: Pt[]): string {
  return run.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")
}
