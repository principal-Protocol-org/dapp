import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SiteFooter } from "../closing"

describe("the landing footer", () => {
  it("links the public dashboard (spec 0004 D-3), in the same tab", () => {
    render(<SiteFooter />)
    const link = within(screen.getByRole("navigation", { name: "Footer" })).getByRole("link", { name: "Dashboard" })
    expect(link.getAttribute("href")).toBe("/dashboard")
    expect(link.getAttribute("target")).toBeNull()
  })

  it("keeps opening the documentation and GitHub in a new tab", () => {
    render(<SiteFooter />)
    const nav = within(screen.getByRole("navigation", { name: "Footer" }))
    expect(nav.getByRole("link", { name: "Documentation" }).getAttribute("target")).toBe("_blank")
    expect(nav.getByRole("link", { name: "GitHub" }).getAttribute("target")).toBe("_blank")
  })
})
