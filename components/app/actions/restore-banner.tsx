"use client"

import { Button } from "@/components/ui/button"
import { TxNoticeView } from "@/components/app/actions/tx-feedback"
import type { TxNotice } from "@/lib/app/tx-notice"
import { formatAmount } from "@/lib/protocol/format"
import type { RestoreReview } from "@/lib/protocol/review"

export const RESTORE_NEEDED = "Some contract data has expired — restore it first (one extra signature)"

export type RestoreStep =
  | { step: "idle" }
  | { step: "preparing" }
  | { step: "ready"; restore: RestoreReview }
  | { step: "signing"; restore: RestoreReview }
  | { step: "failed"; notice: TxNotice }

/** Stroops to XLM, every decimal. A malformed fee shows as such rather than as a number. */
function xlm(stroops: string): string {
  return /^\d+$/.test(stroops) ? `${formatAmount(BigInt(stroops), 7, 7)} XLM` : "unknown (refuse to sign)"
}

/**
 * Review Focus 5: an archived-entry simulation offers a restore first. The restore is prepared,
 * its fee shown, then signed; once it lands the action is simulated and prepared again.
 */
export function RestoreBanner({
  needed,
  flow,
  restored,
  onStart,
  onSign,
  onCancel,
}: {
  /** The latest simulation of this input reported archived entries. */
  needed: boolean
  flow: RestoreStep
  /** A restore landed; the action is waiting to be prepared again. */
  restored: boolean
  onStart(): void
  onSign(): void
  onCancel(): void
}) {
  if (!needed && flow.step === "idle") {
    return restored ? (
      <p role="status" className="text-sm text-ink">
        Contract data restored. The action is simulated and prepared again as soon as every check passes.
      </p>
    ) : null
  }
  const pending = flow.step === "ready" || flow.step === "signing" ? flow.restore : null
  return (
    <section aria-label="Restore archived data" className="grid gap-3 rounded-lg border border-coupon bg-coupon-wash p-3 text-sm text-ink">
      <p className="font-medium">{RESTORE_NEEDED}</p>
      <p className="text-ink-muted">
        The network archives contract data that has not been used for a while. A restore transaction brings it back; then
        this action is prepared again.
      </p>
      {flow.step === "preparing" ? <p>Preparing the restore…</p> : null}
      {pending ? (
        <>
          <p className="font-mono tabular-nums">Network fee: up to {xlm(pending.fee)}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={onSign} disabled={flow.step === "signing"}>
              Sign restore
            </Button>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={flow.step === "signing"}>
              Cancel
            </Button>
          </div>
          {flow.step === "signing" ? <p className="text-ink-muted">Waiting for Freighter…</p> : null}
        </>
      ) : null}
      {flow.step === "failed" ? <TxNoticeView notice={flow.notice} /> : null}
      {(flow.step === "idle" || flow.step === "failed") && needed ? (
        <Button type="button" variant="secondary" className="w-fit" onClick={onStart}>
          Restore contract data
        </Button>
      ) : null}
    </section>
  )
}
