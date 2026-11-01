// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../tabs"

function Harness({ onMouseDown }: { onMouseDown?: () => void }) {
  return (
    <Tabs defaultValue="pt">
      <TabsList aria-label="Token">
        <TabsTrigger value="pt">PT</TabsTrigger>
        <TabsTrigger value="yt" onMouseDown={onMouseDown}>
          YT
        </TabsTrigger>
      </TabsList>
      <TabsContent value="pt">pt body</TabsContent>
      <TabsContent value="yt">yt body</TabsContent>
    </Tabs>
  )
}

describe("TabsTrigger", () => {
  it("focuses a clicked tab without the keyboard focus ring, and still selects it", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    render(<Harness />)
    const yt = screen.getByRole("tab", { name: "YT" })
    fireEvent.mouseDown(yt, { button: 0 })
    expect(yt.getAttribute("aria-selected")).toBe("true")
    expect(focus.mock.calls[0]).toEqual([{ focusVisible: false }])
    expect(focus.mock.contexts[0]).toBe(yt)
    focus.mockRestore()
  })
  it("leaves a right click alone and keeps the caller's onMouseDown", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const own = vi.fn()
    render(<Harness onMouseDown={own} />)
    const yt = screen.getByRole("tab", { name: "YT" })
    fireEvent.mouseDown(yt, { button: 2 })
    expect(own).toHaveBeenCalledTimes(1)
    expect(focus).not.toHaveBeenCalled()
    expect(yt.getAttribute("aria-selected")).toBe("false")
    focus.mockRestore()
  })
})
