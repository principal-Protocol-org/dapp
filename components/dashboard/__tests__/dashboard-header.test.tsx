import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  network: "testnet" as "testnet" | "local" | "mainnet",
  pathname: "/dashboard",
}))
vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => ({ network: mocks.network }) }))
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }))

import { DASHBOARD_NAV, DashboardHeader } from "../dashboard-header"

beforeEach(() => {
  mocks.network = "testnet"
  mocks.pathname = "/dashboard"
})

describe("the dashboard header (D-2)", () => {
  it("has no wallet button: nothing on the page suggests a wallet is needed", () => {
    render(<DashboardHeader />)
    expect(screen.queryByRole("button", { name: /wallet|connect|varial/i })).toBeNull()
    expect(screen.queryByRole("link", { name: /varial/i })).toBeNull()
    expect(screen.queryByText(/connect/i)).toBeNull()
  })

  it("has the logo, the network badge and Open the app", () => {
    render(<DashboardHeader />)
    expect(screen.getByRole("link", { name: /principal home/i }).getAttribute("href")).toBe("/")
    expect(screen.getAllByText("Stellar Testnet").length).toBeGreaterThan(0)
    expect(screen.getByRole("link", { name: "Open the app" }).getAttribute("href")).toBe("/app")
    expect(screen.getByRole("button", { name: /switch to dark mode/i })).toBeTruthy()
  })

  it("links the dashboard's views (D-1); a market's page is reached from Markets", () => {
    render(<DashboardHeader />)
    const nav = within(screen.getByRole("navigation", { name: "Dashboard" }))
    expect(DASHBOARD_NAV.map((i) => [i.label, i.href])).toEqual([
      ["Overview", "/dashboard"],
      ["Markets", "/dashboard/markets"],
      ["Oracle", "/dashboard/oracle"],
      ["Risk", "/dashboard/risk"],
      ["Compliance", "/dashboard/compliance"],
      ["Activity", "/dashboard/activity"],
    ])
    for (const { label, href } of DASHBOARD_NAV) expect(nav.getByRole("link", { name: label }).getAttribute("href")).toBe(href)
    expect(nav.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page")
    expect(nav.getByRole("link", { name: "Markets" }).getAttribute("aria-current")).toBeNull()
  })

  it("marks Markets on a market's page, and Overview only on the overview", () => {
    mocks.pathname = "/dashboard/markets/testnet-usdy-1802336344"
    render(<DashboardHeader />)
    const nav = within(screen.getByRole("navigation", { name: "Dashboard" }))
    expect(nav.getByRole("link", { name: "Markets" }).getAttribute("aria-current")).toBe("page")
    expect(nav.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull()
  })

  it("names Mainnet on Mainnet", () => {
    mocks.network = "mainnet"
    render(<DashboardHeader />)
    expect(screen.getAllByText("Stellar Mainnet").length).toBeGreaterThan(0)
  })

  it("at 375 px the links wrap instead of widening the page", () => {
    render(<DashboardHeader />)
    const nav = screen.getByRole("navigation", { name: "Dashboard" })
    expect(nav.querySelector("ul")?.className).toContain("flex-wrap")
    expect(nav.closest("div")?.className).toContain("flex-wrap")
  })
})
