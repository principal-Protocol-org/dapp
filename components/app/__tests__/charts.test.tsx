import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { LineChart } from "@/components/app/charts/line-chart"
import { SparkLine } from "@/components/app/charts/spark-line"
import type { Series } from "@/lib/app/history-types"

const T0 = 1_700_000_000
const mk = (values: (number | null)[]): Series => values.map((value, i) => ({ at: T0 + i * 900, value }))
const NOW_MS = (T0 + 3 * 900 + 3 * 3600) * 1000

function chart(over: Partial<React.ComponentProps<typeof LineChart>> = {}) {
  return render(
    <LineChart
      series={[
        { id: "fixed", label: "Fixed APY", color: "pt", points: mk([0.05, 0.06, 0.055, 0.07]) },
        { id: "underlying", label: "Underlying APY", color: "yt", points: mk([0.04, 0.045, 0.05, 0.05]) },
      ]}
      range="30d"
      onRangeChange={() => {}}
      stale={false}
      latestAt={T0 + 3 * 900}
      now={NOW_MS}
      spread={{ fixed: "fixed", variable: "underlying" }}
      {...over}
    />,
  )
}

describe("LineChart", () => {
  it("a null point breaks the line", () => {
    const { container } = chart({
      series: [{ id: "fixed", label: "Fixed APY", color: "pt", points: mk([0.05, 0.06, null, 0.07, 0.08]) }],
    })
    expect(container.querySelectorAll('path[data-series="fixed"]')).toHaveLength(2)
    const whole = chart({
      series: [{ id: "fixed", label: "Fixed APY", color: "pt", points: mk([0.05, 0.06, 0.07]) }],
    })
    expect(whole.container.querySelectorAll('path[data-series="fixed"]')).toHaveLength(1)
  })

  it('tooltip shows both series and the spread labelled "Fixed premium"', () => {
    chart()
    fireEvent.focus(screen.getByTestId("chart-plot"))
    const tip = screen.getByRole("tooltip")
    expect(tip.textContent).toContain("Fixed APY")
    expect(tip.textContent).toContain("7.00%")
    expect(tip.textContent).toContain("Underlying APY")
    expect(tip.textContent).toContain("5.00%")
    expect(tip.textContent).toContain("Fixed premium")
    expect(tip.textContent).toContain("+2.00 pts")
  })

  it("arrow keys move the tooltip to an earlier point", () => {
    chart()
    const plot = screen.getByTestId("chart-plot")
    fireEvent.focus(plot)
    fireEvent.keyDown(plot, { key: "ArrowLeft" })
    expect(screen.getByRole("tooltip").textContent).toContain("5.50%")
  })

  it('stale banner reads "History is N h old"', () => {
    chart({ stale: true })
    expect(screen.getByText("History is 3 h old")).toBeTruthy()
  })

  it("no banner while fresh", () => {
    chart()
    expect(screen.queryByText(/History is/)).toBeNull()
  })

  it('empty series renders "No history yet"', () => {
    chart({ series: [{ id: "fixed", label: "Fixed APY", color: "pt", points: [] }], latestAt: null })
    expect(screen.getByText("No history yet")).toBeTruthy()
  })

  it("labels the image with the latest values and switches range", () => {
    const onRangeChange = vi.fn()
    chart({ onRangeChange })
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/Fixed APY 7\.00%.*Underlying APY 5\.00%/)
    fireEvent.click(screen.getByRole("button", { name: "90 d" }))
    expect(onRangeChange).toHaveBeenCalledWith("90d")
    expect(screen.getByRole("button", { name: "30 d" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("a flat series shows only its own value on the axis", () => {
    const { container } = chart({
      series: [{ id: "fixed", label: "Fixed APY", color: "pt", points: mk([0.05, 0.05, 0.05]) }],
    })
    const labels = [...container.querySelectorAll("text")].map((t) => t.textContent)
    expect(labels).toEqual(["5.00%"])
  })

  it("a single point still renders without invented axis figures", () => {
    const { container } = chart({
      series: [{ id: "fixed", label: "Fixed APY", color: "pt", points: mk([0.05]) }],
    })
    expect([...container.querySelectorAll("text")].map((t) => t.textContent)).toEqual(["5.00%"])
    expect(container.querySelectorAll("circle")).toHaveLength(1)
  })

  it("a flat amount series keeps its zero baseline and never exceeds its value", () => {
    const { container } = chart({
      unit: "amount",
      series: [{ id: "liq", label: "Liquidity", color: "pt", points: mk([1000, 1000]) }],
    })
    expect([...container.querySelectorAll("text")].map((t) => t.textContent)).toEqual(["0", "500", "1,000"])
  })

  it("the liquidity chart shows no spread", () => {
    chart({
      unit: "amount",
      series: [
        { id: "fixed", label: "A", color: "pt", points: mk([10, 20]) },
        { id: "underlying", label: "B", color: "yt", points: mk([5, 6]) },
      ],
    })
    fireEvent.focus(screen.getByTestId("chart-plot"))
    expect(screen.getByRole("tooltip").textContent).not.toContain("Fixed premium")
  })

  it("no spread without a named pair", () => {
    chart({ spread: undefined })
    fireEvent.focus(screen.getByTestId("chart-plot"))
    expect(screen.getByRole("tooltip").textContent).not.toContain("Fixed premium")
  })

  it("hides the stale banner when latestAt is unknown", () => {
    chart({ stale: true, latestAt: null })
    expect(screen.queryByText(/History is/)).toBeNull()
  })

  it("formats amounts with grouping", () => {
    chart({
      unit: "amount",
      series: [{ id: "liq", label: "Liquidity", color: "pt", points: mk([1000, 2500000]) }],
    })
    fireEvent.focus(screen.getByTestId("chart-plot"))
    expect(screen.getByRole("tooltip").textContent).toContain("2,500,000")
  })
})

describe("SparkLine", () => {
  it("spark colour follows the sign of the change", () => {
    const { rerender, container } = render(<SparkLine points={mk([0.05, 0.06])} changePts={1} />)
    expect(container.querySelector("svg")!.getAttribute("data-trend")).toBe("up")
    expect(container.querySelector("path")!.getAttribute("stroke")).toBe("var(--positive)")
    rerender(<SparkLine points={mk([0.06, 0.05])} changePts={-1} />)
    expect(container.querySelector("svg")!.getAttribute("data-trend")).toBe("down")
    expect(container.querySelector("path")!.getAttribute("stroke")).toBe("var(--negative)")
  })

  it('renders "No history yet" without points', () => {
    render(<SparkLine points={[]} changePts={null} />)
    expect(screen.getByText("No history yet")).toBeTruthy()
  })

  it("breaks at gaps", () => {
    const { container } = render(<SparkLine points={mk([0.05, null, 0.06, 0.07])} changePts={2} />)
    expect(container.querySelectorAll("path")).toHaveLength(1) // one run of 2 points; the lone point is a dot
    expect(container.querySelectorAll("circle")).toHaveLength(1)
  })
})
