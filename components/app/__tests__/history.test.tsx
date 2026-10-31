import { act, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendLog } from "@/lib/app/local-log"
import { writeRoute, type RouteRun } from "@/lib/app/route-log"
import { TX_TIMEOUT_SECONDS } from "@/lib/protocol/review"
import type { HistoryData } from "@/hooks/use-history"

const ADDRESS = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const HASH = "a".repeat(64)
const PENDING = "b".repeat(64)

const mocks = vi.hoisted(() => ({
  network: "testnet" as "testnet" | "local",
  wallet: { status: "connected", publicKey: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI" } as {
    status: string
    publicKey?: string
  },
  history: {} as { data?: unknown; isPending: boolean; isError: boolean; stale: boolean },
}))

vi.mock("@/components/app/manifest-provider", () => {
  // One object per network, as the provider gives: hooks depend on its identity.
  const byNetwork = new Map<string, unknown>()
  const make = (network: string) => ({ network, markets: [{ marketId: "m1", displayName: "STA", underlying: { code: "STA", decimals: 7 } }] })
  return {
    useManifest: () => {
      if (!byNetwork.has(mocks.network)) byNetwork.set(mocks.network, make(mocks.network))
      return byNetwork.get(mocks.network)
    },
  }
})
vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ state: mocks.wallet }) }))
vi.mock("@/hooks/use-history", () => ({ useHistory: () => mocks.history }))

import { HistoryTable } from "../history/history-table"

const data = (over: Partial<HistoryData> = {}) => ({
  entries: [
    {
      hash: HASH,
      ledger: 250,
      at: "2026-10-05T10:00:00Z",
      kind: "mint" as const,
      lines: ["Deposited 10 STA", "Minted 9.95 PT + 9.95 YT"],
      marketId: "m1",
    },
  ],
  window: { oldestLedger: 100, latestLedger: 100 + 120_960 },
  oracleUpdates: {},
  truncated: false,
  ...over,
})

const H1 = "1".repeat(64)
const H2 = "2".repeat(64)
const E7 = 10_000_000n

/** A two-step "Buy PT" route (deposit, then buy) over USDY with the given step states. */
function route(over: Partial<RouteRun> = {}, steps?: RouteRun["steps"]): RouteRun {
  return {
    id: "r1",
    account: ADDRESS,
    marketId: "m1",
    kind: "buy_pt",
    request: { kind: "buy_pt", marketId: "m1", source: ADDRESS, amount: 1500n * E7, pay: "underlying", receive: "sy", matured: false },
    plans: [
      { action: "deposit", amount: { from: "input" }, gives: "STA", takes: "SY" },
      { action: "buy_pt", amount: { from: "step", index: 0, field: "value" }, gives: "SY", takes: "PT" },
    ],
    outputs: [{ kind: "amount", value: 1500n * E7 }],
    steps: steps ?? [
      { action: "deposit", status: "confirmed", hash: H1 },
      { action: "buy_pt", status: "confirmed", hash: H2 },
    ],
    startedAt: Date.now(),
    ...over,
  } as RouteRun
}

beforeEach(() => {
  localStorage.clear()
  mocks.network = "testnet"
  mocks.wallet = { status: "connected", publicKey: ADDRESS }
  mocks.history = { data: data(), isPending: false, isError: false, stale: false }
})

describe("history table", () => {
  it("asks to connect a wallet when none is connected", () => {
    mocks.wallet = { status: "disconnected" }
    render(<HistoryTable />)
    expect(screen.getByText(/connect your wallet/i)).toBeTruthy()
  })

  it("shows the RPC window notice", () => {
    render(<HistoryTable />)
    expect(
      screen.getByText(
        "Showing activity from ledger 100 to 121060, about 7 days. Older activity is not available from the network.",
      ),
    ).toBeTruthy()
  })

  it("lists the entry lines and links the hash to stellar.expert on testnet", () => {
    render(<HistoryTable />)
    expect(screen.getByText("Deposited 10 STA")).toBeTruthy()
    expect(screen.getByText("Minted 9.95 PT + 9.95 YT")).toBeTruthy()
    expect(screen.getByRole("link", { name: /aaaaaa/ }).getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/tx/${HASH}`)
  })

  it("names the link with the full hash and where it goes (M11)", () => {
    render(<HistoryTable />)
    const link = screen.getByRole("link", { name: `View transaction ${HASH} on stellar.expert` })
    // The URL comes from explorerTxUrl, which encodes the hash.
    expect(link.getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(HASH)}`)
    expect(link.textContent).toBe("aaaaaaaa...aaaaaaaa")
  })

  it("shows the full hash and no link on a local network", () => {
    mocks.network = "local"
    render(<HistoryTable />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText(HASH)).toBeTruthy()
  })

  it("merges pending local-log entries and drops the ones already seen in events", () => {
    appendLog({ hash: PENDING, action: "buy_pt", marketId: "m1", account: ADDRESS, at: Date.now(), status: "NOT_FOUND" })
    appendLog({ hash: HASH, action: "mint", marketId: "m1", account: ADDRESS, at: 2, status: "SUCCESS" })
    render(<HistoryTable />)
    const row = screen.getByText("Buy PT").closest("tr") as HTMLElement
    expect(within(row).getByText("Pending")).toBeTruthy()
    expect(screen.getAllByText(/Minted 9.95 PT/)).toHaveLength(1)
    expect(screen.getAllByRole("row")).toHaveLength(3) // header + pending + event
  })

  describe("a local entry the network never showed (M10)", () => {
    const EXPIRED_AFTER_MS = (TX_TIMEOUT_SECONDS + 60) * 1000
    afterEach(() => {
      vi.useRealTimers()
    })

    it("is Pending within its time window plus a margin", () => {
      appendLog({ hash: PENDING, action: "buy_pt", marketId: "m1", account: ADDRESS, at: Date.now() - EXPIRED_AFTER_MS + 5_000, status: "NOT_FOUND" })
      render(<HistoryTable />)
      expect(within(screen.getByText("Buy PT").closest("tr") as HTMLElement).getByText("Pending")).toBeTruthy()
    })

    it("is Not found — expired once its window and the margin have passed", () => {
      appendLog({ hash: PENDING, action: "buy_pt", marketId: "m1", account: ADDRESS, at: Date.now() - EXPIRED_AFTER_MS - 1_000, status: "NOT_FOUND" })
      render(<HistoryTable />)
      const row = screen.getByText("Buy PT").closest("tr") as HTMLElement
      expect(within(row).getByText("Not found — expired")).toBeTruthy()
      expect(within(row).getByText(/can no longer land/)).toBeTruthy()
      expect(screen.queryByText("Pending")).toBeNull()
    })

    it("turns from Pending to expired while the page stays open", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
      appendLog({ hash: PENDING, action: "buy_pt", marketId: "m1", account: ADDRESS, at: Date.now(), status: "NOT_FOUND" })
      render(<HistoryTable />)
      expect(screen.getByText("Pending")).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(EXPIRED_AFTER_MS + 30_000)
      })
      expect(screen.getByText("Not found — expired")).toBeTruthy()
    })
  })

  it("shows a confirmed local entry as Confirmed and a failed one as Failed, not Pending", () => {
    appendLog({ hash: PENDING, action: "buy_pt", marketId: "m1", account: ADDRESS, at: 1, status: "SUCCESS" })
    appendLog({ hash: "c".repeat(64), action: "sell_pt", marketId: "m1", account: ADDRESS, at: 2, status: "FAILED" })
    render(<HistoryTable />)
    expect(within(screen.getByText("Buy PT").closest("tr") as HTMLElement).getByText("Confirmed")).toBeTruthy()
    expect(within(screen.getByText("Sell PT").closest("tr") as HTMLElement).getByText("Failed")).toBeTruthy()
    expect(screen.queryByText("Pending")).toBeNull()
  })

  it("shows the cause of a failed local entry in its details (R49)", () => {
    const reason = "Amounts moved between your review and inclusion (the pool or oracle changed). Nothing was taken except the network fee; prepare again."
    appendLog({ hash: "d".repeat(64), action: "buy_yt", marketId: "m1", account: ADDRESS, at: 3, status: "FAILED", reason })
    render(<HistoryTable />)
    const row = screen.getByText("Buy YT").closest("tr") as HTMLElement
    expect(within(row).getByText("Failed")).toBeTruthy()
    expect(within(row).getByText(reason)).toBeTruthy()
  })

  it("shows an entry appended after mount", async () => {
    render(<HistoryTable />)
    expect(screen.queryByText("Buy PT")).toBeNull()
    act(() => appendLog({ hash: PENDING, action: "buy_pt", marketId: "m1", account: ADDRESS, at: Date.now(), status: "NOT_FOUND" }))
    expect(screen.getByText("Buy PT")).toBeTruthy()
  })

  it("says unavailable when the history could not be loaded, never an empty list", () => {
    mocks.history = { data: undefined, isPending: false, isError: true, stale: true }
    render(<HistoryTable />)
    expect(screen.getByText("Unavailable — could not load history")).toBeTruthy()
    expect(screen.queryByText(/no activity/i)).toBeNull()
  })

  it("does not show old data after a failed refresh", () => {
    mocks.history = { data: data(), isPending: false, isError: true, stale: true }
    render(<HistoryTable />)
    expect(screen.getByText("Unavailable — could not load history")).toBeTruthy()
    expect(screen.queryByText("Deposited 10 STA")).toBeNull()
  })

  it("says so when there is no activity in the window", () => {
    mocks.history = { data: data({ entries: [] }), isPending: false, isError: false, stale: false }
    render(<HistoryTable />)
    expect(screen.getByText(/no activity in this window/i)).toBeTruthy()
  })

  it("warns that older entries may be missing when cut short", () => {
    mocks.history = { data: data({ truncated: true }), isPending: false, isError: false, stale: false }
    render(<HistoryTable />)
    expect(screen.getByText(/too long to load in full.*older entries may be missing/i)).toBeTruthy()
  })

  it("groups a route's steps under one entry", () => {
    appendLog({ hash: H1, action: "deposit", marketId: "m1", account: ADDRESS, at: 1, status: "SUCCESS" })
    appendLog({ hash: H2, action: "buy_pt", marketId: "m1", account: ADDRESS, at: 2, status: "SUCCESS" })
    writeRoute(route())
    render(<HistoryTable />)
    const row = screen.getByText("Buy PT · 2 steps").closest("tr") as HTMLElement
    expect(within(row).getByText("1. Deposit · Confirmed")).toBeTruthy()
    expect(within(row).getByRole("link", { name: `View transaction ${H1} on stellar.expert` })).toBeTruthy()
    expect(within(row).getByRole("link", { name: `View transaction ${H2} on stellar.expert` })).toBeTruthy()
    // the steps are not listed again as rows of their own
    expect(screen.getAllByRole("link", { name: /View transaction 1{64}/ })).toHaveLength(1)
    expect(screen.getAllByRole("row")).toHaveLength(3) // header + route + event
    expect(within(row).getByText("Completed")).toBeTruthy()
  })

  it("an interrupted route links back to its market with Continue", () => {
    appendLog({ hash: H1, action: "deposit", marketId: "m1", account: ADDRESS, at: 1, status: "SUCCESS" })
    writeRoute(route({}, [{ action: "deposit", status: "confirmed", hash: H1 }, { action: "buy_pt", status: "pending" }]))
    render(<HistoryTable />)
    const row = screen.getByText("Buy PT · 2 steps").closest("tr") as HTMLElement
    expect(within(row).getByText("Interrupted")).toBeTruthy()
    expect(within(row).getByText("You hold 1,500 SY")).toBeTruthy()
    expect(within(row).getByRole("link", { name: /continue/i }).getAttribute("href")).toBe("/app/markets/m1?tab=pt&side=buy")
  })

  it("does not offer Continue on a finished or closed route", () => {
    writeRoute(route())
    writeRoute(route({ id: "r2", closed: true }, [{ action: "deposit", status: "confirmed", hash: H1 }, { action: "buy_pt", status: "pending" }]))
    render(<HistoryTable />)
    expect(screen.queryByRole("link", { name: /continue/i })).toBeNull()
    expect(screen.getByText("Stopped")).toBeTruthy()
  })

  it("amounts are grouped", () => {
    mocks.history = {
      data: data({ entries: [{ hash: HASH, ledger: 250, at: "2026-10-05T10:00:00Z", kind: "mint", lines: ["Deposited 1,234.5 STA"], marketId: "m1" }] }),
      isPending: false, isError: false, stale: false,
    }
    writeRoute(route({}, [{ action: "deposit", status: "confirmed", hash: H1 }, { action: "buy_pt", status: "failed", hash: H2 }]))
    render(<HistoryTable />)
    expect(screen.getByText("Deposited 1,234.5 STA")).toBeTruthy()
    expect(screen.getByText("You hold 1,500 SY")).toBeTruthy()
  })
})
