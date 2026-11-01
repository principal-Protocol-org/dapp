import { ACTION_META, type ActionInput } from "./actions"
import {
  BLOCKER_ORDER,
  breakerReport,
  capCharge,
  evaluateGates,
  routeCapBlocker,
  withEarlierCapCharges,
  withEarlierReports,
  type Blocker,
  type BlockerCode,
  type GateContext,
} from "./gates"
import type { ActionOutput, GuardResult } from "./guards"
import { resolveStep, type AmountSource, type RouteRequest, type StepPlan } from "./routes"
import type { SimulationOutcome } from "./stellar"

/**
 * Why a route may not start now (spec 0002 §4), before its first signature: what `useTradeRoute`
 * shows and the live suites check, from one pure function.
 *
 * - Step 1 is gated with its own simulation as the user (R2-23).
 * - The later steps are gated on everything that does not depend on what the earlier steps produce
 *   (maturity, oracle, pauses, pool, compliance grants, caps), so a route is refused before its first
 *   signature rather than left holding SY halfway.
 * - The circuit breaker (R2-61) and the deposit cap (R2-62) see each later step with what the steps
 *   before it already counted: the route's deposits (a mint's included) fill the same windows.
 * - A later step's `requires` that reads only step 1's output is checked against step 1's simulation.
 *
 * A later step's own amount, balance and quote are checked when the route prepares it (`useRoute`).
 */

/**
 * What a later step spends comes from the steps before it, and its exact quote from its own
 * simulation once they are confirmed: those gates run when the route prepares it (`useRoute`).
 */
const LATER_STEP_SKIPS = new Set<BlockerCode>(["amount", "balance", "quote", "archived"])

/** Whether an amount reads no step output other than step 1's. */
const readsOnlyFirst = (src: AmountSource): boolean => (src.from === "step" ? src.index === 0 : src.from === "sum" ? src.parts.every(readsOnlyFirst) : true)
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

const dedupe = (list: Blocker[]) => list.filter((b, i) => list.findIndex((o) => o.code === b.code && o.message === b.message) === i)
const rank = (b: Blocker) => BLOCKER_ORDER.indexOf(b.code)

/** A step's input before the route starts, and whether its amount is the step's own (`known`). */
export type PreStartDraft = { input: ActionInput; known: boolean }

/**
 * A step's input with no floors and no deadline, as the gates see it before the start. Its `requires`
 * checks (what an earlier step must have produced) run when the route prepares it; they are left out
 * here, so a step whose amount is a value (Buy YT's sy_in, Keep YT's split) is gated on that amount.
 * A step whose amount comes from an earlier one stands in with the request's, and is not `known`:
 * what it deposits or reports is then unknown to the steps after it.
 */
export function preStartDraft(plan: StepPlan, request: RouteRequest): PreStartDraft {
  let amounts: { amount: bigint; secondaryAmount?: bigint }
  let known = true
  try {
    amounts = resolveStep({ ...plan, requires: [] }, request, [])
  } catch {
    amounts = { amount: request.amount }
    known = false
  }
  const input: ActionInput = {
    action: plan.action,
    marketId: request.marketId,
    source: request.source,
    amount: amounts.amount,
    ...(amounts.secondaryAmount !== undefined ? { secondaryAmount: amounts.secondaryAmount } : {}),
    guards: {},
    deadline: 0n,
  }
  return { input, known }
}

/** A step this release offers (R47): one that is not is never simulated. */
export const isOffered = (input: ActionInput | null): input is ActionInput => input !== null && !ACTION_META[input.action].disabled

/** The amount field's check (`checkAmount`): its refusal replaces the amount and balance gates. */
export type AmountFieldCheck = { ok: true } | { ok: false; code: "amount" | "balance"; message: string }

export type PreStartInput = {
  /** The route's steps; empty when the planner refused it. */
  plans: StepPlan[]
  /** Why the planner refused the route (`RouteDisabled.disabled`), if it did. */
  disabled?: string
  request: RouteRequest
  /** Every gate input but the simulation (`useGateContext`'s `base`). */
  base: Omit<GateContext, "simulation">
  /** Step 1's simulation as the user, for this exact request; absent until it has run. */
  simOutcome?: SimulationOutcome
  /** Step 1's simulated output, validated for its action. */
  simOutput?: ActionOutput
  /** The floors derived from that output at the user's slippage; a refusal is a `quote` blocker. */
  simGuards?: GuardResult
  /** The amount field. Absent: the request's amount is valid, and complete when above zero. */
  trade?: { check: AmountFieldCheck }
}

/** What a step adds to a running total: unknown once its own amount is a stand-in. */
const counted = (total: bigint | undefined, adds: bigint | undefined, known: boolean): bigint | undefined =>
  total === undefined || adds === undefined || (!known && adds !== 0n) ? undefined : total + adds

/** Every reason the route may not start now, deduplicated, in 0001's order; the amount field's own refusal first. */
export function routePreStartBlockers(p: PreStartInput): Blocker[] {
  const { plans, request, base } = p
  const check = p.trade?.check ?? { ok: true }
  const complete = check.ok && request.amount > 0n
  const drafts = plans.map((plan) => preStartDraft(plan, request))
  const firstDraft = drafts[0]
  const offered = isOffered(firstDraft?.input ?? null)

  let list: Blocker[] = p.disabled ? [{ code: "disabled", message: p.disabled }] : []
  if (firstDraft) {
    list.push(...evaluateGates(firstDraft.input, { ...base, simulation: p.simOutcome }))
    if (p.simGuards && !p.simGuards.ok) list.push({ code: "quote", message: p.simGuards.reason })
  }
  // R2-61: RiskControl counts every step of the route in the same window, and R2-62: every deposit
  // of the route (wrap_and_mint's included) is charged against the same deposit cap. So each later
  // step is checked with what the steps before it report and charge already added.
  let reported: bigint | undefined = firstDraft ? counted(0n, breakerReport(firstDraft.input, base), firstDraft.known) : 0n
  let charged: bigint | undefined = firstDraft ? counted(0n, capCharge(firstDraft.input), firstDraft.known) : 0n
  // What the whole route deposits, for a cap refusal said at route level (undefined: not known).
  const routeDeposits = drafts.reduce<bigint | undefined>((total, d) => counted(total, capCharge(d.input), d.known), 0n)
  drafts.slice(1).forEach(({ input: draft, known }, k) => {
    const n = k + 2
    const seen = withEarlierCapCharges(withEarlierReports(base, reported, n), charged, n)
    const found = evaluateGates(draft, seen).filter((b) => !LATER_STEP_SKIPS.has(b.code))
    const label = ACTION_META[draft.action].label
    for (const b of found) {
      if (b.code === "risk") list.push({ ...b, message: `Step ${n} (${label}), counted after the steps before it: ${lowerFirst(b.message)}` })
      else if (b.code === "cap") {
        // Said for the route: the steps before this one have not deposited anything yet.
        const total = routeDeposits ?? (charged ?? 0n) + capCharge(draft)
        list.push(routeCapBlocker(total, base.account) ?? b)
      } else list.push(b)
    }
    reported = counted(reported, breakerReport(draft, base), known)
    charged = counted(charged, capCharge(draft), known)
  })
  // A later step's `requires` that reads only step 1's output is checked against step 1's
  // simulation, so a step 1 that gives too little is refused before its signature, not at step 2.
  const firstOut = p.simOutput
  if (firstOut) {
    plans.slice(1).forEach((plan, k) => {
      const checks = (plan.requires ?? []).filter((r) => readsOnlyFirst(r.value) && readsOnlyFirst(r.atLeast))
      if (checks.length === 0) return
      try {
        resolveStep({ ...plan, amount: { from: "value", value: 0n }, secondaryAmount: undefined, requires: checks }, request, [firstOut])
      } catch {
        list.push({
          code: "quote",
          message: `Step ${k + 2} (${ACTION_META[plan.action].label}) needs more than step 1 gives, as simulated now, so the route is not started: it would stop after step 1. Try again in a moment, or change the amount.`,
        })
      }
    })
  }
  // Nothing is simulated until the amount is complete, nor for a step that is not offered.
  if (!complete || !offered) list = list.filter((b) => b.code !== "quote")
  if (!check.ok) {
    // The gates saw 0 for an amount that does not parse; the field's own refusal replaces theirs.
    list = [{ code: check.code, message: check.message }, ...list.filter((b) => b.code !== "amount" && b.code !== "balance")]
  }
  return dedupe(list).sort((a, b) => rank(a) - rank(b))
}
