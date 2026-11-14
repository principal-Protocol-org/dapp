import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "@/lib/protocol/manifest"
import type { Manifest, Market } from "@/lib/protocol/types"
import {
  CREATOR,
  marketTable,
  ownMarket,
  POOL_STATE,
  sweepTable,
  TREASURY,
  type Calls,
  type Handler,
} from "@/lib/protocol/dashboard/__tests__/fake-reader"

const mocks = vi.hoisted(() => ({
  manifest: {} as Manifest,
  table: {} as Record<string, unknown>,
  calls: [] as { key: string; args: unknown[] }[],
  clock: { ledgerTime: 0 as number | null, sequence: 5_720_087 as number | null, isError: false },
  /** When set, the detail page's market query fails (its refresh throws), as an RPC outage between refreshes would. */
  failMarket: null as Error | null,
  resolvedManifest: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND")
  }),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
// The real read model runs against a counting fake RPC: every simulation the pages cause is in `mocks.calls`.
vi.mock("@/lib/protocol/reader", async (importActual) => {
  const { fakeReader } = await import("@/lib/protocol/dashboard/__tests__/fake-reader")
  return { ...(await importActual<object>()), createRpcReader: () => fakeReader(mocks.table as never, mocks.calls as never, 5_721_241) }
})
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => mocks.clock }))
vi.mock("@/lib/protocol/dashboard/protocol-state", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/protocol/dashboard/protocol-state")>()
  return {
    ...actual,
    fetchMarketDashboard: (...args: Parameters<typeof actual.fetchMarketDashboard>) =>
      mocks.failMarket ? Promise.reject(mocks.failMarket) : actual.fetchMarketDashboard(...args),
  }
})
vi.mock("@/lib/server/manifest", () => ({ resolvedManifest: mocks.resolvedManifest }))
vi.mock("next/navigation", async (importActual) => ({ ...(await importActual<object>()), notFound: mocks.notFound }))
// No wallet provider anywhere: a view that read the wallet would throw.
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => {
    throw new Error("the dashboard must not read the wallet")
  },
}))

import { MATURITY_DATE } from "@/components/app/market/market-header"
import { DASHBOARD_AGGREGATE_MS, DASHBOARD_LIVE_MS } from "@/hooks/use-dashboard"
import { explorerUrl } from "@/lib/protocol/explorer"
import { formatAmountFixed } from "@/lib/protocol/format"
import { indexFor, pendingYield, poolValueInUnderlying } from "@/lib/protocol/yield"
import DashboardNotFound from "../../../app/dashboard/not-found"
import { DashboardMarketRoute } from "../../../app/dashboard/markets/[marketId]/market-route"
import { MarketPanel } from "../market-panel"
import { MarketsView } from "../markets-table"

const base = parseManifest(testnetJson)
const market = base.markets[0]
const c = market.contracts
const sac = market.underlying.sac
const LEDGER_TIME = market.maturity - 89 * 86_400

/** Testnet-like figures (ledger 5721241), with an SY exchange rate of 1.05 so fees in USDY differ from SY. */
const TESTNET: Record<string, Handler> = {
  [`${c.pt}.total_supply`]: 1_092_444_773_604n,
  [`${c.yt}.total_supply`]: 1_092_444_773_604n,
  [`${c.pool}.pool_state`]: { ...POOL_STATE, pt_reserve: 1_008_895_354_189n, sy_reserve: 986_099_938_208n, total_lp: 997_186_129_124n },
  [`${c.pool}.reserves`]: [1_008_895_354_189n, 986_099_938_208n],
  [`${c.pool}.lp_total_supply`]: 997_186_129_124n,
  [`${c.sy}.exchange_rate`]: 10_500_000n,
  [`${sac}.balance`]: 0n,
}

let client: QueryClient
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
const row = (name: RegExp | string) => screen.getByRole("listitem", { name })
const calls = () => mocks.calls as Calls

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.manifest = base
  mocks.table = { ...marketTable(market, base), ...TESTNET }
  mocks.calls.length = 0
  mocks.clock = { ledgerTime: LEDGER_TIME, sequence: 5_721_241, isError: false }
  mocks.notFound.mockClear()
  mocks.failMarket = null
})

afterEach(() => {
  vi.useRealTimers()
  client.clear()
})

describe("/dashboard/markets", () => {
  it("one row per market: status, maturity, settlement, PT and YT supply, reserves, LP supply, liquidity, TVL and fee buckets in SY and USDY", async () => {
    wrap(<MarketsView />)
    const r = await waitFor(() => row(new RegExp(market.marketId)))
    const t = within(r)
    expect(t.getByRole("link", { name: market.displayName }).getAttribute("href")).toBe(`/dashboard/markets/${market.marketId}`)
    expect(t.getByText("Live")).toBeTruthy()
    expect(t.getByText(MATURITY_DATE.format(new Date(market.maturity * 1000)))).toBeTruthy()
    expect(t.getByText("89 d left")).toBeTruthy()
    expect(t.getByText("Not settled")).toBeTruthy()
    expect(t.getAllByText("109,244.47 PT")).toHaveLength(1)
    expect(t.getByText("109,244.47 YT")).toBeTruthy()
    expect(t.getByText("100,889.53 PT")).toBeTruthy()
    expect(t.getByText("98,609.99 SY")).toBeTruthy()
    expect(t.getByText("99,718.61 LP")).toBeTruthy()
    const liquidity = poolValueInUnderlying({
      syReserve: 986_099_938_208n,
      ptReserve: 1_008_895_354_189n,
      exchangeRate: 10_500_000n,
      ptPrice: 9_500_000n,
      oracleRate: 10_500_000n,
    })!
    expect(t.getByText(`${formatAmountFixed(liquidity, 7)} USDY`)).toBeTruthy()
    // TVL: total_underlying + RecoveryEscrow's balance (0 here); under it the reference value (× the oracle's 1.05, D-8).
    expect(t.getByText("223,011.30 USDY")).toBeTruthy()
    expect(t.getByText("234,161.86 USD")).toBeTruthy()
    // Protocol bucket 7,150,331 + 112,374,969 SY shares; creator 28,601,503 + 449,499,977; USDY at the 1.05 exchange rate.
    expect(t.getByText("11.9525 SY")).toBeTruthy()
    expect(t.getByText("12.5501 USDY")).toBeTruthy()
    expect(t.getByText("47.8101 SY")).toBeTruthy()
    expect(t.getByText("50.2006 USDY")).toBeTruthy()
    // Every figure opens its How-to-verify drawer, named for its market.
    for (const label of ["Maturity", "Settlement", "PT supply", "YT supply", "PT reserve", "SY reserve", "LP supply", "Liquidity", "TVL", "TVL in USD", "Protocol fees (SY)", "Protocol fees (USDY)", "Creator fees (SY)", "Creator fees (USDY)"])
      expect(t.getByRole("button", { name: `How to verify ${label} · ${market.marketId}` })).toBeTruthy()
    // Each value is labelled for assistive tech, also where the column header carries it visually.
    for (const label of ["Supply", "Reserves", "LP supply", "Liquidity", "TVL", "Protocol fees", "Creator fees"]) expect(t.getByText(label)).toBeTruthy()
  })

  it("totals: TVL, TVL in USD, pool liquidity and the RecoveryEscrow share, with the page's as-of line and evidence button", async () => {
    wrap(<MarketsView />)
    const totals = await waitFor(() => screen.getByRole("region", { name: "Totals" }))
    await waitFor(() => expect(within(totals).getByRole("button", { name: "How to verify TVL" })).toBeTruthy())
    expect(within(totals).getByText("223,011.30 USDY")).toBeTruthy()
    // 2,230,113,029,038 × the oracle's 1.05.
    expect(within(totals).getByText("234,161.86 USD (oracle units)")).toBeTruthy()
    expect(within(totals).getByText("0.00 USDY")).toBeTruthy()
    expect(screen.getByRole("heading", { level: 1, name: "Markets" })).toBeTruthy()
    expect(screen.getAllByTestId("as-of")[0].textContent).toMatch(/Ledger 5721241/)
    expect(screen.getByRole("button", { name: /Copy evidence table/ })).toBeTruthy()
  })

  it("an unseeded pool shows No liquidity yet, never 0, in its row and in the total", async () => {
    mocks.table = {
      ...marketTable(market, base, { reserves: [0n, 0n] }),
      [`${c.pool}.pool_state`]: { ...POOL_STATE, pt_reserve: 0n, sy_reserve: 0n, total_lp: 0n },
    }
    wrap(<MarketsView />)
    const r = await waitFor(() => row(new RegExp(market.marketId)))
    await waitFor(() => expect(within(r).getByText("No liquidity yet")).toBeTruthy())
    expect(within(screen.getByRole("region", { name: "Totals" })).getByText("No liquidity yet")).toBeTruthy()
    expect(calls().some((x) => x.key === `${c.pool}.pt_price`)).toBe(false)
  })

  it("a settled market says so with its rate", async () => {
    mocks.table = { ...mocks.table, [`${c.manager}.settled_rate`]: 10_500_000n }
    mocks.clock = { ...mocks.clock, ledgerTime: market.maturity + 100 }
    wrap(<MarketsView />)
    const r = await waitFor(() => row(new RegExp(market.marketId)))
    await waitFor(() => expect(within(r).getByText("Settled at 1.0500")).toBeTruthy())
    expect(within(r).getByText("Settled")).toBeTruthy()
  })

  describe("30 markets (Review Focus 5)", () => {
    const N = 30
    const markets: Market[] = Array.from({ length: N }, (_, i) => ownMarket(market, i))
    const many: Manifest = { ...base, markets }
    /** Each market's own views (28) once, plus the shared oracle and RiskControl views (13) once: one sweep. */
    const PER_REFRESH = N * 28 + 13

    it("one batched read per market per refresh: 853 reads, again every 60 s, none at 15 s", async () => {
      vi.useFakeTimers()
      mocks.manifest = many
      mocks.table = sweepTable(markets, many)
      wrap(<MarketsView />)
      await act(() => vi.advanceTimersByTimeAsync(50))
      expect(screen.getAllByRole("listitem", { name: /USDY \(test\) · m\d+/ })).toHaveLength(N)
      expect(calls()).toHaveLength(PER_REFRESH)
      // Each market's TVL view is read once per refresh: one sweep, not one query per row.
      for (const m of markets) expect(calls().filter((x) => x.key === `${m.contracts.sy}.total_underlying`)).toHaveLength(1)
      // The page runs one query for its contract reads: the every-market sweep, on the aggregate cadence.
      const reading = client.getQueryCache().findAll({ queryKey: ["dashboard"] })
      expect(reading.map((q) => q.queryKey[1])).toEqual(["protocol"])
      expect((reading[0].observers[0].options as { refetchInterval?: number }).refetchInterval).toBe(DASHBOARD_AGGREGATE_MS)

      await act(() => vi.advanceTimersByTimeAsync(DASHBOARD_LIVE_MS))
      expect(calls()).toHaveLength(PER_REFRESH)
      await act(() => vi.advanceTimersByTimeAsync(DASHBOARD_AGGREGATE_MS - DASHBOARD_LIVE_MS))
      expect(calls()).toHaveLength(2 * PER_REFRESH)
      for (const m of markets) expect(calls().filter((x) => x.key === `${m.contracts.sy}.total_underlying`)).toHaveLength(2)
    })

    it("one market failing turns the totals Unavailable, naming it, never a partial sum; the other rows stand", async () => {
      const user = userEvent.setup()
      mocks.manifest = many
      mocks.table = sweepTable(markets, many, { "SY17.total_underlying": new Error("rpc down") })
      wrap(<MarketsView />)
      const totals = await waitFor(() => screen.getByRole("region", { name: "Totals" }))
      const why = await waitFor(() => within(totals).getByRole("button", { name: "Why TVL is unavailable, and how to verify it" }))
      expect(within(totals).getByRole("button", { name: "Why TVL in USD is unavailable, and how to verify it" })).toBeTruthy()
      // 29 × (2,230,113,029,038 + 5,000,000) would be 6,467,342.22 USDY: never shown.
      expect(screen.queryByText(/6,467,342/)).toBeNull()
      expect(within(row(/· m17$/)).getByRole("button", { name: "Why TVL · m17 is unavailable, and how to verify it" })).toBeTruthy()
      expect(within(row(/· m16$/)).getByText("223,011.80 USDY")).toBeTruthy()
      await user.click(why)
      expect(within(await screen.findByRole("dialog")).getByText(/m17: rpc down/)).toBeTruthy()
    })
  })
})

describe("/dashboard/markets/[marketId]", () => {
  const ytReads = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
    [`${c.yt}.balance`]: 1_000_0000000n,
    [`${c.yt}.last_claimed_index`]: indexFor(10_000_000n),
    [`${c.yt}.pending_claim`]: 7_0000000n,
    ...over,
  })
  /** What a claim pays the account now, net of the 20 bps YT fee, at the 1.05 SY exchange rate (as /app shows it). */
  const net = pendingYield({
    balance: 1_000_0000000n,
    lastClaimedIndex: indexFor(10_000_000n),
    pendingClaim: 7_0000000n,
    liveOracleRate: 10_500_000n,
    ytFrozen: false,
    accruedYieldIndex: indexFor(10_500_000n),
    ytFeeBps: 20n,
    exchangeRate: 10_500_000n,
  }).net

  it("shows the market's figures, its settlement state and fee buckets in SY and USDY", async () => {
    wrap(<MarketPanel marketId={market.marketId} />)
    const figures = await waitFor(() => screen.getByRole("region", { name: "Market figures" }))
    // With an empty escrow, TVL equals what the SY wrapper holds: both read 223,011.30, and RecoveryEscrow 0.
    await waitFor(() => expect(within(figures).getAllByText("223,011.30 USDY")).toHaveLength(2))
    expect(within(figures).getByText("0.00 USDY")).toBeTruthy()
    expect(within(figures).getByRole("button", { name: "How to verify TVL" })).toBeTruthy()
    expect(within(figures).getByRole("button", { name: "How to verify Underlying held by RecoveryEscrow" })).toBeTruthy()
    expect(within(figures).getByText("109,244.47 PT")).toBeTruthy()
    expect(within(figures).getByText("98,609.99 SY")).toBeTruthy()
    expect(within(figures).getByText("99,718.61 LP")).toBeTruthy()
    expect(within(figures).getByText("234,161.86 USD (oracle units)")).toBeTruthy()
    const settlement = screen.getByRole("region", { name: "Settlement" })
    expect(within(settlement).getByText("Not settled yet")).toBeTruthy()
    expect(within(settlement).getByText("Accruing")).toBeTruthy()
    const fees = screen.getByRole("region", { name: "Fees" })
    expect(within(fees).getByText("11.9525 SY")).toBeTruthy()
    expect(within(fees).getByText("12.5501 USDY")).toBeTruthy()
    expect(within(fees).getByText("47.8101 SY")).toBeTruthy()
    expect(within(fees).getByText("50.2006 USDY")).toBeTruthy()
    expect(within(fees).getByText("0.40%")).toBeTruthy()
    expect(screen.getByRole("heading", { level: 1, name: market.displayName })).toBeTruthy()
    expect(screen.getByRole("link", { name: "All markets" }).getAttribute("href")).toBe("/dashboard/markets")
    expect(screen.getByRole("link", { name: "Open in the app" }).getAttribute("href")).toBe(`/app/markets/${market.marketId}`)
    // One market, live cadence: 41 reads per refresh (36 market state + 5 dashboard views), and no YT account read yet.
    expect(calls()).toHaveLength(41)
    expect(client.getQueryCache().find({ queryKey: ["dashboard", "market", base.network, market.marketId] })?.observers[0].options).toMatchObject({
      refetchInterval: DASHBOARD_LIVE_MS,
    })
  })

  it("fee recipients are shortened addresses linking to stellar.expert (an account, or a contract for C…)", async () => {
    mocks.table = { ...mocks.table, [`${c.config}.protocol_admin`]: c.router }
    wrap(<MarketPanel marketId={market.marketId} />)
    const recipients = await waitFor(() => screen.getByRole("region", { name: "Fee recipients" }))
    const treasury = await waitFor(() => within(recipients).getByRole("link", { name: `Treasury ${TREASURY} on stellar.expert` }))
    expect(treasury.textContent).toBe("GBBP…JVXG")
    expect(treasury.getAttribute("href")).toBe(explorerUrl("testnet", "account", TREASURY))
    expect(within(recipients).getByRole("link", { name: `Creator ${CREATOR} on stellar.expert` }).getAttribute("href")).toBe(
      explorerUrl("testnet", "account", CREATOR),
    )
    expect(within(recipients).getByRole("link", { name: `Protocol admin ${c.router} on stellar.expert` }).getAttribute("href")).toBe(
      explorerUrl("testnet", "contract", c.router),
    )
    for (const label of ["Treasury", "Creator", "Protocol admin"]) expect(within(recipients).getByRole("button", { name: `How to verify ${label}` })).toBeTruthy()
  })

  describe("pending-yield lookup (D-9)", () => {
    it("is a labelled field: an invalid address gets the inline message and reads nothing", async () => {
      const user = userEvent.setup()
      mocks.table = { ...mocks.table, ...ytReads() }
      wrap(<MarketPanel marketId={market.marketId} />)
      const input = await screen.findByLabelText("Account or contract address")
      await waitFor(() => expect(screen.getByRole("button", { name: "Look up" }).hasAttribute("disabled")).toBe(false))
      await user.type(input, "GNOTANADDRESS{Enter}")
      const message = screen.getByText("Enter a valid Stellar account (G…) or contract (C…) address.")
      expect(input.getAttribute("aria-invalid")).toBe("true")
      expect(input.getAttribute("aria-describedby")).toContain(message.id)
      expect(calls().some((x) => x.key.startsWith(`${c.yt}.`) && x.args.length > 0)).toBe(false)
    })

    it("shows the net pending yield for a G… account, with no wallet, and the drawer gives the pending_claim command", async () => {
      const user = userEvent.setup()
      mocks.table = { ...mocks.table, ...ytReads() }
      wrap(<MarketPanel marketId={market.marketId} />)
      const input = await screen.findByLabelText("Account or contract address")
      await waitFor(() => expect(screen.getByRole("button", { name: "Look up" }).hasAttribute("disabled")).toBe(false))
      await user.type(input, CREATOR)
      await user.click(screen.getByRole("button", { name: "Look up" }))
      const result = await screen.findByText(`${formatAmountFixed(net, 7, 7)} USDY`)
      expect(net).toBeGreaterThan(0n)
      expect(input.getAttribute("aria-invalid")).toBe("false")
      expect(screen.queryByText(/Enter a valid Stellar account/)).toBeNull()
      expect(result.closest("section")?.textContent).toMatch(/net of the YT fee/)
      await user.click(screen.getByRole("button", { name: "How to verify Pending yield" }))
      const dialog = await screen.findByRole("dialog")
      expect(dialog.textContent).toContain(`pending_claim --account ${CREATOR}`)
    })

    it("accepts a C… contract address", async () => {
      const user = userEvent.setup()
      mocks.table = { ...mocks.table, ...ytReads() }
      wrap(<MarketPanel marketId={market.marketId} />)
      const input = await screen.findByLabelText("Account or contract address")
      await waitFor(() => expect(screen.getByRole("button", { name: "Look up" }).hasAttribute("disabled")).toBe(false))
      await user.type(input, `  ${c.router} {Enter}`)
      expect(await screen.findByText(`${formatAmountFixed(net, 7, 7)} USDY`)).toBeTruthy()
      const yt = calls().filter((x) => x.key === `${c.yt}.pending_claim`)
      expect(yt.map((x) => x.args[0])).toEqual([{ type: "address", value: c.router }])
    })

    it("turns Unavailable, never the last answer, when the market's refresh fails after a lookup", async () => {
      const user = userEvent.setup()
      mocks.table = { ...mocks.table, ...ytReads() }
      wrap(<MarketPanel marketId={market.marketId} />)
      const input = await screen.findByLabelText("Account or contract address")
      await waitFor(() => expect(screen.getByRole("region", { name: "Market figures" }).textContent).toContain("223,011.30 USDY"))
      await user.type(input, `${CREATOR}{Enter}`)
      const shown = `${formatAmountFixed(net, 7, 7)} USDY`
      expect(await screen.findByText(shown)).toBeTruthy()

      mocks.failMarket = new Error("rpc down")
      await act(() => client.refetchQueries({ queryKey: ["dashboard", "market"] }))
      const why = await screen.findByRole("button", { name: "Why Pending yield is unavailable, and how to verify it" })
      expect(screen.queryByText(shown)).toBeNull()
      await user.click(why)
      expect(within(await screen.findByRole("dialog")).getByText(/the market's last refresh failed: rpc down/)).toBeTruthy()
    })
  })

  describe("375 px (class-level)", () => {
    it("the markets page column may shrink below its content, and each market is a one-column card until the 1280 px grid", async () => {
      wrap(<MarketsView />)
      const section = screen.getByRole("heading", { level: 1, name: "Markets" }).closest("section")
      expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
      const r = await waitFor(() => row(new RegExp(market.marketId)))
      expect(r.className).toMatch(/(^| )grid-cols-1( |$)/)
      expect(r.className).toContain("xl:grid-cols-[")
      // The column header is a desktop-only row; on a card each group keeps its own label.
      const header = screen.getByText("Protocol fees", { selector: "[aria-hidden] span" }).parentElement
      expect(header?.className).toMatch(/(^| )hidden( |$)/)
      expect(header?.className).toContain("xl:grid")
    })

    it("the market page column may shrink below its content, and the lookup's field wraps under its label", async () => {
      wrap(<MarketPanel marketId={market.marketId} />)
      const section = screen.getByRole("heading", { level: 1, name: market.displayName }).closest("section")
      expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
      const panels = screen.getByRole("region", { name: "Market figures" }).parentElement
      expect(panels?.className).toContain("grid-cols-[minmax(0,1fr)]")
      const input = await screen.findByLabelText("Account or contract address")
      expect(input.className).toContain("min-w-0")
      expect(input.parentElement?.className).toContain("flex-wrap")
    })
  })

  describe("the route", () => {
    it("an unknown market id is not found; a known one renders its panel", async () => {
      mocks.resolvedManifest.mockResolvedValue(base)
      await expect(DashboardMarketRoute({ params: Promise.resolve({ marketId: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND")
      expect(mocks.notFound).toHaveBeenCalledTimes(1)
      const element = await DashboardMarketRoute({ params: Promise.resolve({ marketId: market.marketId }) })
      expect(element!.type).toBe(MarketPanel)
      expect(element!.props).toEqual({ marketId: market.marketId })
    })

    it("the dashboard's not-found page points back to the markets", () => {
      render(<DashboardNotFound />)
      expect(screen.getByRole("heading", { level: 1, name: "This page was not found" })).toBeTruthy()
      // Only the market route calls notFound() under /dashboard, so the page speaks of a market.
      expect(screen.getByText(/^No market at this address\./)).toBeTruthy()
      expect(screen.getByRole("link", { name: "See all markets" }).getAttribute("href")).toBe("/dashboard/markets")
    })
  })
})
