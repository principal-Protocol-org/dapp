"use client"

import { Suspense, useId, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ActionPanel } from "@/components/app/actions/action-panel"
import { addLiquidityPanel, addLiquiditySyPanel, removeLiquidityPanel } from "@/components/app/actions/liquidity-tab"
import { redeemPanel } from "@/components/app/actions/redeem-tab"
import { usePanels, type PanelEntry } from "@/components/app/actions/panel-group"
import { buyYtPanel, sellYtPanel } from "@/components/app/actions/trade-tab"
import { PtTab } from "@/components/app/trade/pt-tab"
import { TokenPicker, type PayToken } from "@/components/app/trade/token-picker"
import { ToolsMenu, type ToolId } from "@/components/app/trade/tools-menu"
import { useManifest } from "@/components/app/manifest-provider"
import { useHydrated } from "@/hooks/use-hydrated"
import { useMatured } from "@/hooks/use-matured"
import { createRpcReader } from "@/lib/protocol/reader"
import { getMarket } from "@/lib/protocol/manifest"
import type { Manifest, Market } from "@/lib/protocol/types"

type TabId = "pt" | "yt" | "lp"
type SideId = "buy" | "sell" | "deposit" | "withdraw"

const TABS: { id: TabId; label: string }[] = [
  { id: "pt", label: "PT" },
  { id: "yt", label: "YT" },
  { id: "lp", label: "LP" },
]
const SIDES: Record<TabId, { id: SideId; label: string }[]> = {
  pt: [{ id: "buy", label: "Buy" }, { id: "sell", label: "Sell" }],
  yt: [{ id: "buy", label: "Buy" }, { id: "sell", label: "Sell" }],
  lp: [{ id: "deposit", label: "Deposit" }, { id: "withdraw", label: "Withdraw" }],
}

const isTab = (v: string | null | undefined): v is TabId => TABS.some((t) => t.id === v)
const sideOr = (tab: TabId, v: string | null | undefined): SideId => SIDES[tab].find((s) => s.id === v)?.id ?? SIDES[tab][0].id

/**
 * The 0001 panels this panel still hosts, built once per market: configs must stay stable
 * (panel-config rule 1). PT trades are the PT tab's (Task 16); after maturity the PT tab hosts
 * 0001's Redeem. YT and LP are interim bodies (R2-48) until Tasks 17 and 18 replace them.
 */
const bodies = (market: Market, manifest: Manifest): PanelEntry[] => {
  const reader = () => createRpcReader(manifest)
  return [
    { id: "pt:redeem", label: "Redeem", config: redeemPanel(market) },
    { id: "yt:buy", label: "Buy YT", config: buyYtPanel(market, reader) },
    { id: "yt:sell", label: "Sell YT", config: sellYtPanel(market, reader) },
    { id: "lp:deposit", label: "Add PT + SY", config: addLiquidityPanel() },
    { id: "lp:deposit-sy", label: "Add SY only", config: addLiquiditySyPanel(market, reader) },
    { id: "lp:withdraw", label: "Remove", config: removeLiquidityPanel() },
  ]
}

/**
 * The market page's action panel: PT, YT and LP tabs, a side toggle, a token picker and the Tools
 * menu. `?tab=` and `?side=` choose where it opens, so it sits in a Suspense boundary.
 */
export function TradePanel({ marketId }: { marketId: string }) {
  return (
    <Suspense fallback={<PanelFallback />}>
      <TradePanelView marketId={marketId} />
    </Suspense>
  )
}

function PanelFallback() {
  return (
    <section aria-label="Trade" className="grid min-w-0 gap-3">
      <h2 className="font-serif text-2xl text-ink">Trade</h2>
      <p className="text-sm text-ink-muted">Loading actions…</p>
    </section>
  )
}

/**
 * This boundary is rendered at request time and hydrates after the page around it, when the ledger
 * clock or the market data may already have loaded: the previews and the gate list would then
 * differ from the server HTML (I2). So the server, and hydration, render the fallback; the panel
 * renders from the first client render after it.
 */
function TradePanelView({ marketId }: { marketId: string }) {
  const hydrated = useHydrated()
  const headingId = useId()
  const params = useSearchParams()
  const urlTab = params?.get("tab")
  const urlSide = params?.get("side")
  const matured = useMatured(marketId)
  const market = getMarket(useManifest(), marketId)
  const panels = usePanels(marketId, bodies)
  const [chosenTab, setChosenTab] = useState<TabId | null>(null)
  const [chosenSide, setChosenSide] = useState<SideId | null>(null)
  // The interim YT and LP bodies pay in SY (R2-50); the PT tab has a picker on its own fields.
  const [pay, setPay] = useState<PayToken>("sy")
  const [tool, setTool] = useState<ToolId | null>(null)
  if (!hydrated) return <PanelFallback />

  const tab: TabId = chosenTab ?? (isTab(urlTab) ? urlTab : "pt")
  // A tab the user picked starts on its first side; the URL's side applies to the URL's tab.
  const side = sideOr(tab, chosenSide ?? (chosenTab ? null : urlSide))
  const code = market?.underlying.code ?? "USDY"
  // After maturity the PT tab offers Redeem only (spec §3), through 0001's panel.
  const ptTrade = tab === "pt" && !matured
  const bodyId = tab === "pt" ? "pt:redeem" : `${tab}:${side}`
  const body = panels.find((p) => p.id === bodyId)

  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="font-serif text-2xl text-ink">
          Trade
        </h2>
        <ToolsMenu marketId={marketId} tool={tool} onToolChange={setTool} />
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (isTab(v)) {
            setChosenTab(v)
            setChosenSide(null)
          }
        }}
        className="gap-3"
      >
        <TabsList aria-label="Token to trade" className="w-full">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {tab === "pt" && matured ? (
            <p className="text-sm text-ink-muted">This market has matured: redeem your PT.</p>
          ) : (
            <div role="group" aria-label="Side" className="inline-flex gap-1">
              {SIDES[tab].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={s.id === side}
                  onClick={() => setChosenSide(s.id)}
                  className={
                    "min-h-8 rounded-sm px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring " +
                    (s.id === side ? "bg-surface-sunk text-ink" : "text-ink-muted hover:text-ink")
                  }
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {tab !== "pt" ? <TokenPicker value={pay} onChange={setPay} options={["underlying", "sy"]} code={code} /> : null}
        </div>
        {tab !== "pt" && pay === "underlying" ? (
          <p className="text-xs text-ink-muted">
            Paying with {code} directly is coming. These panels pay in SY: deposit {code} to SY first.
          </p>
        ) : null}
        <TabsContent value={tab}>
          {ptTrade ? (
            <PtTab marketId={marketId} side={side === "sell" ? "sell" : "buy"} />
          ) : body ? (
            <ActionPanel key={body.id} config={body.config} marketId={marketId} />
          ) : null}
        </TabsContent>
      </Tabs>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-muted">
        {/* Only the interim YT and LP bodies still need SY; the PT tab pays the underlying directly. */}
        {tab !== "pt" ? (
          <button type="button" onClick={() => setTool("deposit")} className="underline underline-offset-2 hover:text-ink">
            Need SY? Deposit {code}
          </button>
        ) : null}
        <button type="button" onClick={() => setTool("split")} className="underline underline-offset-2 hover:text-ink">
          Split {code} into PT + YT
        </button>
      </p>
    </section>
  )
}
