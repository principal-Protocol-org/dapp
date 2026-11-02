import { cn } from "cn"

/** One stat: a title over a value. `className` styles the pair, `valueClassName` the value only. */
export function Metric({
  label,
  children,
  className,
  valueClassName,
}: {
  label: string
  children: React.ReactNode
  className?: string
  valueClassName?: string
}) {
  return (
    <div className={cn("grid gap-1", className)}>
      <dt className="label">{label}</dt>
      <dd className={cn("font-mono text-[15px]/6 tabular-nums text-ink", valueClassName)}>{children}</dd>
    </div>
  )
}
