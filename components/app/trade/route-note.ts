import { ACTION_META } from "@/lib/protocol/actions"
import type { StepPlan } from "@/lib/protocol/routes"
import type { TradeQuote } from "@/lib/protocol/trade-adapter"

/** One step in plain words: its action, and what it gives and takes. */
const stepText = (plan: StepPlan) => `${ACTION_META[plan.action].label} (you give ${plan.gives}, you get ${plan.takes})`

export type RouteNote = {
  /** How many signatures the route takes: the number of steps the adapter planned (R2-55). */
  signatures: number
  /** The steps in plain words: the tip on the "Signatures" row. */
  route: string
  /** Which figures are exact and which are indicative, or null when there is no quote yet: the tip on the exactness badge. */
  exactness: string | null
}

/**
 * The route in plain words, built from the steps the adapter planned (never from an assumed route
 * shape), and which figures are exact (R2-55). Shared by the PT, YT and LP tabs. The route text sits
 * behind the "Signatures" row's info tip and the exactness text behind the badge's (R2-65).
 */
export function routeNote(p: { plans: StepPlan[]; q: TradeQuote | undefined; connected: boolean; pending: boolean }): RouteNote | null {
  const { plans, q, connected, pending } = p
  if (plans.length === 0) return null
  const route =
    plans.length === 1
      ? `This is one step, one signature: ${stepText(plans[0])}.`
      : `This takes ${plans.length} signatures, one per step: ${plans.map((plan, i) => `step ${i + 1}, ${stepText(plan)}`).join("; ")}.`
  const note = (exactness: string | null): RouteNote => ({ signatures: plans.length, route, exactness })
  if (!q) return note(null)
  if (q.exactness === "simulated") return note("The amount you receive is exact: it was simulated as your account.")
  if (q.swapOut?.exactness === "simulated") {
    return note(
      `Step ${q.swapOut.step}'s output is exact (simulated); what the later steps give is worked out at today's rates, and each gets its own minimum when it is prepared.`,
    )
  }
  const later = plans.length > 1 ? " Each step after the first is signed with an exact amount and minimum from its own simulation, once the step before it is confirmed." : ""
  const exact = !connected ? " Connect a wallet for an exact quote." : pending ? " Getting an exact quote…" : ""
  return note(`The figures are indicative, from this app's copy of the pool's math on its current state.${later}${exact}`)
}

/** The "Signatures" row: the count, with the route behind its tip. */
export const signaturesLine = (note: RouteNote): { label: string; value: string; hint: string } => ({
  label: "Signatures",
  value: String(note.signatures),
  hint: note.route,
})
