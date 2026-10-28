"use client" // Error boundaries must be Client Components.

import { useEffect } from "react"
import { Button } from "@/components/ui/button"

/**
 * The /app error boundary (M9): a render error in a page shows this, inside the app's header and
 * banner, instead of blanking the app. `retry` re-fetches and re-renders the page.
 */
export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])

  // Errors from Server Components arrive with a generic message and a digest; client ones as thrown.
  const detail = error instanceof Error ? error.message : undefined
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : undefined

  return (
    <section role="alert" aria-labelledby="app-error-heading" className="grid max-w-2xl gap-4 rounded-lg border border-line bg-surface p-6">
      <h1 id="app-error-heading" className="font-serif text-3xl text-ink">
        This page could not be shown
      </h1>
      <p className="text-ink-muted">
        Something went wrong while showing this page. Nothing was signed or sent. Try again; if it keeps happening, reload the page or
        come back later.
      </p>
      <div>
        <Button type="button" onClick={() => retry()}>
          Try again
        </Button>
      </div>
      {detail || digest ? (
        <details className="text-sm text-ink-muted">
          <summary className="cursor-pointer font-medium text-ink">Technical details</summary>
          {detail ? <p className="mt-2 font-mono text-xs break-all">{detail}</p> : null}
          {digest ? <p className="mt-1 font-mono text-xs">Error id: {digest}</p> : null}
        </details>
      ) : null}
    </section>
  )
}
