import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"

/**
 * An unknown market id (`notFound()` in the market route) lands here, inside the /app layout, so
 * the header and testnet banner stay. Served as 200 and noindex when it streams inside Suspense,
 * the documented cost of `notFound()` there.
 */
export default function AppNotFound() {
  return (
    <section aria-labelledby="app-not-found-heading" className="grid max-w-2xl gap-4 rounded-lg border border-line bg-surface p-6">
      <h1 id="app-not-found-heading" className="font-serif text-3xl text-ink">
        This page was not found
      </h1>
      <p className="text-ink-muted">There is no market or page at this address. Check the link, or pick a market from the list.</p>
      <div>
        <Link href="/app" className={buttonVariants()}>
          See all markets
        </Link>
      </div>
    </section>
  )
}
