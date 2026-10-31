"use client"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { GateList } from "@/components/app/actions/gate-list"
import { TechnicalDetails, TimeLimit } from "@/components/app/actions/review-parts"
import type { Blocker } from "@/lib/protocol/gates"
import type { Review } from "@/lib/protocol/review"
import type { StepPlan } from "@/lib/protocol/routes"
import type { RouteStep } from "@/lib/app/route-log"

function Lines({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="grid gap-0.5">
      <h4 className="label">{title}</h4>
      <ul className="grid gap-0.5 font-mono text-sm text-ink tabular-nums wrap-anywhere">
        {items.map((item, i) => (
          <li key={`${item}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

const STATUS_WORD: Record<RouteStep["status"], string> = {
  pending: "Not signed yet",
  unknown: "Sent, result not known yet",
  confirmed: "Confirmed",
  failed: "Failed",
}

/**
 * The whole route, before the first signature and at every step after: each step's plain-words
 * give and take, with the exact minimum for the step prepared now and, for the steps after it, the
 * plain statement that their minimum is set from a fresh quote once the previous step is confirmed
 * (spec 0002 §4: floors of steps 2+ never come from the first review).
 */
export function RouteSteps({
  plans,
  steps,
  current,
  review,
}: {
  plans: StepPlan[]
  steps?: RouteStep[]
  /** 1-based step prepared or on screen. */
  current: number
  review?: Review
}) {
  return (
    <ol aria-label="Route steps" className="grid gap-3">
      {plans.map((plan, i) => {
        const n = i + 1
        const status = steps?.[i]?.status
        const isCurrent = n === current
        return (
          <li
            key={`${plan.action}-${i}`}
            aria-current={isCurrent ? "step" : undefined}
            className={`grid gap-1 rounded-lg border p-3 text-sm wrap-anywhere ${isCurrent ? "border-ink" : "border-line"}`}
          >
            <p className="font-medium text-ink">
              Step {n} of {plans.length}
              {status && status !== "pending" ? <span className="text-ink-muted"> · {STATUS_WORD[status]}</span> : null}
            </p>
            <p className="text-ink">You give: {plan.gives}</p>
            <p className="text-ink">You get: {plan.takes}</p>
            {isCurrent && review ? (
              <p className="font-mono text-ink tabular-nums">At least: {review.summary.getAtLeast.join(", ") || "nothing"}</p>
            ) : n > current ? (
              <p className="text-ink-muted">
                Its minimum is set from a fresh quote once step {n - 1} is confirmed, not from this review.
              </p>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Reviewing and signing one step of a route. Opens as soon as the route is started, with the
 * whole route listed; the sign button names the step ("Sign step 1 of 3"). Closing it before
 * signing drops the unsigned review.
 */
export function RouteReviewDialog({
  title,
  plans,
  steps,
  step,
  phase,
  review,
  secondsLeft,
  ledgerTime,
  signing,
  blockers,
  onSign,
  onClose,
}: {
  title: string
  plans: StepPlan[]
  steps?: RouteStep[]
  step: number
  /** Signing needs the step reviewed (prepared, gates passed), not signing and not stopped. */
  phase: "reviewing" | "signing"
  review?: Review
  secondsLeft?: number
  ledgerTime: number | null
  signing: boolean
  blockers: Blocker[]
  onSign(): void
  onClose(): void
}) {
  const of = plans.length
  return (
    <Dialog open onOpenChange={(next) => !next && !signing && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" showCloseButton={!signing}>
        <DialogHeader>
          <DialogTitle>Review route: {title}</DialogTitle>
          <DialogDescription>
            This takes {of} {of === 1 ? "signature" : "signatures"}, one per step. Your wallet asks you to sign each step on its own.
          </DialogDescription>
        </DialogHeader>
        <RouteSteps plans={plans} steps={steps} current={step} review={review} />
        {review ? (
          <div className="grid gap-3">
            <Lines title={`Step ${step}: you give`} items={review.summary.give} />
            <Lines title={`Step ${step}: you get at least`} items={review.summary.getAtLeast} />
            <Lines title="Fees" items={review.summary.fees} />
            <TimeLimit deadline={review.summary.deadline} validUntil={review.summary.validUntil} ledgerTime={ledgerTime} />
            {secondsLeft !== undefined ? (
              <p className="text-xs text-ink-muted">
                This step is valid for {secondsLeft} more seconds; after that the route stops and you can prepare it again.
              </p>
            ) : null}
            <TechnicalDetails review={review} />
          </div>
        ) : (
          <p className="text-sm text-ink">Preparing step {step} with the network…</p>
        )}
        {blockers.length > 0 ? <GateList blockers={blockers} /> : null}
        <DialogFooter className="items-center">
          {signing ? <p className="text-sm text-ink-muted sm:mr-auto">Waiting for your wallet…</p> : null}
          <Button type="button" variant="secondary" onClick={onClose} disabled={signing}>
            Cancel
          </Button>
          <Button type="button" onClick={onSign} disabled={signing || phase !== "reviewing" || !review || blockers.length > 0}>
            Sign step {step} of {of}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
