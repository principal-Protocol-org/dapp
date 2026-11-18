import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MainnetPendingError } from "@/lib/protocol/manifest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  resolvedManifest: vi.fn(),
  sql: vi.fn(() => {
    throw new Error("the database was read while Mainnet is pending")
  }),
}))
// What the committed stub gives with NEXT_PUBLIC_PRINCIPAL_NETWORK=mainnet (lib/protocol tests pin it).
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { MainnetPendingError: Pending } = await import("@/lib/protocol/manifest")
  return {
    activeManifest: () => {
      throw new Pending()
    },
    activeNetwork: () => "mainnet",
    manifestPending: () => true,
  }
})
vi.mock("@/lib/server/manifest", () => ({ resolvedManifest: mocks.resolvedManifest }))
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", notFound: vi.fn() }))
vi.mock("next/server", () => ({ connection: async () => {} }))
vi.mock("@/lib/server/db", () => ({ sql: mocks.sql, DatabaseConfigError: class DatabaseConfigError extends Error {} }))

import AppLayout from "../../../app/app/layout"
import DashboardLayout from "../../../app/dashboard/layout"
import { generateStaticParams as appParams } from "../../../app/app/markets/[marketId]/page"
import { generateStaticParams as dashboardParams } from "../../../app/dashboard/markets/[marketId]/page"
import { MarketRoute } from "../../../app/app/markets/[marketId]/market-route"
import { DashboardMarketRoute } from "../../../app/dashboard/markets/[marketId]/market-route"
import { invalidRegistryMarkets, resumableRegistrySalts } from "@/lib/server/manage"

const HEADING = "Mainnet contracts are not deployed yet."

beforeEach(() => {
  mocks.resolvedManifest.mockReset()
  mocks.sql.mockClear()
})

describe("the pending Mainnet stub in the app and the dashboard (D-24)", () => {
  it("/app shows one clear page, never the app, and reads nothing", () => {
    render(AppLayout({ children: <p>the markets</p> }))
    expect(screen.getByRole("heading", { level: 1, name: HEADING })).toBeTruthy()
    expect(screen.queryByText("the markets")).toBeNull()
    expect(screen.getByRole("link", { name: "Principal home" }).getAttribute("href")).toBe("/")
    expect(mocks.resolvedManifest).not.toHaveBeenCalled()
    // No test-network banner on Mainnet.
    expect(screen.queryByText(/test assets only/)).toBeNull()
  })

  it("/dashboard shows the same page under its header, never guessed data", () => {
    render(DashboardLayout({ children: <p>the overview</p> } as LayoutProps<"/dashboard">))
    expect(screen.getByRole("heading", { level: 1, name: HEADING })).toBeTruthy()
    expect(screen.queryByText("the overview")).toBeNull()
    expect(screen.getAllByText("Stellar Mainnet").length).toBeGreaterThan(0)
    expect(mocks.resolvedManifest).not.toHaveBeenCalled()
  })

  it("the market pages still build: their placeholder id is never a market", () => {
    expect(appParams()).toEqual([{ marketId: "no-seed-market" }])
    expect(dashboardParams()).toEqual([{ marketId: "no-seed-market" }])
  })

  // Next renders a layout's pages in parallel with it, whether or not the layout shows them: the
  // pages' own server reads must stop too, or each request logs a MainnetPendingError stack.
  it("the pages' server parts read nothing either", async () => {
    const params = Promise.resolve({ marketId: "anything" })
    expect(await MarketRoute({ params })).toBeNull()
    expect(await DashboardMarketRoute({ params })).toBeNull()
    expect(mocks.resolvedManifest).not.toHaveBeenCalled()
    expect(await invalidRegistryMarkets()).toEqual({ status: "unavailable" })
    expect(await resumableRegistrySalts()).toEqual({ status: "unavailable" })
    expect(mocks.sql).not.toHaveBeenCalled()
  })

  it("says why in plain words", () => {
    render(AppLayout({ children: null }))
    const page = screen.getByRole("heading", { level: 1, name: HEADING }).closest("section")!
    expect(page.textContent).toMatch(/Stellar Mainnet/)
    expect(new MainnetPendingError().message).toBe(HEADING)
  })
})
