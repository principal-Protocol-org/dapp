import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/dashboard/overview", () => ({ Overview: () => <h1>overview</h1> }))
vi.mock("@/components/dashboard/markets-table", () => ({ MarketsView: () => <h1>markets view</h1> }))
vi.mock("@/components/dashboard/risk-panel", () => ({ RiskPanel: () => <h1>risk view</h1> }))
vi.mock("@/components/dashboard/compliance-panel", () => ({ CompliancePanel: () => <h1>compliance view</h1> }))

import DashboardPage from "../../../app/dashboard/page"
import ActivityPage from "../../../app/dashboard/activity/page"
import CompliancePage from "../../../app/dashboard/compliance/page"
import MarketsPage from "../../../app/dashboard/markets/page"
import OraclePage from "../../../app/dashboard/oracle/page"
import RiskPage from "../../../app/dashboard/risk/page"
import { DASHBOARD_NAV } from "../dashboard-nav"

describe("the dashboard routes", () => {
  it("/dashboard is the overview", () => {
    render(<DashboardPage />)
    expect(screen.getByRole("heading", { name: "overview" })).toBeTruthy()
  })

  it("/dashboard/markets is the markets view, no longer a placeholder", () => {
    render(<MarketsPage />)
    expect(screen.getByRole("heading", { name: "markets view" })).toBeTruthy()
    expect(screen.queryByText(/Coming in this release/)).toBeNull()
  })

  it.each([
    ["risk", RiskPage],
    ["compliance", CompliancePage],
  ])("/dashboard/%s is its view, no longer a placeholder", (name, Page) => {
    render(<Page />)
    expect(screen.getByRole("heading", { name: `${name} view` })).toBeTruthy()
    expect(screen.queryByText(/Coming in this release/)).toBeNull()
  })

  // Every sub-navigation link has a page (none 404s); the ones a later task fills say so plainly.
  it.each([
    ["Oracle", OraclePage],
    ["Activity", ActivityPage],
  ])("%s has a page that says it is coming, and fits 375 px", (title, Page) => {
    render(<Page />)
    const heading = screen.getByRole("heading", { level: 1, name: title })
    expect(screen.getByText(/Coming in this release/)).toBeTruthy()
    expect(heading.closest("section")?.className).toContain("grid-cols-[minmax(0,1fr)]")
    expect(DASHBOARD_NAV.some((i) => i.label === title)).toBe(true)
  })
})
