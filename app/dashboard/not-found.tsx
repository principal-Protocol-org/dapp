import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"

/**
 * An unknown market id (`notFound()` in the dashboard market route) lands here, inside the dashboard
 * layout, so its header and sub-navigation stay. As `/app`'s not-found page, pointing back to the
 * dashboard's markets.
 */
export default function DashboardNotFound() {
  return (
    <section aria-labelledby="dashboard-not-found-heading" className="grid max-w-2xl gap-4 rounded-lg border border-line bg-surface p-6">
      <h1 id="dashboard-not-found-heading" className="font-serif text-3xl text-ink">
        This page was not found
      </h1>
      <p className="text-ink-muted">No market at this address. Check the link, or pick a market from the list.</p>
      <div>
        <Link href="/dashboard/markets" className={buttonVariants()}>
          See all markets
        </Link>
      </div>
    </section>
  )
}
