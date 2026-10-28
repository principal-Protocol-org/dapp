import { PortfolioView } from "@/components/app/portfolio/portfolio-view"

export default function PortfolioPage() {
  return (
    <section aria-labelledby="portfolio-heading" className="grid gap-6">
      <div>
        <h1 id="portfolio-heading" className="font-serif text-3xl text-ink">
          Portfolio
        </h1>
        <p className="mt-2 text-ink-muted">Your positions on every market: balances, pending yield and what PT returns at maturity.</p>
      </div>
      <PortfolioView />
    </section>
  )
}
