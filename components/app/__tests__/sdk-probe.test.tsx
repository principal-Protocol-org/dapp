import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { SdkProbe } from "../sdk-probe"

describe("SdkProbe", () => {
  it("renders true for a valid contract id", () => {
    render(<SdkProbe />)
    expect(screen.getByTestId("sdk-probe").textContent).toBe("true")
  })
})
