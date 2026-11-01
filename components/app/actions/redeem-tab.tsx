"use client"

import { showLive } from "@/components/app/live"
import type { PanelConfig, PreviewLine } from "@/components/app/actions/panel-config"
import { amountOf, outputOf, plain, tokens, withoutAccount } from "@/components/app/actions/panel-lines"
import { formatBps, formatRate } from "@/lib/protocol/format"
import { previewRedeemPt } from "@/lib/protocol/previews"
import { allLive } from "@/lib/protocol/reader"
import type { Market } from "@/lib/protocol/types"
import { pendingOf, settlementOf } from "@/lib/protocol/position"
import type { RedemptionRate } from "@/lib/protocol/yield"

/**
 * The 0001 claim and redeem panels (spec §6): claim YT yield (the Portfolio's Claim dialog) and
 * redeem PT and YT at maturity (the PT tab after maturity). Claim and redeem take no floor; the
 * previews say what fixes the amount. Recombining is the Quick action's route (R2-72).
 */

const BASIS_HINT: Record<RedemptionRate["basis"], string> = {
  settled: "Final: fixed when the market settled.",
  frozen: "Fixed: the YT yield index froze at maturity at this rate; the first redemption records it.",
  oracle: "Indicative — settles at the oracle rate of your redemption.",
}

export function claimPanel(market: Market): PanelConfig {
  const { code, decimals } = market.underlying
  return {
    action: "claim_yield",
    fields: [],
    description: `Collect the yield your YT has earned since your last claim, paid in ${code}. You keep your YT.`,
    indicative: () => [],
    marketLabel: "Your yield (indicative)",
    market(ms, ctx) {
      const { account } = ctx
      if (!account) return [{ label: "Pending yield", value: withoutAccount(ctx) }]
      const y = pendingOf(ms, account)
      const bps = ms.fees.ytBps
      return [
        { label: "Pending yield (gross)", value: showLive(y, (v) => tokens(v.gross, code, decimals)) },
        {
          label: "YT fee",
          value: showLive(y, (v) => tokens(v.fee, code, decimals)),
          ...(bps.status === "live" ? { hint: `${formatBps(bps.value)} of the yield, kept by the market.` } : {}),
        },
        { label: "You receive (net)", value: showLive(y, (v) => tokens(v.net, code, decimals)) },
      ]
    },
    exact: (output) => [{ label: "You receive", value: tokens(amountOf(output), code, decimals) }],
    result: (output) => `You claimed ${plain(amountOf(output), decimals)} ${code} of yield.`,
  }
}

export function redeemPanel(market: Market): PanelConfig {
  const { code, decimals } = market.underlying
  return {
    action: "redeem",
    fields: [
      { id: "amount", label: "PT to redeem", unit: "PT", optional: true },
      { id: "secondaryAmount", label: "YT to redeem", unit: "YT", optional: true },
    ],
    description: `At maturity, PT pays ${code} at the settlement rate and YT pays the yield it has left. Redeem either or both.`,
    indicative(ms, { amount: pt, secondaryAmount: yt }, ctx) {
      const { account } = ctx
      const lines: PreviewLine[] = []
      if (pt !== undefined && pt > 0n) {
        // PT is notional: underlying = previewRedeemPt(pt, settlement rate, exchange rate) (T6 note).
        const paid = allLive([settlementOf(ms), ms.exchangeRate] as const, ([s, x]) => previewRedeemPt(pt, s.rate, x))
        lines.push({ label: "From PT", value: showLive(paid, (v) => tokens(v, code, decimals)) })
      }
      if (yt !== undefined && yt > 0n) {
        lines.push({
          label: "From YT (net of the YT fee)",
          value: account ? showLive(pendingOf(ms, account), (v) => tokens(v.net, code, decimals)) : withoutAccount(ctx),
          hint: "Redeeming YT pays all the yield your YT has earned, net of the YT fee.",
        })
      }
      return lines
    },
    marketLabel: "Settlement",
    market(ms) {
      const s = settlementOf(ms)
      const hint = s.status === "live" ? { hint: BASIS_HINT[s.value.basis] } : {}
      return [{ label: "Settlement rate", value: showLive(s, (v) => formatRate(v.rate)), ...hint }]
    },
    exact(output, { inputs }) {
      const o = outputOf(output, "redeem")
      const lines: PreviewLine[] = []
      if ((inputs.amount ?? 0n) > 0n) lines.push({ label: "From PT", value: tokens(o.underlying_from_pt, code, decimals) })
      if ((inputs.secondaryAmount ?? 0n) > 0n) lines.push({ label: "From YT", value: tokens(o.underlying_from_yt, code, decimals) })
      lines.push({ label: "Total", value: tokens(o.underlying_from_pt + o.underlying_from_yt, code, decimals) })
      return lines
    },
    notes({ ms }) {
      if (!ms || ms.settledRate.status !== "live" || ms.settledRate.value !== null) return []
      if (ms.ytFrozen.status === "live" && ms.ytFrozen.value) return ["The first redemption records the settlement rate for everyone."]
      // Unsettled and unfrozen: the rate is the oracle's when the transaction lands; the oracle is
      // monotonic and the index keeps a high-water mark, so PT pays at most what was simulated.
      return [
        "The first redemption settles the market for everyone, at the oracle rate of that moment.",
        "Until the market is settled, the PT amount depends on the oracle rate when your transaction lands; it can only be lower than shown.",
      ]
    },
    result(output, { input }) {
      const o = outputOf(output, "redeem")
      const yt = input.secondaryAmount ?? 0n
      const parts = [...(input.amount > 0n ? [`${plain(input.amount)} PT`] : []), ...(yt > 0n ? [`${plain(yt)} YT`] : [])]
      return `You redeemed ${parts.join(" and ")} for ${plain(o.underlying_from_pt + o.underlying_from_yt, decimals)} ${code}.`
    },
  }
}
