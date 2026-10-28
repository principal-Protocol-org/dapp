"use client"

import { showLive } from "@/components/app/live"
import type { PanelConfig, PreviewLine } from "@/components/app/actions/panel-config"
import { PanelGroup, usePanels, type PanelEntry } from "@/components/app/actions/panel-group"
import { amountOf, outputOf, plain, tokens } from "@/components/app/actions/panel-lines"
import { formatFeeRate, formatRate } from "@/lib/protocol/format"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { MarketState } from "@/lib/protocol/market-state"
import { FEE_RATE_SCALE, ceilDiv } from "@/lib/protocol/math"
import { previewBuyYt, previewMint, previewSellYt } from "@/lib/protocol/previews"
import { effectivePrice, formatImpact, priceImpactPpm, ptSpot, spotAtScale, ytSpot, type Spot } from "@/lib/protocol/prices"
import { quoteBuyExactPt, quotePtForSy, quoteSyForPt } from "@/lib/protocol/quotes"
import { allLive, createRpcReader } from "@/lib/protocol/reader"
import type { Live, Market } from "@/lib/protocol/types"

/**
 * The Trade tab (spec §6): buy and sell PT against the pool, and buy and sell YT through the
 * Router's flash-mint and the pool's flash-redeem. Indicative previews read the pool's quote views;
 * the market section (R38) compares the exact quote with the pool's spot price.
 */

type Token = "PT" | "YT"

const reader = () => createRpcReader(activeManifest())

/** One PT or YT in SY at the pool's spot: `pt_price` at the rate the pool values SY with. */
const spotOf = (ms: MarketState, token: Token): Live<Spot> =>
  allLive([ms.ptPrice, ms.poolState] as const, ([price, pool]) => (token === "PT" ? ptSpot(price, pool.rate) : ytSpot(price, pool.rate)))

function spotLine(ms: MarketState, token: Token): PreviewLine {
  return {
    label: `${token} price (pool spot)`,
    value: showLive(allLive([spotOf(ms, token)] as const, ([s]) => spotAtScale(s)), (v) => `${formatRate(v)} SY per ${token}`),
    hint:
      token === "PT"
        ? "The pool's pt_price (notional value per PT), in SY at the oracle rate."
        : "1 − the pool's pt_price, since PT + YT recombine into one notional unit; in SY at the oracle rate.",
  }
}

const feeRateLine = (ms: MarketState): PreviewLine => ({
  label: "Swap fee rate",
  value: showLive(ms.swapFeeRate, formatFeeRate),
  hint: "Falls to 0 at maturity. Swap fees go to the protocol and the market creator.",
})

/** `sy` paid for (buy) or received for (sell) `tokenAmount` tokens, against the spot price. */
const impactLine = (spot: Live<Spot>, side: "buy" | "sell", sy: bigint, tokenAmount: bigint): PreviewLine => ({
  label: "Price impact",
  value: showLive(allLive([spot] as const, ([s]) => priceImpactPpm(side, sy, tokenAmount, s)), formatImpact),
  hint: "Your price against the pool's spot price, swap fee included.",
})

const priceLine = (sy: bigint, tokenAmount: bigint, token: Token): PreviewLine => ({
  label: "Effective price",
  value: `${formatRate(effectivePrice(sy, tokenAmount))} SY per ${token}`,
})

export function buyPtPanel(market: Market): PanelConfig {
  const pool = market.contracts.pool
  return {
    action: "buy_pt",
    fields: [{ id: "amount", label: "SY to spend", unit: "SY" }],
    description: "Buy PT with SY. Each PT redeems for one notional unit at maturity, so buying below it locks in a fixed return.",
    indicative: () => [],
    async quote(ms, { amount }) {
      if (amount === undefined) return []
      const q = await quoteSyForPt(reader(), pool, amount)
      return [
        { label: "PT received", value: tokens(q.amountOut, "PT") },
        { label: "Swap fee", value: tokens(q.feeShares, "SY") },
        impactLine(spotOf(ms, "PT"), "buy", amount, q.amountOut),
      ]
    },
    market(ms, { inputs: { amount }, output }) {
      const lines = [spotLine(ms, "PT")]
      if (amount !== undefined && output) lines.push(impactLine(spotOf(ms, "PT"), "buy", amount, amountOf(output)))
      if (amount !== undefined) {
        // calc_buy_pt takes ceil(sy_in · fee_rate / 1e12) from the SY in (market_pool:796).
        const fee = showLive(ms.swapFeeRate, (r) => tokens(ceilDiv(amount * r, FEE_RATE_SCALE), "SY"))
        lines.push({ label: "Swap fee", value: fee, hint: "Taken from the SY you spend, rounded up." })
      }
      lines.push(feeRateLine(ms))
      return lines
    },
    exact(output, { inputs: { amount } }) {
      const pt = amountOf(output)
      return [{ label: "PT received", value: tokens(pt, "PT") }, ...(amount !== undefined ? [priceLine(amount, pt, "PT")] : [])]
    },
    floors: { minOut: { label: "Minimum PT received", unit: "PT" } },
    result: (output, { input }) => `You bought ${plain(amountOf(output))} PT for ${plain(input.amount)} SY.`,
  }
}

export function sellPtPanel(market: Market): PanelConfig {
  const pool = market.contracts.pool
  return {
    action: "sell_pt",
    fields: [{ id: "amount", label: "PT to sell", unit: "PT" }],
    description: "Sell PT for SY before maturity.",
    indicative: () => [],
    async quote(ms, { amount }) {
      if (amount === undefined) return []
      const q = await quotePtForSy(reader(), pool, amount)
      return [
        { label: "SY received", value: tokens(q.amountOut, "SY") },
        { label: "Swap fee", value: tokens(q.feeShares, "SY") },
        impactLine(spotOf(ms, "PT"), "sell", q.amountOut, amount),
      ]
    },
    market(ms, { inputs: { amount }, output }) {
      const lines = [spotLine(ms, "PT")]
      if (amount !== undefined && output) lines.push(impactLine(spotOf(ms, "PT"), "sell", amountOf(output), amount))
      lines.push(feeRateLine(ms))
      return lines
    },
    exact(output, { inputs: { amount } }) {
      const sy = amountOf(output)
      return [{ label: "SY received", value: tokens(sy, "SY") }, ...(amount !== undefined ? [priceLine(sy, amount, "PT")] : [])]
    },
    floors: { minOut: { label: "Minimum SY received", unit: "SY" } },
    result: (output, { input }) => `You sold ${plain(input.amount)} PT for ${plain(amountOf(output))} SY.`,
  }
}

export function buyYtPanel(market: Market): PanelConfig {
  const pool = market.contracts.pool
  return {
    action: "buy_yt",
    fields: [{ id: "amount", label: "SY to spend", unit: "SY" }],
    description:
      "Buy YT with SY in one step: your SY is minted into PT + YT, the PT is sold back to the pool, and you keep the YT and the SY the sale returns.",
    indicative: () => [],
    async quote(ms, { amount }) {
      if (amount === undefined) return []
      const reads = allLive([ms.oracleRate, ms.fees.tokenizationBps] as const, (values) => values)
      if (reads.status === "unavailable") throw new Error(`the oracle rate or the tokenization fee could not be read (${reads.error})`)
      const [oracle, bps] = reads.value
      // Router.swap_sy_for_yt mints first (previewMint), then sells every PT minted (router:347-363).
      const q = await quotePtForSy(reader(), pool, previewMint(amount, oracle, bps).pt)
      const p = previewBuyYt(amount, oracle, bps, q.amountOut)
      return [
        { label: "YT received", value: tokens(p.yt, "YT") },
        { label: "SY returned", value: tokens(p.syBack, "SY"), hint: "What the PT minted with your SY sells for." },
        { label: "Net cost", value: tokens(p.netCost, "SY") },
      ]
    },
    market(ms, { inputs: { amount }, output }) {
      const lines = [spotLine(ms, "YT")]
      if (amount !== undefined && output) {
        const o = outputOf(output, "buy_yt")
        lines.push(impactLine(spotOf(ms, "YT"), "buy", amount - o.sy_back, o.yt_out))
      }
      lines.push(feeRateLine(ms))
      return lines
    },
    exact(output, { inputs: { amount } }) {
      const o = outputOf(output, "buy_yt")
      return [
        { label: "YT received", value: tokens(o.yt_out, "YT") },
        { label: "SY returned", value: tokens(o.sy_back, "SY") },
        ...(amount !== undefined ? [{ label: "Net cost", value: tokens(amount - o.sy_back, "SY") }] : []),
      ]
    },
    floors: { minOut: { label: "Minimum YT received", unit: "YT" }, maxNetCost: { label: "Maximum net cost", unit: "SY" } },
    result(output, { input }) {
      const o = outputOf(output, "buy_yt")
      return `You bought ${plain(o.yt_out)} YT for a net ${plain(input.amount - o.sy_back)} SY (${plain(input.amount)} SY in, ${plain(o.sy_back)} SY returned).`
    },
  }
}

export function sellYtPanel(market: Market): PanelConfig {
  const pool = market.contracts.pool
  return {
    action: "sell_yt",
    fields: [{ id: "amount", label: "YT to sell", unit: "YT" }],
    description: "Sell YT for SY in one step: the pool buys as much PT, recombines it with your YT into SY, and pays you what is left.",
    indicative: () => [],
    async quote(ms, { amount }) {
      if (amount === undefined) return []
      if (ms.oracleRate.status === "unavailable") throw new Error(`the oracle rate could not be read (${ms.oracleRate.error})`)
      // The pool keeps quote_buy_exact_pt(yt).amount_in of the recombined SY (market_pool:353-369).
      const q = await quoteBuyExactPt(reader(), pool, amount)
      const sy = previewSellYt(amount, ms.oracleRate.value, q.amountIn)
      return [
        sy > 0n
          ? { label: "SY received", value: tokens(sy, "SY") }
          : { label: "SY received", value: tokens(sy, "SY"), hint: "The PT costs more than the SY recombined, so the pool would refuse this sale." },
      ]
    },
    market(ms, { inputs: { amount }, output }) {
      const lines = [spotLine(ms, "YT")]
      if (amount !== undefined && output) lines.push(impactLine(spotOf(ms, "YT"), "sell", amountOf(output), amount))
      lines.push(feeRateLine(ms))
      return lines
    },
    exact: (output) => [{ label: "SY received", value: tokens(amountOf(output), "SY") }],
    floors: { minOut: { label: "Minimum SY received", unit: "SY" } },
    result: (output, { input }) => `You sold ${plain(input.amount)} YT for ${plain(amountOf(output))} SY.`,
  }
}

const tradePanels = (market: Market): PanelEntry[] => [
  { id: "buy_pt", label: "Buy PT", config: buyPtPanel(market) },
  { id: "sell_pt", label: "Sell PT", config: sellPtPanel(market) },
  { id: "buy_yt", label: "Buy YT", config: buyYtPanel(market) },
  { id: "sell_yt", label: "Sell YT", config: sellYtPanel(market) },
]

export function TradeTab({ marketId }: { marketId: string }) {
  const panels = usePanels(marketId, tradePanels)
  return <PanelGroup label="Trade" marketId={marketId} panels={panels} />
}
