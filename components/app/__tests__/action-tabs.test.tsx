import { act } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Blocker } from "@/lib/protocol/gates"

const mocks = vi.hoisted(() => ({ search: "", matured: false as boolean | null, blockers: [] as Blocker[] }))

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }))
vi.mock("@/hooks/use-matured", () => ({ useMatured: () => mocks.matured }))
// The mint panel's gate list is real: it is what differed between the server HTML and hydration (I2).
vi.mock("@/components/app/actions/mint-tab", async () => {
  const { GateList } = await import("@/components/app/actions/gate-list")
  return {
    MintTab: (p: { initialPanel?: string }) => (
      <>
        <p>{`mint panel: ${p.initialPanel ?? "default"}`}</p>
        <GateList blockers={mocks.blockers} />
      </>
    ),
  }
})
vi.mock("@/components/app/actions/trade-tab", () => ({ TradeTab: (p: { initialPanel?: string }) => <p>{`trade panel: ${p.initialPanel ?? "default"}`}</p> }))
vi.mock("@/components/app/actions/liquidity-tab", () => ({ LiquidityTab: (p: { initialPanel?: string }) => <p>{`liquidity panel: ${p.initialPanel ?? "default"}`}</p> }))
vi.mock("@/components/app/actions/redeem-tab", () => ({ RedeemTab: (p: { initialPanel?: string }) => <p>{`redeem panel: ${p.initialPanel ?? "default"}`}</p> }))

import { ActionTabs } from "../actions/action-tabs"

beforeEach(() => {
  mocks.search = ""
  mocks.matured = false
  mocks.blockers = []
})

describe("ActionTabs hydration (I2)", () => {
  const CLOCK = "Waiting for the network clock: the latest ledger time has not loaded."
  const LOADING = "Loading this market's on-chain data. Signing turns on once it has loaded."

  it("the first client render is the server HTML, even when data loaded before the tabs hydrated", async () => {
    // Request time on the server: no ledger clock, no market data.
    mocks.matured = null
    mocks.blockers = [{ code: "unavailable", message: CLOCK }, { code: "unavailable", message: LOADING }]
    const serverHtml = renderToString(<ActionTabs marketId="m1" />)
    const container = document.createElement("div")
    container.innerHTML = serverHtml
    document.body.append(container)

    // The tabs hydrate later than the page around them: by then the clock query, started outside
    // this boundary, has answered (a matured market opens on Redeem) and the gate list has changed.
    mocks.matured = true
    mocks.blockers = [{ code: "unavailable", message: LOADING }]
    const recoverable: unknown[] = []
    let root: Root | undefined
    try {
      await act(async () => {
        root = hydrateRoot(container, <ActionTabs marketId="m1" />, { onRecoverableError: (error) => recoverable.push(error) })
      })
      // React reports a hydration mismatch as a recoverable error: there must be none.
      expect(recoverable).toEqual([])
      // Once hydrated, the client shows what it knows now.
      expect(screen.getByText("redeem panel: default")).toBeTruthy()
    } finally {
      act(() => root?.unmount())
      container.remove()
    }
  })

  it("renders the gate list once mounted on the client", async () => {
    mocks.blockers = [{ code: "unavailable", message: LOADING }]
    render(<ActionTabs marketId="m1" />)
    expect(await screen.findByText(LOADING)).toBeTruthy()
  })
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
