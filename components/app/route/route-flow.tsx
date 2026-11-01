"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { GateList } from "@/components/app/actions/gate-list"
import { RestoreBanner, type RestoreStep } from "@/components/app/actions/restore-banner"
import { showTxToast } from "@/components/app/actions/tx-feedback"
import { RouteProgress } from "@/components/app/route/route-progress"
import { RouteReviewDialog } from "@/components/app/route/route-review-dialog"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useExecute } from "@/hooks/use-execute"
import { useRoute, type UseRouteOptions } from "@/hooks/use-route"
import { noticeForError, noticeForResult, type TxNotice } from "@/lib/app/tx-notice"
import type { Blocker } from "@/lib/protocol/gates"
import type { RestoreReview } from "@/lib/protocol/review"
import type { RouteKind, RouteRequest, StepPlan } from "@/lib/protocol/routes"
import { useManifest } from "@/components/app/manifest-provider"

export type RouteFlowProps = {
  /** Connected account, market and the per-step gate; handed to `useRoute`. */
  account: string | null
  marketId: string
  /** The route kinds this host offers (R2-77): it shows and starts only these. */
  kinds: UseRouteOptions["kinds"]
  /** The run History's Continue names (`?route=<id>`), if any. */
  routeId?: string | null
  /**
   * The panel's 0001 gates for one step. It MUST pass the simulation through:
   * `(input, simulation) => evaluateGates(input, { ...base, simulation })`.
   */
  gate: UseRouteOptions["gate"]
  /** What the user asked for; null while the form is not valid. */
  request: RouteRequest | null
  /** The route the form builds, for the button's label while `request` is still null. */
  kind?: RouteKind
  plans: StepPlan[]
  /** The form is valid and every gate passes for starting. */
  canStart: boolean
  /** Why starting is off (shown while idle). */
  blockers: Blocker[]
  /**
   * False: no start button nor refusals while idle, for a form that is closed (the LP tab's Deposit,
   * the PT and YT tabs after maturity): nothing renders until a route resumed from the log shows its
   * progress. Default true.
   */
  showStart?: boolean
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
/**
 * Which route kinds each host shows and starts (R2-77). Disjoint, so no two hosts ever hold the
 * same run: the trade tabs and the Recombine dialogs can sit on one page and never act on one run.
 */
export const ROUTE_HOSTS = {
  pt: ["buy_pt", "sell_pt"],
  yt: ["buy_yt", "sell_yt"],
  lp: ["lp_keep_yt", "lp_only", "lp_withdraw"],
  recombine: ["recombine"],
} as const satisfies Record<string, readonly RouteKind[]>

const LABELS: Record<RouteKind, string> = {
  buy_pt: "Buy PT",
  sell_pt: "Sell PT",
  buy_yt: "Buy YT",
  sell_yt: "Sell YT",
  lp_keep_yt: "Add liquidity (keep YT)",
  lp_only: "Add liquidity",
  lp_withdraw: "Withdraw liquidity",
  split: "Split",
  recombine: "Recombine",
}

export function RouteFlow(props: RouteFlowProps) {
  const network = useManifest().network
  const { ledgerTime } = useLedgerClock()
  const route = useRoute({
    account: props.account,
    marketId: props.marketId,
    kinds: props.kinds,
    routeId: props.routeId,
    gate: props.gate,
    onReachedNetwork: props.onReachedNetwork,
  })
  const exec = useExecute()
  const { state } = route
  const kind = state.run?.kind ?? props.request?.kind ?? props.kind
  const label = kind ? LABELS[kind] : "route"
  const latest = useRef({ ...props, label })
  useEffect(() => {
    latest.current = { ...props, label }
  })

  const [restore, setRestore] = useState<RestoreStep>({ step: "idle" })
  const restoreRef = useRef<RestoreReview | null>(null)

  // A done route is announced once; one turned back into USDY says so (M1), never "all steps".
  const announced = useRef<string | null>(null)
  const doneId = state.phase === "done" ? (state.run?.id ?? null) : null
  const unwound = state.run?.unwound === true
  useEffect(() => {
    if (!doneId || announced.current === doneId) return
    announced.current = doneId
    const title = unwound ? `${latest.current.label} stopped and turned back into USDY.` : `${latest.current.label}: all steps confirmed.`
    const notice: TxNotice = { tone: "success", title }
    showTxToast(notice)
    latest.current.onNotice(notice)
  }, [doneId, unwound])

  const fail = (label: string, error: unknown) => {
    const notice = noticeForError(label, error, network)
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
      const notice = noticeForResult("Restore", result, network)
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
  // A closed form keeps the route mounted, so a run resumed from the log shows; until then, nothing.
  if (state.phase === "idle" && props.showStart === false) return null

  return (
    <div className="grid gap-3">
      {state.phase === "idle" && props.showStart !== false ? (
        <>
          <Button type="button" className="w-full" disabled={!props.canStart || !props.request || props.plans.length === 0} onClick={start}>
            Review {label}
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
          title={label}
          plans={state.run.plans}
          steps={state.run.steps}
          step={state.step}
          review={state.review}
          secondsLeft={state.secondsLeft}
          ledgerTime={ledgerTime}
          phase={state.phase as "reviewing" | "signing"}
          signing={state.phase === "signing"}
          blockers={state.blockers ?? []}
          onSign={route.sign}
          onClose={route.dismiss}
        />
      ) : null}
    </div>
  )
}
