"use client"

import { useId, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AmountField } from "@/components/app/actions/amount-field"
import type { PreviewLine } from "@/components/app/actions/panel-config"
import { PreviewList } from "@/components/app/actions/preview-lines"
import { TxNoticeView } from "@/components/app/actions/tx-feedback"
import { UNAVAILABLE } from "@/components/app/live"
import { RouteFlow } from "@/components/app/route/route-flow"
import { routeNote } from "@/components/app/trade/route-note"
import { TokenPicker, type PayToken } from "@/components/app/trade/token-picker"
import { useTradeRoute } from "@/components/app/trade/use-trade-route"
import { useManifest } from "@/components/app/manifest-provider"
import { STALE, useGateContext } from "@/hooks/use-gate-context"
import { useSettings } from "@/hooks/use-settings"
import { checkAmount } from "@/lib/app/amounts"
import type { TxNotice } from "@/lib/app/tx-notice"
import { formatBps, formatGainLoss, formatPercent, formatTokenAmount, formatUsdCents } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { formatImpact } from "@/lib/protocol/prices"
import type { TradeQuote, TradeRequest, TradeToken } from "@/lib/protocol/trade-adapter"

export type PtSide = "buy" | "sell"

/** Every Principal token (SY, PT, YT, LP) has 7 decimals; PT is in USD (oracle units). */
const TOKEN_DECIMALS = 7

/**
 * The PT tab (spec 0002 §3): buy or sell PT, paying or receiving the underlying (a multi-step
 * route today) or its SY (one step), on the trade adapter (R2-55) and the route runner. The details
 * show the fixed APY before → after the trade, the effective fixed APY, the fee, the minimum
 * received and the payoff at maturity, fixed in USD.
 *
 * One `RouteFlow` serves both sides, so a route started on one side (or resumed from History)
 * stays on screen when the side changes. The amounts reset once a step reaches the network (R2-3).
 * After maturity the trade panel hosts 0001's Redeem panel in this tab's place.
 */
export function PtTab({ marketId, side }: { marketId: string; side: PtSide }) {
  const baseId = useId()
  const market = getMarket(useManifest(), marketId)
  const { slippageBps } = useSettings()
  const gate = useGateContext(marketId)
  const [texts, setTexts] = useState<Record<PtSide, string>>({ buy: "", sell: "" })
  const [touched, setTouched] = useState<Record<PtSide, boolean>>({ buy: false, sell: false })
  // The picker defaults to the underlying (R2-50): on "You pay" for a buy, on "You receive" for a sale.
  const [tokens, setTokens] = useState<Record<PtSide, PayToken>>({ buy: "underlying", sell: "underlying" })
  const [last, setLast] = useState<{ owner: string; notice: TxNotice } | null>(null)

  const code = market?.underlying.code ?? "USDY"
  const underlyingDecimals = market?.underlying.decimals ?? TOKEN_DECIMALS
  const token = tokens[side]
  const decimalsOf = (t: TradeToken) => (t === "underlying" ? underlyingDecimals : TOKEN_DECIMALS)
  const unitOf = (t: TradeToken) => (t === "underlying" ? code : t.toUpperCase())
  const amountText = (raw: bigint, t: TradeToken) => `${formatTokenAmount(raw, decimalsOf(t), true)} ${unitOf(t)}`

  // --- The amount (0001's field and checks: the hostile-input rules hold here too).
  const payToken: TradeToken = side === "buy" ? token : "pt"
  const { account, ms } = gate
  const balance = account ? (payToken === "pt" ? account.pt : payToken === "sy" ? account.sy : account.underlying) : undefined
  const text = texts[side]
  const check = checkAmount(text, { decimals: decimalsOf(payToken), unit: unitOf(payToken), balance })
  const fieldError = !check.ok && (text.trim() !== "" || touched[side]) ? check.message : undefined

  // R2-21: a buy pays with the picked token (its `receive` is ignored), a sale receives it.
  const trade: TradeRequest = { kind: side === "buy" ? "buy_pt" : "sell_pt", amount: check.ok ? check.raw : 0n, pay: token, receive: token }
  const route = useTradeRoute({ marketId, gate, trade, check })
  const q = route.quote?.status === "live" ? route.quote.value : undefined
  const swapExact = q ? (q.swapOut ?? q).exactness === "simulated" : false
  const steps = route.plans.length

  const owner = JSON.stringify(gate.wallet)
  const reset = () => {
    setTexts({ buy: "", sell: "" })
    setTouched({ buy: false, sell: false })
  }

  if (!market) return null

  const picker = (label: string) => (
    <TokenPicker label={label} value={token} onChange={(t) => setTokens((all) => ({ ...all, [side]: t }))} options={["underlying", "sy"]} code={code} />
  )

  const details: PreviewLine[] = q ? detailLines(q, side, code, slippageBps, steps, amountText, unitOf) : []
  const note = routeNote({ plans: route.plans, q, connected: route.source !== null, pending: route.sim.pending })

  return (
    <Card className="@container">
      <CardHeader className="flex-col gap-1 @lg:flex-row @lg:gap-4">
        <CardTitle>{side === "buy" ? "Buy PT" : "Sell PT"}</CardTitle>
        <CardDescription>
          {side === "buy"
            ? `Each PT redeems for $1 of ${code} at maturity, so buying it below $1 fixes your return in USD.`
            : `Sell PT before maturity, for ${code} or its SY.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <AmountField
          id={`${baseId}-pay`}
          spec={{ id: "amount", label: "You pay", unit: unitOf(payToken) }}
          text={text}
          error={fieldError}
          balance={balance}
          decimals={decimalsOf(payToken)}
          picker={side === "buy" ? picker("Pay with") : undefined}
          onChange={(next) => {
            setTexts((all) => ({ ...all, [side]: next }))
            setTouched((all) => ({ ...all, [side]: true }))
          }}
          onBlur={() => setTouched((all) => ({ ...all, [side]: true }))}
        />

        <div className="grid gap-1.5">
          <span id={`${baseId}-receive`} className="text-sm leading-none font-medium text-ink">
            You receive (preview)
          </span>
          {side === "sell" ? <div className="flex min-w-0 flex-wrap items-center gap-2">{picker("Receive as")}</div> : null}
          <output
            aria-labelledby={`${baseId}-receive`}
            className="flex min-h-9 items-center rounded-md border border-line bg-surface-sunk px-3 py-1.5 font-mono text-sm text-ink tabular-nums wrap-anywhere"
          >
            {q ? amountText(q.out, q.outToken) : route.quote ? UNAVAILABLE : null}
          </output>
          {q && q.valueToday !== undefined ? (
            <p className="text-xs text-ink-muted">{`Worth about ${amountText(q.valueToday, "underlying")} today, at the pool's price.`}</p>
          ) : null}
          {q && q.swapOut ? (
            <p className="text-xs text-ink-muted">{`Indicative: the steps after step ${q.swapOut.step} turn its ${unitOf(q.swapOut.token)} into ${unitOf(q.outToken)} at today's rate.`}</p>
          ) : null}
        </div>

        <section aria-label="Trading details" className="grid gap-2">
          {!ms ? (
            gate.marketStatus === "loading" ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <p className="text-sm text-ink">
                {gate.marketStatus === "stale" ? `${STALE}.` : "Unavailable: this market's data could not be read."} No preview is shown.
              </p>
            )
          ) : route.quote?.status === "unavailable" ? (
            <p className="text-sm text-ink wrap-anywhere">{`${UNAVAILABLE}: ${route.quote.error}`}</p>
          ) : q ? (
            <>
              <p className="label">{swapExact ? (q.swapOut ? `Step ${q.swapOut.step} exact (simulated)` : "Exact (simulated)") : "Indicative"}</p>
              <PreviewList lines={details} />
              {q.payoff ? (
                <div className="grid gap-1 rounded-lg border border-line p-3">
                  <p className="text-sm font-medium text-ink">
                    {`At maturity: ${formatUsdCents(q.payoff.gainUsd, TOKEN_DECIMALS)} (${formatPercent(q.payoff.pct)}), fixed in USD whatever ${code}'s price does.`}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {`About ${formatGainLoss(q.payoff.gainUnderlying, underlyingDecimals, 4, { group: true })} ${code} at today's ${code} price (indicative). Counted in ${code}, this falls as ${code}'s price rises, so only the USD figure is fixed.`}
                  </p>
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-ink-muted">Enter an amount to see the trade&apos;s details.</p>
          )}
          {note ? <p className="text-xs text-ink-muted">{note}</p> : null}
        </section>

        <RouteFlow
          account={route.source}
          marketId={marketId}
          gate={route.gate}
          request={route.request}
          kind={trade.kind}
          plans={route.plans}
          canStart={route.canStart}
          blockers={route.blockers}
          onNotice={(notice) => setLast({ owner, notice })}
          onReachedNetwork={reset}
        />

        {last && last.owner === owner ? <TxNoticeView notice={last.notice} /> : null}
      </CardContent>
    </Card>
  )
}

function detailLines(
  q: TradeQuote,
  side: PtSide,
  code: string,
  slippageBps: bigint,
  steps: number,
  amountText: (raw: bigint, t: TradeToken) => string,
  unitOf: (t: TradeToken) => string,
): PreviewLine[] {
  const slippage = formatBps(slippageBps)
  const lines: PreviewLine[] = [
    {
      label: "Fixed APY",
      value: `${formatPercent(q.apyBefore)} → ${formatPercent(q.apyAfter)}`,
      hint:
        side === "buy"
          ? "The pool's fixed APY now, and once your trade lands: buying PT raises its price, so the fixed APY falls."
          : "The pool's fixed APY now, and once your trade lands: selling PT lowers its price, so the fixed APY rises.",
    },
  ]
  if (side === "buy") {
    lines.push({
      label: "Your effective fixed APY",
      value: q.effectiveApy === undefined ? UNAVAILABLE : formatPercent(q.effectiveApy),
      hint: `What you lock in: the PT you receive against what you pay, valued in USD at today's ${code} oracle rate.`,
    })
  }
  if (q.swapOut) {
    lines.push({
      label: `${unitOf(q.swapOut.token)} from step ${q.swapOut.step}`,
      value: amountText(q.swapOut.amount, q.swapOut.token),
      hint: q.swapOut.exactness === "simulated" ? "Simulated as your account." : `Indicative until step ${q.swapOut.step} is simulated as your account.`,
    })
  }
  lines.push(
    {
      label: "Price impact",
      value: q.priceImpactPpm === undefined ? UNAVAILABLE : formatImpact(q.priceImpactPpm),
      hint: "Your price against the pool's spot price, swap fee included.",
    },
    { label: "Fees", value: amountText(q.fee, q.feeToken), hint: "The pool's swap fee, taken from the trade." },
    {
      label: "Minimum received",
      value: amountText(q.minOut, q.minOutToken),
      hint: q.swapOut
        ? `Step ${q.swapOut.step}'s minimum, in ${unitOf(q.minOutToken)}, at your ${slippage} slippage tolerance. The steps after it get their own minimums when they are prepared.`
        : steps > 1
          ? `At your ${slippage} slippage tolerance, on this preview. Each step is signed with its own minimum, from a fresh simulation once the step before it is confirmed.`
          : `Signed into the transaction at your ${slippage} slippage tolerance: it fails rather than give less.`,
    },
  )
  return lines
}
