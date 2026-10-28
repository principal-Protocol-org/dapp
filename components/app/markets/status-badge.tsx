import { Badge } from "@/components/ui/badge"

export type MarketStatus = "live" | "matured" | "settled" | "paused" | "unavailable"

const LABEL: Record<MarketStatus, string> = {
  live: "Live",
  matured: "Matured",
  settled: "Settled",
  paused: "Paused",
  unavailable: "Unavailable",
}
const VARIANT = { live: "live", matured: "soon", settled: "neutral", paused: "paused", unavailable: "dev" } as const

export function StatusBadge({ status }: { status: MarketStatus }) {
  return <Badge status={VARIANT[status]}>{LABEL[status]}</Badge>
}
