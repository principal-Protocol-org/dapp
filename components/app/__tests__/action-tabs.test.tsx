import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ search: "", matured: false as boolean | null }))

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }))
vi.mock("@/hooks/use-matured", () => ({ useMatured: () => mocks.matured }))
vi.mock("@/components/app/actions/mint-tab", () => ({ MintTab: (p: { initialPanel?: string }) => <p>{`mint panel: ${p.initialPanel ?? "default"}`}</p> }))
vi.mock("@/components/app/actions/trade-tab", () => ({ TradeTab: (p: { initialPanel?: string }) => <p>{`trade panel: ${p.initialPanel ?? "default"}`}</p> }))
vi.mock("@/components/app/actions/liquidity-tab", () => ({ LiquidityTab: (p: { initialPanel?: string }) => <p>{`liquidity panel: ${p.initialPanel ?? "default"}`}</p> }))
vi.mock("@/components/app/actions/redeem-tab", () => ({ RedeemTab: (p: { initialPanel?: string }) => <p>{`redeem panel: ${p.initialPanel ?? "default"}`}</p> }))

import { ActionTabs } from "../actions/action-tabs"

beforeEach(() => {
  mocks.search = ""
  mocks.matured = false
})

describe("ActionTabs URL shortcut", () => {
  it("opens on Mint without a param", async () => {
    render(<ActionTabs marketId="m1" />)
    expect(await screen.findByText("mint panel: default")).toBeTruthy()
  })

  it("opens the tab and panel named by ?tab= and ?panel=", async () => {
    mocks.search = "tab=redeem&panel=claim_yield"
    render(<ActionTabs marketId="m1" />)
    expect(await screen.findByText("redeem panel: claim_yield")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Redeem" }).getAttribute("aria-selected")).toBe("true")
  })

  it("ignores an unknown tab and passes no panel to the other tabs", async () => {
    mocks.search = "tab=bogus&panel=claim_yield"
    render(<ActionTabs marketId="m1" />)
    expect(await screen.findByText("mint panel: default")).toBeTruthy()
  })

  it("the user's later pick wins over the URL", async () => {
    mocks.search = "tab=redeem&panel=claim_yield"
    render(<ActionTabs marketId="m1" />)
    await screen.findByText("redeem panel: claim_yield")
    await userEvent.click(screen.getByRole("tab", { name: "Trade" }))
    expect(screen.getByText("trade panel: default")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "Redeem" }).getAttribute("aria-selected")).toBe("false")
  })

  it("a tab param beats the matured default", async () => {
    mocks.matured = true
    mocks.search = "tab=liquidity&panel=remove_liquidity"
    render(<ActionTabs marketId="m1" />)
    expect(await screen.findByText("liquidity panel: remove_liquidity")).toBeTruthy()
  })
})
