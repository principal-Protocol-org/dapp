"use client"

import { Suspense, useId, useState } from "react"
import { useSearchParams } from "next/navigation"
import { cn } from "cn"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ActionPanel } from "@/components/app/actions/action-panel"
import { redeemPanel } from "@/components/app/actions/redeem-tab"
import { usePanels, type PanelEntry } from "@/components/app/actions/panel-group"
import { LpTab } from "@/components/app/trade/lp-tab"
import { PtTab } from "@/components/app/trade/pt-tab"
import { QuickActions, type QuickActionId } from "@/components/app/trade/quick-actions"
import { YtTab } from "@/components/app/trade/yt-tab"
import { useHydrated } from "@/hooks/use-hydrated"
import { useMatured } from "@/hooks/use-matured"
import type { Market } from "@/lib/protocol/types"

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

/** Exchange colours (developer's request): the side that buys or adds is green, the one that sells or takes out is red. */
const SIDE_TONE: Record<SideId, "buy" | "sell"> = { buy: "buy", deposit: "buy", sell: "sell", withdraw: "sell" }
/**
 * The pressed side's tint is a tenth of its colour over the surface track: its text keeps at least
 * 4.5:1 in both themes (measured in the browser: light 4.95 green and 4.77 red; dark 6.94 and 6.29),
 * which a heavier tint, or the page's ground under it, does not.
 */
const SIDE_BUY = "border-positive bg-positive/10 text-positive"
const SIDE_SELL = "border-negative bg-negative/10 text-negative"
const SIDE_OFF = "border-transparent bg-transparent text-ink-muted hover:text-ink"

const isTab = (v: string | null | undefined): v is TabId => TABS.some((t) => t.id === v)
/**
 * The side `v` names on `tab`, else the tab's first. After maturity LP opens on Withdraw: Deposit has
 * closed (History's Continue still asks for Deposit, where a Keep YT route resumes).
 */
const sideOr = (tab: TabId, v: string | null | undefined, matured: boolean): SideId =>
  SIDES[tab].find((s) => s.id === v)?.id ?? (tab === "lp" && matured ? "withdraw" : SIDES[tab][0].id)

/**
 * The 0001 panel this panel still hosts, built once per market: configs must stay stable
 * (panel-config rule 1). PT, YT and LP are the trade-adapter tabs (Tasks 16–18); after maturity the
 * PT tab hosts 0001's Redeem.
 */
const bodies = (market: Market): PanelEntry[] => [{ id: "pt:redeem", label: "Redeem", config: redeemPanel(market) }]

/**
 * The market page's action panel: PT, YT and LP tabs, a side toggle, and the Quick actions menu
 * (each tab's fields carry their own token picker). `?tab=` and `?side=` choose where it opens, so it
 * sits in a Suspense boundary.
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
  const panels = usePanels(marketId, bodies)
  const [chosenTab, setChosenTab] = useState<TabId | null>(null)
  const [chosenSide, setChosenSide] = useState<SideId | null>(null)
  const [tool, setTool] = useState<QuickActionId | null>(null)
  if (!hydrated) return <PanelFallback />

  const tab: TabId = chosenTab ?? (isTab(urlTab) ? urlTab : "pt")
  // A tab the user picked starts on its first side; the URL's side applies to the URL's tab.
  const side = sideOr(tab, chosenSide ?? (chosenTab ? null : urlSide), matured === true)
  // After maturity the PT tab offers Redeem only (spec §3), through 0001's panel, and the YT tab
  // says its trading has closed (R2-60).
  const ptTrade = tab === "pt" && !matured
  const body = panels.find((p) => p.id === "pt:redeem")
  const toRedeem = () => {
    setChosenTab("pt")
    setChosenSide(null)
  }

  return (
    <section aria-labelledby={headingId} className="grid min-w-0 gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} className="font-serif text-2xl text-ink">
          Trade
        </h2>
        <QuickActions marketId={marketId} tool={tool} onToolChange={setTool} />
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
          ) : tab === "yt" && matured ? (
            <p className="text-sm text-ink-muted">This market has matured: YT trading has closed.</p>
          ) : (
            <div role="group" aria-label="Side" className="grid w-full grid-cols-2 gap-1 rounded-md border border-line bg-surface p-1">
              {SIDES[tab].map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={s.id === side}
                  onClick={() => setChosenSide(s.id)}
                  className={cn(
                    "min-h-10 w-full rounded-sm border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                    s.id !== side ? SIDE_OFF : SIDE_TONE[s.id] === "buy" ? SIDE_BUY : SIDE_SELL,
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <TabsContent value={tab}>
          {ptTrade ? (
            <PtTab marketId={marketId} side={side === "sell" ? "sell" : "buy"} />
          ) : tab === "yt" ? (
            <YtTab marketId={marketId} side={side === "sell" ? "sell" : "buy"} onRedeem={toRedeem} />
          ) : tab === "lp" ? (
            <LpTab marketId={marketId} side={side === "withdraw" ? "withdraw" : "deposit"} />
          ) : body ? (
            <ActionPanel key={body.id} config={body.config} marketId={marketId} />
          ) : null}
        </TabsContent>
      </Tabs>
    </section>
  )
}
