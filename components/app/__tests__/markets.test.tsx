import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { MarketState } from "@/lib/protocol/market-state"
import type { MarketHistory, Spark } from "@/lib/app/history-types"
import { down, live, LEDGER_TIME, marketState, MATURITY } from "./fixtures"

const POOL1 = "C" + "A".repeat(55)
const POOL2 = "C" + "B".repeat(55)

type Query<T> = { data: T | undefined; isPending: boolean; isError: boolean }

const mocks = vi.hoisted(() => ({
  states: {} as Record<string, { data: unknown; isPending: boolean; stale: boolean }>,
  ledgerTime: null as number | null,
  testAsset: true,
  extraAsset: false,
  history: {} as Record<string, unknown>,
  sparks: undefined as unknown,
}))

vi.mock("@/components/app/manifest-provider", () => {
  const underlying = { code: "USDY", issuer: "GISS", sac: "CSAC", decimals: 7 }
  const other = { code: "BENJI", issuer: "GOTH", sac: "COTHER", decimals: 7 }
  const mk = (id: string, pool: string, u: typeof underlying) => ({
    marketId: id,
    displayName: `${u.code} · ${id}`,
    underlying: u,
    maturity: 1_800_000_000,
    contracts: { pool },
  })
  const make = (testAsset: boolean, extra: boolean) => ({
    network: "testnet",
    testAsset: testAsset ? { ...underlying, displayName: "USDY (test)" } : undefined,
    markets: [
      mk("m1", "C" + "A".repeat(55), underlying),
      mk("m2", "C" + "B".repeat(55), underlying),
      ...(extra ? [mk("m3", "C" + "D".repeat(55), other)] : []),
    ],
  })
  const cache = new Map<string, unknown>()
  return {
    useManifest: () => {
      const key = `${mocks.testAsset}${mocks.extraAsset}`
      if (!cache.has(key)) cache.set(key, make(mocks.testAsset, mocks.extraAsset))
      return cache.get(key)
    },
  }
})
vi.mock("@/hooks/use-market-state", () => ({
  useMarketStates: (ids: string[]) => ids.map((id) => mocks.states[id] ?? { data: undefined, isPending: true, stale: false }),
}))
vi.mock("@/hooks/use-market-history", () => ({
  useMarketHistory: (pool: string): Query<MarketHistory> => {
    const h = mocks.history[pool] as MarketHistory | "pending" | "error" | undefined
    if (h === "pending") return { data: undefined, isPending: true, isError: false }
    if (h === undefined || h === "error") return { data: undefined, isPending: false, isError: true }
    return { data: h, isPending: false, isError: false }
  },
  useSparks: (): Query<{ sparks: Record<string, Spark>; stale: boolean }> =>
    mocks.sparks === "pending"
      ? { data: undefined, isPending: true, isError: false }
      : mocks.sparks === undefined
        ? { data: undefined, isPending: false, isError: true }
        : { data: mocks.sparks as { sparks: Record<string, Spark>; stale: boolean }, isPending: false, isError: false },
}))
vi.mock("@/hooks/use-ledger-clock", () => ({
  useLedgerClock: () => ({ ledgerTime: mocks.ledgerTime, sequence: 1, isError: false }),
}))

import { MarketGroups, marketStatus } from "../markets/market-groups"

const DAY = 86_400
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const NOW = LEDGER_TIME
const emptyHistory: MarketHistory = {
  fixedApy: [],
  underlyingApy7d: [],
  liquidity: [],
  latestAt: null,
  stale: false,
  underlyingWindowSeconds: null,
}
function history(over: Partial<MarketHistory> = {}): MarketHistory {
  return { ...emptyHistory, ...over }
}
const spark = (over: Partial<Spark> = {}): Spark => ({
  points: [
    { at: NOW - 2 * DAY, value: 0.05 },
    { at: NOW - DAY, value: 0.052 },
  ],
  changePts: 0.18,
  stale: false,
  ...over,
})

function setMarket(id: string, ms: MarketState | undefined, extra: { isPending?: boolean; stale?: boolean } = {}) {
  mocks.states[id] = { data: ms, isPending: extra.isPending ?? ms === undefined, stale: extra.stale ?? false }
}

beforeEach(() => {
  // jsdom has no ResizeObserver; Radix tooltips measure with it.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  mocks.states = {}
  mocks.testAsset = true
  mocks.extraAsset = false
  mocks.ledgerTime = LEDGER_TIME
  // m1: PT 0.98 -> 50x, 5% APR. m2: PT 0.95 -> 20x, 7% APR (longer-dated look, same maturity in the fixture).
  setMarket("m1", marketState())
  setMarket("m2", marketState({ ptPrice: live(9_500_000n), impliedRate: live(700_000n) }))
  mocks.history = {
    [POOL1]: history({
      underlyingApy7d: [{ at: NOW - 600, value: 0.0498 }],
      underlyingWindowSeconds: 7 * DAY,
      latestAt: NOW - 600,
    }),
    [POOL2]: history(),
  }
  mocks.sparks = { sparks: { [POOL1]: spark(), [POOL2]: spark({ points: [], changePts: null }) }, stale: false }
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

describe("MarketGroups", () => {
  const renderList = () =>
    render(
      <TooltipProvider>
        <MarketGroups />
      </TooltipProvider>,
    )
  const assetRow = () => screen.getByRole("button", { name: /USDY \(test\)/ })
  const marketCard = (id: string) => screen.getByRole("listitem", { name: new RegExp(`USDY · ${id}`) })

  it("groups markets by underlying with a count badge", () => {
    mocks.extraAsset = true
    setMarket("m3", marketState())
    renderList()
    expect(within(assetRow()).getByText("2 markets")).toBeTruthy()
    expect(within(screen.getByRole("button", { name: /BENJI/ })).getByText("1 market")).toBeTruthy()
  })

  it("asset row shows total liquidity over TVL, best YT leverage, best fixed APY", () => {
    renderList()
    const row = assetRow()
    // Liquidity per market: SY 3,400 + PT 1,200 x its price / oracle 1.05. m1: 4,520. m2: 4,485.71. TVL: (6,000 + 3,400) = 9,400 each.
    expect(within(row).getByText("9,005.71")).toBeTruthy()
    expect(within(row).getByText("18,800")).toBeTruthy()
    expect(within(row).getByText("50x")).toBeTruthy()
    // 7% APR compounded over 10 days: 7.2436%.
    expect(within(row).getByText("7.24%")).toBeTruthy()
  })

  it("asset row total is Unavailable when any market's liquidity is, never a partial sum", () => {
    setMarket("m2", marketState({ poolState: down() }))
    renderList()
    const row = assetRow()
    expect(within(row).queryByText("9,005.71")).toBeNull()
    expect(within(row).queryByText("4,520")).toBeNull()
    expect(within(row).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(1)
    // The best figures still come from the markets that did answer.
    expect(within(row).getByText("50x")).toBeTruthy()
  })

  it("best figures skip matured markets", () => {
    setMarket("m1", marketState({ settledRate: live<bigint | null>(10_500_000n) }))
    mocks.ledgerTime = Number(MATURITY) + 100
    renderList()
    expect(within(assetRow()).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2)
    expect(within(assetRow()).queryByText("50x")).toBeNull()
  })

  it("maturity row shows liquidity over TVL, 7-day underlying APY, spark, YT chip with leverage, PT chip with fixed APY", () => {
    renderList()
    const card = marketCard("m1")
    expect(within(card).getByRole("link", { name: /USDY · m1/ }).getAttribute("href")).toBe("/app/markets/m1")
    expect(within(card).getByText("4,520")).toBeTruthy()
    expect(within(card).getByText("9,400")).toBeTruthy()
    expect(within(card).getByText("4.98%")).toBeTruthy()
    expect(within(card).getByRole("img", { name: /30-day fixed APY, up 0\.18 points/ })).toBeTruthy()
    expect(within(card).getByText("+0.18 pt")).toBeTruthy()
    expect(within(card).getByRole("link", { name: /YT.*50x/ })).toBeTruthy()
    // 5% APR compounded over 10 days: 5.1235%.
    expect(within(card).getByRole("link", { name: /PT.*5\.12%/ })).toBeTruthy()
    expect(within(card).getByText("Live")).toBeTruthy()
    expect(within(card).getByText(/10 d left/)).toBeTruthy()
  })

  it("chip links to the market with tab and side", () => {
    renderList()
    const card = marketCard("m1")
    expect(within(card).getByRole("link", { name: /YT.*50x/ }).getAttribute("href")).toBe("/app/markets/m1?tab=yt&side=buy")
    expect(within(card).getByRole("link", { name: /PT.*5\.12%/ }).getAttribute("href")).toBe("/app/markets/m1?tab=pt&side=buy")
  })

  it("list renders without history: spark says No history yet, 7-day APY says Unavailable with its reason", () => {
    renderList()
    const card = marketCard("m2")
    expect(within(card).getByText("No history yet")).toBeTruthy()
    const apy = within(card).getByText("Unavailable", { selector: "[data-cell='underlying-apy']" })
    expect(apy.getAttribute("title")).toMatch(/No oracle snapshots yet/)
    // The rest of the row still renders.
    expect(within(card).getByRole("link", { name: /YT.*20x/ })).toBeTruthy()
  })

  it("says Unavailable, not No history yet, when history cannot be read", () => {
    mocks.history = {}
    mocks.sparks = undefined
    renderList()
    const card = marketCard("m1")
    expect(within(card).queryByText("No history yet")).toBeNull()
    expect(within(card).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2)
  })

  it("shows the window since the first point when history is shorter than 7 days (R2-44)", () => {
    mocks.history = {
      [POOL1]: history({
        underlyingApy7d: [{ at: NOW - 600, value: 0.0612 }],
        underlyingWindowSeconds: 2 * DAY,
        latestAt: NOW - 600,
      }),
    }
    renderList()
    const cell = within(marketCard("m1")).getByText("6.12%").closest("[data-cell='underlying-apy']") as HTMLElement
    const since = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
      new Date((NOW - 600 - 2 * DAY) * 1000),
    )
    expect(cell.textContent).toContain(`since ${since}`)
  })

  it("does not say since for a full 7-day window", () => {
    renderList()
    const cell = within(marketCard("m1")).getByText("4.98%").closest("[data-cell='underlying-apy']") as HTMLElement
    expect(cell.textContent).not.toContain("since")
  })

  it("labels the test asset USDY (test) with the note", () => {
    renderList()
    expect(within(assetRow()).getByText("Test token issued by Principal for Stellar Testnet, not Ondo's USDY")).toBeTruthy()
  })

  it("uses the plain code and no note when the manifest has no test asset", () => {
    mocks.testAsset = false
    renderList()
    expect(screen.getByRole("button", { name: /USDY/ })).toBeTruthy()
    expect(screen.queryByText(/USDY \(test\)/)).toBeNull()
    expect(screen.queryByText(/not Ondo's USDY/)).toBeNull()
  })

  it("collapses and expands an asset", async () => {
    mocks.extraAsset = true
    setMarket("m3", marketState())
    renderList()
    // Several assets start collapsed.
    expect(screen.queryByRole("listitem", { name: /USDY · m1/ })).toBeNull()
    await userEvent.click(assetRow())
    expect(screen.getByRole("listitem", { name: /USDY · m1/ })).toBeTruthy()
    expect(assetRow().getAttribute("aria-expanded")).toBe("true")
  })

  it("says Unavailable for unavailable values, never zero", () => {
    setMarket("m1", marketState({ impliedRate: down(), poolState: down(), ptPrice: down() }))
    renderList()
    const card = marketCard("m1")
    expect(within(card).queryByRole("link", { name: /^(YT|PT)/ })).toBeNull()
    expect(within(card).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(3)
    expect(within(card).queryByText(/^0/)).toBeNull()
  })

  it("shows Unavailable for the ledger-dependent figures while the ledger clock is missing", () => {
    mocks.ledgerTime = null
    renderList()
    const card = marketCard("m1")
    expect(within(card).queryByRole("link", { name: /PT.*%/ })).toBeNull()
    expect(within(card).getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2)
  })

  it("shows Matured, no chips, after maturity", () => {
    mocks.ledgerTime = Number(MATURITY) + 100
    renderList()
    const card = marketCard("m1")
    expect(within(card).getAllByText("Matured").length).toBeGreaterThanOrEqual(1)
    expect(within(card).queryByRole("link", { name: /^(YT|PT)/ })).toBeNull()
  })

  it("shows Settled once the settlement rate is set", () => {
    setMarket("m1", marketState({ settledRate: live<bigint | null>(10_500_000n) }))
    mocks.ledgerTime = Number(MATURITY) + 100
    renderList()
    expect(within(marketCard("m1")).getAllByText("Settled").length).toBeGreaterThanOrEqual(1)
  })

  it("shows hours, not 0 d, inside the last day", () => {
    mocks.ledgerTime = Number(MATURITY) - 23 * 3600
    renderList()
    expect(within(marketCard("m1")).getByText(/23 h left/)).toBeTruthy()
  })

  it("shows No liquidity yet for an unseeded pool, not 0", () => {
    setMarket("m1", marketState({ poolSeeded: live(false), impliedRate: live(0n) }))
    renderList()
    const card = marketCard("m1")
    expect(within(card).getByText("No liquidity yet")).toBeTruthy()
    expect(within(card).queryByRole("link", { name: /PT.*%/ })).toBeNull()
  })

  it("shows Unavailable, not 0.00%, when pool seeding is unreadable", () => {
    setMarket("m1", marketState({ poolSeeded: down(), impliedRate: live(0n) }))
    renderList()
    const card = marketCard("m1")
    expect(within(card).queryByText(/0\.00%/)).toBeNull()
    expect(within(card).queryByRole("link", { name: /PT/ })).toBeNull()
  })

  it("YT chip is Unavailable when the PT is at or above par", () => {
    setMarket("m1", marketState({ ptPrice: live(10_000_000n) }))
    renderList()
    expect(within(marketCard("m1")).queryByRole("link", { name: /^YT/ })).toBeNull()
  })

  it("does not show old values after a failed refresh", () => {
    setMarket("m1", marketState(), { stale: true })
    renderList()
    const card = marketCard("m1")
    expect(within(card).getByText(/Unavailable — last update failed/)).toBeTruthy()
    expect(within(card).queryByText("4,520")).toBeNull()
  })

  it("375 px: a maturity row is a stacked card below md and a grid row from md", () => {
    renderList()
    const card = marketCard("m1")
    // Cards stack by default; the shared column grid applies from md up. The list may shrink with its page.
    expect(card.className).toContain("flex-col")
    expect(card.className).toContain("md:grid")
    expect(card.parentElement?.parentElement?.parentElement?.parentElement?.className).toContain("min-w-0")
  })

  it("shows the chevron on the asset row at every width", () => {
    renderList()
    const chevron = within(assetRow()).getByTestId("chevron")
    expect(chevron.className).not.toContain("hidden")
  })

  it("spark says since <date> when its history is younger than 30 days, and not for a full window", () => {
    renderList()
    const since = SHORT.format(new Date((NOW - 2 * DAY) * 1000))
    const card = marketCard("m1")
    expect(within(card).getByText(`since ${since}`)).toBeTruthy()
    mocks.sparks = {
      sparks: { [POOL1]: spark({ points: [{ at: NOW - 30 * DAY, value: 0.05 }, { at: NOW, value: 0.052 }] }), [POOL2]: spark({ points: [], changePts: null }) },
      stale: false,
    }
    cleanup()
    renderList()
    expect(within(marketCard("m1")).queryByText(/^since /)).toBeNull()
  })

  it("asset row says No liquidity yet, not 0, when every pool is unseeded", () => {
    setMarket("m1", marketState({ poolSeeded: live(false) }))
    setMarket("m2", marketState({ poolSeeded: live(false) }))
    renderList()
    const row = assetRow()
    expect(within(row).getByText("No liquidity yet")).toBeTruthy()
    expect(within(row).queryByText(/^0 /)).toBeNull()
  })

  it("shows a skeleton while a market loads", () => {
    setMarket("m1", undefined, { isPending: true })
    renderList()
    expect(within(marketCard("m1")).getByTestId("market-loading")).toBeTruthy()
  })
})
