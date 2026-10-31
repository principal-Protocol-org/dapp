import { formatAmount } from "@/lib/protocol/format"
import type { MarketState } from "@/lib/protocol/market-state"
import { poolValueInUnderlying } from "@/lib/protocol/yield"
import { UNAVAILABLE } from "@/components/app/live"

export type Liquidity = { kind: "value"; value: bigint } | { kind: "none" } | { kind: "unavailable" }

/** Estimated pool value in underlying (R34): "none" for an unseeded pool, "unavailable" if any input is. */
export function liquidityOf(ms: MarketState): Liquidity {
  const { poolSeeded, poolState, exchangeRate, ptPrice, oracleRate } = ms
  if (poolSeeded.status === "unavailable") return { kind: "unavailable" }
  if (!poolSeeded.value) return { kind: "none" }
  if (poolState.status === "unavailable" || exchangeRate.status === "unavailable") return { kind: "unavailable" }
  if (ptPrice.status === "unavailable" || oracleRate.status === "unavailable") return { kind: "unavailable" }
  const value = poolValueInUnderlying({
    syReserve: poolState.value.syReserve,
    ptReserve: poolState.value.ptReserve,
    exchangeRate: exchangeRate.value,
    ptPrice: ptPrice.value,
    oracleRate: oracleRate.value,
  })
  return value === null ? { kind: "unavailable" } : { kind: "value", value }
}

/** Estimated pool value in underlying (R34). Unavailable if any input is, or the pool is unseeded. */
export function liquidityText(ms: MarketState, decimals: number, code: string, withNote = false): string {
  const l = liquidityOf(ms)
  if (l.kind === "unavailable") return UNAVAILABLE
  if (l.kind === "none") return "No liquidity yet"
  return `≈ ${formatAmount(l.value, decimals)} ${code}${withNote ? ", PT at pool price" : ""}`
}
