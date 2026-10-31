"use client"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { GateList } from "@/components/app/actions/gate-list"
import { TechnicalDetails, TimeLimit } from "@/components/app/actions/review-parts"
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
  return (
    <div className="grid gap-4">
      <Group title="You give" items={summary.give} />
      <Group title="You get at least" items={summary.getAtLeast} />
      <Group title="Fees" items={summary.fees} />
      <TimeLimit deadline={summary.deadline} validUntil={summary.validUntil} ledgerTime={ledgerTime} />
      {secondsLeft !== null ? (
        <p className="text-xs text-ink-muted">
          This review is valid for {secondsLeft} more seconds; after that it is prepared again with the live conditions.
        </p>
      ) : null}
      <TechnicalDetails review={review} />
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
  canSign,
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
  /** Every gate was evaluated and passes, with floors from this input's simulation. */
  canSign: boolean
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
            Your wallet asks you to sign exactly this transaction. Check what you give and the least you get.
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
          {signing ? <p className="text-sm text-ink-muted sm:mr-auto">Waiting for your wallet…</p> : null}
          <Button type="button" variant="secondary" onClick={onClose} disabled={signing}>
            Cancel
          </Button>
          <Button type="button" onClick={onSign} disabled={signing || !canSign || phase !== "review" || review === null || blockers.length > 0}>
            Sign transaction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
