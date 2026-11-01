// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"
import { useState } from "react"
import { CardTabs, CardTabsContent, type CardTab } from "../card-tabs"

function Harness({ tabs }: { tabs: CardTab[] }) {
  const [value, setValue] = useState(tabs[0].value)
  return (
    <CardTabs value={value} onValueChange={setValue} tabs={tabs} label="Things">
      {tabs.map((t) => (
        <CardTabsContent key={t.value} value={t.value}>
          body {t.value}
        </CardTabsContent>
      ))}
    </CardTabs>
  )
}

const TABS: CardTab[] = [
  { value: "a", title: "Alpha", subtitle: "First one" },
  { value: "b", title: "Beta", subtitle: "Second one", count: 2 },
  { value: "c", title: "Gamma", subtitle: "Third one", count: 0 },
]

describe("CardTabs", () => {
  it("renders role=tab triggers with the first selected, one equal column per tab", () => {
    render(<Harness tabs={TABS} />)
    const tabs = screen.getAllByRole("tab")
    expect(tabs).toHaveLength(3)
    expect(tabs[0].getAttribute("aria-selected")).toBe("true")
    expect(tabs[1].getAttribute("aria-selected")).toBe("false")
    const list = screen.getByRole("tablist", { name: "Things" })
    expect(list.style.gridTemplateColumns).toBe("repeat(3, minmax(0, 1fr))")
    expect(list.className).toContain("border-b")
  })
  it("moves between tabs with the arrow keys", async () => {
    render(<Harness tabs={TABS} />)
    screen.getByRole("tab", { name: "Alpha" }).focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(screen.getByRole("tab", { name: /^Beta/ }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByText("body b")).toBeTruthy()
  })
  it("styles the active tab with the accent underline and the others on the darker band", () => {
    render(<Harness tabs={TABS} />)
    const [a, b] = screen.getAllByRole("tab")
    expect(a.className).toContain("data-[state=active]:bg-surface")
    expect(a.className).toContain("data-[state=active]:border-coupon")
    expect(a.className).toContain("data-[state=active]:text-ink")
    expect(b.className).toContain("bg-surface-sunk")
    expect(b.className).toContain("text-ink-muted")
    expect(a.className).toContain("border-b-2")
  })
  it("shows the subtitle, hidden on phones, as the tab's description rather than its name", () => {
    render(<Harness tabs={TABS} />)
    const a = screen.getByRole("tab", { name: "Alpha" })
    const sub = screen.getByText("First one")
    expect(sub.className).toContain("max-sm:hidden")
    expect(sub.className).toContain("text-ink-muted")
    expect(a.getAttribute("aria-describedby")).toBe(sub.id)
  })
  it("shows a count badge for a number, neutral for 0 and negative above 0, none when undefined", () => {
    render(<Harness tabs={[...TABS, { value: "d", title: "Delta", subtitle: "x" }]} />)
    const beta = screen.getByRole("tab", { name: "Beta, 2 problems" })
    const bad = within(beta).getByText("2")
    expect(bad.className).toContain("bg-negative/15")
    expect(bad.className).toContain("var(--negative)")
    const gamma = screen.getByRole("tab", { name: "Gamma, 0 problems" })
    const zero = within(gamma).getByText("0")
    expect(zero.className).toContain("bg-surface-sunk")
    expect(zero.className).toContain("text-ink-muted")
    const delta = screen.getByRole("tab", { name: "Delta" })
    expect(delta.querySelector("[data-slot=count]")).toBeNull()
    expect(within(delta).queryByText(/problem/)).toBeNull()
  })
  it("says '1 problem' in the singular, with visually hidden text and no role=img", () => {
    render(<Harness tabs={[{ value: "a", title: "Safety", subtitle: "s", count: 1 }]} />)
    const tab = screen.getByRole("tab", { name: "Safety, 1 problem" })
    expect(within(tab).getByText(", 1 problem").className).toContain("sr-only")
    expect(within(tab).queryByRole("img")).toBeNull()
  })

  it("gives the focusable tab panel a visible focus ring (M11)", () => {
    render(<Harness tabs={TABS} />)
    const panel = screen.getByRole("tabpanel")
    expect(panel.className).not.toMatch(/(^|\s)outline-none(\s|$)/)
    expect(panel.className).toContain("focus-visible:outline-2")
    expect(panel.className).toContain("focus-visible:outline-ring")
  })
})
