import { formatAmount } from "@/lib/protocol/format"
import type { MarketState } from "@/lib/protocol/market-state"
import { poolValueInUnderlying } from "@/lib/protocol/yield"
import { UNAVAILABLE } from "@/components/app/live"

/** Estimated pool value in underlying (R34). Unavailable if any input is, or the pool is unseeded. */
export function liquidityText(ms: MarketState, decimals: number, code: string, withNote = false): string {
  const { poolSeeded, poolState, exchangeRate, ptPrice, oracleRate } = ms
  if (poolSeeded.status === "unavailable") return UNAVAILABLE
  if (!poolSeeded.value) return "No liquidity yet"
  if (poolState.status === "unavailable" || exchangeRate.status === "unavailable") return UNAVAILABLE
  if (ptPrice.status === "unavailable" || oracleRate.status === "unavailable") return UNAVAILABLE
  const value = poolValueInUnderlying({
    syReserve: poolState.value.syReserve,
    ptReserve: poolState.value.ptReserve,
    exchangeRate: exchangeRate.value,
    ptPrice: ptPrice.value,
    oracleRate: oracleRate.value,
  })
  if (value === null) return UNAVAILABLE
  return `≈ ${formatAmount(value, decimals)} ${code}${withNote ? ", PT at pool price" : ""}`
}
