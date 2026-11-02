"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Logo } from "@/components/landing/brand"
import { Container } from "@/components/landing/layout"
import { ThemeToggle } from "@/components/landing/theme-toggle"
import { useMyRoles } from "@/hooks/use-manage"
import { managesAnything } from "@/lib/protocol/roles"
import { cn } from "@/lib/utils"
import { SettingsPopover } from "./settings-popover"
import { WalletButton } from "./wallet-button"

const NAV = [
  { href: "/app", label: "Markets" },
  { href: "/app/portfolio", label: "Portfolio" },
  { href: "/app/history", label: "History" },
] as const
const MANAGE = { href: "/app/manage", label: "Manage" } as const

function isActive(pathname: string, href: string) {
  return href === "/app" ? pathname === "/app" || pathname.startsWith("/app/markets") : pathname.startsWith(href)
}

export function AppHeader() {
  const pathname = usePathname()
  // Shown only on a read that came back "yes": a role on a listed market, or the test asset's issuer (spec 0002 §5).
  const { roles } = useMyRoles()
  const items = managesAnything(roles) ? [...NAV, MANAGE] : NAV
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-ground/86 backdrop-blur-md">
      {/* The row may always wrap: with a wallet connected (and Manage, or the wrong-network warning)
          a single row needs more room than a mid-size window has, and a no-wrap row would push the
          wallet button off screen. Below 900 px the nav takes its own row. */}
      <Container className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 min-[900px]:min-h-16">
        <Link href="/" aria-label="Principal home" className="inline-flex items-center text-ink">
          <Logo className="h-[26px] min-[700px]:h-[30px]" />
        </Link>
        <nav
          aria-label="App"
          className="order-last flex w-full items-center gap-5 min-[900px]:order-none min-[900px]:mr-auto min-[900px]:ml-8 min-[900px]:w-auto"
        >
          {items.map(({ href, label }) => {
            const active = isActive(pathname, href)
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "border-b-2 border-transparent py-2 text-sm font-medium text-ink-muted hover:text-ink",
                  active && "border-coupon text-ink",
                )}
              >
                {label}
              </Link>
            )
          })}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <SettingsPopover />
          <WalletButton />
        </div>
      </Container>
    </header>
  )
}
