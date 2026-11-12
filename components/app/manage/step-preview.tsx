"use client"

import { useId } from "react"
import { Button } from "@/components/ui/button"
import { UNAVAILABLE } from "@/components/app/live"
import { usePredictedMarket } from "@/hooks/use-wizard"
import type { MarketContractName } from "@/lib/protocol/types"

export type StepPreviewProps = {
  salt: string
  onBack(): void
  onNext(): void
}

const ADDRESS_NAME: Record<MarketContractName, string> = {
  sy: "SY wrapper",
  pt: "PT",
  yt: "YT",
  config: "Market config",
  manager: "PrincipalManager",
  pool: "Pool",
  recoveryEscrow: "Recovery escrow",
}

/**
 * Step 2 (spec 0002 §5): the seven addresses this salt gives, read with `MarketFactory.predict_market`
 * and checked against the addresses the salt derives on this network. Nothing is signed.
 */
export function StepPreview({ salt, onBack, onNext }: StepPreviewProps) {
  const id = useId()
  const predicted = usePredictedMarket(salt)
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-5">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="font-serif text-2xl text-ink">
          Step 2 of 7: Addresses
        </h2>
        <p className="text-sm text-ink-muted">
          Where the market&apos;s contracts will be, read from the MarketFactory before anything is deployed. Nothing is signed in this step.
        </p>
      </div>
      {predicted.isPending ? <p className="text-ink-muted">Reading the predicted addresses…</p> : null}
      {predicted.isError ? (
        <p role="alert" className="text-sm text-negative">
          {UNAVAILABLE}: {predicted.error.message}
        </p>
      ) : null}
      {predicted.data ? (
        <dl className="grid grid-cols-[minmax(0,1fr)] gap-3 rounded-lg border border-line bg-surface p-4 min-[560px]:grid-cols-2">
          {(Object.keys(ADDRESS_NAME) as MarketContractName[]).map((k) => (
            <div key={k} className="grid min-w-0 gap-0.5">
              <dt className="label">{ADDRESS_NAME[k]}</dt>
              <dd className="font-mono text-xs break-all text-ink">{predicted.data[k]}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button type="button" disabled={!predicted.data} onClick={onNext}>
          Next: deploy
        </Button>
      </div>
    </section>
  )
}
