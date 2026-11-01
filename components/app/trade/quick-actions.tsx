"use client"

import { useId } from "react"
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, ChevronDownIcon, MergeIcon, SplitIcon, ZapIcon, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ActionPanel } from "@/components/app/actions/action-panel"
import { depositPanel, mintPanel, withdrawPanel } from "@/components/app/actions/mint-tab"
import { recombinePanel } from "@/components/app/actions/redeem-tab"
import { usePanels, type PanelEntry } from "@/components/app/actions/panel-group"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { Market } from "@/lib/protocol/types"

export type QuickActionId = "deposit" | "withdraw" | "split" | "recombine"

const ACTION_IDS: QuickActionId[] = ["deposit", "withdraw", "split", "recombine"]

const ICONS: Record<QuickActionId, LucideIcon> = {
  deposit: ArrowDownToLineIcon,
  withdraw: ArrowUpFromLineIcon,
  split: SplitIcon,
  recombine: MergeIcon,
}

const actionPanels = (market: Market): PanelEntry[] => {
  const code = market.underlying.code
  return [
    { id: "deposit", label: `Deposit ${code} → SY`, config: depositPanel(market) },
    { id: "withdraw", label: `Withdraw SY → ${code}`, config: withdrawPanel(market) },
    { id: "split", label: `Split ${code} → PT + YT`, config: mintPanel(market) },
    { id: "recombine", label: "Recombine PT + YT → " + code, config: recombinePanel() },
  ]
}

const DESCRIPTIONS: Record<QuickActionId, string> = {
  deposit: "Turn the underlying asset into SY, the token the pool trades.",
  withdraw: "Turn SY back into the underlying asset.",
  split: "Split the underlying asset into equal amounts of PT and YT.",
  recombine: "Give back equal amounts of PT and YT for the underlying asset, before maturity.",
}

/** An action's one-line description, with the underlying's code in place of "the underlying asset". */
const describe = (id: QuickActionId, code: string) => DESCRIPTIONS[id].replace("the underlying asset", code || "the underlying asset")

/**
 * Quick actions: deposit, withdraw, split and recombine, from a small menu on the panel's heading
 * row, each in a dialog that hosts the same panel config as before. Each item shows an icon, its
 * label (its accessible name) and a one-line description (its accessible description). The open
 * action (`tool`) is controlled by the parent, so plain-word links elsewhere on the page open the
 * same dialogs.
 */
export function QuickActions({
  marketId,
  tool,
  onToolChange,
}: {
  marketId: string
  tool: QuickActionId | null
  onToolChange: (tool: QuickActionId | null) => void
}) {
  const baseId = useId()
  const panels = usePanels(marketId, actionPanels)
  const open = panels.find((p) => p.id === tool)
  const code = getMarket(useManifest(), marketId)?.underlying.code ?? ""
  if (panels.length === 0) return null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" size="toggle" className="gap-1.5">
            <ZapIcon aria-hidden className="size-3.5" />
            Quick actions
            <ChevronDownIcon aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel>Quick actions</DropdownMenuLabel>
          {ACTION_IDS.map((id) => {
            const Icon = ICONS[id]
            const labelId = `${baseId}-${id}`
            return (
              <DropdownMenuItem
                key={id}
                onSelect={() => onToolChange(id)}
                aria-labelledby={labelId}
                aria-describedby={`${labelId}-description`}
                className="items-start gap-2.5 py-2"
              >
                <Icon aria-hidden className="mt-0.5 size-4 text-ink-muted" />
                <span className="grid min-w-0 gap-0.5">
                  <span id={labelId} className="text-sm text-ink">
                    {panels.find((p) => p.id === id)?.label}
                  </span>
                  <span id={`${labelId}-description`} className="text-xs text-ink-muted wrap-anywhere">
                    {describe(id, code)}
                  </span>
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={open !== undefined} onOpenChange={(o) => !o && onToolChange(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{open?.label}</DialogTitle>
            <DialogDescription>{tool ? describe(tool, code) : null}</DialogDescription>
          </DialogHeader>
          {open ? <ActionPanel config={open.config} marketId={marketId} /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
