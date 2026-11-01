"use client"

import type { GateInputs } from "@/hooks/use-gate-context"
import { useMatured } from "@/hooks/use-matured"
import type { RouteGate } from "@/hooks/use-route"
import { useSettings } from "@/hooks/use-settings"
import { useSimulation, type Simulation } from "@/hooks/use-simulation"
import type { AmountCheck } from "@/lib/app/amounts"
import { ACTION_META, type ActionInput } from "@/lib/protocol/actions"
import { BLOCKER_ORDER, evaluateGates, type Blocker, type BlockerCode } from "@/lib/protocol/gates"
import { resolveStep, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import { currentContractsAdapter, toRouteRequest, type TradeAdapter, type TradeQuote, type TradeRequest, type TradeState } from "@/lib/protocol/trade-adapter"
import type { Live } from "@/lib/protocol/types"
import { useManifest } from "@/components/app/manifest-provider"

/**
 * What a later step spends comes from the steps before it, and its exact quote from its own
 * simulation once they are confirmed: those gates run when the route prepares it (`useRoute`).
 */
const LATER_STEP_SKIPS = new Set<BlockerCode>(["amount", "balance", "quote", "archived"])

const NO_CONTEXT: Blocker = {
  code: "unavailable",
  message: "This market's data or your account could not be checked yet, so signing stays off. Try again in a moment.",
}

export type TradeRoute = {
  /** The connected account, or null. */
  source: string | null
  /** What `RouteFlow` starts; null while the amount is not valid or no wallet is connected. */
  request: RouteRequest | null
  /** The route's steps; empty when the route is not offered (its reason is among `blockers`). */
  plans: StepPlan[]
  /** The adapter's figures for this trade; null while there is no amount or no market data. */
  quote: Live<TradeQuote> | null
  /** 0001's simulation of the route's first step, as the user, for this exact request. */
  sim: Simulation
  /** Every reason the route may not start now, in 0001's order; the amount field's own refusal first. */
  blockers: Blocker[]
  canStart: boolean
  /** The per-step gate `RouteFlow` hands to `useRoute`: 0001's gates, with the step's simulation. */
  gate: RouteGate
}

const dedupe = (list: Blocker[]) => list.filter((b, i) => list.findIndex((o) => o.code === b.code && o.message === b.message) === i)
const rank = (b: Blocker) => BLOCKER_ORDER.indexOf(b.code)

/**
 * One trade of the PT, YT or LP tab, from the amount the user typed to the route `RouteFlow` runs,
 * through the trade adapter (R2-55). Before the route starts:
 * - its first step is simulated as the user, exactly as 0001 simulates an action, and gated with
 *   that simulation (R2-23): the route starts only when it would pass;
 * - its later steps are gated too, on everything that does not depend on what the earlier steps
 *   produce (maturity, oracle, pauses, pool, compliance grants, caps), so a route is refused before
 *   its first signature rather than left holding SY halfway;
 * - the quote takes the first step's simulated output, so a one-step trade shows its exact figures.
 *
 * A first step stopped only by an archived entry may start: the route then stops on that step and
 * `RouteFlow` offers 0001's restore, then Continue.
 */
export function useTradeRoute({
  marketId,
  gate,
  trade,
  check,
  adapter = currentContractsAdapter,
}: {
  marketId: string
  /** The panel's `useGateContext(marketId)`. */
  gate: GateInputs
  /** The trade asked for; its `amount` is 0 while `check` refuses the field. */
  trade: TradeRequest
  /** The amount field's check (`checkAmount`): its refusal replaces the amount and balance gates. */
  check: AmountCheck
  adapter?: TradeAdapter
}): TradeRoute {
  const manifest = useManifest()
  const matured = useMatured(marketId) === true
  const { slippageBps, deadlineSeconds } = useSettings()
  const { wallet, ledgerTime, ms } = gate
  const source = wallet.status === "connected" ? wallet.publicKey : null
  const complete = check.ok && trade.amount > 0n

  const ctx = { marketId, source: source ?? "", matured, routerFunctions: manifest.routerFunctions ?? [], ...(ms ? { ms } : {}) }
  const planned = adapter.plan(trade, ctx)
  const plans = Array.isArray(planned) ? planned : []
  const disabled = Array.isArray(planned) ? undefined : planned.disabled
  const request = toRouteRequest(trade, ctx)

  /** A step's input with open guards; a step whose amount comes from an earlier one stands in with the request's. */
  const draftOf = (plan: StepPlan): ActionInput => {
    let amounts: { amount: bigint; secondaryAmount?: bigint }
    try {
      amounts = resolveStep(plan, request, [])
    } catch {
      amounts = { amount: trade.amount }
    }
    return {
      action: plan.action,
      marketId,
      source: source ?? "",
      amount: amounts.amount,
      ...(amounts.secondaryAmount !== undefined ? { secondaryAmount: amounts.secondaryAmount } : {}),
      guards: {},
      deadline: 0n,
    }
  }

  const first = plans[0] ? draftOf(plans[0]) : null
  const offered = first !== null && !ACTION_META[first.action].disabled
  const simInput: ActionInput | null =
    source !== null && complete && ledgerTime !== null && first && offered ? { ...first, deadline: BigInt(Math.floor(ledgerTime) + deadlineSeconds) } : null
  const sim = useSimulation(simInput)
  const firstStep: TradeState["firstStep"] = simInput && sim.output ? { action: simInput.action, output: sim.output } : undefined

  const quote = ms && trade.amount > 0n ? adapter.quote(trade, { ms, slippageBps, ...(firstStep ? { firstStep } : {}) }) : null

  let blockers: Blocker[] = gate.unavailable
  if (gate.base) {
    const base = gate.base
    let list: Blocker[] = disabled ? [{ code: "disabled", message: disabled }] : []
    if (first) {
      list.push(...evaluateGates(first, { ...base, simulation: sim.outcome }))
      if (sim.guards && !sim.guards.ok) list.push({ code: "quote", message: sim.guards.reason })
    }
    for (const plan of plans.slice(1)) {
      list.push(...evaluateGates(draftOf(plan), base).filter((b) => !LATER_STEP_SKIPS.has(b.code)))
    }
    // Nothing is simulated until the amount is complete, nor for a step that is not offered.
    if (!complete || !offered) list = list.filter((b) => b.code !== "quote")
    if (!check.ok) {
      // The gates saw 0 for an amount that does not parse; the field's own refusal replaces theirs.
      list = [{ code: check.code, message: check.message }, ...list.filter((b) => b.code !== "amount" && b.code !== "balance")]
    }
    blockers = dedupe(list).sort((a, b) => rank(a) - rank(b))
  }

  const onlyArchived = blockers.length > 0 && blockers.every((b) => b.code === "archived")
  const canStart = gate.base !== null && simInput !== null && plans.length > 0 && ((blockers.length === 0 && sim.guards?.ok === true) || onlyArchived)

  const routeGate: RouteGate = (input, simulation) => {
    if (gate.base) return evaluateGates(input, { ...gate.base, simulation })
    return gate.unavailable.length > 0 ? gate.unavailable : [NO_CONTEXT]
  }

  return {
    source,
    request: complete && source !== null && plans.length > 0 ? { ...request, source } : null,
    plans,
    quote,
    sim,
    blockers,
    canStart,
    gate: routeGate,
  }
}
