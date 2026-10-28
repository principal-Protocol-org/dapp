"use client"

import { useMemo, useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ActionPanel } from "@/components/app/actions/action-panel"
import type { PanelConfig } from "@/components/app/actions/panel-config"
import { getMarket } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { Market } from "@/lib/protocol/types"

export type PanelEntry = { id: string; label: string; config: PanelConfig }

/**
 * A tab's panel configs for one market, built once per market: configs must stay stable, since a
 * new config object re-reads its quotes (panel-config rule 1). `build` must be a module-level function.
 */
export function usePanels(marketId: string, build: (market: Market) => PanelEntry[]): PanelEntry[] {
  return useMemo(() => {
    const market = getMarket(activeManifest(), marketId)
    return market ? build(market) : []
  }, [marketId, build])
}

/**
 * The panels of one action tab, one at a time behind a row of sub-tabs. Only the selected panel is
 * mounted, so only it reads quotes and simulates. `defaultId` (the first panel when absent or
 * unknown) applies until the user picks a panel, and may change meanwhile (e.g. at maturity).
 */
export function PanelGroup({
  label,
  marketId,
  panels,
  defaultId,
}: {
  label: string
  marketId: string
  panels: PanelEntry[]
  defaultId?: string
}) {
  const [chosen, setChosen] = useState<string | null>(null)
  if (panels.length === 0) return null
  const fallback = panels.some((p) => p.id === defaultId) ? defaultId! : panels[0].id
  return (
    <Tabs value={chosen ?? fallback} onValueChange={setChosen} className="gap-4">
      <TabsList variant="line" aria-label={`${label} actions`} className="max-w-full justify-start overflow-x-auto">
        {panels.map((p) => (
          <TabsTrigger key={p.id} value={p.id} className="flex-none">
            {p.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {panels.map((p) => (
        <TabsContent key={p.id} value={p.id}>
          <ActionPanel config={p.config} marketId={marketId} />
        </TabsContent>
      ))}
    </Tabs>
  )
}
