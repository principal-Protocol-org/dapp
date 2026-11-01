import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it } from "vitest"
import { InfoTip } from "@/components/app/info-tip"
import { PreviewList } from "@/components/app/actions/preview-lines"

afterEach(cleanup)

describe("InfoTip", () => {
  it("is a real button named after the label, closed until asked", () => {
    render(<InfoTip label="Fees">{"The pool's fee."}</InfoTip>)
    const button = screen.getByRole("button", { name: "More about Fees" })
    expect(button.tagName).toBe("BUTTON")
    expect(button.getAttribute("type")).toBe("button")
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  it("opens on hover", async () => {
    const user = userEvent.setup()
    render(<InfoTip label="Fees">{"The pool's fee."}</InfoTip>)
    await user.hover(screen.getByRole("button", { name: "More about Fees" }))
    expect((await screen.findByRole("tooltip")).textContent).toBe("The pool's fee.")
    // (Leaving closes it through Radix's grace-area pointer tracking, which jsdom has no geometry for: checked in the browser.)
  })

  it("opens on keyboard focus, is described by the tip, and closes on Escape", async () => {
    const user = userEvent.setup()
    render(<InfoTip label="Fees">{"The pool's fee."}</InfoTip>)
    await user.tab()
    const button = screen.getByRole("button", { name: "More about Fees" })
    expect(document.activeElement).toBe(button)
    expect((await screen.findByRole("tooltip")).textContent).toBe("The pool's fee.")
    expect(button.getAttribute("aria-describedby")).toBeTruthy()
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  it("opens on a tap (click) with no hover, toggles shut on a second tap, and closes on an outside tap", async () => {
    const user = userEvent.setup()
    render(
      <div>
        <InfoTip label="Fees">{"The pool's fee."}</InfoTip>
        <p>elsewhere</p>
      </div>,
    )
    const button = screen.getByRole("button", { name: "More about Fees" })
    await user.click(button)
    expect((await screen.findByRole("tooltip")).textContent).toBe("The pool's fee.")
    await user.click(button)
    expect(screen.queryByRole("tooltip")).toBeNull()
    await user.click(button)
    await screen.findByRole("tooltip")
    await user.click(screen.getByText("elsewhere"))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })
})

describe("PreviewList", () => {
  it("renders label | value rows, an info button only on a hinted row, and no hint text inline", async () => {
    const user = userEvent.setup()
    render(
      <PreviewList
        lines={[
          { label: "Fixed APY", value: "5.01% → 4.98%", hint: "The pool's fixed APY now, and after." },
          { label: "Fees", value: "0.12 USDY" },
        ]}
      />,
    )
    expect(screen.getByText("Fixed APY").closest("dt")?.nextSibling?.textContent).toBe("5.01% → 4.98%")
    expect(screen.getByText("Fees").closest("dt")?.nextSibling?.textContent).toBe("0.12 USDY")
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(screen.queryByText(/The pool's fixed APY now/)).toBeNull()
    await user.click(screen.getByRole("button", { name: "More about Fixed APY" }))
    expect((await screen.findByRole("tooltip")).textContent).toBe("The pool's fixed APY now, and after.")
  })
})
