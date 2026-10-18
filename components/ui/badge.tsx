import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Principal `pp-badge`: a square status dot and one or two uppercase words.
// The word carries the meaning; the dot colour only reinforces it.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-sm border border-line px-2 py-[3px] font-sans text-[11px]/4 font-semibold tracking-[0.08em] whitespace-nowrap uppercase before:size-1.5 before:rounded-[1px] before:content-['']",
  {
    variants: {
      status: {
        neutral: "before:bg-ink-muted",
        live: "before:bg-positive",
        soon: "before:bg-coupon",
        dev: "before:bg-line-strong",
        paused: "before:bg-negative",
      },
    },
    defaultVariants: {
      status: "neutral",
    },
  }
)

function Badge({
  className,
  status = "neutral",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-status={status}
      className={cn(badgeVariants({ status }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
