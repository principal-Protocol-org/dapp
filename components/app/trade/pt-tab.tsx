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
import { TokenPicker, type PayToken } from "@/components/app/trade/token-picker"
import { useTradeRoute } from "@/components/app/trade/use-trade-route"
import { useManifest } from "@/components/app/manifest-provider"
import { STALE, useGateContext } from "@/hooks/use-gate-context"
import { useSettings } from "@/hooks/use-settings"
import { checkAmount } from "@/lib/app/amounts"
import type { TxNotice } from "@/lib/app/tx-notice"
import { formatAmount, formatBps, formatPercent, formatTokenAmount } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { formatImpact } from "@/lib/protocol/prices"
import type { TradeQuote, TradeRequest, TradeToken } from "@/lib/protocol/trade-adapter"

export type PtSide = "buy" | "sell"

/** Every Principal token (SY, PT, YT, LP) has 7 decimals; the underlying's come from the manifest. */
const TOKEN_DECIMALS = 7
/** PT is denominated in USD (oracle units, 7 decimals): one cent is 10^5 raw units. */
const CENT = 100_000n

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** A USD gain or loss to the cent, signed: a gain is never overstated, a loss never understated. */
function usd(raw: bigint): string {
  const negative = raw < 0n
  const abs = negative ? -raw : raw
  const cents = negative ? (abs + CENT - 1n) / CENT : abs / CENT
  return `${negative ? "−" : "+"}$${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, "0")}`
}

/** Spec §3's payoff ratio: two decimals and a spaced percent sign ("5.26 %"). */
const payoffPct = (pct: number) => `${(pct * 100).toFixed(2).replace("-", "−")} %`

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

  const details: PreviewLine[] = q ? detailLines(q, side, code, slippageBps, steps, amountText) : []
  const note = routeNote({ side, token, code, steps, exact: swapExact, connected: route.source !== null, pending: route.sim.pending })

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
            <p className="text-xs text-ink-muted">{`Indicative: step 2 withdraws step 1's SY to ${code} at today's SY rate.`}</p>
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
              <p className="label">{swapExact ? (q.swapOut ? "Step 1 exact (simulated)" : "Exact (simulated)") : "Indicative"}</p>
              <PreviewList lines={details} />
              {q.payoff ? (
                <div className="grid gap-1 rounded-lg border border-line p-3">
                  <p className="text-sm font-medium text-ink">
                    {`At maturity: ${usd(q.payoff.gainUsd)} (${payoffPct(q.payoff.pct)}), fixed in USD whatever ${code}'s price does.`}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {`About ${formatAmount(q.payoff.gainUnderlying, underlyingDecimals, 4, { group: true })} ${code} at today's ${code} price (indicative). Counted in ${code}, this falls as ${code}'s price rises, so only the USD figure is fixed.`}
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
      label: "SY from step 1",
      value: amountText(q.swapOut.amount, q.swapOut.token),
      hint: q.swapOut.exactness === "simulated" ? "Simulated as your account." : "Indicative until step 1 is simulated as your account.",
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
      hint:
        steps > 1
          ? side === "buy"
            ? `At your ${slippage} slippage tolerance, on this preview. Step 2 is signed with its own minimum, from a fresh simulation once step 1 is confirmed.`
            : `Step 1's minimum, in SY, at your ${slippage} slippage tolerance. Step 2 gets its own minimum in ${code} when it is prepared.`
          : `Signed into the transaction at your ${slippage} slippage tolerance: it fails rather than give less.`,
    },
  )
  return lines
}

/** The route in plain words, and which figures are exact (R2-55). */
function routeNote(p: { side: PtSide; token: PayToken; code: string; steps: number; exact: boolean; connected: boolean; pending: boolean }): string | null {
  const { side, token, code, steps, exact, connected, pending } = p
  if (steps === 0) return null
  const signatures = `${steps} ${steps === 1 ? "signature" : "signatures"}`
  const pendingSim = !connected
    ? "connect a wallet for an exact quote."
    : pending
      ? "getting an exact quote…"
      : "the exact quote comes from simulating it as your account."
  if (side === "buy" && token === "underlying") {
    return `Paying in ${code} takes ${signatures}: step 1 deposits your ${code} into SY, step 2 swaps that SY for PT. The PT figures are indicative, from this app's copy of the pool's math on its current state: step 2 gets its exact amount and minimum from its own simulation once step 1 is confirmed.`
  }
  if (side === "buy") {
    return `Paying in SY takes ${signatures}. ${exact ? "The figures are exact: the swap was simulated as your account." : `The figures are indicative until the swap is simulated: ${pendingSim}`}`
  }
  const swap = exact ? "The SY from step 1 is exact (simulated)" : `The SY from step 1 is indicative until it is simulated (${pendingSim.replace(/\.$/, "")})`
  if (token === "underlying") {
    return `Receiving ${code} takes ${signatures}: step 1 sells your PT for SY, step 2 withdraws that SY to ${code}. ${swap}; the ${code} is worked out at today's SY rate, and step 2 gets its own minimum when it is prepared.`
  }
  return `Receiving SY takes ${signatures}. ${exact ? "The figures are exact: the sale was simulated as your account." : `The figures are indicative until the sale is simulated: ${pendingSim}`}`
}
