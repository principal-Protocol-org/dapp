"use client"

import { Suspense, useId, useState, type ComponentType } from "react"
import { useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LiquidityTab } from "@/components/app/actions/liquidity-tab"
import { MintTab } from "@/components/app/actions/mint-tab"
import { RedeemTab } from "@/components/app/actions/redeem-tab"
import { useMatured } from "@/hooks/use-matured"
import { TradeTab } from "@/components/app/actions/trade-tab"

type TabId = "mint" | "trade" | "liquidity" | "redeem"
type TabSpec = { id: TabId; label: string; Panel?: ComponentType<{ marketId: string; initialPanel?: string }> }

/** Spec §3: the action panels, grouped in tabs. A tab whose panels are not built yet is disabled (R8). */
const TABS: TabSpec[] = [
  { id: "mint", label: "Mint", Panel: MintTab },
  { id: "trade", label: "Trade", Panel: TradeTab },
  { id: "liquidity", label: "Liquidity", Panel: LiquidityTab },
  { id: "redeem", label: "Redeem", Panel: RedeemTab },
]

const isTabId = (value: string): value is TabId => TABS.some((t) => t.id === value)

/**
 * The market page's actions, in a Suspense boundary: reading `?tab=` and `?panel=` (the portfolio's
 * shortcuts) makes the tabs client-rendered, while the page around them still prerenders.
 */
export function ActionTabs({ marketId }: { marketId: string }) {
  return (
    <Suspense fallback={<ActionsFallback />}>
      <ActionTabsView marketId={marketId} />
    </Suspense>
  )
}

function ActionsFallback() {
  return (
    <section aria-label="Actions" className="grid min-w-0 gap-3">
      <h2 className="font-serif text-2xl text-ink">Actions</h2>
      <p className="text-sm text-ink-muted">Loading actions…</p>
    </section>
  )
}

/**
 * The tabs. Only the selected tab is mounted, so only its panel reads and
 * simulates. It opens on Mint, or on Redeem once the market has matured (ledger time), until the
 * user picks a tab. A `?tab=` in the URL (and `?panel=` for that tab's panel) opens there instead; the
 * user's later picks win.
 */
function ActionTabsView({ marketId }: { marketId: string }) {
  const headingId = useId()
  const params = useSearchParams()
  const urlTab = params?.get("tab") ?? ""
  const urlPanel = params?.get("panel") ?? undefined
  const requested = isTabId(urlTab) ? urlTab : null
  const matured = useMatured(marketId)
  const [chosen, setChosen] = useState<TabId | null>(null)
  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-3">
      <h2 id={headingId} className="font-serif text-2xl text-ink">
        Actions
      </h2>
      <Tabs value={chosen ?? requested ?? (matured ? "redeem" : "mint")} onValueChange={(v) => isTabId(v) && setChosen(v)} className="gap-4">
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
              <Panel marketId={marketId} initialPanel={id === requested ? urlPanel : undefined} />
            </TabsContent>
          ) : null,
        )}
      </Tabs>
    </section>
  )
}
