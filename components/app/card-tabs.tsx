"use client"

import type { ReactNode } from "react"
import { Tabs as TabsPrimitive } from "radix-ui"
import { cn } from "cn"
import { focusWithoutRing } from "@/components/ui/tabs"

export type CardTab = {
  value: string
  title: string
  /** A number of problems. A badge shows for a number (0 is neutral); nothing shows for `undefined` (not known). */
  count?: number
}

const plural = (n: number) => `${n} problem${n === 1 ? "" : "s"}`

/**
 * The header of a card as tabs: the tab list is the card's top band, edge to edge, with one equal
 * column per tab (R2-69), its title centred. The active tab is lifted onto the card surface with the
 * brand underline the site header's active link uses; the others sit on a darker band. The card must
 * clip its corners (`overflow-hidden`) and keep its body padding in `CardTabsContent`.
 *
 * It is Radix Tabs, so roving focus, arrow keys, `role=tab` and `aria-selected` come with it. The count
 * is spoken as part of the name ("Safety, 2 problems"). A click focuses the tab without the focus ring.
 */
export function CardTabs({
  value,
  onValueChange,
  tabs,
  label,
  children,
}: {
  value: string
  onValueChange: (value: string) => void
  tabs: CardTab[]
  label?: string
  children: ReactNode
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className="flex flex-col">
      <TabsPrimitive.List
        aria-label={label}
        className="grid w-full border-b border-line bg-surface-sunk"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((t) => (
          <TabsPrimitive.Trigger
            key={t.value}
            value={t.value}
            onMouseDown={focusWithoutRing}
            className={cn(
              "flex min-w-0 cursor-pointer items-center justify-center border-b-2 border-transparent bg-surface-sunk px-3 py-3 text-center text-ink-muted transition-colors sm:px-5 sm:py-4",
              "hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              "data-[state=active]:border-coupon data-[state=active]:bg-surface data-[state=active]:text-ink",
            )}
          >
            <span className="flex max-w-full items-center gap-2 text-base font-medium sm:text-lg">
              <span data-slot="title" className="min-w-0 truncate">
                {t.title}
              </span>
              {t.count !== undefined ? (
                <>
                  <span
                    aria-hidden="true"
                    data-slot="count"
                    className={cn(
                      "inline-flex min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-xs/4 tabular-nums",
                      t.count > 0 ? "bg-negative/15 text-[color-mix(in_srgb,var(--negative)_65%,var(--ink))]" : "bg-surface-sunk text-ink-muted",
                    )}
                  >
                    {t.count}
                  </span>
                  <span className="sr-only">, {plural(t.count)}</span>
                </>
              ) : null}
            </span>
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {children}
    </TabsPrimitive.Root>
  )
}

/** A tab's body, padded like the rest of the card. It is focusable (Radix), so it shows a focus ring (M11). */
export function CardTabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("p-5 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", className)}
      {...props}
    />
  )
}
