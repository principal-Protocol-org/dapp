import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const LEDGER_TIME = 1_800_000_000
const TX = "445a001b1a22259cc9566fadbd9645da017240fb8a31c3b068ca12e437c7e336"

const mocks = vi.hoisted(() => ({
  manifest: { network: "testnet", rpcUrl: "https://rpc.test", markets: [], shared: { riskControl: "CRISK" } } as Record<string, unknown>,
  clock: { ledgerTime: 0 as number | null, sequence: 5_720_087 as number | null, isError: false },
  fetch: vi.fn(),
}))
vi.mock("@/components/app/manifest-provider", () => ({ useManifest: () => mocks.manifest }))
vi.mock("@/hooks/use-ledger-clock", () => ({ useLedgerClock: () => mocks.clock }))

import { EventList } from "../event-list"

const id = (n: number) => `${String(n).padStart(19, "0")}-0000000000`
const row = (n: number, topic = "cb_limit", data: Record<string, unknown> = { caller: "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA", limit: "100000000000000" }) => ({
  id: id(n),
  group: "risk",
  contractId: "CRISK",
  topic,
  ledger: 5_718_000 + n,
  closeTime: "2026-11-14T00:04:59.000Z",
  txHash: TX,
  pool: null,
  data,
})

const answer = (rows: unknown[], over: Record<string, unknown> = {}) => ({
  rows,
  indexedThrough: 5_719_749,
  indexedThroughCloseTime: new Date((LEDGER_TIME - 125) * 1000).toISOString(),
  lagSeconds: 125,
  gaps: [],
  reconcile: null,
  ...over,
})

let client: QueryClient
const wrap = (ui: ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider>

beforeEach(() => {
  mocks.manifest = { network: "testnet", rpcUrl: "https://rpc.test", markets: [], shared: { riskControl: "CRISK" } }
  mocks.clock = { ledgerTime: LEDGER_TIME, sequence: 5_720_087, isError: false }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.fetch.mockReset().mockImplementation(async (url: string) => Response.json(answer(url.includes("before=") ? [row(1)] : [row(3), row(2)])))
  vi.stubGlobal("fetch", mocks.fetch)
})

afterEach(() => vi.unstubAllGlobals())

describe("EventList", () => {
  it("lists indexed events newest first, each with a tx link, its ledger and its close time; the header says how far the index has read", async () => {
    render(wrap(<EventList label="Limit changes" group="risk" topics={["cb_limit"]} empty="No limit change indexed yet" pageSize={2} />))
    const table = await screen.findByRole("table", { name: "Limit changes" })
    expect(mocks.fetch).toHaveBeenCalledWith("/api/dashboard/events?group=risk&topic=cb_limit&limit=2")
    const rows = within(table).getAllByRole("row").slice(1)
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getAllByText("5718003").length).toBeGreaterThan(0)
    expect(within(rows[0]).getAllByText("2026-11-14 00:04:59 UTC").length).toBeGreaterThan(0)
    const [tx] = within(rows[0]).getAllByRole("link", { name: `View transaction ${TX} on stellar.expert` })
    expect(tx.getAttribute("href")).toBe(`https://stellar.expert/explorer/testnet/tx/${TX}`)
    expect(tx.textContent).toBe("445a00…e336")
    expect(screen.getByTestId("event-list-index").textContent).toMatch(/^Indexed through ledger 5719749·lag 2m 5s·Refreshes every 1 min$/)
  })

  it("says what each row is with describe", async () => {
    render(
      wrap(<EventList label="Limit changes" group="risk" empty="none" pageSize={2} describe={(r) => ({ title: `Limit set (${r.data.limit as string})`, detail: "by the admin" })} />),
    )
    expect(await screen.findAllByText("Limit set (100000000000000)")).toHaveLength(2)
    expect(screen.getAllByText("by the admin")).toHaveLength(2)
  })

  it("by default, the topic's words and the account the event is about", async () => {
    render(wrap(<EventList label="Defaults" group="risk" empty="none" pageSize={2} />))
    expect(await screen.findAllByText("Circuit-breaker limit set")).toHaveLength(2)
  })

  it("pages through older events with before, appending them", async () => {
    const user = userEvent.setup()
    render(wrap(<EventList label="Limit changes" group="risk" empty="none" pageSize={2} />))
    await screen.findByRole("table", { name: "Limit changes" })
    await user.click(screen.getByRole("button", { name: "Show older events" }))
    expect(await screen.findAllByText("5718001")).not.toHaveLength(0)
    expect(mocks.fetch).toHaveBeenLastCalledWith(`/api/dashboard/events?group=risk&limit=2&before=${id(2)}`)
    expect(within(screen.getByRole("table", { name: "Limit changes" })).getAllByRole("row")).toHaveLength(4)
    // The last page was short: no older events.
    expect(screen.queryByRole("button", { name: "Show older events" })).toBeNull()
  })

  it("an empty index reads its plain empty text, never an error; gaps are listed in the header", async () => {
    mocks.fetch.mockImplementation(async () => Response.json(answer([], { gaps: [{ group: "risk", from: 5_707_342, to: 5_707_400 }] })))
    render(wrap(<EventList label="Limit changes" group="risk" empty="No limit change indexed yet" />))
    expect(await screen.findByText("No limit change indexed yet")).toBeTruthy()
    expect(screen.queryByText(/Unavailable/)).toBeNull()
    expect(screen.getByText("Gap: risk ledgers 5707342–5707400 are not indexed")).toBeTruthy()
  })

  it("a lag over an hour is marked", async () => {
    mocks.fetch.mockImplementation(async () => Response.json(answer([], { indexedThroughCloseTime: new Date((LEDGER_TIME - 5000) * 1000).toISOString() })))
    render(wrap(<EventList label="x" group="risk" empty="none" />))
    expect(await screen.findByText(/over 1 hour behind/)).toBeTruthy()
  })

  it("an index the server cannot read is Unavailable, with its reason", async () => {
    mocks.fetch.mockImplementation(async () => Response.json({ error: "not_configured" }, { status: 503 }))
    render(wrap(<EventList label="Limit changes" group="risk" empty="none" />))
    expect(await screen.findByRole("button", { name: "More about Limit changes (unavailable)" })).toBeTruthy()
  })

  it("on a local network a transaction is plain text (no explorer)", async () => {
    mocks.manifest = { ...mocks.manifest, network: "local" }
    render(wrap(<EventList label="Limit changes" group="risk" empty="none" pageSize={2} />))
    await screen.findByRole("table", { name: "Limit changes" })
    expect(screen.queryAllByRole("link")).toHaveLength(0)
    expect(screen.getAllByText("445a00…e336").length).toBeGreaterThan(0)
  })

  it("fits 375 px: below 520 px the ledger and transaction fold under the event, below 720 px the close time", async () => {
    render(wrap(<EventList label="Limit changes" group="risk" empty="none" pageSize={2} />))
    const table = await screen.findByRole("table", { name: "Limit changes" })
    expect(within(table).getByRole("columnheader", { name: "Ledger" }).className).toContain("max-[520px]:hidden")
    expect(within(table).getByRole("columnheader", { name: "Transaction" }).className).toContain("max-[520px]:hidden")
    expect(within(table).getByRole("columnheader", { name: "Closed (UTC)" }).className).toContain("max-[720px]:hidden")
    const links = within(table).getAllByRole("link", { name: /^View transaction / })
    expect(links.map((a) => Boolean(a.closest("td")?.className.includes("max-[520px]:hidden") || a.closest("span")?.className.includes("min-[520px]:hidden")))).toEqual([true, true, true, true])
    // A space inside a nowrap span is no break point: the separators sit outside them.
    for (const el of table.querySelectorAll(".whitespace-nowrap")) expect(el.textContent).not.toMatch(/·/)
  })
})
