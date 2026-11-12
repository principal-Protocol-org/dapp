"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { useManifest } from "@/components/app/manifest-provider"
import type { ChainStepProps } from "@/components/app/manage/wizard"

type Publish = { status: "idle" } | { status: "posting" } | { status: "sent" } | { status: "refused"; message: string }

/**
 * `POST /api/markets { pool }`: the registry validates the pool (0001's topology rule, the wiring to
 * this network's shared contracts, and the Wasm the manifest pins for every contract) and lists it
 * only when it passes (spec 0002 §1). Never throws: a refusal is said in the registry's own words.
 */
async function publish(pool: string): Promise<{ ok: true } | { ok: false; message: string }> {
  let response: Response
  try {
    // A JSON content type from this app's own page: the route refuses anything else.
    response = await fetch("/api/markets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pool }) })
  } catch {
    return { ok: false, message: "The registry could not be reached. Try again in a moment." }
  }
  if (response.ok) return { ok: true }
  let body: Record<string, unknown> = {}
  try {
    const parsed: unknown = await response.json()
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>
  } catch {
    // An unreadable answer: said by its status below.
  }
  const message = typeof body.message === "string" ? body.message : `The registry answered ${response.status}.`
  const reason = typeof body.reason === "string" ? ` Not listed because ${body.reason}` : ""
  return { ok: false, message: `${message}${reason}` }
}

/**
 * Step 7 (spec 0002 §5, §1): publish the seeded market to the registry, so it appears in the client
 * list within one refresh. The registry validates it like every discovered market, and writes it as
 * `published` only when it passes. The page's market list is resolved on the server at each request,
 * so a refresh of this route lists it. Nothing is signed. A market already in the list is done.
 */
export function StepPublish({ progress }: ChainStepProps) {
  const id = useId()
  const manifest = useManifest()
  const router = useRouter()
  const [state, setState] = useState<Publish>({ status: "idle" })
  const pool = progress.predicted.pool
  const listed = manifest.markets.find((m) => m.contracts.pool === pool)

  const run = async () => {
    setState({ status: "posting" })
    const result = await publish(pool)
    if (!result.ok) {
      setState({ status: "refused", message: result.message })
      return
    }
    setState({ status: "sent" })
    // The server layout resolves the market list from the registry at each request.
    router.refresh()
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-5">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="font-serif text-2xl text-ink">
          Step 7 of 7: Publish
        </h2>
        <p className="text-sm text-ink-muted">
          The pool holds its first liquidity. Publishing adds the market to the registry, which checks it like every market it lists: the
          Router lists the same contracts, each is wired to this network&apos;s shared contracts, and each runs the code this network&apos;s
          manifest pins. Nothing is signed.
        </p>
      </div>

      {listed ? (
        <div role="status" className="grid gap-3 rounded-lg border border-line bg-surface p-4 text-sm text-ink">
          <p>
            Published: {listed.displayName}, maturing {new Date(listed.maturity * 1000).toISOString().slice(0, 10)}, is in the market list.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href={`/app/markets/${listed.marketId}`}>Open the market</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/app">See the market list</Link>
            </Button>
          </div>
        </div>
      ) : (
        <>
          {state.status === "sent" ? (
            <p role="status" className="text-sm text-ink">
              The registry accepted the market. Refreshing the market list… If it does not appear, reload the page.
            </p>
          ) : null}
          {state.status === "refused" ? (
            <p role="alert" className="text-sm break-words text-negative">
              {state.message}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={state.status === "posting" || state.status === "sent"} onClick={() => void run()}>
              Publish the market
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
