import { HistoryTable } from "@/components/app/history/history-table"

export default function HistoryPage() {
  return (
    <section aria-labelledby="history-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div>
        <h1 id="history-heading" className="font-serif text-3xl text-ink">
          History
        </h1>
        <p className="mt-2 text-ink-muted">Your transactions on every market, read from the network events.</p>
      </div>
      <HistoryTable />
    </section>
  )
}
