import Link from "next/link"
import { Suspense } from "react"
import { Wizard, WizardUnavailable } from "@/components/app/manage/wizard"
import { wizardAvailable } from "@/lib/protocol/factory"
import { activeNetwork } from "@/lib/protocol/manifest-source"

export const metadata = { title: "New market · Principal App" }

/**
 * The market-creation wizard (spec 0002 §5). The salt is URL data (`?salt=`): the wizard reads it in
 * a client component inside `<Suspense>`, so the rest of the page is a static shell. Where the wizard
 * is not offered (`wizardAvailable`: Mainnet, whose issuer keys are the protocol team's), the page is
 * a card that says so, whatever the URL holds: the wizard is not mounted.
 */
export default function NewMarketPage() {
  const offered = wizardAvailable({ network: activeNetwork() })
  return (
    <section aria-labelledby="new-market-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <Link href="/app/manage" className="text-sm text-ink-muted underline underline-offset-4">
          Manage
        </Link>
        <h1 id="new-market-heading" className="mt-2 font-serif text-3xl text-ink">
          New market
        </h1>
        {offered ? (
          <p className="mt-2 text-ink-muted">
            Seven steps, from the parameters to the market list. Every transaction is reviewed and signed in your wallet, and where the
            market stands is read from the chain, so you can stop and come back with this page&apos;s link.
          </p>
        ) : null}
      </div>
      {offered ? (
        <Suspense fallback={<p className="text-ink-muted">Loading the wizard…</p>}>
          <Wizard />
        </Suspense>
      ) : (
        <WizardUnavailable />
      )}
    </section>
  )
}
