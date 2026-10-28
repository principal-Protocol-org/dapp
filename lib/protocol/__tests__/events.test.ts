// @vitest-environment node
import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { decodeEvent, fetchAccountHistory, MAX_PAGES, type Role } from "../events"
import { parseManifest } from "../manifest"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const C = market.contracts
const ACCOUNT = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()

const addr = (a: string) => new Address(a).toScVal()
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" })
const sym = (s: string) => nativeToScVal(s, { type: "symbol" })
const tuple = (...v: xdr.ScVal[]) => xdr.ScVal.scvVec(v)

describe("decodeEvent: one decoder per topic", () => {
  const cases: [Role, string, unknown[], Record<string, unknown>][] = [
    ["pool", "buy_pt", [ACCOUNT, ACCOUNT, 10n, 9n, 1n], { from: ACCOUNT, to: ACCOUNT, sy_in: 10n, pt_out: 9n, fee_shares: 1n }],
    ["pool", "sell_pt", [ACCOUNT, ACCOUNT, 10n, 9n, 1n], { from: ACCOUNT, to: ACCOUNT, pt_in: 10n, sy_out: 9n, fee_shares: 1n }],
    ["pool", "sell_yt", [ACCOUNT, ACCOUNT, 10n, 9n, 1n], { from: ACCOUNT, to: ACCOUNT, yt_in: 10n, sy_out: 9n, fee_shares: 1n }],
    ["pool", "add_liq", [ACCOUNT, 5n, 6n, 7n], { from: ACCOUNT, pt_used: 5n, sy_used: 6n, lp: 7n }],
    ["pool", "zap_liq", [ACCOUNT, 5n, 6n, 7n], { from: ACCOUNT, pt_used: 5n, sy_used: 6n, lp: 7n }],
    ["pool", "rem_liq", [ACCOUNT, ACCOUNT, 7n, 5n, 6n], { from: ACCOUNT, to: ACCOUNT, lp: 7n, pt_out: 5n, sy_out: 6n }],
    ["pool", "lp_xfer", [ACCOUNT, OTHER, 3n], { from: ACCOUNT, to: OTHER, amount: 3n }],
    ["manager", "mint", [ACCOUNT, 100n, 90n, 10n], { from: ACCOUNT, sy_shares: 100n, notional: 90n, fee_shares: 10n }],
    ["manager", "recombine", [ACCOUNT, 50n, 48n], { from: ACCOUNT, amount: 50n, shares: 48n }],
    ["manager", "redeem", [ACCOUNT, 50n, 40n, 45n, 5n], { from: ACCOUNT, pt_amount: 50n, yt_amount: 40n, from_pt: 45n, from_yt: 5n }],
    ["manager", "yt_claim", [ACCOUNT, 12n, 11n], { from: ACCOUNT, gross: 12n, paid: 11n }],
    ["sy", "deposit", [ACCOUNT, 100n, 95n], { from: ACCOUNT, amount: 100n, shares: 95n }],
    ["sy", "withdraw", [ACCOUNT, 95n, 100n], { from: ACCOUNT, shares: 95n, underlying_out: 100n }],
    ["sy", "sy_xfer", [ACCOUNT, OTHER, 4n], { from: ACCOUNT, to: OTHER, amount: 4n }],
    ["pt", "transfer", [ACCOUNT, OTHER, 4n], { from: ACCOUNT, to: OTHER, amount: 4n }],
    ["yt", "transfer", [ACCOUNT, OTHER, 4n], { from: ACCOUNT, to: OTHER, amount: 4n }],
    ["yt", "claim", [ACCOUNT, 8n], { from: ACCOUNT, amount: 8n }],
    ["escrow", "finalize", [1n, ACCOUNT, 2n, 3n], { id: 1n, account: ACCOUNT, underlying_from_pt: 2n, underlying_from_yt: 3n }],
    ["oracle", "ref_set", [10_500_000n, 1_790_000_000n], { value: 10_500_000n, timestamp: 1_790_000_000n }],
  ]
  it.each(cases)("%s %s", (role, topic, data, fields) => {
    const ev = decodeEvent(role, topic, data)
    expect(ev).toEqual({ role, topic, fields })
  })

  it("mint collision: manager decodes 4 fields, pt decodes 2", () => {
    const m = decodeEvent("manager", "mint", [ACCOUNT, 100n, 90n, 10n])
    expect(Object.keys(m?.fields ?? {})).toEqual(["from", "sy_shares", "notional", "fee_shares"])
    const p = decodeEvent("pt", "mint", [ACCOUNT, 90n])
    expect(Object.keys(p?.fields ?? {})).toEqual(["to", "amount"])
    expect(decodeEvent("pt", "mint", [ACCOUNT, 100n, 90n, 10n])).toBeNull()
    expect(decodeEvent("manager", "mint", [ACCOUNT, 90n])).toBeNull()
  })

  it("returns null for an unknown topic or a wrong shape", () => {
    expect(decodeEvent("pool", "nope", [ACCOUNT])).toBeNull()
    expect(decodeEvent("sy", "deposit", "not a tuple")).toBeNull()
  })
})

// ---- fake RPC ----
type FakeEvent = { id: string; ledger: number; hash: string; contract: string; topic: string; data: xdr.ScVal; ok?: boolean }
let seq = 0
function ev(ledger: number, hash: string, contract: string, topic: string, ...fields: xdr.ScVal[]): FakeEvent {
  seq += 1
  return {
    id: `${String(ledger).padStart(10, "0")}-${String(seq).padStart(10, "0")}`,
    ledger,
    hash,
    contract,
    topic,
    data: fields.length === 1 && topic === "ref_set" ? fields[0] : tuple(...fields),
  }
}
const toResponse = (e: FakeEvent) => ({
  id: e.id,
  type: "contract",
  ledger: e.ledger,
  ledgerClosedAt: `2026-10-0${(e.ledger % 9) + 1}T10:00:00Z`,
  txHash: e.hash,
  contractId: { contractId: () => e.contract },
  topic: [sym(e.topic)],
  value: e.data,
  inSuccessfulContractCall: e.ok ?? true,
})

type Req = { startLedger?: number; cursor?: string; limit?: number; filters: { contractIds: string[] }[] }
function fakeServer(all: FakeEvent[], opts: { pageSize?: number; oldest?: number; latest?: number } = {}) {
  const getEvents = vi.fn(async (req: Req) => {
    const ids = req.filters[0].contractIds
    const mine = all.filter((e) => ids.includes(e.contract)).sort((a, b) => a.id.localeCompare(b.id))
    const after = req.cursor ? mine.filter((e) => e.id > (req.cursor as string)) : mine.filter((e) => e.ledger >= (req.startLedger ?? 0))
    const page = after.slice(0, opts.pageSize ?? 1000)
    return { events: page.map(toResponse), cursor: page.at(-1)?.id ?? req.cursor ?? "0", latestLedger: opts.latest ?? 500, oldestLedger: opts.oldest ?? 100 }
  })
  const getHealth = vi.fn(async () => ({ status: "healthy", latestLedger: opts.latest ?? 500, oldestLedger: opts.oldest ?? 100, ledgerRetentionWindow: 120960 }))
  return { getEvents, getHealth }
}
const run = (all: FakeEvent[], opts?: Parameters<typeof fakeServer>[1]) => {
  const server = fakeServer(all, opts)
  return {
    server,
    promise: fetchAccountHistory({ manifest, marketId: market.marketId, account: ACCOUNT, server: server as never }),
  }
}

describe("fetchAccountHistory", () => {
  it("filters to the account: events without it in their data are dropped", async () => {
    const { promise } = run([
      ev(200, "h1", C.sy, "deposit", addr(ACCOUNT), i128(100_000_000n), i128(95_000_000n)),
      ev(201, "h2", C.sy, "deposit", addr(OTHER), i128(100n), i128(95n)),
    ])
    const { entries } = await promise
    expect(entries.map((e) => e.hash)).toEqual(["h1"])
  })

  it("groups wrap_and_mint: deposit + mint of one hash form one mint entry with two lines", async () => {
    const { promise } = run([
      ev(200, "h1", C.sy, "deposit", addr(ACCOUNT), i128(100_000_000n), i128(95_000_000n)),
      ev(200, "h1", C.manager, "mint", addr(ACCOUNT), i128(95_000_000n), i128(99_500_000n), i128(500_000n)),
      ev(200, "h1", C.pt, "mint", addr(ACCOUNT), i128(99_500_000n)),
      ev(200, "h1", C.yt, "mint", addr(ACCOUNT), i128(99_500_000n)),
    ])
    const { entries } = await promise
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ hash: "h1", ledger: 200, kind: "mint" })
    expect(entries[0].lines).toEqual(["Deposited 10 STA", "Minted 9.95 PT + 9.95 YT"])
  })

  it("buy_yt is recognised: a manager mint plus a pool sell_pt in one hash", async () => {
    const { promise } = run([
      ev(200, "h1", C.manager, "mint", addr(ACCOUNT), i128(100_000_000n), i128(100_000_000n), i128(0n)),
      ev(200, "h1", C.pt, "transfer", addr(ACCOUNT), addr(C.pool), i128(100_000_000n)),
      ev(200, "h1", C.pool, "sell_pt", addr(ACCOUNT), addr(ACCOUNT), i128(100_000_000n), i128(80_000_000n), i128(1_000n)),
    ])
    const { entries } = await promise
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("buy_yt")
    expect(entries[0].lines).toEqual(["Minted 10 PT + 10 YT", "Sold 10 PT for 8 SY"])
  })

  it.each([
    ["sell_yt", () => ev(200, "h", C.pool, "sell_yt", addr(ACCOUNT), addr(ACCOUNT), i128(10_000_000n), i128(5_000_000n), i128(0n)), "Sold 1 YT for 0.5 SY"],
    ["buy_pt", () => ev(200, "h", C.pool, "buy_pt", addr(ACCOUNT), addr(ACCOUNT), i128(10_000_000n), i128(11_000_000n), i128(0n)), "Bought 1.1 PT for 1 SY"],
    ["add_liquidity", () => ev(200, "h", C.pool, "zap_liq", addr(ACCOUNT), i128(10_000_000n), i128(20_000_000n), i128(30_000_000n)), "Added 1 PT + 2 SY, received 3 LP"],
    ["remove_liquidity", () => ev(200, "h", C.pool, "rem_liq", addr(ACCOUNT), addr(ACCOUNT), i128(30_000_000n), i128(10_000_000n), i128(20_000_000n)), "Removed 3 LP, received 1 PT + 2 SY"],
    ["recombine", () => ev(200, "h", C.manager, "recombine", addr(ACCOUNT), i128(10_000_000n), i128(9_000_000n)), "Recombined 1 PT + 1 YT into 0.9 SY"],
    ["redeem", () => ev(200, "h", C.manager, "redeem", addr(ACCOUNT), i128(10_000_000n), i128(0n), i128(10_500_000n), i128(0n)), "Received 1.05 STA"],
    ["claim", () => ev(200, "h", C.manager, "yt_claim", addr(ACCOUNT), i128(20_000_000n), i128(19_000_000n)), "Claimed 1.9 STA of yield"],
    ["withdraw", () => ev(200, "h", C.sy, "withdraw", addr(ACCOUNT), i128(10_000_000n), i128(10_500_000n)), "Withdrew 1 SY for 1.05 STA"],
    ["transfer", () => ev(200, "h", C.pt, "transfer", addr(ACCOUNT), addr(OTHER), i128(10_000_000n)), "Sent 1 PT"],
  ])("classifies %s", async (kind, make, line) => {
    const { promise } = run([make()])
    const { entries } = await promise
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe(kind)
    expect(entries[0].lines.join("\n")).toContain(line)
  })

  it("claim: the YT token's claim event does not add a second row or line", async () => {
    const { promise } = run([
      ev(200, "h", C.yt, "claim", addr(ACCOUNT), i128(20_000_000n)),
      ev(200, "h", C.manager, "yt_claim", addr(ACCOUNT), i128(20_000_000n), i128(19_000_000n)),
    ])
    const { entries } = await promise
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("claim")
    expect(entries[0].lines).toHaveLength(1)
  })

  it("an unknown combination becomes a generic entry listing every decoded event", async () => {
    const { promise } = run([
      ev(200, "h", C.sy, "deposit", addr(ACCOUNT), i128(10n), i128(9n)),
      ev(200, "h", C.pool, "sell_yt", addr(ACCOUNT), addr(ACCOUNT), i128(1n), i128(1n), i128(0n)),
      ev(200, "h", C.recoveryEscrow, "finalize", nativeToScVal(7n, { type: "u64" }), addr(ACCOUNT), i128(2n), i128(3n)),
      ev(200, "h", C.pool, "paused_unknown", addr(ACCOUNT)),
    ])
    const { entries } = await promise
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe("other")
    expect(entries[0].lines).toHaveLength(4)
    expect(entries[0].lines.join("\n")).toContain("pool paused_unknown")
  })

  it("ref_set feeds the entry APY: oracle updates are returned, never as entries", async () => {
    const { promise } = run([
      ev(150, "o1", C.oracle, "ref_set", i128(10_400_000n), nativeToScVal(1_790_000_000n, { type: "u64" })),
      ev(180, "o2", C.oracle, "ref_set", i128(10_500_000n), nativeToScVal(1_790_000_600n, { type: "u64" })),
      ev(200, "h1", C.sy, "deposit", addr(ACCOUNT), i128(1n), i128(1n)),
    ])
    const { entries, oracleUpdates } = await promise
    expect(entries.map((e) => e.hash)).toEqual(["h1"])
    expect(oracleUpdates).toEqual([
      { ledger: 150, value: 10_400_000n },
      { ledger: 180, value: 10_500_000n },
    ])
  })

  it("reads the window from getHealth and starts at the oldest ledger", async () => {
    const { server, promise } = run([], { oldest: 321, latest: 999 })
    const res = await promise
    expect(res.window).toEqual({ oldestLedger: 321, latestLedger: 999 })
    expect(res.entries).toEqual([])
    expect(server.getEvents.mock.calls[0][0]).toMatchObject({ startLedger: 321, limit: 1000 })
  })

  it("makes two requests of at most 5 contract IDs each", async () => {
    const { server, promise } = run([])
    await promise
    const sets = server.getEvents.mock.calls.map((c) => c[0].filters[0].contractIds)
    expect(sets).toContainEqual([C.sy, C.manager, C.pt, C.yt, C.pool])
    expect(sets).toContainEqual([C.recoveryEscrow, C.oracle])
    expect(sets.every((s) => s.length <= 5)).toBe(true)
  })

  it("paginates by cursor, merges both groups by ledger then id, newest entry first", async () => {
    const all = [
      ev(200, "a", C.sy, "deposit", addr(ACCOUNT), i128(1n), i128(1n)),
      ev(210, "b", C.sy, "deposit", addr(ACCOUNT), i128(2n), i128(2n)),
      ev(220, "c", C.sy, "deposit", addr(ACCOUNT), i128(3n), i128(3n)),
      ev(205, "e", C.recoveryEscrow, "finalize", nativeToScVal(1n, { type: "u64" }), addr(ACCOUNT), i128(1n), i128(1n)),
    ]
    const { server, promise } = run(all, { pageSize: 2 })
    const { entries } = await promise
    expect(entries.map((e) => e.hash)).toEqual(["c", "b", "e", "a"])
    expect(server.getEvents.mock.calls.some((c) => typeof c[0].cursor === "string")).toBe(true)
  })

  it("bounds pagination at MAX_PAGES and says the history is truncated", async () => {
    const getEvents = vi.fn(async () => ({
      events: [toResponse(ev(200, "x", C.sy, "deposit", addr(ACCOUNT), i128(1n), i128(1n)))].map((e, i) => ({ ...e, id: `${getEvents.mock.calls.length}-${i}` })),
      cursor: `c${getEvents.mock.calls.length}`,
      latestLedger: 500,
      oldestLedger: 100,
    }))
    const getHealth = async () => ({ status: "healthy", latestLedger: 500, oldestLedger: 100, ledgerRetentionWindow: 1 })
    const res = await fetchAccountHistory({ manifest, marketId: market.marketId, account: ACCOUNT, server: { getEvents, getHealth } as never })
    expect(getEvents).toHaveBeenCalledTimes(MAX_PAGES * 2)
    expect(res.truncated).toBe(true)
  })

  it("ignores events of failed contract calls", async () => {
    const e = ev(200, "bad", C.sy, "deposit", addr(ACCOUNT), i128(1n), i128(1n))
    e.ok = false
    const { promise } = run([e])
    expect((await promise).entries).toEqual([])
  })

  it("rejects when the RPC fails (never an empty history)", async () => {
    const server = { getHealth: async () => { throw new Error("rate limited") }, getEvents: vi.fn() }
    await expect(fetchAccountHistory({ manifest, marketId: market.marketId, account: ACCOUNT, server: server as never })).rejects.toThrow("rate limited")
  })

  it("rejects an unknown market", async () => {
    await expect(fetchAccountHistory({ manifest, marketId: "nope", account: ACCOUNT, server: fakeServer([]) as never })).rejects.toThrow(/market/i)
  })
})
