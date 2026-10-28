import { Badge } from "@/components/ui/badge"

/** `loading`: the data the status needs has not answered yet (display only; never from a failure). */
export type MarketStatus = "live" | "matured" | "settled" | "paused" | "unavailable" | "loading"

const LABEL: Record<MarketStatus, string> = {
  live: "Live",
  matured: "Matured",
  settled: "Settled",
  paused: "Paused",
  unavailable: "Unavailable",
  loading: "Loading",
}
const VARIANT = { live: "live", matured: "soon", settled: "neutral", paused: "paused", unavailable: "dev", loading: "dev" } as const

export function StatusBadge({ status }: { status: MarketStatus }) {
  return <Badge status={VARIANT[status]}>{LABEL[status]}</Badge>
}
