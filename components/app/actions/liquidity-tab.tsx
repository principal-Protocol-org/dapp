"use client"

import { showLive } from "@/components/app/live"
import type { PanelConfig, PreviewLine, ReaderFor } from "@/components/app/actions/panel-config"
import { PanelGroup, usePanels, type PanelEntry } from "@/components/app/actions/panel-group"
import { outputOf, plain, tokens } from "@/components/app/actions/panel-lines"
import { formatFeeRate } from "@/lib/protocol/format"
import type { MarketState, PoolStateView } from "@/lib/protocol/market-state"
import { previewAddLiquidity, previewAddLiquiditySingleSy, previewRemoveLiquidity } from "@/lib/protocol/previews"
import { quoteSyForPt, zapSwapAmount } from "@/lib/protocol/quotes"
import { allLive, createRpcReader } from "@/lib/protocol/reader"
import type { Manifest, Market } from "@/lib/protocol/types"

/**
 * The Liquidity tab (spec §6): add PT + SY in the pool's ratio, add from SY alone (the pool swaps
 * part of it into PT), and remove. The pool pays LPs no fee share (spec), hence the note.
 */

export const LP_NOTE = "LPs earn PT convergence; swap fees go to the protocol and the market creator."

const LEFTOVER = "Leftover (stays in your wallet)"
const LEFTOVER_HINT = "Only the amounts matching the pool's ratio are taken; the rest never leaves your wallet."

/** Reserves and LP supply from one `pool_state` read, so they are consistent with each other. */
const reservesOf = (p: PoolStateView) => ({ pt: p.ptReserve, sy: p.syReserve })

const poolLines = (ms: MarketState): PreviewLine[] => [
  { label: "Pool reserves", value: showLive(ms.poolState, (p) => `${tokens(p.ptReserve, "PT")} + ${tokens(p.syReserve, "SY")}`) },
  { label: "LP total supply", value: showLive(ms.poolState, (p) => tokens(p.totalLp, "LP")) },
]

/** What a two-sided add does not take. */
function leftover(pt: bigint, sy: bigint): string {
  const parts = [...(pt > 0n ? [tokens(pt, "PT")] : []), ...(sy > 0n ? [tokens(sy, "SY")] : [])]
  return parts.length > 0 ? parts.join(" + ") : "None"
}

export function addLiquidityPanel(): PanelConfig {
  return {
    action: "add_liquidity",
    fields: [
      { id: "amount", label: "PT to add", unit: "PT" },
      { id: "secondaryAmount", label: "SY to add", unit: "SY" },
    ],
    description: "Add PT and SY to the pool in its current ratio, for LP tokens.",
    indicative(ms, { amount, secondaryAmount }) {
      if (amount === undefined || secondaryAmount === undefined) return []
      const p = allLive([ms.poolState] as const, ([pool]) => previewAddLiquidity(amount, secondaryAmount, reservesOf(pool), pool.totalLp))
      return [
        { label: "LP received", value: showLive(p, (v) => tokens(v.lp, "LP")) },
        { label: "PT used", value: showLive(p, (v) => tokens(v.ptUsed, "PT")) },
        { label: "SY used", value: showLive(p, (v) => tokens(v.syUsed, "SY")) },
        { label: LEFTOVER, value: showLive(p, (v) => leftover(amount - v.ptUsed, secondaryAmount - v.syUsed)), hint: LEFTOVER_HINT },
      ]
    },
    market: poolLines,
    exact(output, { inputs: { amount, secondaryAmount } }) {
      const o = outputOf(output, "add_liquidity")
      const lines: PreviewLine[] = [
        { label: "LP received", value: tokens(o.lp, "LP") },
        { label: "PT used", value: tokens(o.pt_used, "PT") },
        { label: "SY used", value: tokens(o.sy_used, "SY") },
      ]
      if (amount !== undefined && secondaryAmount !== undefined) {
        lines.push({ label: LEFTOVER, value: leftover(amount - o.pt_used, secondaryAmount - o.sy_used), hint: LEFTOVER_HINT })
      }
      return lines
    },
    floors: { minOut: { label: "Minimum LP received", unit: "LP" } },
    notes: () => [LP_NOTE],
    result(output) {
      const o = outputOf(output, "add_liquidity")
      return `You added ${plain(o.pt_used)} PT and ${plain(o.sy_used)} SY and received ${plain(o.lp)} LP.`
    },
  }
}

export function addLiquiditySyPanel(market: Market, reader: ReaderFor): PanelConfig {
  const pool = market.contracts.pool
  return {
    action: "add_liquidity_sy",
    fields: [{ id: "amount", label: "SY to add", unit: "SY" }],
    description: "Add liquidity from SY alone: the pool swaps part of it into PT, paying the swap fee, and adds both.",
    indicative: () => [],
    async quote(ms, { amount }) {
      if (amount === undefined) return []
      if (ms.poolState.status === "unavailable") throw new Error(`the pool could not be read (${ms.poolState.error})`)
      const state = ms.poolState.value
      const r = reader()
      const split = await zapSwapAmount(r, pool, amount)
      const q = await quoteSyForPt(r, pool, split)
      const p = previewAddLiquiditySingleSy(amount, split, { ptOut: q.amountOut, feeShares: q.feeShares }, reservesOf(state), state.totalLp)
      const lines: PreviewLine[] = [
        { label: "SY swapped to PT", value: tokens(split, "SY"), hint: "zap_swap_amount: the swap that leaves the deposit in the pool's ratio." },
        { label: "LP received", value: tokens(p.lp, "LP") },
        { label: "SY used", value: tokens(p.syUsed, "SY") },
      ]
      if (p.ptRefund > 0n) lines.push({ label: "PT refunded", value: tokens(p.ptRefund, "PT"), hint: "PT bought but not added, sent back to you." })
      if (p.syKept > 0n) lines.push({ label: "SY kept", value: tokens(p.syKept, "SY"), hint: "Never leaves your wallet." })
      return lines
    },
    market: (ms) => [
      ...poolLines(ms),
      { label: "Swap fee rate", value: showLive(ms.swapFeeRate, formatFeeRate), hint: "Paid on the part swapped into PT." },
    ],
    exact(output, { inputs: { amount } }) {
      const o = outputOf(output, "add_liquidity")
      const lines: PreviewLine[] = [
        { label: "LP received", value: tokens(o.lp, "LP") },
        { label: "SY used", value: tokens(o.sy_used, "SY") },
        { label: "PT added from the swap", value: tokens(o.pt_used, "PT") },
      ]
      if (amount !== undefined && amount > o.sy_used) lines.push({ label: "SY kept", value: tokens(amount - o.sy_used, "SY") })
      return lines
    },
    floors: { minOut: { label: "Minimum LP received", unit: "LP" } },
    notes: () => [LP_NOTE],
    result(output) {
      const o = outputOf(output, "add_liquidity")
      return `You added ${plain(o.sy_used)} SY, part of it swapped to PT, and received ${plain(o.lp)} LP.`
    },
  }
}

export function removeLiquidityPanel(): PanelConfig {
  return {
    action: "remove_liquidity",
    fields: [{ id: "amount", label: "LP to remove", unit: "LP" }],
    description: "Burn LP tokens for your share of the pool's PT and SY.",
    indicative(ms, { amount }) {
      if (amount === undefined) return []
      const p = allLive([ms.poolState] as const, ([pool]) => previewRemoveLiquidity(amount, reservesOf(pool), pool.totalLp))
      return [
        { label: "PT received", value: showLive(p, (v) => tokens(v.pt, "PT")) },
        { label: "SY received", value: showLive(p, (v) => tokens(v.sy, "SY")) },
      ]
    },
    market: poolLines,
    exact(output) {
      const o = outputOf(output, "remove_liquidity")
      return [
        { label: "PT received", value: tokens(o.pt, "PT") },
        { label: "SY received", value: tokens(o.sy, "SY") },
      ]
    },
    floors: { minOut: { label: "Minimum PT received", unit: "PT" }, minOut2: { label: "Minimum SY received", unit: "SY" } },
    notes: () => ["Removing liquidity stays open after maturity, even if the pool is paused."],
    result(output, { input }) {
      const o = outputOf(output, "remove_liquidity")
      return `You removed ${plain(input.amount)} LP and received ${plain(o.pt)} PT and ${plain(o.sy)} SY.`
    },
  }
}

const liquidityPanels = (market: Market, manifest: Manifest): PanelEntry[] => [
  { id: "add_liquidity", label: "Add PT + SY", config: addLiquidityPanel() },
  { id: "add_liquidity_sy", label: "Add SY only", config: addLiquiditySyPanel(market, () => createRpcReader(manifest)) },
  { id: "remove_liquidity", label: "Remove", config: removeLiquidityPanel() },
]

export function LiquidityTab({ marketId, initialPanel }: { marketId: string; initialPanel?: string }) {
  const panels = usePanels(marketId, liquidityPanels)
  return <PanelGroup label="Liquidity" marketId={marketId} panels={panels} requestedId={initialPanel} />
}
