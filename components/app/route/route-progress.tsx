"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { GateList } from "@/components/app/actions/gate-list"
import { RouteSteps } from "@/components/app/route/route-review-dialog"
import type { RouteControls } from "@/hooks/use-route"

/** A confirmed or unknown step means funds may sit between steps. */
const holdsFunds = (state: RouteControls["state"]) =>
  !!state.run?.steps.some((s) => s.status === "confirmed" || s.status === "unknown") && state.phase !== "done"

/**
 * "Step n of m" and what to do next, for a route that is waiting, interrupted or done. While a
 * route holds funds, Dismiss shows only after the holdings sentence is on screen, and asks for an
 * explicit confirmation (R2-24); the run stays in History either way.
 */
export function RouteProgress({ route }: { route: RouteControls }) {
  const { state } = route
  const [confirming, setConfirming] = useState(false)
  if (state.phase === "idle" || state.phase === "reviewing" || state.phase === "signing" || !state.run) return null
  const plans = state.run.plans
  const funds = holdsFunds(state)
  const dismissible = state.canDismiss && (!funds || !!state.holdings)
  const close = () => {
    setConfirming(false)
    route.dismiss()
  }
  return (
    <section aria-label="Route progress" className="grid gap-3 rounded-lg border border-line p-3 text-sm text-ink wrap-anywhere">
      <h3 className="font-medium">
        {state.phase === "done"
          ? `${state.run.unwound ? "Turned back into USDY" : "Route complete"}: ${state.of} of ${state.of} steps confirmed`
          : `Step ${state.step} of ${state.of}`}
      </h3>
      <RouteSteps plans={plans} steps={state.run.steps} current={state.phase === "done" ? 0 : state.step} />
      {state.error ? (
        <p role="alert" className="text-negative">
          {state.error}
        </p>
      ) : null}
      {state.blockers && state.blockers.length > 0 ? <GateList blockers={state.blockers} /> : null}
      {state.holdings ? <p className="font-medium">{state.holdings}</p> : null}
      {state.checking ? <p role="status">Checking the network for this step…</p> : null}

      {state.phase === "waiting" ? (
        <Button type="button" variant="secondary" className="w-fit" disabled={state.checking} onClick={route.continue}>
          Check again
        </Button>
      ) : null}
      {state.phase === "interrupted" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={route.continue}>
            Continue
          </Button>
          {state.unwind?.available ? (
            <Button type="button" variant="secondary" onClick={route.unwind}>
              Back to USDY
            </Button>
          ) : state.unwind ? (
            <p className="text-ink-muted">{state.unwind.reason}</p>
          ) : null}
        </div>
      ) : null}

      {dismissible && !confirming ? (
        <Button type="button" variant="secondary" className="w-fit" onClick={() => (funds ? setConfirming(true) : close())}>
          {state.phase === "done" ? "Close" : "Dismiss"}
        </Button>
      ) : null}
      {dismissible && confirming ? (
        <div role="alertdialog" aria-label="Close this route" className="grid gap-2 rounded-lg border border-line bg-surface-sunk p-3">
          <p>
            Close anyway? {state.holdings} The route stays in History so you can continue it later.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={close}>
              Close anyway
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
              Keep route open
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
