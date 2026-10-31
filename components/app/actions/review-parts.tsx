import { formatDuration } from "@/components/app/live"
import { formatUnixTime, shorten } from "@/lib/protocol/format"
import type { Review } from "@/lib/protocol/review"

/**
 * When the transaction can no longer land, in plain words (M3). Two limits apply: the contract
 * call's deadline (actions that take one) and the transaction's own time bound, 5 minutes after it
 * was prepared. The network checks both against ledger time; the earlier one is the one shown, and
 * says who refuses the transaction after it.
 */
export function TimeLimit({ deadline, validUntil, ledgerTime }: { deadline?: number; validUntil: number; ledgerTime: number | null }) {
  const at = (t: number) => `${formatUnixTime(t)}${ledgerTime !== null ? `, in ${formatDuration(t - ledgerTime)} by ledger time` : ""}`
  const lines =
    deadline !== undefined && deadline <= validUntil
      ? [`${at(deadline)}. If the transaction lands after it, the contract refuses it and only the network fee is spent.`]
      : [
          `${at(validUntil)}. After it the network refuses the transaction: it is valid for 5 minutes from when it was prepared.`,
          ...(deadline !== undefined ? [`Your deadline, ${formatUnixTime(deadline)}, comes later, so this is the limit that applies.`] : []),
        ]
  // The time bound comes from the device clock; one already past by ledger time can never land.
  const clockBehind = ledgerTime !== null && validUntil <= ledgerTime
  return (
    <div className="grid gap-1">
      <h3 className="label">{deadline !== undefined ? "Deadline" : "Valid until"}</h3>
      {lines.map((line) => (
        <p key={line} className="text-sm text-ink">
          {line}
        </p>
      ))}
      {clockBehind ? (
        <p className="text-sm text-negative">
          This device&apos;s clock is behind the network&apos;s, so the network will refuse this transaction. Check your device clock, then
          review again.
        </p>
      ) : null}
    </div>
  )
}

/** The folded call, call tree, unsigned transaction hash and fee field of a prepared review. */
export function TechnicalDetails({ review }: { review: Review }) {
  return (
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
  )
}
