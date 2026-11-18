import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const RPC = "https://rpc.test"
const LEDGER_TIME = 1_800_000_000
const ORACLE = "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS"
const POOL = "CB3JI6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPOOL"
const POOL2 = "CB3JI6BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBPOOL"
const TRADER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const TX = "68be08ad3f0c4e2b9a1d7c5e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a"

const mocks = vi.hoisted(() => ({
  manifest: {} as Record<string, unknown>,
  clock: { ledgerTime: 0 as number | null, sequence: 5_720_087 as number | null, isError: false },
  search: "",
  fetch: vi.fn(),
}))

const baseManifest = () => ({
  network: "testnet",
  rpcUrl: RPC,
  markets: [
    { marketId: "testnet-usdy-1802336344", displayName: "USDY Mar 2027", underlying: { code: "USDY", decimals: 7, sac: "CSAC" }, contracts: { sy: "CSY", pool: POOL, manager: "CMGR", recoveryEscrow: "CESC" } },
    { marketId: "testnet-usdy-1900000000", displayName: "USDY Mar 2030", underlying: { code: "USDY", decimals: 7, sac: "CSAC" }, contracts: { sy: "CSY2", pool: POOL2, manager: "CMGR2", recoveryEscrow: "CESC" } },
  ],
  shared: { oracle: ORACLE, riskControl: "CRISK", permissioning: "CPERM", router: "CROUTER" },
  wasmHashes: {},
})
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => mocks.clock }))
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(mocks.search) }))
vi.mock("@/hooks/use-wallet", () => ({
  useWallet: () => {
    throw new Error("the dashboard must not read the wallet")
  },
}))

import { ActivityPanel } from "../activity-panel"

const INDEX = {
  rows: [] as unknown[],
  indexedThrough: 5_719_749,
  indexedThroughCloseTime: new Date((LEDGER_TIME - 125) * 1000).toISOString(),
  lagSeconds: 125,
  gaps: [{ group: "escrow", from: 5_700_000, to: 5_700_100 }],
  reconcile: null,
}
let n = 0
const ev = (ledger: number, group: string, contractId: string, topic: string, data: Record<string, unknown>, pool: string | null = null) => ({
  id: `${String(ledger).padStart(19, "0")}-${String(n++).padStart(10, "0")}`,
  group,
  contractId,
  topic,
  ledger,
  closeTime: "2027-01-15T07:48:05.000Z",
  txHash: TX,
  pool,
  data,
})
const ROWS = [
  ev(5_719_700, "market", POOL, "buy_pt", { from: TRADER, to: TRADER, sy_in: "1", pt_out: "1", fee_shares: "0" }, POOL),
  ev(5_719_600, "oracle", ORACLE, "ref_rej", { value: "12000000", timestamp: "1799999280", reason: "deviate" }),
  ev(5_719_592, "oracle", ORACLE, "ref_set", { value: "10000919", timestamp: "1799999280" }),
  ev(5_719_500, "risk", "CRISK", "cb_limit", { caller: TRADER, limit: "100000000000000" }),
]
const COUNTS: Record<string, Record<string, number>> = {
  all: { buy_pt: 20, deposit: 111, ref_set: 35, ref_rej: 1, cb_limit: 2, acc_grant: 37 },
  oracle: { ref_set: 35, ref_rej: 1, src_set: 1 },
  market: { buy_pt: 20, deposit: 111 },
}

function answer(url: string): Response {
  const q = new URL(url, "https://app.example").searchParams
  if (q.get("counts") === "1") return Response.json({ ...INDEX, counts: COUNTS[q.get("group") ?? "all"] ?? {} })
  const group = q.get("group")
  const topics = q.get("topic")?.split(",")
  const pool = q.get("pool")
  const rows = ROWS.filter((r) => (!group || r.group === group) && (!topics || topics.includes(r.topic)) && (!pool || r.pool === pool))
  return Response.json({ ...INDEX, rows })
}
const listUrls = () => mocks.fetch.mock.calls.map((c) => String(c[0])).filter((u) => !u.includes("counts=1"))

let client: QueryClient
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>

beforeEach(() => {
  mocks.manifest = baseManifest()
  mocks.search = ""
  window.history.replaceState(null, "", "/dashboard/activity")
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.clock = { ledgerTime: LEDGER_TIME, sequence: 5_720_087, isError: false }
  mocks.fetch.mockReset().mockImplementation(async (url: string) => answer(url))
  vi.stubGlobal("fetch", mocks.fetch)
})

afterEach(() => vi.unstubAllGlobals())

describe("the activity page (/dashboard/activity)", () => {
  it("lists every indexed event newest first, worded, with its contract, market, account and tx link, under 'Indexed through ledger N · lag M' and the gaps", async () => {
    render(wrap(<ActivityPanel />))
    expect(await screen.findByRole("heading", { level: 1, name: "Activity" })).toBeTruthy()
    const table = await screen.findByRole("table", { name: "Activity" })
    const rows = within(table).getAllByRole("row").slice(1)
    expect(rows.map((r) => r.querySelector("td span")?.textContent)).toEqual([
      "PT bought",
      "Oracle update rejected: Moved more than the cap",
      "Oracle value set",
      "Circuit-breaker limit set",
    ])
    expect(within(rows[0]).getByText(/MarketPool CB3JI6… · USDY Mar 2027/)).toBeTruthy()
    expect(within(rows[0]).getAllByTitle(TRADER).length).toBeGreaterThan(0)
    expect(within(rows[1]).getByText(/OracleAdapter CDYGBF…/)).toBeTruthy()
    expect(within(rows[0]).getAllByRole("link", { name: `View transaction ${TX} on stellar.expert` }).length).toBeGreaterThan(0)
    const header = screen.getByTestId("event-list-index").textContent ?? ""
    expect(header).toContain("Indexed through ledger 5719749")
    expect(header).toContain("lag 2m 5s")
    expect(header).toContain("Gap: escrow ledgers 5700000–5700100 are not indexed")
    // Every group: no group, pool or topic asked.
    expect(listUrls()[0]).toBe("/api/dashboard/events?limit=50")
  })

  it("filters by group, then by kind (the topics the index holds, with their counts), and keeps the filters in the URL", async () => {
    const user = userEvent.setup()
    render(wrap(<ActivityPanel />))
    await screen.findByRole("table", { name: "Activity" })
    await user.selectOptions(screen.getByLabelText("Group"), "oracle")
    await waitFor(() => expect(listUrls().at(-1)).toBe("/api/dashboard/events?group=oracle&limit=50"))
    expect(window.location.search).toBe("?group=oracle")
    const kind = screen.getByLabelText("Kind") as HTMLSelectElement
    await waitFor(() => expect(within(kind).getByRole("option", { name: "Oracle value set (ref_set) · 35" })).toBeTruthy())
    expect(within(kind).getByRole("option", { name: "Oracle update rejected (ref_rej) · 1" })).toBeTruthy()
    await user.selectOptions(kind, "ref_rej")
    await waitFor(() => expect(listUrls().at(-1)).toBe("/api/dashboard/events?group=oracle&topic=ref_rej&limit=50"))
    expect(window.location.search).toBe("?group=oracle&topic=ref_rej")
    const table = await screen.findByRole("table", { name: "Activity" })
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2))
    // A new group clears the kind: its topics differ.
    await user.selectOptions(screen.getByLabelText("Group"), "market")
    await waitFor(() => expect(listUrls().at(-1)).toBe("/api/dashboard/events?group=market&limit=50"))
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).value).toBe("")
  })

  it("filters by market (its pool); a protocol-wide group has no market filter", async () => {
    const user = userEvent.setup()
    render(wrap(<ActivityPanel />))
    await screen.findByRole("table", { name: "Activity" })
    const market = screen.getByLabelText("Market") as HTMLSelectElement
    expect(within(market).getByRole("option", { name: "USDY Mar 2030" })).toBeTruthy()
    await user.selectOptions(market, "testnet-usdy-1802336344")
    await waitFor(() => expect(listUrls().at(-1)).toBe(`/api/dashboard/events?pool=${POOL}&limit=50`))
    expect(window.location.search).toBe("?market=testnet-usdy-1802336344")
    await user.selectOptions(screen.getByLabelText("Group"), "risk")
    expect((screen.getByLabelText("Market") as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText("Market") as HTMLSelectElement).value).toBe("")
    expect(screen.getByText("RiskControl is protocol-wide: no market filter")).toBeTruthy()
    await waitFor(() => expect(listUrls().at(-1)).toBe("/api/dashboard/events?group=risk&limit=50"))
  })

  it("opens on the filters a shared link names, and ignores ones it does not know", async () => {
    mocks.search = "group=oracle&topic=ref_set&market=nope"
    render(wrap(<ActivityPanel />))
    await screen.findByRole("table", { name: "Activity" })
    expect(listUrls()[0]).toBe("/api/dashboard/events?group=oracle&topic=ref_set&limit=50")
    expect((screen.getByLabelText("Group") as HTMLSelectElement).value).toBe("oracle")
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).value).toBe("ref_set")
    expect((screen.getByLabelText("Market") as HTMLSelectElement).value).toBe("")
  })

  it("a bad group or topic in the link is ignored, never sent", async () => {
    mocks.search = "group=bogus&topic=no%20way"
    render(wrap(<ActivityPanel />))
    await screen.findByRole("table", { name: "Activity" })
    expect(listUrls()[0]).toBe("/api/dashboard/events?limit=50")
  })

  it("filters that match nothing read a plain empty text, never an error", async () => {
    mocks.search = "group=escrow"
    render(wrap(<ActivityPanel />))
    expect(await screen.findByText("No event indexed for these filters")).toBeTruthy()
  })

  it("links the same list as JSON, for a cross-check; fits 375 px", async () => {
    mocks.search = "group=oracle&topic=ref_rej"
    render(wrap(<ActivityPanel />))
    await screen.findByRole("table", { name: "Activity" })
    expect(screen.getByRole("link", { name: /\/api\/dashboard\/events/ }).getAttribute("href")).toBe("/api/dashboard/events?group=oracle&topic=ref_rej&limit=50")
    const section = screen.getByRole("heading", { level: 1, name: "Activity" }).closest("section")
    expect(section?.className).toContain("grid-cols-[minmax(0,1fr)]")
  })
})
