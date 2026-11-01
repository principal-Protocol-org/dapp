"use client"

import { useId, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AmountField } from "@/components/app/actions/amount-field"
import type { PreviewLine } from "@/components/app/actions/panel-config"
import { PreviewList } from "@/components/app/actions/preview-lines"
import { TxNoticeView } from "@/components/app/actions/tx-feedback"
import { UNAVAILABLE } from "@/components/app/live"
import { ROUTE_HOSTS, RouteFlow } from "@/components/app/route/route-flow"
import { RouteResume } from "@/components/app/trade/route-resume"
import { LabelWithTip } from "@/components/app/info-tip"
import { routeNote, signaturesLine } from "@/components/app/trade/route-note"
import { TokenPicker, type PayToken } from "@/components/app/trade/token-picker"
import { useTradeRoute } from "@/components/app/trade/use-trade-route"
import { useManifest } from "@/components/app/manifest-provider"
import { STALE, useGateContext } from "@/hooks/use-gate-context"
import { useMatured } from "@/hooks/use-matured"
import { useSettings } from "@/hooks/use-settings"
import { checkAmount, maxText } from "@/lib/app/amounts"
import type { TxNotice } from "@/lib/app/tx-notice"
import { formatBps, formatPercent, formatTokenAmount } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { formatImpact } from "@/lib/protocol/prices"
import { maxSpend, type TradeQuote, type TradeRequest, type TradeToken } from "@/lib/protocol/trade-adapter"

export type YtSide = "buy" | "sell"

/** Every Principal token (SY, PT, YT, LP) has 7 decimals; YT is in USD (oracle units). */
const TOKEN_DECIMALS = 7

/**
 * The YT tab (spec 0002 §3): buy YT with the amount the user SPENDS, in the underlying or its SY, or
 * sell YT for either, on the trade adapter (R2-55) and the route runner. A buy shows the capital its
 * route moves (R2-59: only when the adapter reports one), the fixed APY before → after, the effective
 * implied APY (the break-even rate), leverage, fees, the minimum YT and the most it may spend (R2-58),
 * and a plain sentence on what the YT pays. After maturity there is no form (R2-60).
 *
 * One `RouteFlow` serves both sides, so a route started on one side (or resumed from History) stays
 * on screen when the side changes; it shows only YT routes (R2-77). The amounts reset once a step
 * reaches the network (R2-3). After maturity a `RouteResume` keeps a YT route stopped between its
 * steps on screen, beside "YT trading has closed".
 */
export function YtTab({
  marketId,
  side,
  onRedeem,
  routeId,
  onRouteOpened,
}: {
  marketId: string
  side: YtSide
  onRedeem?: () => void
  routeId?: string | null
  onRouteOpened?: (id: string) => void
}) {
  const matured = useMatured(marketId) === true
  if (matured) return <YtClosed marketId={marketId} onRedeem={onRedeem} routeId={routeId} onRouteOpened={onRouteOpened} />
  return <YtTrade marketId={marketId} side={side} routeId={routeId} onRouteOpened={onRouteOpened} />
}

/**
 * R2-60: trades close at maturity; the yield a YT earned before it is paid by Redeem. A YT route
 * interrupted between its steps still shows here, with "Back to USDY" (R2-77).
 */
function YtClosed({ marketId, onRedeem, routeId, onRouteOpened }: { marketId: string; onRedeem?: () => void; routeId?: string | null; onRouteOpened?: (id: string) => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>YT trading has closed</CardTitle>
        <CardDescription>YT trading closed at maturity: a YT can no longer be bought or sold.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm text-ink">
          From maturity a YT earns nothing more, so it is now worth 0. The yield your YT earned before maturity is not lost: redeeming your YT pays it out.
        </p>
        {onRedeem ? (
          <button type="button" onClick={onRedeem} className="justify-self-start text-sm text-ink underline underline-offset-2 hover:text-ink-muted">
            Redeem in the PT tab
          </button>
        ) : null}
        <RouteResume marketId={marketId} kinds={ROUTE_HOSTS.yt} routeId={routeId} onRouteOpened={onRouteOpened} />
      </CardContent>
    </Card>
  )
}

function YtTrade({ marketId, side, routeId, onRouteOpened }: { marketId: string; side: YtSide; routeId?: string | null; onRouteOpened?: (id: string) => void }) {
  const baseId = useId()
  const market = getMarket(useManifest(), marketId)
  const { slippageBps } = useSettings()
  const gate = useGateContext(marketId)
  const [texts, setTexts] = useState<Record<YtSide, string>>({ buy: "", sell: "" })
  const [touched, setTouched] = useState<Record<YtSide, boolean>>({ buy: false, sell: false })
  // The picker defaults to the underlying (R2-50): on "You pay" for a buy, on "You receive" for a sale.
  const [tokens, setTokens] = useState<Record<YtSide, PayToken>>({ buy: "underlying", sell: "underlying" })
  // Max's refusal is for the side and token it was asked on: a change of either clears it.
  const [maxError, setMaxError] = useState<string | null>(null)
  const [maxSide, setMaxSide] = useState(side)
  if (maxSide !== side) {
    setMaxSide(side)
    setMaxError(null)
  }
  const [last, setLast] = useState<{ owner: string; notice: TxNotice } | null>(null)

  const code = market?.underlying.code ?? "USDY"
  const underlyingDecimals = market?.underlying.decimals ?? TOKEN_DECIMALS
  const token = tokens[side]
  const decimalsOf = (t: TradeToken) => (t === "underlying" ? underlyingDecimals : TOKEN_DECIMALS)
  const unitOf = (t: TradeToken) => (t === "underlying" ? code : t.toUpperCase())
  const amountText = (raw: bigint, t: TradeToken) => `${formatTokenAmount(raw, decimalsOf(t), true)} ${unitOf(t)}`

  // --- The amount (0001's field and checks: the hostile-input rules hold here too). A buy's amount
  // is what the user spends, in the token paid; the gates check what its route moves.
  const payToken: TradeToken = side === "buy" ? token : "yt"
  const { account, ms } = gate
  const balance = account ? (payToken === "yt" ? account.yt : payToken === "sy" ? account.sy : account.underlying) : undefined
  const text = texts[side]
  const check = checkAmount(text, { decimals: decimalsOf(payToken), unit: unitOf(payToken), balance })
  const fieldError = maxError ?? (!check.ok && (text.trim() !== "" || touched[side]) ? check.message : undefined)

  // R2-21: a buy pays with the picked token (its `receive` is ignored), a sale receives it.
  const trade: TradeRequest = { kind: side === "buy" ? "buy_yt" : "sell_yt", amount: check.ok ? check.raw : 0n, pay: token, receive: token }
  const route = useTradeRoute({ marketId, gate, trade, check })
  const q = route.quote?.status === "live" ? route.quote.value : undefined
  const swapExact = q ? (q.swapOut ?? q).exactness === "simulated" : false
  const steps = route.plans.length

  const owner = JSON.stringify(gate.wallet)
  const setText = (next: string) => {
    setMaxError(null)
    setTexts((all) => ({ ...all, [side]: next }))
    setTouched((all) => ({ ...all, [side]: true }))
  }
  const reset = () => {
    setMaxError(null)
    setTexts({ buy: "", sell: "" })
    setTouched({ buy: false, sell: false })
  }

  // Max on a buy: the balance divided by the moved ratio, never a spend that moves more than it.
  const onMax =
    side === "buy"
      ? () => {
          if (balance?.status !== "live") return
          const r = maxSpend(route.quoteFor, balance.value, check.ok ? check.raw : undefined)
          if (r.ok) setText(maxText(r.amount, decimalsOf(payToken)))
          else setMaxError(r.reason)
        }
      : undefined

  if (!market) return null

  const picker = (label: string) => (
    <TokenPicker
      label={label}
      value={token}
      onChange={(t) => {
        setMaxError(null)
        setTokens((all) => ({ ...all, [side]: t }))
      }}
      options={["underlying", "sy"]}
      code={code}
    />
  )

  const note = routeNote({ plans: route.plans, q, connected: route.source !== null, pending: route.sim.pending })
  const spentText = (raw: bigint) => amountText(raw, token)
  const details: PreviewLine[] = []
  if (q) {
    // R2-59: the capital rows only when the adapter reports a capital; the step is the planned one.
    if (q.capital) {
      details.push(
        {
          label: "Moves",
          value: spentText(q.capital.moved),
          hint: "Buying YT today mints PT + YT from the whole amount moved and sells the PT straight back, so your balance must cover what is moved, not only what is spent. The cap and limits are checked on what is moved.",
        },
        { label: "Spends", value: spentText(q.capital.spent) },
        { label: `Comes back (step ${q.capital.backStep})`, value: spentText(q.capital.back) },
      )
    }
    // The step that signs the Buy YT bound, from the plan (R2-55: never a literal step number).
    const buyStep = route.plans.findIndex((p) => p.action === "buy_yt") + 1
    details.push(...detailLines(q, side, code, slippageBps, steps, buyStep, amountText, unitOf, side === "buy" && q.yieldOn !== undefined ? breakEven(q, code, spentText(q.capital?.spent ?? trade.amount), amountText(q.yieldOn, "underlying")) : undefined))
    if (side === "buy" && q.yieldOn !== undefined) {
      details.push({
        label: "At maturity",
        value: "YT worth 0",
        hint: `Indicative: ${amountText(q.yieldOn, "underlying")} is your ${amountText(q.out, "yt")} (USD) at today's ${code} oracle rate. From maturity a YT earns nothing more.`,
      })
    }
    if (note) details.push(signaturesLine(note))
  }
  const exactLabel = swapExact ? (q?.swapOut ? `Step ${q.swapOut.step} exact (simulated)` : "Exact (simulated)") : "Indicative"
  const exactnessTip = [q?.swapOut ? `Indicative: the steps after step ${q.swapOut.step} turn its ${unitOf(q.swapOut.token)} into ${unitOf(q.outToken)} at today's rate.` : null, note?.exactness]
    .filter(Boolean)
    .join(" ")

  return (
    <Card className="@container">
      <CardHeader className="flex-col gap-1 @lg:flex-row @lg:gap-4">
        <CardTitle>{side === "buy" ? "Buy YT" : "Sell YT"}</CardTitle>
        <CardDescription>
          {side === "buy"
            ? `A YT earns ${code}'s variable yield until maturity, then is worth 0. Enter what you want to spend.`
            : `Sell YT before maturity, for ${code} or its SY.`}
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
          onMax={onMax}
          onChange={setText}
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
              <p className="label">
                <LabelWithTip label={exactLabel} tip={exactnessTip || undefined} />
              </p>
              <PreviewList lines={details} />
            </>
          ) : (
            <p className="text-sm text-ink-muted">Enter an amount to see the trade&apos;s details.</p>
          )}
          {!q && note ? <PreviewList lines={[signaturesLine(note)]} /> : null}
        </section>

        <RouteFlow
          account={route.source}
          marketId={marketId}
          kinds={ROUTE_HOSTS.yt}
          routeId={routeId}
          onRouteOpened={onRouteOpened}
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

/** The spec's plain sentence (§3): what the YT pays, for what, and the break-even rate. */
function breakEven(q: TradeQuote, code: string, spent: string, yieldOn: string): string {
  const head = `You receive ${code}'s variable yield on ${yieldOn} until maturity, for ${spent}.`
  const gain =
    q.effectiveApy === undefined
      ? "The break-even rate is unavailable: this app could not work it out from these amounts."
      : `You gain if ${code}'s average APY until then exceeds ${formatPercent(q.effectiveApy)}.`
  return `${head} ${gain}`
}

const timesText = (x: number | undefined) => (x === undefined ? UNAVAILABLE : `${Math.round(x)}x`)

function detailLines(
  q: TradeQuote,
  side: YtSide,
  code: string,
  slippageBps: bigint,
  steps: number,
  /** The planned Buy YT step (1-based); 0 when none is planned. */
  buyStep: number,
  amountText: (raw: bigint, t: TradeToken) => string,
  unitOf: (t: TradeToken) => string,
  breakEvenTip: string | undefined,
): PreviewLine[] {
  const slippage = formatBps(slippageBps)
  const lines: PreviewLine[] = [
    {
      label: "Fixed APY",
      value: q.apyBefore === undefined || q.apyAfter === undefined ? UNAVAILABLE : `${formatPercent(q.apyBefore)} → ${formatPercent(q.apyAfter)}`,
      hint:
        side === "buy"
          ? "The pool's fixed APY now, and once your trade lands: buying YT sells PT into the pool, so the fixed APY rises."
          : "The pool's fixed APY now, and once your trade lands: selling YT buys PT from the pool, so the fixed APY falls.",
    },
  ]
  if (side === "buy") {
    lines.push(
      {
        label: "Break-even APY",
        value: q.effectiveApy === undefined ? UNAVAILABLE : formatPercent(q.effectiveApy),
        hint:
          breakEvenTip ??
          `The fixed rate at which what you pay for the YT is fair: your break-even. You gain if ${code}'s average APY until maturity is higher.`,
      },
      {
        label: "Leverage",
        value: timesText(q.leverage?.trade),
        hint: `YT received per dollar spent: 1 / the price you pay per YT. At the pool's price it is ${timesText(q.leverage?.spot)}; fees and price impact lower yours. There is no borrowing.`,
      },
    )
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
      hint: side === "buy" ? "Your price per YT against the pool's spot price, fees included." : "Your price against the pool's spot price, swap fee included.",
    },
    {
      label: "Fees",
      value: amountText(q.fee, q.feeToken),
      hint: side === "buy" ? "The tokenization fee on the SY split into PT + YT, and the pool's swap fee on the PT sold back." : "The pool's swap fee, taken from the trade.",
    },
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
  if (side === "buy" && q.maxCost !== undefined) {
    // M15: the figure is this preview's, in the token paid; what is signed is the step's own SY bound
    // (max_net_cost), from that step's own simulation.
    const signer = buyStep > 0 ? `Step ${buyStep}` : "The Buy YT step"
    lines.push({
      label: "Spends at most",
      // A buy's fee token is the token paid.
      value: amountText(q.maxCost, q.feeToken),
      hint: `At your ${slippage} slippage tolerance, on this preview. ${signer} is signed with its own bound, from its own simulation, and fails rather than cost more.`,
    })
  }
  return lines
}
