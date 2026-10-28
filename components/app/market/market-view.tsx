"use client"

import { useState } from "react"
import { useManifestFindings } from "@/hooks/use-manifest-findings"
import { ActionTabs } from "@/components/app/actions/action-tabs"
import { ComplianceCard } from "@/components/app/market/compliance-card"
import { MarketHeader } from "@/components/app/market/market-header"
import { SafetyCard } from "@/components/app/market/safety-card"
import { OnboardingDialog } from "@/components/app/onboarding/onboarding-dialog"

export function MarketView({ marketId }: { marketId: string }) {
  const errors = useManifestFindings().filter((f) => f.severity === "error")
  const [onboarding, setOnboarding] = useState(false)
  const openOnboarding = () => setOnboarding(true)
  return (
    <div className="grid gap-8">
      {errors.length > 0 ? (
        <div role="alert" className="rounded-lg border border-negative bg-surface p-4 text-sm text-ink">
          <p className="font-semibold">The deployment manifest has errors. Do not trust the data on this page.</p>
          <ul className="mt-2 list-disc pl-5">
            {errors.map((f) => (
              <li key={f.message}>{f.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <MarketHeader marketId={marketId} />
      <div className="grid items-start gap-6 min-[900px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ActionTabs marketId={marketId} />
        <div className="grid min-w-0 gap-6">
          <ComplianceCard marketId={marketId} onGetTestTokens={openOnboarding} />
          <SafetyCard marketId={marketId} />
        </div>
      </div>
      <OnboardingDialog open={onboarding} onOpenChange={setOnboarding} marketId={marketId} />
    </div>
  )
}
