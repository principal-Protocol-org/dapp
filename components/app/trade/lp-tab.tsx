"use client"

import { useId, useState } from "react"
import { cn } from "cn"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AmountField } from "@/components/app/actions/amount-field"
import type { PreviewLine } from "@/components/app/actions/panel-config"
import { PreviewList } from "@/components/app/actions/preview-lines"
import { TxNoticeView } from "@/components/app/actions/tx-feedback"
import { UNAVAILABLE } from "@/components/app/live"
import { ROUTE_HOSTS, RouteFlow } from "@/components/app/route/route-flow"
import { InfoTip, LabelWithTip } from "@/components/app/info-tip"
import { routeNote, signaturesLine } from "@/components/app/trade/route-note"
import { TokenPicker, type PayToken } from "@/components/app/trade/token-picker"
import { useTradeRoute } from "@/components/app/trade/use-trade-route"
import { useManifest } from "@/components/app/manifest-provider"
import { STALE, useGateContext } from "@/hooks/use-gate-context"
import { useMatured } from "@/hooks/use-matured"
import { useSettings } from "@/hooks/use-settings"
import { checkAmount } from "@/lib/app/amounts"
import type { TxNotice } from "@/lib/app/tx-notice"
import { formatBps, formatPercent, formatTokenAmount } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { formatImpact } from "@/lib/protocol/prices"
import type { TradeKind, TradeQuote, TradeRequest, TradeToken } from "@/lib/protocol/trade-adapter"

export type LpSide = "deposit" | "withdraw"

/** Every Principal token (SY, PT, YT, LP) has 7 decimals. */
const TOKEN_DECIMALS = 7

/** The pool pays LPs no share of the swap fee (0001's Liquidity tab note). */
export const LP_NOTE = "LPs earn PT convergence; swap fees go to the protocol and the market creator."

/** A pool share as the app's percent; a share too small for two decimals is not shown as 0. */
const shareText = (share: number) => (share > 0 && share < 0.0001 ? "<0.01%" : formatPercent(share))

/**
 * The LP tab (spec 0002 §3): a Deposit and a Withdraw, on the trade adapter (R2-55) and the route
 * runner.
 * - Deposit pays the underlying (or its SY) with a Keep YT switch. On, part of the payment is split
 *   into PT + YT and the PT and the rest go into the pool at its ratio: LP and YT out, the fixed APY
 *   unchanged, no price impact, the tokenization fee on the split part. Off ("LP only") is not
 *   offered on this release (R47): the reason, and nothing else. Paying SY turns Keep YT off (R2-22).
 * - Withdraw takes LP and pays the underlying or SY: the PT removed is sold, which raises the fixed
 *   APY (R2-15), or redeemed after maturity (R2-20).
 *
 * One `RouteFlow` serves both sides and stays mounted after maturity, when Deposit has closed, so a
 * route started here (or resumed from History's Continue) stays on screen; it shows only LP routes
 * (R2-77). The amounts reset once a step reaches the network (R2-3). The split and every figure come
 * from the adapter, and the route's copy from the steps it planned.
 */
export function LpTab({ marketId, side, routeId, onRouteOpened }: { marketId: string; side: LpSide; routeId?: string | null; onRouteOpened?: (id: string) => void }) {
  const baseId = useId()
  const market = getMarket(useManifest(), marketId)
  const { slippageBps } = useSettings()
  const gate = useGateContext(marketId)
  const matured = useMatured(marketId) === true
  const [texts, setTexts] = useState<Record<LpSide, string>>({ deposit: "", withdraw: "" })
  const [touched, setTouched] = useState<Record<LpSide, boolean>>({ deposit: false, withdraw: false })
  // The picker defaults to the underlying (R2-50): on "You pay" for a deposit, on "You receive" for a withdraw.
  const [tokens, setTokens] = useState<Record<LpSide, PayToken>>({ deposit: "underlying", withdraw: "underlying" })
  const [keepYt, setKeepYt] = useState(true)
  const [last, setLast] = useState<{ owner: string; notice: TxNotice } | null>(null)

  const code = market?.underlying.code ?? "USDY"
  const underlyingDecimals = market?.underlying.decimals ?? TOKEN_DECIMALS
  const token = tokens[side]
  const decimalsOf = (t: TradeToken) => (t === "underlying" ? underlyingDecimals : TOKEN_DECIMALS)
  const unitOf = (t: TradeToken) => (t === "underlying" ? code : t.toUpperCase())
  const amountText = (raw: bigint, t: TradeToken) => `${formatTokenAmount(raw, decimalsOf(t), true)} ${unitOf(t)}`

  // Adding liquidity closes at maturity (assert_active); a withdraw stays open.
  const closed = side === "deposit" && matured
  // R2-22: Keep YT splits with Router.wrap_and_mint, which takes the underlying.
  const keep = keepYt && token === "underlying"

  // --- The amount (0001's field and checks: the hostile-input rules hold here too).
  const payToken: TradeToken = side === "deposit" ? token : "lp"
  const { account, ms } = gate
  const balance = account ? (payToken === "lp" ? account.lp : payToken === "sy" ? account.sy : account.underlying) : undefined
  const text = texts[side]
  const check = checkAmount(text, { decimals: decimalsOf(payToken), unit: unitOf(payToken), balance })
  const fieldError = !check.ok && (text.trim() !== "" || touched[side]) ? check.message : undefined

  // R2-21: a deposit pays with the picked token (its `receive` is ignored), a withdraw receives it.
  const kind: TradeKind = side === "withdraw" ? "lp_withdraw" : keep ? "lp_keep_yt" : "lp_only"
  const trade: TradeRequest = { kind, amount: check.ok ? check.raw : 0n, pay: token, receive: token }
  const route = useTradeRoute({ marketId, gate, trade, check })
  const q = route.quote?.status === "live" ? route.quote.value : undefined
  const steps = route.plans.length

  const owner = JSON.stringify(gate.wallet)
  const reset = () => {
    setTexts({ deposit: "", withdraw: "" })
    setTouched({ deposit: false, withdraw: false })
  }

  if (!market) return null

  const picker = (label: string) => (
    <TokenPicker label={label} value={token} onChange={(t) => setTokens((all) => ({ ...all, [side]: t }))} options={["underlying", "sy"]} code={code} />
  )

  // Whether a withdraw redeems its PT (after maturity) or sells it is read from the route the adapter
  // planned, as `routeNote` and the adapter read it, never from which quote fields are present (R2-55).
  const redeems = route.plans.some((p) => p.action === "redeem")
  const ctx: LineContext = { code, slippage: formatBps(slippageBps), steps, paid: trade.amount, connected: route.source !== null, amountText }
  const note = routeNote({ plans: route.plans, q, connected: route.source !== null, pending: route.sim.pending })
  const details: PreviewLine[] = q ? (side === "deposit" ? depositLines(q, ctx) : withdrawLines(q, ctx, redeems)) : []
  if (q && side === "withdraw" && redeems && token === "sy") {
    details.push({
      label: "Redeemed part",
      value: q.alsoOut ? amountText(q.alsoOut.amount, q.alsoOut.token) : UNAVAILABLE,
      hint: q.alsoOut
        ? `The redeemed part, ${amountText(q.alsoOut.amount, q.alsoOut.token)}, is paid in ${unitOf(q.alsoOut.token)} even when you receive SY: after maturity your PT is redeemed, not sold.`
        : `${UNAVAILABLE}: the redeemed part could not be read from the quote. It is paid in ${code} even when you receive SY: after maturity your PT is redeemed, not sold.`,
    })
  }
  if (q) details.push({ label: "LP earns", value: "PT convergence", hint: LP_NOTE })
  if (q && note) details.push(signaturesLine(note))
  const exactLabel = q?.exactness === "simulated" ? "Exact (simulated)" : "Indicative"
  const receivedText = q ? `${amountText(q.out, q.outToken)}${q.alsoOut ? ` + ${amountText(q.alsoOut.amount, q.alsoOut.token)}` : ""}` : route.quote ? UNAVAILABLE : null

  return (
    <Card className="@container">
      <CardHeader className="flex-col gap-1 @lg:flex-row @lg:gap-4">
        <CardTitle>{side === "deposit" ? "Add liquidity" : "Withdraw liquidity"}</CardTitle>
        <CardDescription>
          {side === "deposit"
            ? closed
              ? "Adding liquidity closed at maturity: the pool takes no new PT or SY. You can still withdraw your liquidity: choose Withdraw."
              : `Deposit ${code} into the pool for LP tokens.`
            : redeems
              ? `Withdraw your LP for ${code} or its SY. After maturity your PT is redeemed, not sold.`
              : `Withdraw your LP for ${code} or its SY. The PT you get back is sold into the pool.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {closed ? null : (
          <>
            <AmountField
              id={`${baseId}-pay`}
              spec={{ id: "amount", label: "You pay", unit: unitOf(payToken) }}
              text={text}
              error={fieldError}
              balance={balance}
              decimals={decimalsOf(payToken)}
              picker={side === "deposit" ? picker("Pay with") : undefined}
              onChange={(next) => {
                setTexts((all) => ({ ...all, [side]: next }))
                setTouched((all) => ({ ...all, [side]: true }))
              }}
              onBlur={() => setTouched((all) => ({ ...all, [side]: true }))}
            />

            {side === "deposit" ? (
              <KeepYtSwitch
                id={`${baseId}-keep`}
                checked={keep}
                disabled={token !== "underlying"}
                onChange={() => setKeepYt((on) => !on)}
                reason={
                  token !== "underlying"
                    ? `Keep YT needs ${code}: it splits ${code} into PT + YT with the Router, which takes ${code}. Pay in ${code} to keep the YT.`
                    : keep
                      ? undefined
                      : `LP only: all your ${code} would go into the pool and no YT kept. It is not offered on this release.`
                }
                hint={keep ? `Part of your ${code} is split into PT + YT; the PT and the rest go into the pool at its ratio, and you keep the YT.` : undefined}
              />
            ) : null}

            <div className="grid gap-1.5">
              <span id={`${baseId}-receive`} className="text-sm leading-none font-medium text-ink">
                You receive (preview)
              </span>
              {side === "withdraw" ? <div className="flex min-w-0 flex-wrap items-center gap-2">{picker("Receive as")}</div> : null}
              <output
                aria-labelledby={`${baseId}-receive`}
                className="flex min-h-9 items-center rounded-md border border-line bg-surface-sunk px-3 py-1.5 font-mono text-sm text-ink tabular-nums wrap-anywhere"
              >
                {receivedText}
              </output>
            </div>

            <section aria-label="Liquidity details" className="grid gap-2">
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
                    <LabelWithTip label={exactLabel} tip={note?.exactness ?? undefined} />
                  </p>
                  <PreviewList lines={details} />
                </>
              ) : (
                <>
                  <p className="text-sm text-ink-muted">Enter an amount to see the details.</p>
                  {/* A static explanation, so it needs no quote. */}
                  <PreviewList lines={[{ label: "LP earns", value: "PT convergence", hint: LP_NOTE }]} />
                </>
              )}
              {!q && note ? <PreviewList lines={[signaturesLine(note)]} /> : null}
            </section>
          </>
        )}

        <RouteFlow
          account={route.source}
          marketId={marketId}
          kinds={ROUTE_HOSTS.lp}
          routeId={routeId}
          onRouteOpened={onRouteOpened}
          gate={route.gate}
          request={route.request}
          kind={trade.kind}
          plans={route.plans}
          canStart={route.canStart}
          blockers={route.blockers}
          showStart={!closed}
          onNotice={(notice) => setLast({ owner, notice })}
          onReachedNetwork={reset}
        />

        {last && last.owner === owner ? <TxNoticeView notice={last.notice} /> : null}
      </CardContent>
    </Card>
  )
}

/**
 * The Keep YT switch (spec §3). Why it is off (a payment in SY, or the R47 refusal) stays visible
 * under it; what it does while on goes behind an info tip (R2-65).
 */
function KeepYtSwitch({ id, checked, disabled, onChange, hint, reason }: { id: string; checked: boolean; disabled: boolean; onChange: () => void; hint?: string; reason?: string }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-3">
        <span id={id} className="inline-flex items-center gap-1.5 text-sm leading-none font-medium text-ink">
          <span>Keep YT</span>
          {hint ? <InfoTip label="Keep YT">{hint}</InfoTip> : null}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label="Keep YT"
          aria-describedby={reason ? `${id}-hint` : undefined}
          disabled={disabled}
          onClick={onChange}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-line transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50",
            checked ? "bg-ink" : "bg-surface-sunk",
          )}
        >
          <span aria-hidden="true" className={cn("inline-block size-4 rounded-full bg-surface shadow-sm transition-transform", checked ? "translate-x-6" : "translate-x-1")} />
        </button>
      </div>
      {reason ? (
        <p id={`${id}-hint`} className="text-xs text-ink-muted wrap-anywhere">
          {reason}
        </p>
      ) : null}
    </div>
  )
}

type LineContext = {
  code: string
  slippage: string
  steps: number
  /** What the user pays, in the token paid (a deposit). */
  paid: bigint
  connected: boolean
  amountText: (raw: bigint, t: TradeToken) => string
}

const poolShareLine = (q: TradeQuote, connected: boolean): PreviewLine =>
  q.poolShare
    ? {
        label: "Pool share",
        value: `${shareText(q.poolShare.before)} → ${shareText(q.poolShare.after)}`,
        hint: "Your share of the pool's LP supply now, and once this lands.",
      }
    : {
        label: "Pool share",
        value: UNAVAILABLE,
        hint: connected ? "Your LP balance has not been read, so your share cannot be worked out yet." : "Connect a wallet: your share needs your LP balance.",
      }

/** A fee as the quote gives it: "None" only when it is 0. */
const feeValue = (q: TradeQuote, c: LineContext) => (q.fee === 0n ? "None" : c.amountText(q.fee, q.feeToken))

/** The fixed APY before → after; Unavailable when the quote has none, never dropped (as the PT and YT tabs). */
const apyValue = (q: TradeQuote) =>
  q.apyBefore === undefined || q.apyAfter === undefined ? UNAVAILABLE : `${formatPercent(q.apyBefore)} → ${formatPercent(q.apyAfter)}`

const minimumLine = (q: TradeQuote, c: LineContext): PreviewLine => ({
  label: "Minimum received",
  value: c.amountText(q.minOut, q.minOutToken),
  hint:
    c.steps > 1
      ? `At your ${c.slippage} slippage tolerance, on this preview. Each step is signed with its own minimum, from a fresh simulation once the step before it is confirmed.`
      : `Signed into the transaction at your ${c.slippage} slippage tolerance: it fails rather than give less.`,
})

/** Keep YT on: what the split gives, with no swap in it. */
function depositLines(q: TradeQuote, c: LineContext): PreviewLine[] {
  const { code, amountText } = c
  const lines: PreviewLine[] = []
  // "(unchanged)" is the adapter's word that the trade moves no price (no price impact), not two
  // percentages that happen to round alike.
  const unchanged = q.priceImpactPpm === 0n && q.apyBefore !== undefined ? `${formatPercent(q.apyBefore)} (unchanged)` : undefined
  lines.push({
    label: "Fixed APY",
    value: unchanged ?? apyValue(q),
    hint: "PT and SY go into the pool at its ratio, so its price, and the fixed APY, do not move.",
  })
  lines.push({
    label: "Price impact",
    value: q.priceImpactPpm === undefined ? UNAVAILABLE : q.priceImpactPpm === 0n ? "None" : formatImpact(q.priceImpactPpm),
    hint: `Nothing is swapped: your ${code} is split into PT + YT and SY, and the PT and SY go in at the pool's ratio. Each step is still signed with a slippage minimum from its own simulation.`,
  })
  if (q.splitPart !== undefined) {
    lines.push({
      label: "Split into PT + YT",
      value: amountText(q.splitPart, "underlying"),
      hint: `Minted into PT + YT; the other ${amountText(c.paid - q.splitPart, "underlying")} is deposited as SY. Sized so the PT and SY match the pool's ratio.`,
    })
  }
  lines.push({
    label: "Fees",
    value: feeValue(q, c),
    hint:
      q.splitPart !== undefined
        ? `The tokenization fee on the ${amountText(q.splitPart, "underlying")} split into PT + YT. There is no swap fee: nothing is swapped.`
        : "The tokenization fee on the part split into PT + YT. There is no swap fee: nothing is swapped.",
  })
  if (q.alsoOut) {
    lines.push({
      label: `${q.alsoOut.token.toUpperCase()} you keep`,
      value: amountText(q.alsoOut.amount, q.alsoOut.token),
      hint: q.alsoOut.exactness === "simulated" ? "Exact: the step that mints it was simulated as your account." : "Indicative until the step that mints it is simulated as your account.",
    })
  }
  lines.push(poolShareLine(q, c.connected), minimumLine(q, c))
  if (q.leftover && q.leftover.length > 0) {
    lines.push({
      label: "Left in your wallet",
      value: q.leftover.map((l) => amountText(l.amount, l.token)).join(" + "),
      hint: "The pool takes PT and SY only in its exact ratio: this rounding remainder stays with you.",
    })
  }
  return lines
}

/**
 * Withdraw: the PT sale's effect on the fixed APY, or, when the route redeems the PT (after
 * maturity), the redeem that replaces the sale. `redeems` is read from the planned route.
 */
function withdrawLines(q: TradeQuote, c: LineContext, redeems: boolean): PreviewLine[] {
  const { code } = c
  const lines: PreviewLine[] = []
  if (!redeems) {
    lines.push(
      {
        label: "Fixed APY",
        value: apyValue(q),
        hint: "The pool's fixed APY now, and once your withdraw lands: the PT you get back is sold into the pool, so the fixed APY rises.",
      },
      {
        label: "Price impact",
        value: q.priceImpactPpm === undefined ? UNAVAILABLE : formatImpact(q.priceImpactPpm),
        hint: "The PT sale's price against the pool's spot price, swap fee included.",
      },
      { label: "Fees", value: feeValue(q, c), hint: "The pool's swap fee on the PT sold." },
    )
  } else {
    lines.push(
      {
        label: "Your PT",
        value: "Redeemed, not sold",
        hint: `After maturity the PT you withdraw is redeemed for ${code} at the settlement rate, so nothing moves the pool's price. The redeem pays ${code}, whichever token you receive.`,
      },
      { label: "Fees", value: feeValue(q, c), hint: "Redeeming PT at maturity takes no fee, and nothing is swapped." },
    )
  }
  lines.push(poolShareLine(q, c.connected), minimumLine(q, c))
  return lines
}
