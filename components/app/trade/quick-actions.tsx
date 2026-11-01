"use client"

import { useId } from "react"
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, ChevronDownIcon, MergeIcon, SplitIcon, ZapIcon, type LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { ActionPanel } from "@/components/app/actions/action-panel"
import { depositPanel, mintPanel, withdrawPanel } from "@/components/app/actions/mint-tab"
import { usePanels, type PanelEntry } from "@/components/app/actions/panel-group"
import { RECOMBINE_TITLE, RecombineAction, recombineDescription } from "@/components/app/trade/recombine-action"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { Market } from "@/lib/protocol/types"

export type QuickActionId = "deposit" | "withdraw" | "split" | "recombine"

const ACTION_IDS: QuickActionId[] = ["deposit", "withdraw", "split", "recombine"]

/** A `?quick=` value naming an action (History's Continue opens Recombine this way). */
export const isQuickAction = (v: string | null | undefined): v is QuickActionId => ACTION_IDS.some((id) => id === v)

const ICONS: Record<QuickActionId, LucideIcon> = {
  deposit: ArrowDownToLineIcon,
  withdraw: ArrowUpFromLineIcon,
  split: SplitIcon,
  recombine: MergeIcon,
}

/** An action's menu label and dialog title. */
const labelOf = (id: QuickActionId, code: string): string => {
  switch (id) {
    case "deposit":
      return `Deposit ${code} → SY`
    case "withdraw":
      return `Withdraw SY → ${code}`
    case "split":
      return `Split ${code} → PT + YT`
    case "recombine":
      return RECOMBINE_TITLE
  }
}

/**
 * The actions that keep 0001's single-step panel (split is one step per spec §4). Recombine is a
 * route, recombine → withdraw to the underlying (R2-72): its dialog hosts `RecombineAction`.
 */
const actionPanels = (market: Market): PanelEntry[] => {
  const code = market.underlying.code
  return [
    { id: "deposit", label: labelOf("deposit", code), config: depositPanel(market) },
    { id: "withdraw", label: labelOf("withdraw", code), config: withdrawPanel(market) },
    { id: "split", label: labelOf("split", code), config: mintPanel(market) },
  ]
}

const DESCRIPTIONS: Record<QuickActionId, string> = {
  deposit: "Turn the underlying asset into SY, the token the pool trades.",
  withdraw: "Turn SY back into the underlying asset.",
  split: "Split the underlying asset into equal amounts of PT and YT.",
  recombine: recombineDescription("the underlying asset"),
}

/** An action's one-line description, with the underlying's code in place of "the underlying asset". */
const describe = (id: QuickActionId, code: string) => DESCRIPTIONS[id].replace("the underlying asset", code || "the underlying asset")

/**
 * Quick actions: deposit, withdraw, split and recombine, from a small menu on the panel's heading
 * row, each in a dialog: deposit, withdraw and split host their 0001 panel config, recombine its
 * route form. Each item shows an icon, its label (its accessible name) and a one-line description
 * (its accessible description). The open action (`tool`) is controlled by the parent, so plain-word
 * links elsewhere on the page, and `?quick=`, open the same dialogs. `onRedeem` takes the user to
 * the PT tab's Redeem (the Recombine dialog points there after maturity); the dialog closes first.
 * `routeId` is the run History's Continue names, for the Recombine dialog.
 */
export function QuickActions({
  marketId,
  tool,
  onToolChange,
  onRedeem,
  routeId,
}: {
  marketId: string
  tool: QuickActionId | null
  onToolChange: (tool: QuickActionId | null) => void
  onRedeem?: () => void
  routeId?: string | null
}) {
  const baseId = useId()
  const panels = usePanels(marketId, actionPanels)
  const market = getMarket(useManifest(), marketId)
  const code = market?.underlying.code ?? ""
  if (!market) return null
  const panel = panels.find((p) => p.id === tool)
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
                    {labelOf(id, code)}
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
      <Dialog open={tool !== null} onOpenChange={(o) => !o && onToolChange(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{tool ? labelOf(tool, code) : null}</DialogTitle>
            <DialogDescription>{tool ? describe(tool, code) : null}</DialogDescription>
          </DialogHeader>
          {tool === "recombine" ? (
            <RecombineAction
              marketId={marketId}
              routeId={routeId}
              onRedeem={
                onRedeem
                  ? () => {
                      onToolChange(null)
                      onRedeem()
                    }
                  : undefined
              }
            />
          ) : panel ? (
            <ActionPanel config={panel.config} marketId={marketId} />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
