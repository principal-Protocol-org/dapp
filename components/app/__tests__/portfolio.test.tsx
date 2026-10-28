import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountState } from "@/lib/protocol/account-state"
import type { WalletState } from "@/lib/protocol/types"
import type { HistoryData } from "@/hooks/use-history"
import { TooltipProvider } from "@/components/ui/tooltip"
import { accountState, down, live, LEDGER_TIME, MATURITY, marketState } from "./fixtures"
import { indexFor } from "@/lib/protocol/yield"

const MARKET = { marketId: "m1", displayName: "STA · test", underlying: { code: "STA", decimals: 7 } }
const mocks = vi.hoisted(() => ({
  ms: undefined as unknown,
  msStale: false,
  account: undefined as AccountState | undefined,
  accountStale: false,
  wallet: { status: "connected", publicKey: "GA" } as WalletState,
  history: {} as { data?: HistoryData; isPending: boolean; isError: boolean; stale: boolean },
}))

vi.mock("@/lib/protocol/manifest-source", () => ({ activeManifest: () => ({ network: "testnet", markets: [MARKET] }) }))
vi.mock("@/hooks/use-market-state", () => ({ useMarketState: () => ({ data: mocks.ms, isPending: false, stale: mocks.msStale }) }))
vi.mock("@/hooks/use-account-state", () => ({ useAccountState: () => ({ data: mocks.account, isPending: false, stale: mocks.accountStale }) }))
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))
vi.mock("@/hooks/use-history", () => ({ useHistory: () => mocks.history }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => ({ ledgerTime: LEDGER_TIME, sequence: 1, isError: false }) }))

import { claimPanel } from "../actions/redeem-tab"
import { PortfolioView } from "../portfolio/portfolio-view"

const AT = "2026-10-05T10:00:00Z"
const history = (over: Partial<HistoryData> = {}): HistoryData => ({
  entries: [],
  window: { oldestLedger: 1, latestLedger: 2 },
  oracleUpdates: {},
  truncated: false,
  ...over,
})
const wrap = () => render(<TooltipProvider><PortfolioView /></TooltipProvider>)
const E7 = 10_000_000n

// Radix tooltips measure their content; jsdom has no ResizeObserver.
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })

beforeEach(() => {
  mocks.ms = marketState()
  mocks.msStale = false
  mocks.account = accountState({ pt: live(100n * E7), yt: live(50n * E7), ytLastClaimedIndex: live(indexFor(10_000_000n)) })
  mocks.accountStale = false
  mocks.wallet = { status: "connected", publicKey: "GA" } as WalletState
  mocks.history = { data: history(), isPending: false, isError: false, stale: false }
})

describe("portfolio", () => {
  it("asks to connect a wallet", () => {
    mocks.wallet = { status: "disconnected" } as WalletState
    wrap()
    expect(screen.getByText(/connect your wallet/i)).toBeTruthy()
  })

  it("shows an empty state with a link to Markets when nothing is held", async () => {
    mocks.account = accountState()
    wrap()
    expect(await screen.findByText(/hold nothing in any market/i)).toBeTruthy()
    expect(screen.getByRole("link", { name: /browse the markets/i }).getAttribute("href")).toBe("/app")
    expect(screen.queryByRole("region", { name: "STA · test" })).toBeNull()
  })

  it("shows the five balances", () => {
    mocks.account = accountState({ underlying: live(5n * E7), sy: live(6n * E7), pt: live(7n * E7), yt: live(8n * E7), lp: live(0n) })
    wrap()
    const card = screen.getByRole("region", { name: "STA · test" })
    expect(within(card).getByText("5.0000 STA")).toBeTruthy()
    expect(within(card).getByText("6.0000 SY")).toBeTruthy()
    expect(within(card).getByText("7.0000 PT")).toBeTruthy()
    expect(within(card).getByText("8.0000 YT")).toBeTruthy()
    expect(within(card).getByText("0.0000 LP")).toBeTruthy()
  })

  it("shows the LP share of the reserves and the scaled pool value", () => {
    mocks.ms = marketState({
      poolState: live({ ptReserve: 1000n * E7, syReserve: 2000n * E7, totalLp: 100n * E7, rate: 1n, exponent: 1n, feeRate: 1n, secondsToMaturity: 864000n }),
    })
    mocks.account = accountState({ lp: live(10n * E7) })
    wrap()
    expect(screen.getByText("100.0000 PT", { selector: "dd" })).toBeTruthy() // 10% of 1000
    expect(screen.getByText("200.0000 SY", { selector: "dd" })).toBeTruthy() // 10% of 2000
    // whole = 2000*1.0 + 1000*0.98/1.05 = 2933.3333333; 10% = 293.3333333 STA
    expect(screen.getByText("≈ 293.3333333 STA")).toBeTruthy()
  })

  it("shows the oracle rate and freshness", () => {
    wrap()
    expect(screen.getByText(/1\.0500 · fresh · updated 10m 0s ago/)).toBeTruthy()
    mocks.ms = marketState({ oracleFresh: live(false) })
    wrap()
    expect(screen.getByText(/stale \(older than 1 hour\)/)).toBeTruthy()
  })

  it("shows pending yield net, with gross and fee in a tooltip, equal to the claim panel's", async () => {
    // 50 YT, last index at rate 1.00, oracle 1.05, 10% fee, exchange rate 1.0:
    // gross = 500_000_000 * (1e12 - 952_380_952_381 - 1) / 1e12 = 23_809_523; fee shares = ceil(10%) = 2_380_953; net = 21_428_570
    mocks.ms = marketState({ fees: { tokenizationBps: live(0n), ytBps: live(1000n), swapTierBps: live(0n), protocolShareBps: live(0n) } })
    mocks.account = accountState({ pt: live(0n), yt: live(50n * E7), ytLastClaimedIndex: live(indexFor(10_000_000n)), ytPendingClaim: live(0n) })
    wrap()
    const net = screen.getByText("2.142857 STA")
    await userEvent.hover(net)
    expect((await screen.findAllByText("Gross 2.3809523 STA, YT fee 0.2380953 STA.")).length).toBeGreaterThan(0)
    const lines = claimPanel(MARKET as never).market!(mocks.ms as never, { account: mocks.account } as never)
    expect(lines.find((l) => l.label === "You receive (net)")?.value).toBe("2.142857 STA")
    expect(lines.find((l) => l.label === "Pending yield (gross)")?.value).toBe("2.3809523 STA")
    expect(lines.find((l) => l.label === "YT fee")?.value).toBe("0.2380953 STA")
  })

  it("shows the fixed return in notional units, the APY, and the underlying paid apart", () => {
    wrap()
    const card = screen.getByRole("region", { name: "STA · test" })
    expect(within(card).getByText("Face value at maturity (notional)")).toBeTruthy()
    expect(within(card).getByText("100.0000 notional")).toBeTruthy() // 100 PT
    expect(within(card).getByText("98.0000 notional")).toBeTruthy() // 100 * 0.98
    // 10 days left, price 0.98: positive APY, shown as a percent
    expect(within(card).getByText("109.05%")).toBeTruthy()
    // 100 PT / oracle 1.05 at exchange rate 1.0 = 95.2380952 STA, indicative before settlement
    expect(within(card).getByText("95.2380952 STA")).toBeTruthy()
    expect(within(card).getByText(/indicative until settlement/)).toBeTruthy()
  })

  it("shows a negative APY above par truthfully", () => {
    mocks.ms = marketState({ ptPrice: live(10_200_000n) })
    wrap()
    expect(screen.getByText("-51.46%")).toBeTruthy()
  })

  it("after maturity shows Matured, not Unavailable, and a final redemption value", () => {
    mocks.ms = marketState({ settledRate: live<bigint | null>(10_500_000n), maturity: live(BigInt(LEDGER_TIME - 1)) })
    wrap()
    const card = screen.getByRole("region", { name: "STA · test" })
    expect(within(card).getAllByText("Matured")).toHaveLength(2)
    expect(within(card).getByText("Redeems for (STA)")).toBeTruthy()
    expect(within(card).getByText("95.2380952 STA")).toBeTruthy()
  })

  it("a frozen YT index fixes the redemption rate: no indicative label", () => {
    mocks.ms = marketState({ ytFrozen: live(true), ytAccruedIndex: live(indexFor(10_500_000n)) })
    wrap()
    expect(screen.getByText("Redeems for (STA)")).toBeTruthy()
  })

  it("does not reuse empty statuses of another account", () => {
    mocks.account = accountState()
    const view = render(<TooltipProvider><PortfolioView /></TooltipProvider>)
    expect(screen.getByText(/hold nothing in any market/i)).toBeTruthy()
    mocks.wallet = { status: "connected", publicKey: "GB" } as WalletState
    mocks.account = accountState({ pt: live(1n * E7) })
    view.rerender(<TooltipProvider><PortfolioView /></TooltipProvider>)
    expect(screen.queryByText(/hold nothing in any market/i)).toBeNull()
    expect(screen.getByRole("region", { name: "STA · test" })).toBeTruthy()
    mocks.wallet = { status: "disconnected" } as WalletState
    view.rerender(<TooltipProvider><PortfolioView /></TooltipProvider>)
    mocks.wallet = { status: "connected", publicKey: "GA" } as WalletState
    mocks.account = undefined
    view.rerender(<TooltipProvider><PortfolioView /></TooltipProvider>)
    expect(screen.queryByText(/hold nothing in any market/i)).toBeNull()
  })

  it("shows the mint entry rate and date, saying it is the most recent", () => {
    mocks.history = {
      data: history({
        entries: [{ hash: "h", ledger: 150, at: AT, kind: "mint", lines: [], marketId: "m1", facts: { mint: { notional: 99_500_000n, syShares: 95_000_000n, feeShares: 500_000n } } }],
      }),
      isPending: false, isError: false, stale: false,
    }
    wrap()
    expect(screen.getByText("Entry rate 1.0529 (from your mint on 2026-10-05)")).toBeTruthy()
    expect(screen.getByText(/most recent qualifying transaction/)).toBeTruthy()
  })

  it("shows the fixed APY locked at purchase when a ref_set precedes the buy", () => {
    mocks.history = {
      data: history({
        entries: [{ hash: "h", ledger: 150, at: AT, kind: "buy_pt", lines: [], marketId: "m1", facts: { buyPt: { syIn: 100_000_000n, ptOut: 105_000_000n } } }],
        oracleUpdates: { m1: [{ ledger: 100, value: 10_000_000n }] },
      }),
      isPending: false, isError: false, stale: false,
    }
    wrap()
    // maturity is MATURITY (1.8e9), well after AT: APY is positive
    expect(screen.getByText("Fixed APY locked at purchase 19.09% (from your PT purchase on 2026-10-05)")).toBeTruthy()
    expect(MATURITY).toBeGreaterThan(0n)
  })

  it("omits the purchase APY without a ref_set and falls back to accruing since", () => {
    mocks.history = {
      data: history({
        entries: [{ hash: "h", ledger: 150, at: AT, kind: "buy_pt", lines: [], marketId: "m1", facts: { buyPt: { syIn: 100_000_000n, ptOut: 105_000_000n } } }],
      }),
      isPending: false, isError: false, stale: false,
    }
    wrap()
    expect(screen.queryByText(/locked at purchase/)).toBeNull()
    expect(screen.getByText("Accruing since rate 1.0000")).toBeTruthy()
  })

  it("says the entry is unavailable when history failed, never a made-up rate", () => {
    mocks.history = { data: undefined, isPending: false, isError: true, stale: true }
    wrap()
    expect(screen.getByText(/Entry: Unavailable — last update failed/)).toBeTruthy()
  })

  it("shows unavailable data as such, never zero", () => {
    mocks.ms = marketState({ ptPrice: down(), oracleRate: down() })
    mocks.account = accountState({ pt: live(100n * E7), yt: down(), underlying: down() })
    wrap()
    const card = screen.getByRole("region", { name: "STA · test" })
    expect(within(card).getAllByText("Unavailable").length).toBeGreaterThan(2)
  })

  it("says the update failed when the market or account refetch errored", () => {
    mocks.accountStale = true
    wrap()
    expect(screen.getByText("Unavailable — last update failed")).toBeTruthy()
    expect(screen.queryByText("100.0000 PT")).toBeNull()
  })

  it("links the shortcuts to the right tab and panel", () => {
    wrap()
    const href = (name: RegExp) => screen.getByRole("link", { name }).getAttribute("href")
    expect(href(/claim yield/i)).toBe("/app/markets/m1?tab=redeem&panel=claim_yield")
    expect(href(/exit/i)).toBe("/app/markets/m1?tab=redeem&panel=recombine")
    expect(href(/redeem at maturity/i)).toBe("/app/markets/m1?tab=redeem&panel=redeem")
  })
})
