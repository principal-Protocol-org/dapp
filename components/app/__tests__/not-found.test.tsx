import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import GlobalError from "../../../app/global-error"
import AppNotFound from "../../../app/app/not-found"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("/app not-found page (plan 0001 Task 25)", () => {
  it("says the market was not found and links back to the markets, inside the app layout's chrome", () => {
    render(<AppNotFound />)
    expect(screen.getByRole("heading", { name: "This page was not found" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "See all markets" }).getAttribute("href")).toBe("/app")
  })
})

describe("root error boundary", () => {
  it("renders its own document, says what to do about a signed transaction, and retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const retry = vi.fn()
    // The component renders <html>; render it into the test document's body without nesting warnings.
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(<GlobalError error={new Error("boom")} retry={retry} />, { container: document.documentElement })
    expect(screen.getByRole("heading", { name: "Principal could not be shown" })).toBeTruthy()
    expect(screen.getByText(/check History before trying again/)).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
