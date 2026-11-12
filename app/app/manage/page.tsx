import { Suspense } from "react"
import { MyMarkets } from "@/components/app/manage/my-markets"
import { invalidRegistryMarkets, resumableRegistrySalts } from "@/lib/server/manage"

export const metadata = { title: "Manage · Principal App" }

/**
 * The registry's unlisted rows and the half-finished markets it indexed are request-time data: read
 * on the server, inside `<Suspense>`.
 */
async function Manager() {
  const [invalid, salts] = await Promise.all([invalidRegistryMarkets(), resumableRegistrySalts()])
  return <MyMarkets invalid={invalid} salts={salts} />
}

export default function ManagePage() {
  return (
    <section aria-labelledby="manage-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 id="manage-heading" className="font-serif text-3xl text-ink">
          Manage
        </h1>
        <p className="mt-2 text-ink-muted">
          The markets where your wallet holds a role. You see only the actions that role can sign, and every one is reviewed in your wallet
          before it is sent.
        </p>
      </div>
      <Suspense fallback={<p className="text-ink-muted">Loading the markets…</p>}>
        <Manager />
      </Suspense>
    </section>
  )
}
