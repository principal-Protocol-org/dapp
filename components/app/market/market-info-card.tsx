"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ComplianceContent, useComplianceAttention } from "@/components/app/market/compliance-card"
import { MarketDetails } from "@/components/app/market/market-details"
import { SafetyContent, useSafetyAttention } from "@/components/app/market/safety-card"

const TABS = ["details", "compliance", "safety"] as const
type InfoTab = (typeof TABS)[number]
const isTab = (v: string | null | undefined): v is InfoTab => TABS.includes(v as InfoTab)

const SHELL = "min-w-0 rounded-lg border border-line bg-surface p-5"

function Dot() {
  return <span role="img" aria-label="needs attention" className="ml-1.5 inline-block size-1.5 rounded-full bg-negative" />
}

/**
 * The market's Details, Compliance and Safety in one tabbed card under the chart. `?info=` opens a
 * tab, so it reads the URL inside a Suspense boundary.
 */
export function MarketInfoCard({ marketId, onGetTestTokens }: { marketId: string; onGetTestTokens: () => void }) {
  return (
    <Suspense
      fallback={
        <section aria-label="Market information" className={SHELL}>
          <Skeleton className="h-48 w-full" />
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
  const complianceAttention = useComplianceAttention(marketId)
  const safetyAttention = useSafetyAttention(marketId)

  return (
    <section aria-label="Market information" className={SHELL}>
      <Tabs value={tab} onValueChange={(v) => isTab(v) && setTab(v)}>
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="compliance">
            Compliance
            {complianceAttention ? <Dot /> : null}
          </TabsTrigger>
          <TabsTrigger value="safety">
            Safety
            {safetyAttention ? <Dot /> : null}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="details">
          <MarketDetails marketId={marketId} />
        </TabsContent>
        <TabsContent value="compliance">
          <ComplianceContent marketId={marketId} onGetTestTokens={onGetTestTokens} />
        </TabsContent>
        <TabsContent value="safety">
          <SafetyContent marketId={marketId} />
        </TabsContent>
      </Tabs>
    </section>
  )
}
