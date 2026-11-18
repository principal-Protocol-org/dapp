import Link from "next/link"
import { Logo } from "@/components/landing/brand"
import { Container } from "@/components/landing/layout"
import { ThemeToggle } from "@/components/landing/theme-toggle"
import { buttonVariants } from "@/components/ui/button"
import { MAINNET_PENDING_MESSAGE } from "@/lib/protocol/manifest"

/**
 * What `/app` and `/dashboard` show while the Mainnet manifest is the committed stub
 * `{ "network": "mainnet", "pending": true }` (D-24): one clear page, never a crash and never a
 * guessed figure. It needs no manifest, so it is part of the static shell.
 */
export function MainnetPending() {
  return (
    <section aria-labelledby="mainnet-pending-heading" className="grid max-w-2xl gap-4 rounded-lg border border-line bg-surface p-6">
      <h1 id="mainnet-pending-heading" className="font-serif text-3xl text-ink">
        {MAINNET_PENDING_MESSAGE}
      </h1>
      <p className="text-ink-muted">
        This app is set up for Stellar Mainnet, where the Principal contracts are not live yet. No market, balance or rate is shown until they
        are.
      </p>
      <div>
        <Link href="/" className={buttonVariants()}>
          Back to the home page
        </Link>
      </div>
    </section>
  )
}

/**
 * `/app` while Mainnet is pending: the app's header needs the markets and a wallet, so this page has
 * its own, with the logo and the theme switch only.
 */
export function MainnetPendingApp() {
  return (
    <>
      <header className="sticky top-0 z-20 border-b border-line bg-ground/86 backdrop-blur-md">
        <Container className="flex items-center justify-between gap-4 py-2 min-[900px]:min-h-16">
          <Link href="/" aria-label="Principal home" className="inline-flex items-center text-ink">
            <Logo className="h-[26px] min-[700px]:h-[30px]" />
          </Link>
          <ThemeToggle />
        </Container>
      </header>
      <main id="main" className="min-h-[60vh] bg-ground py-8 text-ink">
        <Container>
          <MainnetPending />
        </Container>
      </main>
    </>
  )
}
