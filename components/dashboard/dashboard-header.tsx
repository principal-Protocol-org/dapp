import { Suspense } from "react"
import Link from "next/link"
import { networkLabel } from "@/components/app/shell/network"
import { Logo } from "@/components/landing/brand"
import { Container } from "@/components/landing/layout"
import { ThemeToggle } from "@/components/landing/theme-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { Network } from "@/lib/protocol/types"
import { DashboardNav, DashboardNavLinks } from "./dashboard-nav"

export { DASHBOARD_NAV } from "./dashboard-nav"

const BADGE_STATUS = { testnet: "soon", local: "dev", mainnet: "live" } as const

function NetworkBadge({ network, className }: { network: Network; className?: string }) {
  return (
    <Badge status={BADGE_STATUS[network]} className={className}>
      {networkLabel(network)}
    </Badge>
  )
}

/**
 * The dashboard's header (D-2): the logo, the views, the network badge, the theme switch and "Open
 * the app". It has no wallet button: no dashboard view reads a wallet. It needs only the network
 * (static, from the manifest) and the path, so it is part of the prerendered shell; the markets
 * resolve below it, in the layout's `<Suspense>`.
 *
 * Below 900 px the links take their own row and wrap; below 520 px the badge moves to the end of the
 * links, so the first row keeps the logo, the theme switch and "Open the app" within 375 px.
 */
export function DashboardHeader() {
  const { network } = activeManifest()
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ground/86 backdrop-blur-md">
      <Container className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 min-[900px]:min-h-16">
        <Link href="/" aria-label="Principal home" className="inline-flex items-center text-ink">
          <Logo className="h-[24px] min-[700px]:h-[30px]" />
        </Link>
        <nav
          aria-label="Dashboard"
          className="order-last w-full min-[900px]:order-none min-[900px]:mr-auto min-[900px]:ml-8 min-[900px]:w-auto"
        >
          <Suspense fallback={<DashboardNavLinks pathname={null} narrowExtra={<NetworkBadge network={network} />} />}>
            <DashboardNav narrowExtra={<NetworkBadge network={network} />} />
          </Suspense>
        </nav>
        <div className="flex items-center gap-2">
          <NetworkBadge network={network} className="max-[520px]:hidden" />
          <ThemeToggle />
          <Button asChild variant="secondary" size="toggle">
            <Link href="/app">Open the app</Link>
          </Button>
        </div>
      </Container>
    </header>
  )
}
