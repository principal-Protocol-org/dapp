import Link from "next/link"
import { Suspense } from "react"
import { Wizard } from "@/components/app/manage/wizard"

export const metadata = { title: "New market · Principal App" }

/**
 * The market-creation wizard (spec 0002 §5). The salt is URL data (`?salt=`): the wizard reads it in
 * a client component inside `<Suspense>`, so the rest of the page is a static shell.
 */
export default function NewMarketPage() {
  return (
    <section aria-labelledby="new-market-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <Link href="/app/manage" className="text-sm text-ink-muted underline underline-offset-4">
          Manage
        </Link>
        <h1 id="new-market-heading" className="mt-2 font-serif text-3xl text-ink">
          New market
        </h1>
        <p className="mt-2 text-ink-muted">
          Seven steps, from the parameters to the market list. Every transaction is reviewed and signed in your wallet, and where the
          market stands is read from the chain, so you can stop and come back with this page&apos;s link.
        </p>
      </div>
      <Suspense fallback={<p className="text-ink-muted">Loading the wizard…</p>}>
        <Wizard />
      </Suspense>
    </section>
  )
}
