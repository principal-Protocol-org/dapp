"use client"

import { useState } from "react"
import { useManifestFindings } from "@/hooks/use-manifest-findings"
import { TradePanel } from "@/components/app/trade/trade-panel"
import { MarketChartBox } from "@/components/app/market/market-chart-box"
import { MarketHeader } from "@/components/app/market/market-header"
import { MarketInfoCard } from "@/components/app/market/market-info-card"
import { MarketStats } from "@/components/app/market/market-stats"
import { OnboardingDialog } from "@/components/app/onboarding/onboarding-dialog"

const LEFT = "grid min-w-0 gap-6 min-[900px]:col-start-1"

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
      {/* One grid, so the one-column order is header, stats, chart, trade panel, info card. From 900 px the
          trade panel takes the right column (sticky, below the 4rem site header); the info card's row
          absorbs any height the panel adds. */}
      <div
        data-testid="market-grid"
        className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 min-[900px]:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] min-[900px]:grid-rows-[auto_1fr]"
      >
        <div data-testid="market-left" className={LEFT}>
          <MarketHeader marketId={marketId} />
          <MarketStats marketId={marketId} />
          <MarketChartBox marketId={marketId} />
        </div>
        <div
          data-testid="market-right"
          className="min-w-0 min-[900px]:sticky min-[900px]:top-20 min-[900px]:col-start-2 min-[900px]:row-span-2 min-[900px]:row-start-1 min-[900px]:self-start"
        >
          <TradePanel marketId={marketId} />
        </div>
        <div data-testid="market-info" className={LEFT}>
          <MarketInfoCard marketId={marketId} onGetTestTokens={openOnboarding} />
        </div>
      </div>
      <OnboardingDialog open={onboarding} onOpenChange={setOnboarding} marketId={marketId} />
    </div>
  )
}
