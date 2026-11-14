import type { Metadata } from "next"
import { Suspense } from "react"
import { ManifestProvider } from "@/components/app/manifest-provider"
import { Providers } from "@/components/app/providers"
import { AppHeader } from "@/components/app/shell/app-header"
import { AppShellFallback } from "@/components/app/shell/app-shell-fallback"
import { MainnetPendingApp } from "@/components/app/shell/mainnet-pending"
import { TestnetBanner } from "@/components/app/shell/testnet-banner"
import { Container } from "@/components/landing/layout"
import { manifestPending } from "@/lib/protocol/manifest-source"
import { resolvedManifest } from "@/lib/server/manifest"

export const metadata: Metadata = {
  title: "Principal App",
  description: "Mint, trade and redeem principal and yield tokens on Stellar.",
}

/**
 * The market list is request-time data (the registry, spec 0002 §1): it is resolved on the server
 * inside `<Suspense>`, like the market id (V3), so the static shell is the banner and a skeleton.
 * Everything below reads it through `useManifest()`.
 */
async function ResolvedApp({ children }: { children: React.ReactNode }) {
  const manifest = await resolvedManifest()
  return (
    <ManifestProvider manifest={manifest}>
      <Providers>
        <AppHeader />
        <main id="main" className="min-h-[60vh] bg-ground py-8 text-ink">
          <Container>{children}</Container>
        </main>
      </Providers>
    </ManifestProvider>
  )
}

/**
 * While the Mainnet manifest is the pending stub (D-24), `/app` is one static page saying so: no
 * page below it renders, and nothing is read.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  if (manifestPending()) return <MainnetPendingApp />
  return (
    <>
      <TestnetBanner />
      <Suspense fallback={<AppShellFallback />}>
        <ResolvedApp>{children}</ResolvedApp>
      </Suspense>
    </>
  )
}
