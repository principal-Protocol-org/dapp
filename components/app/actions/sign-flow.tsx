"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { RestoreBanner, type RestoreStep } from "@/components/app/actions/restore-banner"
import { ReviewDialog } from "@/components/app/actions/review-dialog"
import { showTxToast } from "@/components/app/actions/tx-feedback"
import { useExecute } from "@/hooks/use-execute"
import { noticeForError, noticeForResult, type TxNotice } from "@/lib/app/tx-notice"
import type { ActionInput } from "@/lib/protocol/actions"
import type { Blocker } from "@/lib/protocol/gates"
import { isExpired, type RestoreReview, type Review } from "@/lib/protocol/review"
import type { ContractInvocation } from "@/lib/protocol/stellar"
import type { Network } from "@/lib/protocol/types"

type Flow =
  | { step: "idle" }
  | { step: "preparing" }
  | { step: "review"; review: Review }
  | { step: "signing"; review: Review }
  | { step: "error"; message: string }

export type SignFlowProps = {
  label: string
  /** Inputs valid, exact quote in with usable floors, and no blocker. */
  canReview: boolean
  /** The live blockers: shown in the dialog, and any of them turns signing off. */
  blockers: Blocker[]
  /** The input to sign now (draft, floors from the simulation, ledger-time deadline), or null. */
  buildInput(): ActionInput | null
  /** The simulated call, when its simulation asked for a restore. */
  restoreCall: { source: string; invocation: ContractInvocation } | null
  /** A restore landed: simulate again. */
  onRestored(): void
  onNotice(notice: TxNotice): void
  ledgerTime: number | null
  network: Network
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const NOT_READY = "The checks no longer all pass, so this was not prepared. Close this and review again once they do."

/**
 * The review and restore lifecycle of one panel. The panel mounts it with a `key` made of
 * everything the review is bound to (market, action, wallet address and network, amounts,
 * slippage, deadline): any change unmounts it, which discards an open review or restore before it
 * can be signed (Review Focus 2).
 *
 * R31: the object `prepare` returned is kept in a ref and handed, as is, to `execute`. One attempt
 * per review: it is dropped as signing starts, whatever the outcome.
 */
export function SignFlow(props: SignFlowProps) {
  const exec = useExecute()
  const { prepare } = exec
  const [flow, setFlow] = useState<Flow>({ step: "idle" })
  const [restore, setRestore] = useState<RestoreStep>({ step: "idle" })
  const [restored, setRestored] = useState(false)
  const [nowMs, setNowMs] = useState<number | null>(null)
  const reviewRef = useRef<Review | null>(null)
  const restoreRef = useRef<RestoreReview | null>(null)
  const prepareSeq = useRef(0)
  const busy = useRef(false)
  const latest = useRef(props)
  useEffect(() => {
    latest.current = props
  })

  const runPrepare = useCallback(async () => {
    const seq = ++prepareSeq.current
    reviewRef.current = null
    const input = latest.current.buildInput()
    if (!input) {
      setFlow({ step: "error", message: NOT_READY })
      return
    }
    try {
      const review = await prepare(input)
      if (seq !== prepareSeq.current) return
      reviewRef.current = review
      setFlow({ step: "review", review })
    } catch (error) {
      if (seq === prepareSeq.current) setFlow({ step: "error", message: errorText(error) })
    }
  }, [prepare])

  const startReview = () => {
    if (!props.canReview || flow.step !== "idle") return
    setFlow({ step: "preparing" })
    void runPrepare()
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
    const review = flow.review
    const id = setInterval(() => {
      const now = Date.now()
      setNowMs(now)
      if (isExpired(review, now)) {
        setFlow({ step: "preparing" })
        void runPrepare()
      }
    }, 1_000)
    return () => clearInterval(id)
  }, [flow, runPrepare])

  const sign = async () => {
    const review = reviewRef.current
    if (flow.step !== "review" || review === null || review !== flow.review || busy.current) return
    if (latest.current.blockers.length > 0) return
    if (isExpired(review, Date.now())) {
      setFlow({ step: "preparing" })
      void runPrepare()
      return
    }
    busy.current = true
    prepareSeq.current++
    reviewRef.current = null
    setFlow({ step: "signing", review })
    let notice: TxNotice
    try {
      notice = noticeForResult(latest.current.label, await exec.execute(review), latest.current.network)
    } catch (error) {
      notice = noticeForError(latest.current.label, error, latest.current.network)
    }
    busy.current = false
    setFlow({ step: "idle" })
    showTxToast(notice)
    latest.current.onNotice(notice)
  }

  const startRestore = async () => {
    const call = props.restoreCall
    if (!call || busy.current) return
    restoreRef.current = null
    setRestore({ step: "preparing" })
    try {
      const prepared = await exec.prepareRestore(call)
      restoreRef.current = prepared
      setRestore({ step: "ready", restore: prepared })
    } catch (error) {
      setRestore({ step: "failed", notice: noticeForError("The restore", error, props.network) })
    }
  }

  const signRestore = async () => {
    const prepared = restoreRef.current
    if (restore.step !== "ready" || prepared === null || prepared !== restore.restore || busy.current) return
    if (isExpired(prepared, Date.now())) {
      void startRestore()
      return
    }
    busy.current = true
    restoreRef.current = null
    setRestore({ step: "signing", restore: prepared })
    try {
      const result = await exec.executeRestore(prepared)
      const notice = noticeForResult("Restore", result, latest.current.network)
      showTxToast(notice)
      if (result.status === "SUCCESS") {
        setRestore({ step: "idle" })
        setRestored(true)
        latest.current.onRestored()
      } else {
        setRestore({ step: "failed", notice })
      }
    } catch (error) {
      setRestore({ step: "failed", notice: noticeForError("The restore", error, latest.current.network) })
    } finally {
      busy.current = false
    }
  }

  // After a restore, the action is prepared again once its new simulation passes every gate.
  const canReview = props.canReview
  useEffect(() => {
    if (!restored || !canReview) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      setRestored(false)
      setFlow({ step: "preparing" })
      void runPrepare()
    })
    return () => {
      cancelled = true
    }
  }, [restored, canReview, runPrepare])

  const shown = flow.step === "review" || flow.step === "signing" ? flow.review : null
  const secondsLeft =
    shown && nowMs !== null && nowMs >= shown.preparedAtMs ? Math.max(0, Math.ceil((shown.expiresAtMs - nowMs) / 1000)) : null

  return (
    <div className="grid gap-3">
      <RestoreBanner
        needed={props.restoreCall !== null}
        flow={restore}
        restored={restored}
        onStart={() => void startRestore()}
        onSign={() => void signRestore()}
        onCancel={() => {
          restoreRef.current = null
          setRestore({ step: "idle" })
        }}
      />
      <Button type="button" className="w-full" disabled={!props.canReview || flow.step !== "idle"} onClick={startReview}>
        Review {props.label}
      </Button>
      <ReviewDialog
        open={flow.step !== "idle"}
        title={props.label}
        phase={flow.step === "idle" ? "preparing" : flow.step}
        review={shown}
        error={flow.step === "error" ? flow.message : undefined}
        blockers={props.blockers}
        ledgerTime={props.ledgerTime}
        secondsLeft={secondsLeft}
        pending={exec.pending}
        onSign={() => void sign()}
        onClose={close}
      />
    </div>
  )
}
