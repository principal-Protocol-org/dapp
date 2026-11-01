"use client"

import { useRef, useState, type ReactNode } from "react"
import { InfoIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * A small "i" beside a label, with the explanation behind it (R2-65). One shared component for every
 * details row of the trade tabs and the Quick actions previews.
 *
 * Radix's Tooltip opens on hover and keyboard focus but not on a tap, and a phone has no hover. So the
 * tip is controlled: Radix keeps hover, focus, Escape and outside-press, and a click on the button
 * toggles it, which is the tap. A second click closes it. The button is a real `<button>` named "More about <label>"; while open,
 * Radix points its aria-describedby at the tip, so a screen reader reads the text with the button.
 */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  // Radix closes the tip on pointer-down; the click that follows must toggle from what the user saw.
  const openAtPress = useRef<boolean | null>(null)
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`More about ${label}`}
            onPointerDown={() => {
              openAtPress.current = open
            }}
            onClick={(event) => {
              // Radix's trigger closes the tip on click; preventDefault skips that, so this toggle decides.
              event.preventDefault()
              const seen = openAtPress.current ?? open
              openAtPress.current = null
              setOpen(!seen)
            }}
            className="-m-1 inline-flex shrink-0 items-center justify-center rounded-full p-1 text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          >
            <InfoIcon aria-hidden="true" className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" collisionPadding={8} className="block max-w-[min(18rem,calc(100vw-1rem))] text-xs leading-snug wrap-anywhere">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** A label with its info tip right after it. Without a tip it is the bare label. */
export function LabelWithTip({ label, tip, className }: { label: string; tip?: ReactNode; className?: string }) {
  if (!tip) return <span className={className}>{label}</span>
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ""}`}>
      <span>{label}</span>
      <InfoTip label={label}>{tip}</InfoTip>
    </span>
  )
}
