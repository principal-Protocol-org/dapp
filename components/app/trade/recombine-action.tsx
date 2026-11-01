"use client"

import Link from "next/link"
import { useId, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { AmountField } from "@/components/app/actions/amount-field"
import type { PreviewLine } from "@/components/app/actions/panel-config"
import { PreviewList } from "@/components/app/actions/preview-lines"
import { TxNoticeView } from "@/components/app/actions/tx-feedback"
import { LabelWithTip } from "@/components/app/info-tip"
import { UNAVAILABLE } from "@/components/app/live"
import { useManifest } from "@/components/app/manifest-provider"
import { ROUTE_HOSTS, RouteFlow } from "@/components/app/route/route-flow"
import { routeNote, signaturesLine, type RouteNote } from "@/components/app/trade/route-note"
import { TokenPicker, type PayToken } from "@/components/app/trade/token-picker"
import { useRouteStart } from "@/components/app/trade/use-trade-route"
import { STALE, useGateContext } from "@/hooks/use-gate-context"
import { useMatured } from "@/hooks/use-matured"
import { checkAmount, spendBalance } from "@/lib/app/amounts"
import type { TxNotice } from "@/lib/app/tx-notice"
import { formatTokenAmount } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import type { MarketState } from "@/lib/protocol/market-state"
import { previewRecombine, previewWithdraw } from "@/lib/protocol/previews"
import { planRoute, type RouteRequest } from "@/lib/protocol/routes"

/** The Quick action's menu label and dialog title: the token received is chosen in the form. */
export const RECOMBINE_TITLE = "Recombine PT + YT"
/** Its one-line description, with the underlying's code. */
export const recombineDescription = (code: string) => `Give back equal amounts of PT and YT for ${code} or SY, before maturity.`

/** Every Principal token (SY, PT, YT) has 7 decimals; PT and YT are in USD (oracle units). */
const TOKEN_DECIMALS = 7
const FIELD = { id: "amount", label: "PT and YT to recombine", unit: "PT + YT" } as const

type Figures = { ok: true; sy: bigint; syExact: boolean; underlying?: bigint } | { ok: false; error: string }

/**
 * What the route gives for `amount` PT and YT. Step 1 (Router.recombine) pays `amount ÷ oracle rate`
 * in SY (`previewRecombine`), replaced by its simulation as the user once that has run; step 2
 * (SYWrapper.withdraw), when the user receives the underlying, unwraps that SY at today's SY rate
 * (`previewWithdraw`, floored). Step 2 is never simulated before step 1 lands, so the underlying is
 * always indicative. A figure that cannot be worked out says why: it is never shown as 0.
 */
function figuresFor(ms: MarketState, amount: bigint, receive: PayToken, simulatedSy: bigint | undefined): Figures {
  try {
    let sy = simulatedSy
    if (sy === undefined) {
      if (ms.oracleRate.status !== "live") return { ok: false, error: `the oracle rate could not be read (${ms.oracleRate.error})` }
      sy = previewRecombine(amount, ms.oracleRate.value)
    }
    const syExact = simulatedSy !== undefined
    if (receive === "sy") return { ok: true, sy, syExact }
    if (ms.exchangeRate.status !== "live") return { ok: false, error: `the SY exchange rate could not be read (${ms.exchangeRate.error})` }
    return { ok: true, sy, syExact, underlying: previewWithdraw(sy, ms.exchangeRate.value) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The Quick action "Recombine PT + YT" (spec 0002 §4, R2-72): give back equal amounts of PT and YT
 * before maturity, for the underlying (Router.recombine, then SYWrapper.withdraw of its SY: two
 * signatures) or for SY (Router.recombine alone: one). Planned by `planRoute` (recombine is not a
 * trade of the adapter), checked by `useRouteStart` and run only through `RouteFlow`, as the trade
 * tabs are. The amount resets once a step reaches the network (R2-3).
 *
 * After maturity recombining is closed (the manager's `assert_not_mature`): no form, a pointer to
 * Redeem, and `RouteFlow` stays mounted so a run stopped between its steps can still finish its
 * withdraw (withdraw stays open at maturity). It shows only recombine runs (R2-77), so the market
 * page's dialog and the trade tab behind it never hold the same run. `onRedeem` is the host's way to
 * the PT tab's Redeem; without one the pointer is a link to it. `routeId` is the run History's
 * Continue names.
 */
export function RecombineAction({ marketId, onRedeem, routeId }: { marketId: string; onRedeem?: () => void; routeId?: string | null }) {
  const baseId = useId()
  const manifest = useManifest()
  const market = getMarket(manifest, marketId)
  const gate = useGateContext(marketId)
  const matured = useMatured(marketId) === true
  const [text, setText] = useState("")
  const [touched, setTouched] = useState(false)
  // The underlying by default (R2-50), as the trade tabs' "Receive as".
  const [receive, setReceive] = useState<PayToken>("underlying")
  const [last, setLast] = useState<{ owner: string; notice: TxNotice } | null>(null)

  const code = market?.underlying.code ?? "USDY"
  const underlyingDecimals = market?.underlying.decimals ?? TOKEN_DECIMALS
  const amountText = (raw: bigint, unit: string, decimals = TOKEN_DECIMALS) => `${formatTokenAmount(raw, decimals, true)} ${unit}`

  // --- The amount (0001's field and checks: the hostile-input rules hold here too). Recombine burns
  // PT and YT one for one, so the balance is the smaller of the two, unavailable unless both are live.
  const { account, ms } = gate
  const balance = account ? spendBalance("recombine", "amount", account) : undefined
  const check = checkAmount(text, { decimals: TOKEN_DECIMALS, unit: FIELD.unit, balance })
  const fieldError = !check.ok && (text.trim() !== "" || touched) ? check.message : undefined
  const amount = check.ok ? check.raw : 0n

  const source = gate.wallet.status === "connected" ? gate.wallet.publicKey : null
  const request: RouteRequest = { kind: "recombine", marketId, source: source ?? "", amount, pay: "underlying", receive, matured }
  const planned = planRoute(request, { routerFunctions: manifest.routerFunctions ?? [] })
  const plans = Array.isArray(planned) ? planned : []
  const route = useRouteStart({ gate, request, plans, ...(Array.isArray(planned) ? {} : { disabled: planned.disabled }), check })

  const owner = JSON.stringify(gate.wallet)
  const reset = () => {
    setText("")
    setTouched(false)
  }

  if (!market) return null

  const out = route.sim.output
  const simulatedSy = route.simInput?.action === "recombine" && out?.kind === "amount" ? out.value : undefined
  const figures = ms && amount > 0n ? figuresFor(ms, amount, receive, simulatedSy) : null
  const f = figures?.ok ? figures : undefined
  const note = routeNote({ plans, q: undefined, connected: route.source !== null, pending: route.sim.pending })
  const steps = plans.length
  const exactLabel = f?.syExact ? (receive === "sy" ? "Exact (simulated)" : "Step 1 exact (simulated)") : "Indicative"
  const details = f ? detailLines(f, amount, receive, code, amountText, underlyingDecimals, note) : []

  return (
    <div className="grid min-w-0 gap-5">
      {matured ? (
        <div className="grid gap-3">
          <p className="text-sm text-ink">
            This market has matured, so recombining has closed: PT and YT are now redeemed, not recombined. Redeeming PT pays {code} at the settlement rate,
            and redeeming YT pays the yield it earned.
          </p>
          {onRedeem ? (
            <button type="button" onClick={onRedeem} className="justify-self-start text-sm text-ink underline underline-offset-2 hover:text-ink-muted">
              Redeem in the PT tab
            </button>
          ) : (
            <Link href={`/app/markets/${marketId}?tab=pt`} className="justify-self-start text-sm text-ink underline underline-offset-2 hover:text-ink-muted">
              Redeem in the PT tab
            </Link>
          )}
        </div>
      ) : (
        <>
          <AmountField
            id={`${baseId}-amount`}
            spec={FIELD}
            text={text}
            error={fieldError}
            balance={balance}
            decimals={TOKEN_DECIMALS}
            onChange={(next) => {
              setText(next)
              setTouched(true)
            }}
            onBlur={() => setTouched(true)}
          />

          <div className="grid gap-1.5">
            <p className="text-sm leading-none font-medium text-ink">Receive as</p>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <TokenPicker label="Receive as" value={receive} onChange={setReceive} options={["underlying", "sy"]} code={code} />
            </div>
          </div>

          <section aria-label="Recombine details" className="grid gap-2">
            {!ms ? (
              gate.marketStatus === "loading" ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <p className="text-sm text-ink">
                  {gate.marketStatus === "stale" ? `${STALE}.` : "Unavailable: this market's data could not be read."} No preview is shown.
                </p>
              )
            ) : figures && !figures.ok ? (
              <p className="text-sm text-ink wrap-anywhere">{`${UNAVAILABLE}: ${figures.error}.`}</p>
            ) : f ? (
              <>
                <p className="label">
                  <LabelWithTip label={exactLabel} tip={exactnessTip(f.syExact, receive, steps, code, route.source !== null, route.sim.pending)} />
                </p>
                <PreviewList lines={details} />
              </>
            ) : (
              <p className="text-sm text-ink-muted">Enter an amount to see the details.</p>
            )}
            {!f && note ? <PreviewList lines={[signaturesLine(note)]} /> : null}
          </section>
        </>
      )}

      <RouteFlow
        account={route.source}
        marketId={marketId}
        kinds={ROUTE_HOSTS.recombine}
        routeId={routeId}
        gate={route.gate}
        request={route.request}
        kind="recombine"
        plans={plans}
        canStart={route.canStart}
        blockers={route.blockers}
        showStart={!matured}
        onNotice={(notice) => setLast({ owner, notice })}
        onReachedNetwork={reset}
      />

      {last && last.owner === owner ? <TxNoticeView notice={last.notice} /> : null}
    </div>
  )
}

/** Which figures are exact and which are indicative: the tip on the exactness badge. */
function exactnessTip(syExact: boolean, receive: PayToken, steps: number, code: string, connected: boolean, pending: boolean): string {
  if (syExact && receive === "sy") return "The amount you receive is exact: it was simulated as your account."
  if (syExact) {
    return `Step 1's SY is exact (simulated); the ${code} step 2 gives is worked out at today's SY rate, and step 2 gets its own minimum when it is prepared.`
  }
  const later = steps > 1 ? " Each step after the first is signed with an exact amount and minimum from its own simulation, once the step before it is confirmed." : ""
  const exact = !connected ? " Connect a wallet for an exact quote." : pending ? " Getting an exact quote…" : ""
  return `The figures are indicative, from this app's copy of the contract's math at today's oracle rate.${later}${exact}`
}

function detailLines(
  f: Extract<Figures, { ok: true }>,
  amount: bigint,
  receive: PayToken,
  code: string,
  amountText: (raw: bigint, unit: string, decimals?: number) => string,
  underlyingDecimals: number,
  note: RouteNote | null,
): PreviewLine[] {
  const lines: PreviewLine[] = []
  if (receive === "underlying" && f.underlying !== undefined) {
    lines.push(
      {
        label: "You receive",
        value: `≈ ${amountText(f.underlying, code, underlyingDecimals)}`,
        hint: `Indicative: step 1 pays the amount divided by the oracle rate, in SY; step 2 turns that SY into ${code} at today's SY rate. Each step is signed with its own minimum, from its own simulation.`,
      },
      {
        label: "SY from step 1",
        value: amountText(f.sy, "SY"),
        hint: f.syExact ? "Simulated as your account." : "Indicative until step 1 is simulated as your account.",
      },
    )
  } else {
    lines.push({
      label: "You receive",
      value: amountText(f.sy, "SY"),
      hint: f.syExact
        ? "Simulated as your account: recombining pays the amount divided by the oracle rate, in SY."
        : "Recombining pays the amount divided by the oracle rate, in SY. Indicative until it is simulated as your account.",
    })
  }
  lines.push({
    label: "Burns",
    value: `${amountText(amount, "PT")} + ${amountText(amount, "YT")}`,
    hint: "Recombining burns equal amounts of PT and YT. The yield your YT has already earned stays yours to claim.",
  })
  if (note) lines.push(signaturesLine(note))
  return lines
}
