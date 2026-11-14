import type { ReactNode } from "react"
import { cn } from "cn"

/**
 * One dashboard card: a titled region (named for assistive tech by its title), an optional line
 * under the title (an `AsOf`) and the body. Shared by the dashboard pages.
 */
export function Panel({ title, meta, children, className }: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  return (
    <section aria-labelledby={id} className={cn("grid min-w-0 content-start gap-4 rounded-lg border border-line bg-surface p-5", className)}>
      <div className="grid gap-1">
        <h2 id={id} className="text-lg font-medium text-ink">
          {title}
        </h2>
        {meta}
      </div>
      {children}
    </section>
  )
}

/** A label over its value, as the Safety card rows: readable at 375 px whatever the value's length. */
export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
      <dt className="label">{label}</dt>
      <dd className="min-w-0 font-mono text-sm tabular-nums text-ink wrap-anywhere">{children}</dd>
    </div>
  )
}
