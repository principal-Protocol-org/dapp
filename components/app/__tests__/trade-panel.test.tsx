import { act } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Blocker } from "@/lib/protocol/gates"

const mocks = vi.hoisted(() => ({ search: "", matured: false as boolean | null, blockers: [] as Blocker[], ptMounts: 0 }))

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

// The PT tab has its own tests (pt-tab.test.tsx); here it shows its side and the shared gate list,
// and counts its mounts (its RouteFlow reads the route log when it mounts).
vi.mock("@/components/app/trade/pt-tab", async () => {
  const { useEffect } = await import("react")
  const { GateList } = await import("@/components/app/actions/gate-list")
  return {
    PtTab: ({ side }: { side: string }) => {
      useEffect(() => {
        mocks.ptMounts++
      }, [])
      return (
        <div>
          <p>{`pt tab: ${side}`}</p>
          <GateList blockers={mocks.blockers} />
        </div>
      )
    },
  }
})

// The recombine route form has its own tests (recombine-action.test.tsx); here it says it is there.
vi.mock("@/components/app/trade/recombine-action", async (orig) => ({
  ...(await orig<object>()),
  RecombineAction: ({ onRedeem }: { onRedeem?: () => void }) => (
    <div>
      <p>recombine route form</p>
      {onRedeem ? (
        <button type="button" onClick={onRedeem}>
          Redeem in the PT tab
        </button>
      ) : null}
    </div>
  ),
}))

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
  mocks.ptMounts = 0
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

describe("Side toggle", () => {
  const classes = (el: HTMLElement) => el.className.split(/\s+/)
  const GREEN = ["border-positive", "bg-positive/10", "text-positive"]
  const RED = ["border-negative", "bg-negative/10", "text-negative"]
  const OFF = ["border-transparent", "text-ink-muted", "hover:text-ink"]
  const tinted = (el: HTMLElement) => classes(el).some((c) => /positive|negative/.test(c))

  it("spans the column in two equal cells: green on a pressed Buy or Deposit, red on a pressed Sell or Withdraw", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    const group = () => screen.getByRole("group", { name: "Side" })
    expect(classes(group())).toEqual(expect.arrayContaining(["grid", "w-full", "grid-cols-2", "gap-1"]))
    const side = (name: string) => within(group()).getByRole("button", { name }) as HTMLButtonElement

    for (const [tab, green, red] of [["PT", "Buy", "Sell"], ["YT", "Buy", "Sell"], ["LP", "Deposit", "Withdraw"]] as const) {
      await userEvent.click(screen.getByRole("tab", { name: tab }))
      for (const name of [green, red]) expect(classes(side(name))).toEqual(expect.arrayContaining(["w-full", "min-h-10", "font-medium"]))
      expect(side(green).getAttribute("aria-pressed")).toBe("true")
      expect(classes(side(green))).toEqual(expect.arrayContaining(GREEN))
      expect(classes(side(red))).toEqual(expect.arrayContaining(OFF))
      expect(tinted(side(red))).toBe(false)
      await userEvent.click(side(red))
      expect(side(red).getAttribute("aria-pressed")).toBe("true")
      expect(classes(side(red))).toEqual(expect.arrayContaining(RED))
      expect(classes(side(green))).toEqual(expect.arrayContaining(OFF))
      expect(tinted(side(green))).toBe(false)
      // The focus ring stays.
      expect(classes(side(red))).toEqual(expect.arrayContaining(["focus-visible:outline-2", "focus-visible:outline-ring"]))
    }
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
    // R2-66: the isolated Split link is gone; Split is in Quick actions only.
    expect(screen.queryByRole("button", { name: "Split USDY into PT + YT" })).toBeNull()
    for (const tab of ["YT", "LP"]) {
      await userEvent.click(screen.getByRole("tab", { name: tab }))
      expect(screen.queryByRole("button", { name: /Need SY\?/ })).toBeNull()
    }
  })
})

describe("Quick actions", () => {
  // Label, what the dialog hosts, description. Recombine is a route form (R2-72), the others 0001 panels.
  const EXPECTED: [string, string, string][] = [
    ["Deposit USDY → SY", "panel: deposit", "Turn USDY into SY, the token the pool trades."],
    ["Withdraw SY → USDY", "panel: withdraw", "Turn SY back into USDY."],
    ["Split USDY → PT + YT", "panel: mint", "Split USDY into equal amounts of PT and YT."],
    ["Recombine PT + YT", "recombine route form", "Give back equal amounts of PT and YT for USDY or SY, before maturity."],
  ]

  it("is a small \"Quick actions\" menu on the heading row, not \"Tools\"", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    expect(screen.queryByRole("button", { name: "Tools" })).toBeNull()
    const trigger = screen.getByRole("button", { name: "Quick actions" })
    // The toggle scale (text-xs), a quiet variant, and an icon before and a chevron after, both hidden.
    expect(trigger.getAttribute("data-size")).toBe("toggle")
    expect(trigger.getAttribute("data-variant")).not.toBe("primary")
    const icons = trigger.querySelectorAll("svg")
    expect(icons).toHaveLength(2)
    for (const icon of icons) expect(icon.getAttribute("aria-hidden")).toBe("true")
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu")
  })

  it("lists Deposit, Withdraw, Split and Recombine, each with an icon, its label and its description, each opening its panel", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
    const items = screen.getAllByRole("menuitem")
    expect(items).toHaveLength(4)
    for (const [label, , description] of EXPECTED) {
      const item = screen.getByRole("menuitem", { name: label, description })
      const icon = item.querySelector("svg")
      expect(icon?.getAttribute("aria-hidden")).toBe("true")
    }
    // The old label promised USDY whatever the route paid.
    expect(screen.queryByRole("menuitem", { name: "Recombine PT + YT → USDY" })).toBeNull()
    await userEvent.keyboard("{Escape}")
    for (const [label, body, description] of EXPECTED) {
      await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
      await userEvent.click(screen.getByRole("menuitem", { name: label }))
      const dialog = await screen.findByRole("dialog", { name: label, description })
      expect(within(dialog).getByText(body)).toBeTruthy()
      await userEvent.keyboard("{Escape}")
      expect(screen.queryByRole("dialog")).toBeNull()
    }
  })

  it("Recombine hosts the route form, never 0001's single-step recombine panel (R2-72)", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Recombine PT + YT" }))
    const dialog = await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    expect(within(dialog).getByText("recombine route form")).toBeTruthy()
    expect(within(dialog).queryByText("panel: recombine")).toBeNull()
  })

  it("?quick=recombine opens the Recombine dialog (History's Continue); closing it does not open it again", async () => {
    mocks.search = "quick=recombine"
    render(<TradePanel marketId="m1" />)
    const dialog = await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    expect(within(dialog).getByText("recombine route form")).toBeTruthy()
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByText("pt tab: buy")).toBeTruthy()
  })

  it("ignores an unknown ?quick=", async () => {
    mocks.search = "quick=bogus"
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("closing the Recombine dialog remounts the tab, so its RouteFlow reads the route log again", async () => {
    render(<TradePanel marketId="m1" />)
    await screen.findByText("pt tab: buy")
    expect(mocks.ptMounts).toBe(1)
    await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Recombine PT + YT" }))
    await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    // While the dialog is open the tab stays as it was (it is behind the modal).
    expect(mocks.ptMounts).toBe(1)
    await userEvent.keyboard("{Escape}")
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(mocks.ptMounts).toBe(2)
    // A 0001 panel's dialog hosts no route: closing it leaves the tab alone.
    await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Deposit USDY → SY" }))
    await screen.findByRole("dialog", { name: "Deposit USDY → SY" })
    await userEvent.keyboard("{Escape}")
    expect(mocks.ptMounts).toBe(2)
  })

  it("after maturity the Recombine dialog's pointer to Redeem closes it and opens the PT tab", async () => {
    mocks.matured = true
    mocks.search = "tab=yt"
    render(<TradePanel marketId="m1" />)
    await screen.findByText("yt tab: buy")
    await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Recombine PT + YT" }))
    const dialog = await screen.findByRole("dialog", { name: "Recombine PT + YT" })
    await userEvent.click(within(dialog).getByRole("button", { name: "Redeem in the PT tab" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByText("panel: redeem")).toBeTruthy()
  })

  it("opens the split dialog through Quick actions; no separate link on the page (R2-66)", async () => {
    mocks.search = "tab=lp"
    render(<TradePanel marketId="m1" />)
    await screen.findByText("lp tab: deposit")
    expect(screen.queryByRole("button", { name: "Split USDY into PT + YT" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
    await userEvent.click(screen.getByRole("menuitem", { name: "Split USDY → PT + YT" }))
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
