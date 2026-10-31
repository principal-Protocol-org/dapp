"use client"

import { useState } from "react"
import { useManifestFindings } from "@/hooks/use-manifest-findings"
import { TradePanel } from "@/components/app/trade/trade-panel"
import { ComplianceCard } from "@/components/app/market/compliance-card"
import { MarketChartBox } from "@/components/app/market/market-chart-box"
import { MarketHeader } from "@/components/app/market/market-header"
import { MarketStats } from "@/components/app/market/market-stats"
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
      <div className="grid items-start gap-6 min-[900px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div data-testid="market-left" className="grid min-w-0 gap-6">
          <MarketHeader marketId={marketId} />
          <MarketStats marketId={marketId} />
          <MarketChartBox marketId={marketId} />
        </div>
        <div data-testid="market-right" className="grid min-w-0 gap-6">
          <TradePanel marketId={marketId} />
          <ComplianceCard marketId={marketId} onGetTestTokens={openOnboarding} />
          <SafetyCard marketId={marketId} />
        </div>
      </div>
      <OnboardingDialog open={onboarding} onOpenChange={setOnboarding} marketId={marketId} />
    </div>
  )
}
