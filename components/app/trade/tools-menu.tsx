"use client"

import { WrenchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ActionPanel } from "@/components/app/actions/action-panel"
import { depositPanel, mintPanel, withdrawPanel } from "@/components/app/actions/mint-tab"
import { recombinePanel } from "@/components/app/actions/redeem-tab"
import { usePanels, type PanelEntry } from "@/components/app/actions/panel-group"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { Market } from "@/lib/protocol/types"

export type ToolId = "deposit" | "withdraw" | "split" | "recombine"

const TOOL_IDS: ToolId[] = ["deposit", "withdraw", "split", "recombine"]

const toolPanels = (market: Market): PanelEntry[] => {
  const code = market.underlying.code
  return [
    { id: "deposit", label: `Deposit ${code} → SY`, config: depositPanel(market) },
    { id: "withdraw", label: `Withdraw SY → ${code}`, config: withdrawPanel(market) },
    { id: "split", label: `Split ${code} → PT + YT`, config: mintPanel(market) },
    { id: "recombine", label: "Recombine PT + YT → " + code, config: recombinePanel() },
  ]
}

const DESCRIPTIONS: Record<ToolId, string> = {
  deposit: "Turn the underlying asset into SY, the token the pool trades.",
  withdraw: "Turn SY back into the underlying asset.",
  split: "Split the underlying asset into equal amounts of PT and YT.",
  recombine: "Give back equal amounts of PT and YT for the underlying asset, before maturity.",
}

/**
 * The Tools menu: deposit, withdraw, split and recombine, each in a dialog that hosts the same
 * panel config as before. The open tool is controlled by the parent, so plain-word links elsewhere
 * on the page open the same dialogs.
 */
export function ToolsMenu({ marketId, tool, onToolChange }: { marketId: string; tool: ToolId | null; onToolChange: (tool: ToolId | null) => void }) {
  const panels = usePanels(marketId, toolPanels)
  const open = panels.find((p) => p.id === tool)
  const code = getMarket(useManifest(), marketId)?.underlying.code ?? ""
  if (panels.length === 0) return null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary">
            <WrenchIcon aria-hidden />
            Tools
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          {TOOL_IDS.map((id) => (
            <DropdownMenuItem key={id} onSelect={() => onToolChange(id)}>
              {panels.find((p) => p.id === id)?.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open !== undefined} onOpenChange={(o) => !o && onToolChange(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{open?.label}</DialogTitle>
            <DialogDescription>{tool ? DESCRIPTIONS[tool].replace("the underlying asset", code || "the underlying asset") : null}</DialogDescription>
          </DialogHeader>
          {open ? <ActionPanel config={open.config} marketId={marketId} /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
