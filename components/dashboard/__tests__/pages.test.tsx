import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/dashboard/overview", () => ({ Overview: () => <h1>overview</h1> }))

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

  // Every sub-navigation link has a page (none 404s); the ones a later task fills say so plainly.
  it.each([
    ["Markets", MarketsPage],
    ["Oracle", OraclePage],
    ["Risk", RiskPage],
    ["Compliance", CompliancePage],
    ["Activity", ActivityPage],
  ])("%s has a page that says it is coming, and fits 375 px", (title, Page) => {
    render(<Page />)
    const heading = screen.getByRole("heading", { level: 1, name: title })
    expect(screen.getByText(/Coming in this release/)).toBeTruthy()
    expect(heading.closest("section")?.className).toContain("grid-cols-[minmax(0,1fr)]")
    expect(DASHBOARD_NAV.some((i) => i.label === title)).toBe(true)
  })
})
