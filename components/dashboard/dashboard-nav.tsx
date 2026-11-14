"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "cn"

/**
 * The dashboard's views (spec 0004 D-1). A market's page, `/dashboard/markets/[marketId]`, is reached
 * from Markets, which stays marked there.
 */
export const DASHBOARD_NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/markets", label: "Markets" },
  { href: "/dashboard/oracle", label: "Oracle" },
  { href: "/dashboard/risk", label: "Risk" },
  { href: "/dashboard/compliance", label: "Compliance" },
  { href: "/dashboard/activity", label: "Activity" },
] as const

function isActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false
  return href === "/dashboard" ? pathname === "/dashboard" : pathname === href || pathname.startsWith(`${href}/`)
}

/**
 * The links; `pathname` null (the prerendered shell) marks none. They wrap at narrow widths, never
 * scroll the page. `narrowExtra` (the network badge) ends the list below 520 px, beside the last link.
 */
export function DashboardNavLinks({ pathname, narrowExtra }: { pathname: string | null; narrowExtra?: ReactNode }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-0">
      {DASHBOARD_NAV.map(({ href, label }) => {
        const active = isActive(pathname, href)
        return (
          <li key={href}>
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-block border-b-2 border-transparent py-2 text-sm font-medium text-ink-muted hover:text-ink",
                active && "border-coupon text-ink",
              )}
            >
              {label}
            </Link>
          </li>
        )
      })}
      {narrowExtra ? <li className="min-[520px]:hidden">{narrowExtra}</li> : null}
    </ul>
  )
}

/**
 * The links with the current one marked. `usePathname` suspends on a page whose dynamic param is
 * not known at build time (a registry market), so the header wraps this in `<Suspense>` with the
 * unmarked links as the fallback (Next 16, Cache Components).
 */
export function DashboardNav({ narrowExtra }: { narrowExtra?: ReactNode }) {
  return <DashboardNavLinks pathname={usePathname()} narrowExtra={narrowExtra} />
}
