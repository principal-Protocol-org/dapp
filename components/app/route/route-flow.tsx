"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { GateList } from "@/components/app/actions/gate-list"
import { RestoreBanner, type RestoreStep } from "@/components/app/actions/restore-banner"
import { showTxToast } from "@/components/app/actions/tx-feedback"
import { RouteProgress } from "@/components/app/route/route-progress"
import { RouteReviewDialog } from "@/components/app/route/route-review-dialog"
import { useExecute } from "@/hooks/use-execute"
import { useRoute, type UseRouteOptions } from "@/hooks/use-route"
import { noticeForError, noticeForResult, type TxNotice } from "@/lib/app/tx-notice"
import type { Blocker } from "@/lib/protocol/gates"
import type { RestoreReview } from "@/lib/protocol/review"
import type { RouteRequest, StepPlan } from "@/lib/protocol/routes"
import type { Network } from "@/lib/protocol/types"

export type RouteFlowProps = {
  /** Connected account, market and the per-step gate; handed to `useRoute`. */
  account: string | null
  marketId: string
  /**
   * The panel's 0001 gates for one step. It MUST pass the simulation through:
   * `(input, simulation) => evaluateGates(input, { ...base, simulation })`.
   */
  gate: UseRouteOptions["gate"]
  /** What the user asked for; null while the form is not valid. */
  request: RouteRequest | null
  plans: StepPlan[]
  /** The form is valid and every gate passes for starting. */
  canStart: boolean
  /** Why starting is off (shown while idle). */
  blockers: Blocker[]
  network: Network
  /** Short title, e.g. "Buy PT". */
  label: string
  onNotice(notice: TxNotice): void
  /** Step 1 reached the network (R2-3): the panel resets its amount fields here. */
  onReachedNetwork?: UseRouteOptions["onReachedNetwork"]
}

/**
 * Everything a panel renders for a multi-step route: the start button, the whole-route review
 * before the first signature, "Step n of m" progress, per-step signing, the waiting and
 * interrupted panels, and 0001's restore flow when a step is stopped by an archived entry. It owns
 * `useRoute`, so the host passes only account, market, `gate` and the plans.
 */
export function RouteFlow(props: RouteFlowProps) {
  const route = useRoute({ account: props.account, marketId: props.marketId, gate: props.gate, onReachedNetwork: props.onReachedNetwork })
  const exec = useExecute()
  const { state } = route
  const latest = useRef(props)
  useEffect(() => {
    latest.current = props
  })

  const [restore, setRestore] = useState<RestoreStep>({ step: "idle" })
  const restoreRef = useRef<RestoreReview | null>(null)

  // A done route is announced once.
  const announced = useRef<string | null>(null)
  const doneId = state.phase === "done" ? (state.run?.id ?? null) : null
  useEffect(() => {
    if (!doneId || announced.current === doneId) return
    announced.current = doneId
    const notice: TxNotice = { tone: "success", title: `${latest.current.label}: all steps confirmed.` }
    showTxToast(notice)
    latest.current.onNotice(notice)
  }, [doneId])

  const fail = (label: string, error: unknown) => {
    const notice = noticeForError(label, error, props.network)
    setRestore({ step: "failed", notice })
  }
  const startRestore = async () => {
    if (!state.restore) return
    restoreRef.current = null
    setRestore({ step: "preparing" })
    try {
      const prepared = await exec.prepareRestore(state.restore)
      restoreRef.current = prepared
      setRestore({ step: "ready", restore: prepared })
    } catch (error) {
      fail("The restore", error)
    }
  }
  const signRestore = async () => {
    const prepared = restoreRef.current
    if (restore.step !== "ready" || !prepared || prepared !== restore.restore) return
    restoreRef.current = null
    setRestore({ step: "signing", restore: prepared })
    try {
      const result = await exec.executeRestore(prepared)
      const notice = noticeForResult("Restore", result, props.network)
      showTxToast(notice)
      props.onNotice(notice)
      if (result.status === "SUCCESS") {
        setRestore({ step: "idle" })
        route.continue()
      } else {
        setRestore({ step: "failed", notice })
      }
    } catch (error) {
      fail("The restore", error)
    }
  }

  const reviewing = state.phase === "reviewing" || state.phase === "signing"
  const start = () => props.request && route.start(props.request, props.plans)

  return (
    <div className="grid gap-3">
      {state.phase === "idle" ? (
        <>
          <Button type="button" className="w-full" disabled={!props.canStart || !props.request || props.plans.length === 0} onClick={start}>
            Review {props.label}
          </Button>
          {props.blockers.length > 0 ? <GateList blockers={props.blockers} /> : null}
        </>
      ) : null}
      {state.phase === "interrupted" && state.restore ? (
        <RestoreBanner
          needed
          flow={restore}
          restored={false}
          onStart={() => void startRestore()}
          onSign={() => void signRestore()}
          onCancel={() => {
            restoreRef.current = null
            setRestore({ step: "idle" })
          }}
        />
      ) : null}
      <RouteProgress route={route} />
      {reviewing && state.run ? (
        <RouteReviewDialog
          title={props.label}
          plans={state.run.plans}
          steps={state.run.steps}
          step={state.step}
          review={state.review}
          secondsLeft={state.secondsLeft}
          signing={state.phase === "signing"}
          blockers={state.blockers ?? []}
          onSign={route.sign}
          onClose={route.dismiss}
        />
      ) : null}
    </div>
  )
}
