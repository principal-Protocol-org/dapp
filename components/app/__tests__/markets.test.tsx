import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { down, live, LEDGER_TIME, marketState, MATURITY } from "./fixtures"

const mocks = vi.hoisted(() => ({
  ms: undefined as unknown,
  stale: false,
  ledgerTime: null as number | null,
}))

vi.mock("@/lib/protocol/manifest-source", () => ({
  activeManifest: () => ({
    network: "testnet",
    markets: [{ marketId: "m1", displayName: "STA · test", underlying: { code: "STA", decimals: 7 } }],
  }),
}))
vi.mock("@/hooks/use-market-state", () => ({
  useMarketState: () => ({ data: mocks.ms, isPending: mocks.ms === undefined, stale: mocks.stale }),
}))
vi.mock("@/hooks/use-ledger-clock", () => ({
  useLedgerClock: () => ({ ledgerTime: mocks.ledgerTime, sequence: 1, isError: false }),
}))

import { MarketsTable, marketStatus } from "../markets/markets-table"

beforeEach(() => {
  // jsdom has no ResizeObserver; Radix tooltips measure with it.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  mocks.ms = marketState()
  mocks.stale = false
  mocks.ledgerTime = LEDGER_TIME
})

describe("marketStatus", () => {
  it("is live before maturity", () => {
    expect(marketStatus(marketState(), LEDGER_TIME)).toBe("live")
  })
  it("is matured at or after maturity while unsettled", () => {
    expect(marketStatus(marketState(), Number(MATURITY))).toBe("matured")
  })
  it("is settled when settledRate is non-null", () => {
    expect(marketStatus(marketState({ settledRate: live<bigint | null>(10_500_000n) }), Number(MATURITY) + 5)).toBe("settled")
  })
  it("is paused when any of SY, pool or risk control is paused", () => {
    expect(marketStatus(marketState({ riskPaused: live(true) }), LEDGER_TIME)).toBe("paused")
    expect(marketStatus(marketState({ syPaused: live(true) }), LEDGER_TIME)).toBe("paused")
    expect(marketStatus(marketState({ poolPaused: live(true) }), LEDGER_TIME)).toBe("paused")
  })
  it("is unavailable without the ledger clock or a needed field", () => {
    expect(marketStatus(marketState(), null)).toBe("unavailable")
    expect(marketStatus(marketState({ maturity: down() }), LEDGER_TIME)).toBe("unavailable")
    expect(marketStatus(marketState({ settledRate: down() }), LEDGER_TIME)).toBe("unavailable")
    expect(marketStatus(marketState({ poolPaused: down() }), LEDGER_TIME)).toBe("unavailable")
  })
})

describe("MarketsTable", () => {
  const renderTable = () =>
    render(
      <TooltipProvider>
        <MarketsTable />
      </TooltipProvider>,
    )

  it("shows name, days left, Fixed APY, liquidity and status", () => {
    renderTable()
    const row = screen.getByRole("row", { name: /STA · test/ })
    expect(screen.getByRole("columnheader", { name: "Fixed APY" })).toBeTruthy()
    expect(within(row).getByRole("link", { name: "STA · test" }).getAttribute("href")).toBe("/app/markets/m1")
    expect(within(row).getByText("10 d")).toBeTruthy()
    expect(within(row).getByText("≈ 4520 STA")).toBeTruthy()
    expect(within(row).getByText("Live")).toBeTruthy()
    // 5% APR compounded over 10 days: (1 + 0.05 * 10/365)^(365/10) - 1 = 5.1235%.
    expect(within(row).getByRole("button", { name: "5.12%" })).toBeTruthy()
  })

  it("explains the APR in a tooltip", async () => {
    renderTable()
    await userEvent.hover(screen.getByRole("button", { name: "5.12%" }))
    expect((await screen.findAllByText(/APR 5\.00%/))[0]).toBeTruthy()
  })

  it("says Unavailable for unavailable values, never zero", () => {
    mocks.ms = marketState({ impliedRate: down(), poolState: down() })
    renderTable()
    const row = screen.getByRole("row", { name: /STA · test/ })
    expect(within(row).getAllByText("Unavailable").length).toBe(2)
    expect(within(row).queryByText(/^0/)).toBeNull()
  })

  it("shows Unavailable for everything while the ledger clock is missing", () => {
    mocks.ledgerTime = null
    renderTable()
    const row = screen.getByRole("row", { name: /STA · test/ })
    expect(within(row).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3)
  })

  it("shows Matured in the badge, days left and APY cells after maturity", () => {
    mocks.ledgerTime = Number(MATURITY) + 100
    renderTable()
    const cells = within(screen.getByRole("row", { name: /STA · test/ })).getAllByRole("cell")
    expect(cells[2].textContent).toBe("Matured")
    expect(cells[3].textContent).toBe("Matured")
    expect(cells[5].textContent).toBe("Matured")
  })

  it("shows Settled once the settlement rate is set", () => {
    mocks.ms = marketState({ settledRate: live<bigint | null>(10_500_000n) })
    mocks.ledgerTime = Number(MATURITY) + 100
    renderTable()
    const cells = within(screen.getByRole("row", { name: /STA · test/ })).getAllByRole("cell")
    expect(cells[5].textContent).toBe("Settled")
  })

  it("shows hours, not 0 d, inside the last day", () => {
    mocks.ledgerTime = Number(MATURITY) - 23 * 3600
    renderTable()
    expect(within(screen.getByRole("row", { name: /STA · test/ })).getAllByRole("cell")[2].textContent).toBe("23 h")
  })

  it("shows No liquidity yet for an unseeded pool, not 0%", () => {
    mocks.ms = marketState({ poolSeeded: live(false), impliedRate: live(0n) })
    renderTable()
    const cells = within(screen.getByRole("row", { name: /STA · test/ })).getAllByRole("cell")
    expect(cells[3].textContent).toBe("No liquidity yet")
    expect(cells[4].textContent).toBe("No liquidity yet")
  })

  it("shows Unavailable, not 0.00%, when pool seeding is unreadable", () => {
    mocks.ms = marketState({ poolSeeded: down(), impliedRate: live(0n) })
    renderTable()
    expect(within(screen.getByRole("row", { name: /STA · test/ })).getAllByRole("cell")[3].textContent).toBe("Unavailable")
  })

  it("does not show old values after a failed refresh", () => {
    mocks.stale = true
    renderTable()
    const row = screen.getByRole("row", { name: /STA · test/ })
    expect(within(row).getByText(/Unavailable — last update failed/)).toBeTruthy()
    expect(within(row).queryByText("≈ 4520 STA")).toBeNull()
  })
})
