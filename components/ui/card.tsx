import * as React from "react"
import { cn } from "cn"

// Principal cards: `surface` with a 1px `line` border, `radius-lg`. Borders, not shadows;
// `raised` (shadow-raise) is reserved for the one floating element per view.
function Card({
  className,
  raised = false,
  ...props
}: React.ComponentProps<"div"> & { raised?: boolean }) {
  return (
    <div
      data-slot="card"
      data-raised={raised || undefined}
      className={cn(
        "rounded-lg border border-line bg-card p-6 text-card-foreground",
        raised && "border-transparent shadow-raised",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex items-start justify-between gap-4", className)}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn("text-[19px]/[26px] font-semibold", className)}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-[13px]/[19px] text-ink-muted", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={className} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  )
}

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
