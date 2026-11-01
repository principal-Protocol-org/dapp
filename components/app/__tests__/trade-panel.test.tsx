import { act } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Blocker } from "@/lib/protocol/gates"

const mocks = vi.hoisted(() => ({ search: "", matured: false as boolean | null, blockers: [] as Blocker[] }))

const MARKET = {
  marketId: "m1",
  displayName: "USDY test",
  underlying: { code: "USDY", decimals: 7 },
  maturity: 2_000_000_000,
  contracts: { pool: "POOL1" },
}
const MANIFEST = { network: "testnet", markets: [MARKET] }

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }))
vi.mock("@/hooks/use-matured", () => ({ useMatured: () => mocks.matured }))
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => MANIFEST }))
// Component tests never build transactions: the panel shows which action it was given. The gate
// list is real: it is what differed between the server HTML and hydration (I2).
vi.mock("@/components/app/actions/action-panel", async () => {
  const { GateList } = await import("@/components/app/actions/gate-list")
  return {
    ActionPanel: ({ config }: { config: { action: string } }) => (
      <div>
        <p>{`panel: ${config.action}`}</p>
        <GateList blockers={mocks.blockers} />
      </div>
    ),
  }
})

// The PT tab has its own tests (pt-tab.test.tsx); here it shows its side and the shared gate list.
vi.mock("@/components/app/trade/pt-tab", async () => {
  const { GateList } = await import("@/components/app/actions/gate-list")
  return {
    PtTab: ({ side }: { side: string }) => (
      <div>
        <p>{`pt tab: ${side}`}</p>
        <GateList blockers={mocks.blockers} />
      </div>
    ),
  }
})

// The YT tab has its own tests (yt-tab.test.tsx); here it shows its side.
vi.mock("@/components/app/trade/yt-tab", () => ({
  YtTab: ({ side }: { side: string }) => <p>{`yt tab: ${side}`}</p>,
}))

// The LP tab has its own tests (lp-tab.test.tsx); here it shows its side.
vi.mock("@/components/app/trade/lp-tab", () => ({
  LpTab: ({ side }: { side: string }) => <p>{`lp tab: ${side}`}</p>,
}))

import { TradePanel } from "../trade/trade-panel"
import { TokenPicker } from "../trade/token-picker"

beforeEach(() => {
  mocks.search = ""
  mocks.matured = false
  mocks.blockers = []
})

const tabNames = () => within(screen.getByRole("tablist", { name: "Token to trade" })).getAllByRole("tab").map((t) => t.textContent)

describe("TradePanel tabs", () => {
  it("has three tabs, PT, YT and LP, and no combined PT + YT tab", async () => {
    render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("pt tab: buy")).toBeTruthy()
    expect(tabNames()).toEqual(["PT", "YT", "LP"])
  })

  it("opens on PT Buy and switches tab and side on click", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    await userEvent.click(screen.getByRole("button", { name: "Sell" }))
    expect(screen.getByText("pt tab: sell")).toBeTruthy()
    await userEvent.click(screen.getByRole("tab", { name: "YT" }))
    expect(screen.getByText("yt tab: buy")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Sell" }))
    expect(screen.getByText("yt tab: sell")).toBeTruthy()
    await userEvent.click(screen.getByRole("tab", { name: "LP" }))
    expect(screen.getByText("lp tab: deposit")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Withdraw" }))
    expect(screen.getByText("lp tab: withdraw")).toBeTruthy()
  })

  it("takes the tab and side from ?tab= and ?side=", async () => {
    mocks.search = "tab=yt&side=sell"
    render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("yt tab: sell")).toBeTruthy()
    expect(screen.getByRole("tab", { name: "YT" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByRole("button", { name: "Sell" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("opens LP withdraw from ?tab=lp&side=withdraw", async () => {
    mocks.search = "tab=lp&side=withdraw"
    render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("lp tab: withdraw")).toBeTruthy()
  })

  it("falls back to PT Buy on unknown values, and to the tab's first side on a side it lacks", async () => {
    mocks.search = "tab=bogus&side=bogus"
    const { unmount } = render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("pt tab: buy")).toBeTruthy()
    unmount()
    mocks.search = "tab=lp&side=sell"
    render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("lp tab: deposit")).toBeTruthy()
  })

  it("the user's later pick wins over the URL", async () => {
    mocks.search = "tab=yt&side=sell"
    render(<TradePanel marketId="m1" />)
    await screen.findByText("yt tab: sell")
    await userEvent.click(screen.getByRole("tab", { name: "PT" }))
    expect(screen.getByText("pt tab: buy")).toBeTruthy()
  })

  it("after maturity the PT tab hosts Redeem (0001 behaviour)", async () => {
    mocks.matured = true
    render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("panel: redeem")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Sell" })).toBeNull()
  })

  it("after maturity the YT tab has no Buy/Sell toggle (R2-60)", async () => {
    mocks.matured = true
    mocks.search = "tab=yt"
    render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("yt tab: buy")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Buy" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Sell" })).toBeNull()
    expect(screen.getByText("This market has matured: YT trading has closed.")).toBeTruthy()
  })

  it("after maturity the LP tab opens on Withdraw, unless a side is asked for", async () => {
    mocks.matured = true
    mocks.search = "tab=lp"
    const { unmount } = render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("lp tab: withdraw")).toBeTruthy()
    unmount()
    // History's Continue for a Keep YT route asks for Deposit, where its route resumes.
    mocks.search = "tab=lp&side=deposit"
    render(<TradePanel marketId="m1" />)
    expect(await screen.findByText("lp tab: deposit")).toBeTruthy()
  })
})

describe("TokenPicker", () => {
  it("offers USDY and USDY SY, with an SY badge", () => {
    const onChange = vi.fn()
    render(<TokenPicker value="underlying" onChange={onChange} options={["underlying", "sy"]} />)
    const radios = screen.getAllByRole("radio")
    expect(radios.map((r) => r.textContent)).toEqual(["USDY", "USDYSY"])
    expect(within(radios[1]).getByText("SY")).toBeTruthy()
    expect(radios[0].getAttribute("aria-checked")).toBe("true")
  })

  it("reports the pick", async () => {
    const onChange = vi.fn()
    render(<TokenPicker value="underlying" onChange={onChange} options={["underlying", "sy"]} />)
    await userEvent.click(screen.getByRole("radio", { name: /SY/ }))
    expect(onChange).toHaveBeenCalledWith("sy")
  })

  it("is not in the panel's header on any tab: the PT, YT and LP tabs' fields carry their own", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    for (const [tab, body] of [["YT", "yt tab: buy"], ["LP", "lp tab: deposit"]] as const) {
      expect(screen.queryByRole("radiogroup")).toBeNull()
      expect(screen.queryByText(/pay in SY/)).toBeNull()
      await userEvent.click(screen.getByRole("tab", { name: tab }))
      expect(screen.getByText(body)).toBeTruthy()
    }
    expect(screen.queryByRole("radiogroup")).toBeNull()
    expect(screen.queryByText(/pay in SY/)).toBeNull()
  })

  it("every tab pays the underlying directly, so none offers a \"Need SY?\" deposit link", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    expect(screen.queryByRole("button", { name: "Need SY? Deposit USDY" })).toBeNull()
    expect(screen.getByRole("button", { name: "Split USDY into PT + YT" })).toBeTruthy()
    for (const tab of ["YT", "LP"]) {
      await userEvent.click(screen.getByRole("tab", { name: tab }))
      expect(screen.queryByRole("button", { name: /Need SY\?/ })).toBeNull()
    }
  })
})

describe("Tools", () => {
  it("lists Deposit, Withdraw, Split and Recombine, each opening its panel", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    const expected: [string, string][] = [
      ["Deposit USDY → SY", "deposit"],
      ["Withdraw SY → USDY", "withdraw"],
      ["Split USDY → PT + YT", "mint"],
      ["Recombine PT + YT → USDY", "recombine"],
    ]
    await userEvent.click(screen.getByRole("button", { name: "Tools" }))
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(expected.map(([l]) => l))
    await userEvent.keyboard("{Escape}")
    for (const [label, action] of expected) {
      await userEvent.click(screen.getByRole("button", { name: "Tools" }))
      await userEvent.click(screen.getByRole("menuitem", { name: label }))
      const dialog = await screen.findByRole("dialog", { name: label })
      expect(within(dialog).getByText(`panel: ${action}`)).toBeTruthy()
      await userEvent.keyboard("{Escape}")
      expect(screen.queryByRole("dialog")).toBeNull()
    }
  })

  it("links plain words on the page to the split dialog", async () => {
    mocks.search = "tab=lp"
    render(<TradePanel marketId="m1" />)
    await screen.findByText("lp tab: deposit")
    await userEvent.click(screen.getByRole("button", { name: "Split USDY into PT + YT" }))
    expect(within(await screen.findByRole("dialog")).getByText("panel: mint")).toBeTruthy()
  })
})

describe("TradePanel hydration (I2)", () => {
  const CLOCK = "Waiting for the network clock: the latest ledger time has not loaded."
  const LOADING = "Loading this market's on-chain data. Signing turns on once it has loaded."

  it("the first client render is the server HTML, even when data loaded before the panel hydrated", async () => {
    // Request time on the server: no ledger clock, no market data.
    mocks.matured = null
    mocks.blockers = [{ code: "unavailable", message: CLOCK }, { code: "unavailable", message: LOADING }]
    const serverHtml = renderToString(<TradePanel marketId="m1" />)
    const container = document.createElement("div")
    container.innerHTML = serverHtml
    document.body.append(container)

    // The panel hydrates later than the page around it: by then the clock query has answered
    // (a matured market opens PT on Redeem) and the gate list has changed.
    mocks.matured = true
    mocks.blockers = [{ code: "unavailable", message: LOADING }]
    const recoverable: unknown[] = []
    let root: Root | undefined
    try {
      await act(async () => {
        root = hydrateRoot(container, <TradePanel marketId="m1" />, { onRecoverableError: (error) => recoverable.push(error) })
      })
      // React reports a hydration mismatch as a recoverable error: there must be none.
      expect(recoverable).toEqual([])
      expect(screen.getByText("panel: redeem")).toBeTruthy()
    } finally {
      act(() => root?.unmount())
      container.remove()
    }
  })

  it("renders the gate list once mounted on the client", async () => {
    mocks.blockers = [{ code: "unavailable", message: LOADING }]
    render(<TradePanel marketId="m1" />)
    expect(await screen.findByText(LOADING)).toBeTruthy()
  })
})
