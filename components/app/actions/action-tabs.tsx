"use client"

import { useId, type ComponentType } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LiquidityTab } from "@/components/app/actions/liquidity-tab"
import { MintTab } from "@/components/app/actions/mint-tab"
import { TradeTab } from "@/components/app/actions/trade-tab"

type TabSpec = { id: "mint" | "trade" | "liquidity" | "redeem"; label: string; Panel?: ComponentType<{ marketId: string }> }

/** Spec §3: the action panels, grouped in tabs. A tab whose panels are not built yet is disabled (R8). */
const TABS: TabSpec[] = [
  { id: "mint", label: "Mint", Panel: MintTab },
  { id: "trade", label: "Trade", Panel: TradeTab },
  { id: "liquidity", label: "Liquidity", Panel: LiquidityTab },
  { id: "redeem", label: "Redeem" },
]

/** The market page's actions. Only the selected tab is mounted, so only its panel reads and simulates. */
export function ActionTabs({ marketId }: { marketId: string }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-3">
      <h2 id={headingId} className="font-serif text-2xl text-ink">
        Actions
      </h2>
      <Tabs defaultValue="mint" className="gap-4">
        <TabsList aria-label="Market actions" className="w-full">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id} disabled={!t.Panel}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map(({ id, Panel }) =>
          Panel ? (
            <TabsContent key={id} value={id}>
              <Panel marketId={marketId} />
            </TabsContent>
          ) : null,
        )}
      </Tabs>
    </section>
  )
}
