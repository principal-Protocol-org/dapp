import { render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { appendLog } from "@/lib/app/local-log"
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

vi.mock("@/lib/protocol/manifest-source", () => ({
  activeManifest: () => ({ network: mocks.network, markets: [{ marketId: "m1", displayName: "STA", underlying: { code: "STA", decimals: 7 } }] }),
}))
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

  it("shows the full hash and no link on a local network", () => {
    mocks.network = "local"
    render(<HistoryTable />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText(HASH)).toBeTruthy()
  })

  it("merges pending local-log entries and drops the ones already seen in events", () => {
    appendLog({ hash: PENDING, action: "buy_pt", marketId: "m1", account: ADDRESS, at: 1, status: "NOT_FOUND" })
    appendLog({ hash: HASH, action: "mint", marketId: "m1", account: ADDRESS, at: 2, status: "SUCCESS" })
    render(<HistoryTable />)
    const row = screen.getByText("Buy PT").closest("tr") as HTMLElement
    expect(within(row).getByText("Pending")).toBeTruthy()
    expect(screen.getAllByText(/Minted 9.95 PT/)).toHaveLength(1)
    expect(screen.getAllByRole("row")).toHaveLength(3) // header + pending + event
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

  it("warns when the history was cut short", () => {
    mocks.history = { data: data({ truncated: true }), isPending: false, isError: false, stale: false }
    render(<HistoryTable />)
    expect(screen.getByText(/too long to load in full/i)).toBeTruthy()
  })
})
