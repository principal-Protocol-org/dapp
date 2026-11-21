import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { CallToAction } from "../closing"

describe("the landing call to action (plan 0009)", () => {
  it("says the markets are live on Stellar Mainnet and Testnet", () => {
    render(<CallToAction />)
    expect(screen.getByText("Live on Stellar Mainnet and Testnet")).toBeTruthy()
    expect(screen.queryByText(/coming soon/i)).toBeNull()
  })
})
