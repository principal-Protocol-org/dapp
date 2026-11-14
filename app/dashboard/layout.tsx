import type { Metadata } from "next"
import { Suspense } from "react"
import { ManifestProvider } from "@/components/app/manifest-provider"
import { Providers } from "@/components/app/providers"
import { MainnetPending } from "@/components/app/shell/mainnet-pending"
import { TestnetBanner } from "@/components/app/shell/testnet-banner"
import { DashboardFallback } from "@/components/dashboard/dashboard-fallback"
import { DashboardHeader } from "@/components/dashboard/dashboard-header"
import { Container } from "@/components/landing/layout"
import { manifestPending } from "@/lib/protocol/manifest-source"
import { resolvedManifest } from "@/lib/server/manifest"

export const metadata: Metadata = {
  title: "Principal Dashboard",
  description: "The public state of the Principal protocol on Stellar, read from its contracts. No wallet needed.",
}

/**
 * The markets are request-time data (the registry): resolved on the server inside `<Suspense>`, as
 * in `app/app/layout.tsx`, and handed to the same `ManifestProvider` and `Providers` (React Query,
 * tooltips, toasts; the wallet provider comes with them, but no dashboard view reads it, D-2).
 */
async function ResolvedDashboard({ children }: { children: React.ReactNode }) {
  const manifest = await resolvedManifest()
  return (
    <ManifestProvider manifest={manifest}>
      <Providers>{children}</Providers>
    </ManifestProvider>
  )
}

/**
 * The public dashboard (spec 0004 D-1, D-2), outside `/app`: the URL itself says no wallet is
 * needed. The banner and the header need only the static manifest, so they are the prerendered
 * shell with a page skeleton; the page streams in once the markets are resolved. While the Mainnet
 * manifest is the pending stub (D-24), the header frames one static page saying so instead.
 */
export default function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  if (manifestPending()) {
    return (
      <>
        <DashboardHeader />
        <main id="main" className="min-h-[60vh] bg-ground py-8 text-ink">
          <Container>
            <MainnetPending />
          </Container>
        </main>
      </>
    )
  }
  return (
    <>
      <TestnetBanner />
      <DashboardHeader />
      <main id="main" className="min-h-[60vh] bg-ground py-8 text-ink">
        <Container>
          <Suspense fallback={<DashboardFallback />}>
            <ResolvedDashboard>{children}</ResolvedDashboard>
          </Suspense>
        </Container>
      </main>
    </>
  )
}
