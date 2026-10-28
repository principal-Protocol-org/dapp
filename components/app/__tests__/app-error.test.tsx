import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import AppError from "../../../app/app/error"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("/app error boundary (M9)", () => {
  it("says in plain words that the page failed, and retries on request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const retry = vi.fn()
    render(<AppError error={new Error("Manifest is invalid: markets[0].maturity")} retry={retry} />)
    expect(screen.getByRole("heading", { name: "This page could not be shown" })).toBeTruthy()
    expect(screen.getByText(/Nothing was signed or sent/)).toBeTruthy()
    // The cause stays available, folded away.
    expect(screen.getByText("Manifest is invalid: markets[0].maturity")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it("copes with a thrown value that is not an Error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(<AppError error="boom" retry={() => {}} />)
    expect(screen.getByRole("heading", { name: "This page could not be shown" })).toBeTruthy()
    expect(screen.queryByText("Technical details")).toBeNull()
  })
})
