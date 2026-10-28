"use client"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatDuration } from "@/components/app/live"
import { GateList } from "@/components/app/actions/gate-list"
import { formatUnixTime, shorten } from "@/lib/protocol/format"
import type { Blocker } from "@/lib/protocol/gates"
import type { Review } from "@/lib/protocol/review"

export type ReviewPhase = "preparing" | "review" | "signing" | "error"

function Group({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="grid gap-1">
      <h3 className="label">{title}</h3>
      <ul className="grid gap-0.5 font-mono text-sm text-ink tabular-nums">
        {items.map((item, i) => (
          <li key={`${item}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function Body({ review, ledgerTime, secondsLeft }: { review: Review; ledgerTime: number | null; secondsLeft: number | null }) {
  const { summary } = review
  const deadline = summary.deadline
  return (
    <div className="grid gap-4">
      <Group title="You give" items={summary.give} />
      <Group title="You get at least" items={summary.getAtLeast} />
      <Group title="Fees" items={summary.fees} />
      {deadline !== undefined ? (
        <div className="grid gap-1">
          <h3 className="label">Deadline</h3>
          <p className="text-sm text-ink">
            {formatUnixTime(deadline)}
            {ledgerTime !== null ? `, in ${formatDuration(deadline - ledgerTime)} by ledger time` : null}. After it the
            network refuses the transaction.
          </p>
        </div>
      ) : null}
      {secondsLeft !== null ? (
        <p className="text-xs text-ink-muted">
          This review is valid for {secondsLeft} more seconds; after that it is prepared again with the live conditions.
        </p>
      ) : null}
      <details className="rounded-lg border border-line p-3 text-sm">
        <summary className="cursor-pointer font-medium text-ink">Technical details</summary>
        <dl className="mt-3 grid gap-3 text-ink">
          <div className="grid gap-0.5">
            <dt className="label">Call</dt>
            <dd className="font-mono text-xs break-all" title={review.invocation.contractId}>
              {shorten(review.invocation.contractId)}.{review.invocation.functionName}
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="label">Call tree</dt>
            <dd>
              <ol className="grid gap-0.5 font-mono text-xs">
                {review.callTree.map((call, i) => (
                  <li key={`${call}-${i}`}>{call}</li>
                ))}
              </ol>
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="label">Unsigned transaction hash</dt>
            <dd className="font-mono text-xs break-all">{review.unsignedXdrHash}</dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="label">Fee field (stroops)</dt>
            <dd className="font-mono text-xs">{review.fee}</dd>
          </div>
        </dl>
      </details>
    </div>
  )
}

/**
 * What will be signed, in plain words, from the prepared review: what you give, the least you get,
 * the fees and the deadline; the call tree and XDR hash folded away. Signing needs a prepared
 * review, no live blocker and nothing in flight. Closing it discards the review.
 */
export function ReviewDialog({
  open,
  title,
  phase,
  review,
  error,
  blockers,
  ledgerTime,
  secondsLeft,
  pending,
  onSign,
  onClose,
}: {
  open: boolean
  title: string
  phase: ReviewPhase
  review: Review | null
  error?: string
  blockers: Blocker[]
  ledgerTime: number | null
  secondsLeft: number | null
  /** A signature or submission is in flight (this review or a restore). */
  pending: boolean
  onSign(): void
  onClose(): void
}) {
  const signing = phase === "signing" || pending
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" showCloseButton={!signing}>
        <DialogHeader>
          <DialogTitle>Review: {title}</DialogTitle>
          <DialogDescription>
            Freighter asks you to sign exactly this transaction. Check what you give and the least you get.
          </DialogDescription>
        </DialogHeader>
        {phase === "preparing" ? <p className="text-sm text-ink">Preparing the transaction with the network…</p> : null}
        {phase === "error" ? (
          <p role="alert" className="text-sm text-negative">
            {error}
          </p>
        ) : null}
        {review && (phase === "review" || signing) ? <Body review={review} ledgerTime={ledgerTime} secondsLeft={secondsLeft} /> : null}
        {blockers.length > 0 ? <GateList blockers={blockers} /> : null}
        <DialogFooter className="items-center">
          {signing ? <p className="text-sm text-ink-muted sm:mr-auto">Waiting for Freighter…</p> : null}
          <Button type="button" variant="secondary" onClick={onClose} disabled={signing}>
            Cancel
          </Button>
          <Button type="button" onClick={onSign} disabled={signing || phase !== "review" || review === null || blockers.length > 0}>
            Sign with Freighter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
