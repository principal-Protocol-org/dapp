"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Skeleton } from "@/components/ui/skeleton"
import { CardTabs, CardTabsContent, type CardTab } from "@/components/app/card-tabs"
import { ComplianceContent, useComplianceIssues } from "@/components/app/market/compliance-card"
import { MarketDetails } from "@/components/app/market/market-details"
import { SafetyContent, useSafetyIssues } from "@/components/app/market/safety-card"

const TABS = ["details", "compliance", "safety"] as const
type InfoTab = (typeof TABS)[number]
const isTab = (v: string | null | undefined): v is InfoTab => TABS.includes(v as InfoTab)

const SHELL = "min-w-0 overflow-hidden rounded-lg border border-line bg-surface"

/**
 * The market's Details, Compliance and Safety in one tabbed card under the chart. `?info=` opens a
 * tab, so it reads the URL inside a Suspense boundary.
 */
export function MarketInfoCard({ marketId, onGetTestTokens }: { marketId: string; onGetTestTokens: () => void }) {
  return (
    <Suspense
      fallback={
        <section aria-label="Market information" className={SHELL}>
          <Skeleton className="m-5 h-48" />
        </section>
      }
    >
      <InfoCardView marketId={marketId} onGetTestTokens={onGetTestTokens} />
    </Suspense>
  )
}

function InfoCardView({ marketId, onGetTestTokens }: { marketId: string; onGetTestTokens: () => void }) {
  const param = useSearchParams()?.get("info")
  const [tab, setTab] = useState<InfoTab>(isTab(param) ? param : "details")
  const [seen, setSeen] = useState(param)
  // A link that changes ?info= while the page is open moves the tab; the user's own clicks stay otherwise.
  if (param !== seen) {
    setSeen(param)
    if (isTab(param)) setTab(param)
  }
  const tabs: CardTab[] = [
    { value: "details", title: "Details" },
    { value: "compliance", title: "Compliance", count: useComplianceIssues(marketId) },
    { value: "safety", title: "Safety", count: useSafetyIssues(marketId) },
  ]

  return (
    <section aria-label="Market information" className={SHELL}>
      <CardTabs value={tab} onValueChange={(v) => isTab(v) && setTab(v)} tabs={tabs} label="Market information">
        <CardTabsContent value="details">
          <MarketDetails marketId={marketId} />
        </CardTabsContent>
        <CardTabsContent value="compliance">
          <ComplianceContent marketId={marketId} onGetTestTokens={onGetTestTokens} />
        </CardTabsContent>
        <CardTabsContent value="safety">
          <SafetyContent marketId={marketId} />
        </CardTabsContent>
      </CardTabs>
    </section>
  )
}
