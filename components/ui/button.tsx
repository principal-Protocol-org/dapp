import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Principal `pp-btn`: one primary per view, sentence-case verb labels.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border border-transparent font-sans font-semibold whitespace-nowrap transition-[background-color,color,border-color,translate] duration-160 select-none active:translate-y-px disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 motion-reduce:transition-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-par text-on-par hover:bg-ink hover:text-ground",
        secondary: "border-line-strong bg-transparent text-ink hover:border-ink",
        ghost: "bg-transparent px-2 text-ink hover:text-ink-muted",
        // Theme toggle in the nav.
        toggle:
          "border-line bg-transparent font-mono font-medium text-ink-muted hover:border-ink hover:text-ink",
        // On the always-dark band.
        "band-primary": "bg-band-par text-[#0a1626] hover:bg-white",
        "band-secondary": "border-[#7d8a9c] bg-transparent text-band-ink hover:border-band-ink",
      },
      size: {
        default: "px-[18px] py-3 text-sm/5",
        lg: "px-[26px] py-3.5 text-[15px]/5",
        toggle: "px-3 py-[9px] text-xs/4",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

/** Trailing arrow for navigation buttons; nudges right on hover. */
function ButtonArrow({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "font-mono transition-[translate] duration-160 group-hover/button:translate-x-[3px] motion-reduce:transition-none",
        className
      )}
      {...props}
    >
      →
    </span>
  )
}

export { Button, ButtonArrow, buttonVariants }
