import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// jsdom does not lay out, so these pin the classes that keep a 375 px page from scrolling sideways
// (I3). The width itself is checked in a browser.
vi.mock("@/components/app/markets/market-groups", () => ({ MarketGroups: () => <div /> }))
vi.mock("@/components/app/portfolio/portfolio-view", () => ({ PortfolioView: () => <div /> }))
vi.mock("@/components/app/history/history-table", () => ({ HistoryTable: () => <div /> }))

import { GateList } from "@/components/app/actions/gate-list"
import AppPage from "../../../app/app/page"
import HistoryPage from "../../../app/app/history/page"
import PortfolioPage from "../../../app/app/portfolio/page"

describe("the /app pages at 375 px (I3)", () => {
  it.each([
    ["Markets", AppPage],
    ["Portfolio", PortfolioPage],
    ["History", HistoryPage],
  ])("%s: the page grid's one column may shrink below its content's width", (heading, Page) => {
    render(<Page />)
    const section = screen.getByRole("heading", { name: heading }).closest("section")
    // `1fr` is minmax(auto, 1fr): a wide table would widen the column, and the page, past the screen.
    expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
  })
})

describe("long unbreakable text in a narrow action panel", () => {
  it("the gate list breaks long words, so a contract ID cannot widen the panel past its card", () => {
    const id = "CCESAXEYLLFI34BLJ7NBTQP2554K7PZJRFPZBET3ZE7NRDTE3BGMRJDU"
    render(<GateList blockers={[{ code: "unavailable", message: `Could not read ${id}.` }]} />)
    // A grid item is min-width: auto; only overflow-wrap: anywhere lowers its min-content width.
    expect(screen.getByText(`Could not read ${id}.`).closest("div")?.className).toContain("wrap-anywhere")
  })
})
