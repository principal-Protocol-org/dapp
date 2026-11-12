"use client" // Error boundaries must be Client Components.

import "./globals.css"

/**
 * The root error boundary: it replaces the root layout when that layout itself fails, so it brings
 * its own <html> and <body>. It is deliberately plain: no providers, no manifest, no wallet.
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : undefined
  return (
    <html lang="en">
      <body>
        <main role="alert" className="mx-auto grid max-w-2xl gap-4 p-8">
          <h1 className="font-serif text-3xl">Principal could not be shown</h1>
          <p>
            Something went wrong while loading the page. Try again; if it keeps happening, reload the page or come back later. If you
            signed a transaction just before this, check History before trying again.
          </p>
          <div>
            <button type="button" onClick={() => retry()} className="rounded-md border px-4 py-2">
              Try again
            </button>
          </div>
          {digest ? <p className="font-mono text-xs">Error id: {digest}</p> : null}
        </main>
      </body>
    </html>
  )
}
