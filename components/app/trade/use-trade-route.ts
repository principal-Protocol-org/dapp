"use client"

import type { GateInputs } from "@/hooks/use-gate-context"
import { useMatured } from "@/hooks/use-matured"
import type { RouteGate } from "@/hooks/use-route"
import { useSettings } from "@/hooks/use-settings"
import { useSimulation, type Simulation } from "@/hooks/use-simulation"
import type { AmountCheck } from "@/lib/app/amounts"
import type { ActionInput } from "@/lib/protocol/actions"
import { evaluateGates, type Blocker } from "@/lib/protocol/gates"
import { isOffered, preStartDraft, routePreStartBlockers } from "@/lib/protocol/route-gates"
import type { RouteRequest, StepPlan } from "@/lib/protocol/routes"
import { currentContractsAdapter, toRouteRequest, type TradeAdapter, type TradeQuote, type TradeRequest, type TradeState } from "@/lib/protocol/trade-adapter"
import type { Live } from "@/lib/protocol/types"
import { useManifest } from "@/components/app/manifest-provider"

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
  /**
   * The adapter's figures for the same trade at another amount, on the indicative path (no
   * simulation): what Max asks before it fills the field. Null without market data.
   */
  quoteFor(amount: bigint): Live<TradeQuote> | null
  /** 0001's simulation of the route's first step, as the user, for this exact request. */
  sim: Simulation
  /** Every reason the route may not start now, in 0001's order; the amount field's own refusal first. */
  blockers: Blocker[]
  canStart: boolean
  /** The per-step gate `RouteFlow` hands to `useRoute`: 0001's gates, with the step's simulation. */
  gate: RouteGate
}

/**
 * One trade of the PT, YT or LP tab, from the amount the user typed to the route `RouteFlow` runs,
 * through the trade adapter (R2-55). Before the route starts it is checked by `useRouteStart`; the
 * quote takes the first step's simulated output, so a one-step trade shows its exact figures.
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
  const { slippageBps } = useSettings()
  const { wallet, ms } = gate
  const source = wallet.status === "connected" ? wallet.publicKey : null

  const ctx = { marketId, source: source ?? "", matured, routerFunctions: manifest.routerFunctions ?? [], ...(ms ? { ms } : {}) }
  const planned = adapter.plan(trade, ctx)
  const plans = Array.isArray(planned) ? planned : []
  const disabled = Array.isArray(planned) ? undefined : planned.disabled
  const start = useRouteStart({ gate, request: toRouteRequest(trade, ctx), plans, ...(disabled ? { disabled } : {}), check })
  const { sim, simInput } = start
  const firstStep: TradeState["firstStep"] = simInput && sim.output ? { action: simInput.action, output: sim.output } : undefined

  // The connected account's LP, for the LP tab's pool share; absent without one.
  const lp = gate.account?.lp
  const held = lp?.status === "live" ? { heldLp: lp.value } : {}
  const quote = ms && trade.amount > 0n ? adapter.quote(trade, { ms, slippageBps, plans, ...held, ...(firstStep ? { firstStep } : {}) }) : null
  const quoteFor = (amount: bigint): Live<TradeQuote> | null => {
    if (!ms) return null
    const at = { ...trade, amount }
    const p = adapter.plan(at, ctx)
    return adapter.quote(at, { ms, slippageBps, plans: Array.isArray(p) ? p : [], ...held })
  }

  return {
    source: start.source,
    request: start.request,
    plans,
    quote,
    quoteFor,
    sim,
    blockers: start.blockers,
    canStart: start.canStart,
    gate: start.gate,
  }
}

export type RouteStart = {
  /** The connected account, or null. */
  source: string | null
  /** What `RouteFlow` starts, as the connected account; null while the amount is not valid, no wallet is connected or nothing is planned. */
  request: RouteRequest | null
  /** 0001's simulation of the route's first step, as the user, for this exact request. */
  sim: Simulation
  /** The first step as simulated (open guards, the ledger deadline); null while it is not simulated. */
  simInput: ActionInput | null
  /** Every reason the route may not start now, in 0001's order; the amount field's own refusal first. */
  blockers: Blocker[]
  canStart: boolean
  /** The per-step gate `RouteFlow` hands to `useRoute`: 0001's gates, with the step's simulation. */
  gate: RouteGate
}

/**
 * Whether a planned route may start, for any form that hosts `RouteFlow`: the trade tabs (through
 * `useTradeRoute`) and the Recombine quick action, which plans with `planRoute` directly. Before the
 * route starts:
 * - its first step is simulated as the user, exactly as 0001 simulates an action;
 * - the route is checked by `routePreStartBlockers` (lib/protocol/route-gates.ts): step 1 with that
 *   simulation (R2-23), the later steps on everything that does not depend on what the earlier steps
 *   produce, with the circuit breaker (R2-61) and the deposit cap (R2-62) counted across the steps;
 *   the route starts only when it would pass.
 *
 * A first step stopped only by an archived entry may start: the route then stops on that step and
 * `RouteFlow` offers 0001's restore, then Continue.
 */
export function useRouteStart({
  gate,
  request,
  plans,
  disabled,
  check,
}: {
  /** The panel's `useGateContext(marketId)`. */
  gate: GateInputs
  /** The route asked for; `source` is the connected account or "", `amount` 0 while `check` refuses the field. */
  request: RouteRequest
  /** The planner's steps; empty when it refused the route. */
  plans: StepPlan[]
  /** Why the planner refused the route, if it did. */
  disabled?: string
  /** The amount field's check (`checkAmount`): its refusal replaces the amount and balance gates. */
  check: AmountCheck
}): RouteStart {
  const { deadlineSeconds } = useSettings()
  const { wallet, ledgerTime } = gate
  const source = wallet.status === "connected" ? wallet.publicKey : null
  const complete = check.ok && request.amount > 0n

  const first = plans[0] ? preStartDraft(plans[0], request).input : null
  const offered = isOffered(first)
  const simInput: ActionInput | null =
    source !== null && complete && ledgerTime !== null && first && offered ? { ...first, deadline: BigInt(Math.floor(ledgerTime) + deadlineSeconds) } : null
  const sim = useSimulation(simInput)

  const blockers: Blocker[] = gate.base
    ? routePreStartBlockers({
        plans,
        ...(disabled ? { disabled } : {}),
        request,
        base: gate.base,
        ...(sim.outcome ? { simOutcome: sim.outcome } : {}),
        ...(sim.output ? { simOutput: sim.output } : {}),
        ...(sim.guards ? { simGuards: sim.guards } : {}),
        trade: { check },
      })
    : gate.unavailable

  const onlyArchived = blockers.length > 0 && blockers.every((b) => b.code === "archived")
  const canStart = gate.base !== null && simInput !== null && plans.length > 0 && ((blockers.length === 0 && sim.guards?.ok === true) || onlyArchived)

  return {
    source,
    request: complete && source !== null && plans.length > 0 ? { ...request, source } : null,
    sim,
    simInput,
    blockers,
    canStart,
    gate: stepGate(gate),
  }
}

/**
 * The per-step gate a route host hands `useRoute` (through `RouteFlow`): 0001's gates on the panel's
 * live context, with the step's own simulation. Without a trusted context every step is refused.
 */
export function stepGate(gate: GateInputs): RouteGate {
  return (input, simulation) => {
    if (gate.base) return evaluateGates(input, { ...gate.base, simulation })
    return gate.unavailable.length > 0 ? gate.unavailable : [NO_CONTEXT]
  }
}
