"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useReportFlowBusy } from "@/components/app/manage/flow-busy"
import { ReviewDialog } from "@/components/app/actions/review-dialog"
import { showTxToast } from "@/components/app/actions/tx-feedback"
import { useExecute } from "@/hooks/use-execute"
import { noticeForError, noticeForResult } from "@/lib/app/tx-notice"
import { userErrorMessage } from "@/lib/protocol/errors"
import type { Blocker } from "@/lib/protocol/gates"
import type { ManagerCall } from "@/lib/protocol/manager-calls"
import { isExpired, SIGN_MARGIN_MS, type ManagerReview } from "@/lib/protocol/review"
import type { Network } from "@/lib/protocol/types"

type Flow =
  | { step: "idle" }
  | { step: "preparing"; i: number }
  | { step: "review"; i: number; review: ManagerReview }
  | { step: "signing"; i: number; review: ManagerReview }
  | { step: "error"; i: number; message: string }

/**
 * A step built only when its turn comes, once the step before it has confirmed (plan 0005 Task 8):
 * the seed's calls take their floors from a simulation run then, since the pool's first deposit cannot
 * be simulated before the mint and the deposit have landed. A build that throws stops the flow with
 * its message; nothing of that step is prepared or signed.
 */
export type DeferredCall = { build(): Promise<ManagerCall> }
export type ManagerStep = ManagerCall | DeferredCall

const isDeferred = (step: ManagerStep): step is DeferredCall => "build" in step

export type ManagerSignFlowProps = {
  /** The button's text. */
  label: string
  /** What the dialog and the toasts call this action ("Claim creator fees"). */
  title: string
  /** One transaction per call, signed one after the other: each has its own review. */
  steps: ManagerStep[]
  /** The live reasons `call` may not be signed now; any of them turns signing off. */
  blockersFor(call: ManagerCall): Blocker[]
  disabled?: boolean
  ledgerTime: number | null
  network: Network
}

const errorText = (error: unknown) => userErrorMessage(error)

/**
 * Review → sign for manager calls (0002 §5), the manager view's counterpart of `SignFlow`. Each
 * step is prepared with `useExecute().prepareManager`, shown with its label, and the very
 * `ManagerReview` object it returned is handed to `execute` (R31). Several steps run strictly in
 * order: each is a separate transaction with its own simulation and checks, so each is reviewed
 * and signed on its own, and the next is prepared only after the previous one confirmed. A step
 * that fails, is cancelled or is refused stops the sequence. The steps are fixed when the flow
 * starts, so a figure that changes meanwhile cannot change what is signed.
 */
export function ManagerSignFlow(props: ManagerSignFlowProps) {
  const exec = useExecute()
  const { prepareManager } = exec
  const [flow, setFlow] = useState<Flow>({ step: "idle" })
  const [nowMs, setNowMs] = useState<number | null>(null)
  // The steps fixed at start: in state for rendering, mirrored in a ref for the async paths. A
  // deferred step's call is known once it is built (`built`, by index).
  const [runSteps, setRunSteps] = useState<ManagerStep[]>([])
  const stepsRef = useRef<ManagerStep[]>([])
  const [built, setBuilt] = useState<(ManagerCall | undefined)[]>([])
  const builtRef = useRef<(ManagerCall | undefined)[]>([])
  const reviewRef = useRef<ManagerReview | null>(null)
  const prepareSeq = useRef(0)
  const busy = useRef(false)
  const latest = useRef(props)
  useEffect(() => {
    latest.current = props
  })

  const prepare = useCallback(
    async (i: number) => {
      const seq = ++prepareSeq.current
      reviewRef.current = null
      setFlow({ step: "preparing", i })
      try {
        const step = stepsRef.current[i]
        // A deferred step is built again each time it is prepared (a review older than 60 s too).
        const call = isDeferred(step) ? await step.build() : step
        if (seq !== prepareSeq.current) return
        builtRef.current = builtRef.current.map((c, n) => (n === i ? call : c))
        setBuilt(builtRef.current)
        const review = await prepareManager(call)
        if (seq !== prepareSeq.current) return
        reviewRef.current = review
        setFlow({ step: "review", i, review })
      } catch (error) {
        if (seq === prepareSeq.current) setFlow({ step: "error", i, message: errorText(error) })
      }
    },
    [prepareManager],
  )

  const start = () => {
    if (flow.step !== "idle" || props.disabled || props.steps.length === 0) return
    stepsRef.current = props.steps
    setRunSteps(props.steps)
    builtRef.current = props.steps.map((step) => (isDeferred(step) ? undefined : step))
    setBuilt(builtRef.current)
    void prepare(0)
  }

  const close = () => {
    if (flow.step === "signing") return
    prepareSeq.current++
    reviewRef.current = null
    setFlow({ step: "idle" })
  }

  // A review older than 60 s is prepared again, so what is signed reflects the live conditions.
  useEffect(() => {
    if (flow.step !== "review") return
    const { review, i } = flow
    const id = setInterval(() => {
      const now = Date.now()
      setNowMs(now)
      if (isExpired(review, now)) void prepare(i)
    }, 1_000)
    return () => clearInterval(id)
  }, [flow, prepare])

  const sign = async () => {
    if (flow.step !== "review" || busy.current) return
    const review = reviewRef.current
    const { i } = flow
    const call = builtRef.current[i]
    if (review === null || review !== flow.review || call === undefined) return
    if (latest.current.disabled || latest.current.blockersFor(call).length > 0) return
    if (isExpired(review, Date.now() + SIGN_MARGIN_MS)) {
      void prepare(i)
      return
    }
    busy.current = true
    prepareSeq.current++
    reviewRef.current = null
    setFlow({ step: "signing", i, review })
    const { title, network } = latest.current
    const many = stepsRef.current.length > 1
    const name = many ? `${title} (step ${i + 1} of ${stepsRef.current.length})` : title
    let ok = false
    try {
      const result = await exec.execute(review)
      ok = result.status === "SUCCESS"
      showTxToast(noticeForResult(name, result, network))
    } catch (error) {
      showTxToast(noticeForError(name, error, network))
    }
    busy.current = false
    if (ok && i + 1 < stepsRef.current.length) void prepare(i + 1)
    else setFlow({ step: "idle" })
  }

  const active = flow.step === "idle" ? null : flow
  // The wizard keeps its step mounted while a review or signature is open (flow-busy.tsx).
  useReportFlowBusy(active !== null)
  const call = active ? built[active.i] : undefined
  const blockers = call ? props.blockersFor(call) : []
  const shown = flow.step === "review" || flow.step === "signing" ? flow.review : null
  const secondsLeft =
    shown && nowMs !== null && nowMs >= shown.preparedAtMs ? Math.max(0, Math.ceil((shown.expiresAtMs - nowMs) / 1000)) : null
  const total = runSteps.length

  return (
    <>
      <Button type="button" variant="secondary" disabled={props.disabled || props.steps.length === 0 || flow.step !== "idle"} onClick={start}>
        {props.label}
      </Button>
      <ReviewDialog
        open={flow.step !== "idle"}
        title={props.title}
        phase={flow.step === "idle" ? "preparing" : flow.step}
        review={shown}
        error={flow.step === "error" ? flow.message : undefined}
        blockers={blockers}
        ledgerTime={props.ledgerTime}
        secondsLeft={secondsLeft}
        pending={exec.pending}
        canSign={!props.disabled && blockers.length === 0}
        note={active && total > 1 ? `Step ${active.i + 1} of ${total}` : undefined}
        onSign={() => void sign()}
        onClose={close}
      />
    </>
  )
}
