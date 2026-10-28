import { MarketsTable } from "@/components/app/markets/markets-table"

export default function AppPage() {
  return (
    <section aria-labelledby="markets-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 id="markets-heading" className="font-serif text-3xl text-ink">
          Markets
        </h1>
        <p className="mt-2 text-ink-muted">
          Each market splits one yield-bearing asset into a principal token (PT) and a yield token (YT).
        </p>
      </div>
      <MarketsTable />
    </section>
  )
}
