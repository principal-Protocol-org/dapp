import type { Metadata } from "next"
import { AppHeader } from "@/components/app/shell/app-header"
import { TestnetBanner } from "@/components/app/shell/testnet-banner"
import { Providers } from "@/components/app/providers"
import { Container } from "@/components/landing/layout"

export const metadata: Metadata = {
  title: "Principal App",
  description: "Mint, trade and redeem principal and yield tokens on Stellar.",
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <TestnetBanner />
      <AppHeader />
      <main id="main" className="min-h-[60vh] bg-ground py-8 text-ink">
        <Container>{children}</Container>
      </main>
    </Providers>
  )
}
