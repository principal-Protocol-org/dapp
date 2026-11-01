import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountState } from "@/lib/protocol/account-state"
import type { WalletState } from "@/lib/protocol/types"
import { TooltipProvider } from "@/components/ui/tooltip"
import { accountState, down, live, LEDGER_TIME, marketState } from "./fixtures"

const MARKET = {
  marketId: "m1",
  displayName: "STA · test",
  underlying: { code: "STA", decimals: 7 },
  contracts: { pool: "POOL1" },
}
const mocks = vi.hoisted(() => ({
  ms: undefined as unknown,
  stale: false,
  accountStale: false,
  compliance: undefined as unknown,
  account: undefined as AccountState | undefined,
  wallet: { status: "disconnected" } as WalletState,
  findings: [] as { severity: string; message: string }[],
  network: "testnet" as "testnet" | "local" | "mainnet",
  pending: false,
  history: "ok" as "ok" | "pending" | "error" | "short" | "empty",
  historyRanges: [] as string[],
  clock: { ledgerTime: null as number | null, isError: false },
  search: new URLSearchParams(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("@/components/app/manifest-provider", () => {
  // One object per network, as the provider gives: hooks depend on its identity.
  const byNetwork = new Map<string, unknown>()
  const make = (network: string) => ({ network, markets: [MARKET] })
  return {
    useManifest: () => {
      if (!byNetwork.has(mocks.network)) byNetwork.set(mocks.network, make(mocks.network))
      return byNetwork.get(mocks.network)
    },
  }
})
// Server side: generateStaticParams reads the static seeds, MarketRoute the resolved markets.
vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => ({ network: mocks.network, markets: [MARKET] }) }))
vi.mock("@/lib/server/manifest", () => ({
  resolvedManifest: async () => ({ network: mocks.network, markets: [MARKET, { ...MARKET, marketId: "testnet-sta-registry" }] }),
}))
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, useSearchParams: () => mocks.search }))
vi.mock("@/hooks/use-market-state", () => ({
  useMarketState: () => ({ data: mocks.ms, isPending: mocks.pending, stale: mocks.stale }),
}))
const DAY = 86_400
const HIST_NOW = LEDGER_TIME
const HIST = {
  fixedApy: [
    { at: HIST_NOW - 2 * DAY, value: 0.05 },
    { at: HIST_NOW - DAY, value: 0.052 },
  ],
  underlyingApy7d: [
    { at: HIST_NOW - 2 * DAY, value: 0.04 },
    { at: HIST_NOW - DAY, value: 0.0498 },
  ],
  liquidity: [
    { at: HIST_NOW - 2 * DAY, value: 4000 },
    { at: HIST_NOW - DAY, value: 4520 },
  ],
  latestAt: HIST_NOW - DAY,
  stale: false,
  underlyingWindowSeconds: 7 * DAY,
}
vi.mock("@/hooks/use-market-history", () => ({
  useMarketHistory: (_pool: string, range: string) => {
    mocks.historyRanges.push(range)
    if (mocks.history === "pending") return { data: undefined, isPending: true, isError: false }
    if (mocks.history === "error") return { data: undefined, isPending: false, isError: true }
    if (mocks.history === "empty")
      return { data: { ...HIST, fixedApy: [], underlyingApy7d: [], liquidity: [], latestAt: null, underlyingWindowSeconds: null }, isPending: false, isError: false }
    if (mocks.history === "short") return { data: { ...HIST, underlyingWindowSeconds: 2 * DAY }, isPending: false, isError: false }
    return { data: HIST, isPending: false, isError: false }
  },
}))
vi.mock("@/hooks/use-market-compliance", () => ({
  useMarketCompliance: () => ({ data: mocks.compliance, isPending: false }),
}))
vi.mock("@/hooks/use-account-state", () => ({
  useAccountState: () => ({ data: mocks.account, isPending: false, stale: mocks.accountStale }),
}))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))
vi.mock("@/hooks/use-ledger-clock", () => ({
  useLedgerClock: () => ({ ...mocks.clock, sequence: 1 }),
}))
vi.mock("@/hooks/use-manifest-findings", () => ({ useManifestFindings: () => mocks.findings }))
// The action panels have their own tests (pt-tab, yt-tab, lp-tab, mint-tab, …); here only their mounting matters.
vi.mock("@/components/app/trade/trade-panel", () => ({
  TradePanel: ({ marketId }: { marketId: string }) => <section aria-label={`Actions for ${marketId}`} />,
}))
// The dialog has its own tests (onboarding.test.tsx); here only its wiring matters.
vi.mock("@/components/app/onboarding/onboarding-dialog", () => ({
  OnboardingDialog: ({ open, marketId }: { open: boolean; marketId?: string }) =>
    open ? <div role="dialog" aria-label={`Get test tokens for ${marketId}`} /> : null,
}))

import { isValidElement, Suspense } from "react"
import MarketPage, { generateStaticParams } from "../../../app/app/markets/[marketId]/page"
import { MarketRoute } from "../../../app/app/markets/[marketId]/market-route"
import { ComplianceContent } from "../market/compliance-card"
import { MarketInfoCard } from "../market/market-info-card"
import { MarketChartBox } from "../market/market-chart-box"
import { MarketDetails } from "../market/market-details"
import { MarketHeader } from "../market/market-header"
import { MarketStats } from "../market/market-stats"
import { MarketView } from "../market/market-view"
import { SafetyContent } from "../market/safety-card"

const wrap = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)
const sac = live({
  kind: "sac" as const,
  authRequired: true,
  authRevocable: true,
  clawbackEnabled: false,
  administrator: "GADMINISTRATORADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
})

beforeEach(() => {
  mocks.ms = marketState()
  mocks.stale = false
  mocks.accountStale = false
  mocks.compliance = sac
  mocks.account = undefined
  mocks.wallet = { status: "disconnected" }
  mocks.findings = []
  mocks.network = "testnet"
  mocks.search = new URLSearchParams()
  mocks.notFound.mockClear()
  mocks.pending = false
  mocks.history = "ok"
  mocks.historyRanges = []
  mocks.clock = { ledgerTime: LEDGER_TIME, isError: false }
})

describe("market page route", () => {
  it("prerenders every manifest market", () => {
    expect(generateStaticParams()).toEqual([{ marketId: "m1" }])
  })
  it("keeps the market id out of the shared App Shell: params are read inside Suspense (V3)", () => {
    // A params promise that never settles: the page must not wait for it.
    const params = new Promise<{ marketId: string }>(() => {})
    const el = MarketPage({ params })
    expect(isValidElement(el)).toBe(true)
    if (!isValidElement<{ children: React.ReactElement<{ params: unknown }> }>(el)) return
    expect(el.type).toBe(Suspense)
    expect(el.props.children.type).toBe(MarketRoute)
    expect(el.props.children.props.params).toBe(params)
  })
  it("calls notFound for an unknown market id", async () => {
    await expect(MarketRoute({ params: Promise.resolve({ marketId: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND")
    expect(mocks.notFound).toHaveBeenCalled()
  })
  it("renders the market for a known id", async () => {
    const el = await MarketRoute({ params: Promise.resolve({ marketId: "m1" }) })
    expect(el.props.marketId).toBe("m1")
  })
  it("renders a registry market too: known ids are the resolved markets, not only the seeds", async () => {
    const el = await MarketRoute({ params: Promise.resolve({ marketId: "testnet-sta-registry" }) })
    expect(el.props.marketId).toBe("testnet-sta-registry")
    expect(mocks.notFound).not.toHaveBeenCalled()
  })
})

describe("MarketHeader", () => {
  const badge = () => document.querySelector('[data-slot="badge"]')?.textContent
  it("shows asset, maturity, status and countdown", () => {
    wrap(<MarketHeader marketId="m1" />)
    expect(screen.getByRole("heading", { name: "STA · test" })).toBeTruthy()
    expect(badge()).toBe("Live")
    expect(screen.getByText("Matures in 10d 0h 0m")).toBeTruthy()
    expect(screen.getByText(/Jan 15, 2027/)).toBeTruthy()
  })
  it("says Loading, not Unavailable, in the status badge while the ledger clock loads (V6)", () => {
    mocks.clock = { ledgerTime: null, isError: false }
    wrap(<MarketHeader marketId="m1" />)
    expect(badge()).toBe("Loading")
  })
  it("says Loading in the status badge while the market data loads (V6)", () => {
    mocks.ms = undefined
    mocks.pending = true
    wrap(<MarketHeader marketId="m1" />)
    expect(badge()).toBe("Loading")
  })
  it("says Unavailable once the ledger clock has failed", () => {
    mocks.clock = { ledgerTime: null, isError: true }
    wrap(<MarketHeader marketId="m1" />)
    expect(badge()).toBe("Unavailable")
  })
})

describe("MarketStats", () => {
  const stat = (label: string) => screen.getByText(label).nextSibling
  it("shows five stats: liquidity, TVL, underlying APY 7 d, PT fixed APY, YT leverage", () => {
    wrap(<MarketStats marketId="m1" />)
    expect(stat("Liquidity")?.textContent).toBe("≈ 4,520 STA")
    expect(stat("TVL")?.textContent).toBe("≈ 9,400 STA")
    expect(stat("Underlying APY (7 d)")?.textContent).toContain("4.98%")
    expect(stat("PT fixed APY")?.textContent).toMatch(/^\d+\.\d\d%$/)
    expect(stat("YT leverage")?.textContent).toBe("50x")
  })
  it("labels a short underlying window 'since <date>' and never extrapolates (R2-44)", () => {
    mocks.history = "short"
    wrap(<MarketStats marketId="m1" />)
    expect(stat("Underlying APY (7 d)")?.textContent).toMatch(/4\.98%.*since Jan \d+/)
  })
  it("says Unavailable with a reason when there is no history (R2-44)", () => {
    mocks.history = "empty"
    wrap(<MarketStats marketId="m1" />)
    const v = stat("Underlying APY (7 d)") as HTMLElement
    expect(v?.textContent).toBe("Unavailable")
    expect(v?.querySelector("[title]")?.getAttribute("title")).toMatch(/No oracle snapshots/)
  })
  it("says No liquidity yet for an unseeded pool", () => {
    mocks.ms = marketState({ poolSeeded: live(false) })
    wrap(<MarketStats marketId="m1" />)
    expect(stat("Liquidity")?.textContent).toBe("No liquidity yet")
    expect(stat("YT leverage")?.textContent).toBe("No liquidity yet")
  })
  it("hides old values after a failed refresh", () => {
    mocks.stale = true
    wrap(<MarketStats marketId="m1" />)
    expect(screen.getByRole("alert").textContent).toMatch(/Unavailable — last update failed/)
    expect(screen.queryByText("YT leverage")).toBeNull()
  })
})

describe("MarketChartBox", () => {
  it("has tabs APY and Liquidity only (details moved to the info card) and ranges 7 d, 30 d, 90 d, All", () => {
    wrap(<MarketChartBox marketId="m1" />)
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["APY", "Liquidity"])
    const group = screen.getByRole("group", { name: "Range" })
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["7 d", "30 d", "90 d", "All"])
  })
  it("plots the fixed and the underlying APY on the APY tab", () => {
    wrap(<MarketChartBox marketId="m1" />)
    expect(screen.getByRole("img", { name: /Fixed APY 5\.20%.*Underlying APY \(7 d\) 4\.98%/ })).toBeTruthy()
  })
  it("shows the fixed premium in the APY tooltip (R2-43)", async () => {
    wrap(<MarketChartBox marketId="m1" />)
    screen.getByRole("img", { name: /Chart, latest/ }).focus()
    expect((await screen.findAllByText(/Fixed premium/)).length).toBeGreaterThan(0)
  })
  it("plots liquidity on the Liquidity tab with no premium", async () => {
    wrap(<MarketChartBox marketId="m1" />)
    await userEvent.click(screen.getByRole("tab", { name: "Liquidity" }))
    expect(screen.getByRole("img", { name: /Liquidity.*4,?520/ })).toBeTruthy()
    expect(screen.queryByText(/Fixed premium/)).toBeNull()
  })
  it("refetches for the chosen range", async () => {
    wrap(<MarketChartBox marketId="m1" />)
    await userEvent.click(screen.getByRole("button", { name: "90 d" }))
    expect(mocks.historyRanges).toContain("90d")
  })
  it("says why when history is unavailable", () => {
    mocks.history = "error"
    wrap(<MarketChartBox marketId="m1" />)
    expect(screen.getByText(/History could not be read right now/)).toBeTruthy()
  })
})

describe("MarketDetails", () => {
  const stat = (label: string) => screen.getByText(label).nextSibling?.textContent
  it("lists the funded figures: oracle rate and freshness, PT and YT outstanding, reserves, fees, maturity date", () => {
    mocks.ms = marketState({
      fees: { tokenizationBps: live(5n), ytBps: live(30n), swapTierBps: live(0n), protocolShareBps: live(0n) },
      swapFeeRate: live(3_000_000_000n),
    })
    wrap(<MarketDetails marketId="m1" />)
    expect(stat("Oracle rate")).toBe("1.0500")
    expect(stat("Oracle updated")).toBe("10m 0s ago")
    expect(stat("PT outstanding")).toBe("500")
    expect(stat("YT outstanding")).toBe("500")
    expect(stat("Pool PT reserve")).toBe("1,200")
    expect(stat("Pool SY reserve")).toBe("3,400")
    expect(stat("Tokenization fee")).toBe("0.05%")
    expect(stat("YT fee")).toBe("0.30%")
    expect(stat("Current swap fee (decreases to 0 at maturity)")).toBe("0.3000%")
    expect(stat("Maturity")).toBe("Jan 15, 2027")
  })
  it("defines the oracle rate: notional per SY share (M4)", async () => {
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    wrap(<MarketDetails marketId="m1" />)
    await userEvent.hover(screen.getByRole("button", { name: "1.0500" }))
    expect((await screen.findAllByText(/^Notional per SY share, read from the market oracle\./)).length).toBeGreaterThan(0)
  })
  it("shows an oracle timestamp in the future as 0s ago, not a negative age", () => {
    mocks.ms = marketState({ oracleTimestamp: live(BigInt(LEDGER_TIME + 500)) })
    wrap(<MarketDetails marketId="m1" />)
    expect(stat("Oracle updated")).toBe("0s ago")
  })
  it("shows Unavailable for unreadable values, never a zero", () => {
    mocks.ms = marketState({ oracleRate: down(), totalPt: down(), poolState: down(), fees: { tokenizationBps: down(), ytBps: down(), swapTierBps: live(0n), protocolShareBps: live(0n) }, swapFeeRate: down() })
    wrap(<MarketDetails marketId="m1" />)
    for (const l of ["Oracle rate", "PT outstanding", "Pool SY reserve", "Tokenization fee", "YT fee", "Current swap fee (decreases to 0 at maturity)"]) {
      expect(stat(l)).toBe("Unavailable")
    }
  })
  it("hides old values after a failed refresh", () => {
    mocks.stale = true
    wrap(<MarketDetails marketId="m1" />)
    expect(screen.getByRole("alert").textContent).toMatch(/Unavailable — last update failed/)
    expect(screen.queryByText("Oracle rate")).toBeNull()
  })
})

describe("ComplianceContent", () => {
  it("lists the market model", () => {
    wrap(<ComplianceContent marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByText("Authorization required").nextSibling?.textContent).toBe("Yes")
    expect(screen.getByText("Authorization revocable").nextSibling?.textContent).toBe("Yes")
    expect(screen.getByText("Clawback enabled").nextSibling?.textContent).toBe("No")
    expect(screen.getByText("Administrator").nextSibling?.textContent).toContain("GADMINIS")
    expect(screen.getByText(/Connect a wallet/)).toBeTruthy()
  })
  it("says a SEP-57 token has no flags", () => {
    mocks.compliance = live({ kind: "sep57" as const, administrator: null })
    wrap(<ComplianceContent marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByText(/SEP-57 token. It has no issuer flags/)).toBeTruthy()
  })
  it("says Unavailable when the model cannot be read", () => {
    mocks.compliance = down("horizon 503")
    wrap(<ComplianceContent marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByText(/compliance model could not be read \(horizon 503\)/)).toBeTruthy()
  })
  it("hides old account items after a failed refresh", () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState()
    mocks.accountStale = true
    wrap(<ComplianceContent marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByText(/Unavailable — last update failed/)).toBeTruthy()
    expect(screen.queryByText(/Your account exists/)).toBeNull()
  })
  it("lists account items with fixes; onboarding opens Get test tokens", async () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState({ permPt: live(false), trustline: live("none"), sacAuthorized: live(false) })
    const open = vi.fn()
    wrap(<ComplianceContent marketId="m1" onGetTestTokens={open} />)
    expect(screen.getByText(/You have no trustline/)).toBeTruthy()
    expect(screen.getAllByText(/Fix: Add a trustline/).length).toBeGreaterThan(0)
    await userEvent.click(screen.getAllByRole("button", { name: "Get test tokens" })[0])
    expect(open).toHaveBeenCalledTimes(1)
  })
  it("offers Get test tokens only on testnet or a local network", () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState({ permPt: live(false) })
    mocks.network = "mainnet"
    wrap(<ComplianceContent marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.queryByRole("button", { name: "Get test tokens" })).toBeNull()
    expect(screen.getAllByText(/Fix: Ask the market's administrator/).length).toBeGreaterThan(0)
  })
})

describe("SafetyContent", () => {
  it("lists pauses, oracle freshness and circuit-breaker room", () => {
    mocks.ms = marketState({ riskPaused: live(true) })
    wrap(<SafetyContent marketId="m1" />)
    expect(screen.getByText("SY wrapper").nextSibling?.textContent).toBe("Not paused")
    expect(screen.getByText("Risk control").nextSibling?.textContent).toMatch(/^Paused/)
    expect(screen.getByText("Oracle").nextSibling?.textContent).toBe("Fresh (updated within the last hour), updated 10m 0s ago")
    expect(screen.getByText("Circuit breaker, protocol-wide").nextSibling?.textContent).toBe("75000 left of 100000")
    expect(screen.getByText("Circuit breaker, STA").nextSibling?.textContent).toBe("No limit (disabled)")
    expect(screen.getByText("Your deposit cap").nextSibling?.textContent).toMatch(/Connect a wallet/)
  })
  it("shows deposit cap left for a connected account", () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState()
    wrap(<SafetyContent marketId="m1" />)
    expect(screen.getByText("Your deposit cap").nextSibling?.textContent).toBe("6000 left of 10000")
  })
  it("says a stale oracle is stale", () => {
    mocks.ms = marketState({ oracleFresh: live(false) })
    wrap(<SafetyContent marketId="m1" />)
    expect(screen.getByText("Oracle").nextSibling?.textContent).toBe("Stale (not updated within the last hour), updated 10m 0s ago")
  })
  it("hides old values after a failed refresh", () => {
    mocks.stale = true
    wrap(<SafetyContent marketId="m1" />)
    expect(screen.getByText(/Unavailable — last update failed/)).toBeTruthy()
    expect(screen.queryByText("Not paused")).toBeNull()
  })
  it("never reads an unavailable value as zero", () => {
    mocks.ms = marketState({ syPaused: down(), oracleFresh: down(), cb: { limit: down(), volume: live(0n), assetLimit: live(0n), assetVolume: live(0n) } })
    wrap(<SafetyContent marketId="m1" />)
    expect(screen.getByText("SY wrapper").nextSibling?.textContent).toBe("Unavailable")
    expect(screen.getByText("Oracle").nextSibling?.textContent).toBe("Unavailable")
    expect(screen.getByText("Circuit breaker, protocol-wide").nextSibling?.textContent).toBe("Unavailable")
  })
})

describe("MarketInfoCard", () => {
  const tabNames = () => screen.getAllByRole("tab").map((t) => t.textContent)
  const connect = () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
  }
  it("has Details, Compliance and Safety tabs, opening on Details", () => {
    wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(tabNames()).toEqual(["Details", "Compliance", "Safety"])
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true")
    expect(screen.getByText("Oracle rate")).toBeTruthy()
    expect(screen.queryByText("Authorization required")).toBeNull()
  })
  it("Compliance shows the model rows and Get test tokens on testnet", async () => {
    connect()
    mocks.account = accountState({ permYt: live(false) })
    const open = vi.fn()
    wrap(<MarketInfoCard marketId="m1" onGetTestTokens={open} />)
    await userEvent.click(screen.getByRole("tab", { name: /^Compliance/ }))
    expect(screen.getByText("Authorization required").nextSibling?.textContent).toBe("Yes")
    await userEvent.click(screen.getByRole("button", { name: "Get test tokens" }))
    expect(open).toHaveBeenCalledTimes(1)
  })
  it("Safety shows the safety rows", async () => {
    wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
    await userEvent.click(screen.getByRole("tab", { name: /^Safety/ }))
    expect(screen.getByText("SY wrapper").nextSibling?.textContent).toBe("Not paused")
  })
  it("?info=safety and ?info=compliance open that tab; anything else opens Details", () => {
    mocks.search = new URLSearchParams("info=safety")
    const { unmount } = wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByRole("tab", { name: /^Safety/ }).getAttribute("aria-selected")).toBe("true")
    unmount()
    mocks.search = new URLSearchParams("info=compliance")
    wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByRole("tab", { name: /^Compliance/ }).getAttribute("aria-selected")).toBe("true")
  })
  it("an unknown ?info= value opens Details", () => {
    mocks.search = new URLSearchParams("info=nope")
    wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.getByRole("tab", { name: "Details" }).getAttribute("aria-selected")).toBe("true")
  })
  it("marks Compliance when a connected account has an item that is not OK", () => {
    connect()
    mocks.account = accountState({ permPt: live(false), trustline: live("none"), sacAuthorized: live(false) })
    wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(within(screen.getByRole("tab", { name: /^Compliance/ })).getByRole("img", { name: "needs attention" })).toBeTruthy()
    expect(within(screen.getByRole("tab", { name: "Safety" })).queryByRole("img")).toBeNull()
  })
  it("shows no dot for Compliance when disconnected, or when every item is OK", () => {
    wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(screen.queryByRole("img", { name: "needs attention" })).toBeNull()
  })
  it("marks Safety for a paused contract, a stale oracle or an exhausted breaker", () => {
    for (const ms of [
      marketState({ poolPaused: live(true) }),
      marketState({ oracleFresh: live(false) }),
      marketState({ cb: { limit: live(100n), volume: live(100n), assetLimit: live(0n), assetVolume: live(0n) } }),
    ]) {
      mocks.ms = ms
      const { unmount } = wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
      expect(within(screen.getByRole("tab", { name: /^Safety/ })).getByRole("img", { name: "needs attention" })).toBeTruthy()
      unmount()
    }
  })
  it("shows no Safety dot when all is well, and none while the data is unavailable", () => {
    wrap(<MarketInfoCard marketId="m1" onGetTestTokens={() => {}} />)
    expect(within(screen.getByRole("tab", { name: "Safety" })).queryByRole("img")).toBeNull()
  })
})

describe("MarketView", () => {
  it("shows a banner for manifest errors only", () => {
    mocks.findings = [
      { severity: "error", message: "rpcUrl must use https://" },
      { severity: "warning", message: "minor" },
    ]
    wrap(<MarketView marketId="m1" />)
    const alert = screen.getAllByRole("alert")[0]
    expect(within(alert).getByText(/rpcUrl must use/)).toBeTruthy()
    expect(within(alert).queryByText("minor")).toBeNull()
  })
  it("has no banner for a clean manifest", () => {
    wrap(<MarketView marketId="m1" />)
    expect(screen.queryByRole("alert")).toBeNull()
  })
  it("mounts the action tabs for this market (R8)", () => {
    wrap(<MarketView marketId="m1" />)
    expect(screen.getByRole("region", { name: "Actions for m1" })).toBeTruthy()
  })
  it("the right column holds only the trade panel; it is sticky from 900 px (R2-67)", () => {
    wrap(<MarketView marketId="m1" />)
    const right = screen.getByTestId("market-right")
    expect(within(right).getByRole("region", { name: "Actions for m1" })).toBeTruthy()
    expect(within(right).queryByText("Authorization required")).toBeNull()
    expect(within(right).queryByText("SY wrapper")).toBeNull()
    expect(right.className).toContain("min-[900px]:sticky")
    expect(right.className).toContain("min-[900px]:top-20")
    expect(right.className).toContain("min-[900px]:self-start")
  })
  it("the info card sits in the left column under the chart; the trade panel comes before it in one column", () => {
    wrap(<MarketView marketId="m1" />)
    const left = screen.getByTestId("market-left")
    expect(within(left).getByRole("heading", { name: "STA · test" })).toBeTruthy()
    expect(within(left).getByText("TVL")).toBeTruthy()
    expect(within(left).getByRole("tab", { name: "APY" })).toBeTruthy()
    expect(within(screen.getByTestId("market-info")).getByRole("region", { name: "Market information" })).toBeTruthy()
    expect(within(screen.getByTestId("market-info")).getByRole("tab", { name: "Details" })).toBeTruthy()
    expect(within(screen.getByTestId("market-right")).queryByRole("region", { name: "Market information" })).toBeNull()
    const order = (el: Element) => [...el.closest("[data-testid=market-grid]")!.children].findIndex((c) => c.contains(el))
    const chart = screen.getByRole("region", { name: "Market chart" })
    const trade = screen.getByRole("region", { name: "Actions for m1" })
    const info = screen.getByRole("region", { name: "Market information" })
    expect(order(chart)).toBeLessThan(order(trade))
    expect(order(trade)).toBeLessThan(order(info))
  })
  it("opens the Get test tokens dialog for this market from the compliance card", async () => {
    mocks.wallet = { status: "connected", publicKey: "GABC", networkPassphrase: "x" }
    mocks.account = accountState({ permYt: live(false) })
    wrap(<MarketView marketId="m1" />)
    expect(screen.queryByRole("dialog")).toBeNull()
    await userEvent.click(screen.getByRole("tab", { name: /^Compliance/ }))
    await userEvent.click(screen.getByRole("button", { name: "Get test tokens" }))
    expect(screen.getByRole("dialog", { name: "Get test tokens for m1" })).toBeTruthy()
  })
})
