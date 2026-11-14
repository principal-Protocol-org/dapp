// @vitest-environment node
import { randomBytes } from "node:crypto"
import { Address, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { cursorLedger, type RawEvent } from "@/lib/protocol/events"
import { parseManifest } from "@/lib/protocol/manifest"
import type { ContractReader } from "@/lib/protocol/reader"
import type { Manifest, Market } from "@/lib/protocol/types"

vi.mock("server-only", () => ({}))

import { DatabaseConfigError, type Sql } from "@/lib/server/db"
import {
  contractsOf,
  getIndexedEvent,
  getIndexedEvents,
  indexCursorName,
  indexEvents,
  type IndexerRpc,
  type IndexGroup,
  type IndexResult,
} from "@/lib/server/indexer"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const c = market.contracts
const DEPLOY = manifest.deployLedger as number

// ---------------------------------------------------------------- fixtures

/** A ledger's close time (unix seconds) in the fake chain: 5 s per ledger. */
const closeOf = (ledger: number) => 1_800_000_000 + ledger * 5
/** Close times as the indexer stores them (`toISOString`); the RPC sends whole seconds ("…:33Z"). */
const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
const rpcTime = (seconds: number) => iso(seconds).replace(".000Z", "Z")

const toid = (ledger: number, tx: number) => (BigInt(ledger) << 32n) | (BigInt(tx) << 12n)
const eventId = (ledger: number, tx = 1, index = 0) => `${toid(ledger, tx).toString().padStart(19, "0")}-${String(index).padStart(10, "0")}`
/** The RPC's end-of-scan cursor: every event up to and including `ledger` was scanned. */
const endCursor = (ledger: number) => `${((BigInt(ledger) << 32n) | 0xffffffffn).toString().padStart(19, "0")}-4294967295`

type FakeEvent = {
  id: string
  ledger: number
  contractId: string
  topic: xdr.ScVal[]
  value: xdr.ScVal
  txHash: string
  ledgerClosedAt?: string
}

const sym = (s: string) => xdr.ScVal.scvSymbol(s)
const u64 = (v: bigint) => nativeToScVal(v, { type: "u64" })
const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" })
const addr = (a: string) => new Address(a).toScVal()
const randomContract = () => StrKey.encodeContract(randomBytes(32))

let txCounter = 0
function ev(ledger: number, contractId: string, topic: string, value: xdr.ScVal, opts: { tx?: number; index?: number; closedAt?: string | null } = {}): FakeEvent {
  const tx = opts.tx ?? 1
  txCounter++
  return {
    id: eventId(ledger, tx, opts.index ?? 0),
    ledger,
    contractId,
    topic: [sym(topic)],
    value,
    txHash: txCounter.toString(16).padStart(64, "0"),
    ...(opts.closedAt === null ? {} : { ledgerClosedAt: opts.closedAt ?? rpcTime(closeOf(ledger)) }),
  }
}

const admin = Keypair.random().publicKey()
const holder = Keypair.random().publicKey()

/** `recovery(caller, id, account, sy_shares, pt_amount, yt_amount, lp_amount)` on the market's escrow. */
const recovery = (ledger: number, id: bigint, escrow = c.recoveryEscrow) =>
  ev(ledger, escrow, "recovery", xdr.ScVal.scvVec([addr(admin), u64(id), addr(holder), i128(10n), i128(20n), i128(30n), i128(0n)]))
/** `ref_set(value, timestamp)` on the shared oracle. */
const refSet = (ledger: number, value: bigint, opts: { tx?: number; index?: number; closedAt?: string | null } = {}) =>
  ev(ledger, manifest.shared.oracle, "ref_set", xdr.ScVal.scvVec([i128(value), u64(BigInt(closeOf(ledger)))]), opts)

type Call = { startLedger?: number; cursor?: string; contractIds: string[]; limit: number }

/**
 * An RPC node over `events`: `getEvents` pages like the real one (at most `scan` ledgers per call,
 * an event id cursor on a full page, the end-of-scan cursor otherwise), refuses a start outside its
 * window, and refuses more than 5 contract ids.
 */
function makeRpc(opts: { events: FakeEvent[]; oldest: number; latest: number; scan?: number; delayMs?: number; getLedgers?: boolean }) {
  const events = [...opts.events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const scan = opts.scan ?? 10_000
  const calls: Call[] = []
  const ledgerCalls: number[] = []
  const rpc: IndexerRpc = {
    async getHealth() {
      return { oldestLedger: opts.oldest, latestLedger: opts.latest }
    },
    async getEvents(req) {
      const ids = req.filters[0].contractIds ?? []
      calls.push({ startLedger: req.startLedger, cursor: req.cursor, contractIds: [...ids], limit: req.limit })
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      if (ids.length > 5) throw new Error("filter 1 invalid: contract ids exceed the limit of 5")
      let from: number
      let after: string | null = null
      if (req.cursor !== undefined) {
        from = cursorLedger(req.cursor)
        after = req.cursor
      } else {
        const start = req.startLedger as number
        if (start < opts.oldest || start > opts.latest) {
          throw new Error(`[-32600] startLedger must be within the ledger range: ${opts.oldest} - ${opts.latest}`)
        }
        from = start
      }
      const end = Math.min(from + scan, opts.latest + 1)
      const matching = events.filter((e) => ids.includes(e.contractId) && e.ledger >= from && e.ledger < end && (after === null || e.id > after))
      const page = matching.slice(0, req.limit)
      const cursor = page.length === req.limit ? page[page.length - 1].id : endCursor(end - 1)
      const raw: RawEvent[] = page.map((e) => ({
        id: e.id,
        ledger: e.ledger,
        ledgerClosedAt: e.ledgerClosedAt as string,
        txHash: e.txHash,
        contractId: e.contractId,
        topic: e.topic,
        value: e.value,
      }))
      return { events: raw, cursor, latestLedger: opts.latest, latestLedgerCloseTime: String(closeOf(opts.latest)) }
    },
    ...(opts.getLedgers
      ? {
          async getLedgers(req: { startLedger: number; pagination: { limit: number } }) {
            ledgerCalls.push(req.startLedger)
            return { ledgers: [{ sequence: req.startLedger, ledgerCloseTime: String(closeOf(req.startLedger)) }] }
          },
        }
      : {}),
  }
  return { rpc, calls, ledgerCalls }
}

type Row = Record<string, unknown>
type CursorRow = { ledger: number; cursor: string | null; close_time: string | null }

/**
 * The `events` and `ingest_cursor` tables in memory, keyed as the real ones (events by id, cursors by
 * name), with the statements' conflict rules: an event id is inserted once, and a cursor only moves
 * forward. `cursorHistory` records the stored value after every cursor write.
 */
function makeDb(opts: { cursors?: Record<string, CursorRow>; failWith?: unknown } = {}) {
  const events = new Map<string, Row>()
  const cursors = new Map<string, CursorRow>(Object.entries(opts.cursors ?? {}))
  const cursorHistory: { name: string; attempted: number; stored: number }[] = []
  const texts: string[] = []
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (opts.failWith) throw opts.failWith
    const text = strings.join("?").replace(/\s+/g, " ").trim()
    texts.push(text)
    if (/^insert into events/i.test(text)) {
      expect(text).toMatch(/on conflict \(id\) do nothing returning id/i)
      const rows = JSON.parse(values[0] as string) as Row[]
      const out: Row[] = []
      for (const r of rows) {
        if (events.has(r.id as string)) continue
        events.set(r.id as string, r)
        out.push({ id: r.id })
      }
      return out
    }
    if (/^select ledger, cursor, close_time from ingest_cursor where name = \?$/i.test(text)) {
      const row = cursors.get(values[0] as string)
      return row ? [{ ...row, ledger: String(row.ledger) }] : []
    }
    if (/^insert into ingest_cursor/i.test(text)) {
      // The cursor never moves backwards: an overlapping run that is behind cannot rewind it.
      expect(text).toMatch(/where ingest_cursor\.ledger is null or excluded\.ledger > ingest_cursor\.ledger/i)
      const [name, ledger, cursor, closeTime] = values as [string, number, string | null, string | null]
      const current = cursors.get(name)
      if (!current || ledger > current.ledger) cursors.set(name, { ledger, cursor, close_time: closeTime ?? current?.close_time ?? null })
      cursorHistory.push({ name, attempted: ledger, stored: (cursors.get(name) as CursorRow).ledger })
      return []
    }
    if (/^select count\(\*\)::int as n from events where network = \? and contract_id = \? and topic = 'recovery'$/i.test(text)) {
      const [network, contract] = values
      return [{ n: [...events.values()].filter((r) => r.network === network && r.contract_id === contract && r.topic === "recovery").length }]
    }
    throw new Error(`unexpected SQL: ${text}`)
  }) as unknown as Sql & ReturnType<typeof vi.fn>
  return { sql, events, cursors, cursorHistory, texts }
}

/** `record_count` per escrow; any other call fails. */
function makeReader(counts: Record<string, bigint | Error>): ContractReader {
  return (async (call: { contractId: string; functionName: string }) => {
    const v = counts[call.contractId]
    if (call.functionName !== "record_count" || v === undefined) throw new Error(`unexpected read ${call.contractId}.${call.functionName}`)
    if (v instanceof Error) throw v
    return { value: v, latestLedger: 1, minResourceFee: "0" }
  }) as ContractReader
}

const FAR = Number.MAX_SAFE_INTEGER
const deps = (sql: Sql, rpc: IndexerRpc, extra: Partial<{ manifest: Manifest; markets: Market[]; now: () => number; reader: ContractReader }> = {}) => ({
  sql,
  rpc,
  manifest,
  markets: [market],
  reader: makeReader({ [c.recoveryEscrow]: 0n }),
  ...extra,
})

const groupOf = (result: IndexResult, g: IndexGroup) => result.groups.find((x) => x.group === g)

// ---------------------------------------------------------------- contractsOf

describe("contractsOf", () => {
  it("market: each market's sy, manager and pool; escrow: each recoveryEscrow; shared: oracle, permissioning, riskControl", () => {
    const groups = contractsOf(manifest, [market])
    expect(groups.market).toEqual([
      { id: c.sy, role: "sy", pool: c.pool },
      { id: c.manager, role: "manager", pool: c.pool },
      { id: c.pool, role: "pool", pool: c.pool },
    ])
    expect(groups.escrow).toEqual([{ id: c.recoveryEscrow, role: "escrow", pool: c.pool }])
    expect(groups.oracle).toEqual([{ id: manifest.shared.oracle, role: "oracle" }])
    expect(groups.permissioning).toEqual([{ id: manifest.shared.permissioning, role: "permissioning" }])
    expect(groups.risk).toEqual([{ id: manifest.shared.riskControl, role: "riskControl" }])
  })

  it("a contract listed twice is indexed once", () => {
    expect(contractsOf(manifest, [market, market]).market).toHaveLength(3)
  })
})

// ---------------------------------------------------------------- indexEvents

describe("indexEvents", () => {
  it("first run starts at max(deployLedger, oldestLedger)", async () => {
    // The deploy is inside the RPC window: start there, nothing lost.
    const inside = makeRpc({ events: [], oldest: DEPLOY - 1_000, latest: DEPLOY + 50 })
    const r1 = await indexEvents(deps(makeDb().sql, inside.rpc), { deadline: FAR, groups: ["oracle"] })
    expect(inside.calls[0].startLedger).toBe(DEPLOY)
    expect(groupOf(r1, "oracle")).toEqual({ group: "oracle", indexedThrough: DEPLOY + 50, gap: null, complete: true })

    // The deploy left the window: start at the oldest ledger and record what is missing.
    const outside = makeRpc({ events: [], oldest: DEPLOY + 100, latest: DEPLOY + 150 })
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const r2 = await indexEvents(deps(makeDb().sql, outside.rpc), { deadline: FAR, groups: ["oracle"] })
    expect(outside.calls[0].startLedger).toBe(DEPLOY + 100)
    expect(groupOf(r2, "oracle")?.gap).toEqual({ from: DEPLOY, to: DEPLOY + 99 })

    // No deployLedger in the manifest (a local stack): from the oldest ledger, no gap claimed.
    const local = { ...manifest, deployLedger: undefined }
    const none = makeRpc({ events: [], oldest: 1_000, latest: 1_010 })
    const r3 = await indexEvents(deps(makeDb().sql, none.rpc, { manifest: local }), { deadline: FAR, groups: ["oracle"] })
    expect(none.calls[0].startLedger).toBe(1_000)
    expect(groupOf(r3, "oracle")?.gap).toBeNull()
  })

  it("inserts decoded rows with tx hash, close time and raw xdr", async () => {
    const rec = recovery(DEPLOY + 10, 0n)
    const ref = refSet(DEPLOY + 11, 10_500_000n)
    const { rpc } = makeRpc({ events: [rec, ref], oldest: DEPLOY, latest: DEPLOY + 20 })
    const db = makeDb()
    const result = await indexEvents(deps(db.sql, rpc, { reader: makeReader({ [c.recoveryEscrow]: 1n }) }), { deadline: FAR })
    expect(result.inserted).toBe(2)
    expect(db.events.get(rec.id)).toEqual({
      id: rec.id,
      network: "testnet",
      contract_id: c.recoveryEscrow,
      group_name: "escrow",
      topic: "recovery",
      ledger: DEPLOY + 10,
      close_time: iso(closeOf(DEPLOY + 10)),
      tx_hash: rec.txHash,
      pool: c.pool,
      // bigint amounts and ids are exact decimal strings in JSON.
      data: { caller: admin, id: "0", account: holder, sy_shares: "10", pt_amount: "20", yt_amount: "30", lp_amount: "0" },
      // The event value as the RPC sent it: base64 XDR of the ScVal.
      raw_xdr: rec.value.toXDR("base64"),
    })
    const oracleRow = db.events.get(ref.id) as Row
    expect(oracleRow).toMatchObject({ group_name: "oracle", topic: "ref_set", pool: null, data: { value: "10500000", timestamp: String(closeOf(DEPLOY + 11)) } })
    // Every group reached the tip; its cursor holds the tip and its close time.
    expect(result.groups.every((g) => g.complete && g.indexedThrough === DEPLOY + 20)).toBe(true)
    expect(db.cursors.get(indexCursorName("oracle", "testnet"))).toMatchObject({ ledger: DEPLOY + 20, close_time: iso(closeOf(DEPLOY + 20)) })
    expect(result.reconcile).toEqual([{ escrow: c.recoveryEscrow, recordCount: 1, indexed: 1, ok: true }])
  })

  it("bytes are hex in the decoded data (the oracle's src_set source ids)", async () => {
    const primary = randomBytes(32)
    const src = ev(DEPLOY + 3, manifest.shared.oracle, "src_set", xdr.ScVal.scvVec([xdr.ScVal.scvBytes(primary), xdr.ScVal.scvVoid()]))
    const { rpc } = makeRpc({ events: [src], oldest: DEPLOY, latest: DEPLOY + 5 })
    const db = makeDb()
    await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(db.events.get(src.id)?.data).toEqual({ primary: primary.toString("hex"), fallback: null })
  })

  it("a second run inserts nothing new", async () => {
    const events = [recovery(DEPLOY + 1, 0n), refSet(DEPLOY + 2, 10_000_000n), refSet(DEPLOY + 3, 10_000_001n)]
    const { rpc } = makeRpc({ events, oldest: DEPLOY, latest: DEPLOY + 10 })
    const db = makeDb()
    const d = deps(db.sql, rpc, { reader: makeReader({ [c.recoveryEscrow]: 1n }) })
    expect((await indexEvents(d, { deadline: FAR })).inserted).toBe(3)
    const again = await indexEvents(d, { deadline: FAR })
    expect(again.inserted).toBe(0)
    expect(db.events.size).toBe(3)
    // Re-reading from an older cursor (a re-index) inserts nothing either: the RPC event id is the key.
    db.cursors.set(indexCursorName("oracle", "testnet"), { ledger: DEPLOY - 1, cursor: null, close_time: null })
    expect((await indexEvents(d, { deadline: FAR, groups: ["oracle"] })).inserted).toBe(0)
    expect(db.events.size).toBe(3)
  })

  it("overlapping runs stay idempotent: no duplicate, and the cursor never decreases", async () => {
    // 450 oracle events over 450 ledgers: three pages of 200 for each run.
    const events = Array.from({ length: 450 }, (_, i) => refSet(DEPLOY + 1 + i, 10_000_000n + BigInt(i)))
    const latest = DEPLOY + 460
    const fast = makeRpc({ events, oldest: DEPLOY, latest })
    // The second run's RPC answers slowly: it saves its early pages after the first run reached the tip.
    const slow = makeRpc({ events, oldest: DEPLOY, latest, delayMs: 15 })
    const db = makeDb()
    const [a, b] = await Promise.all([
      indexEvents(deps(db.sql, fast.rpc), { deadline: FAR, groups: ["oracle"] }),
      indexEvents(deps(db.sql, slow.rpc), { deadline: FAR, groups: ["oracle"] }),
    ])
    expect(fast.calls.length).toBeGreaterThanOrEqual(3)
    expect(slow.calls.length).toBeGreaterThanOrEqual(3)
    expect(db.events.size).toBe(450)
    expect(a.inserted + b.inserted).toBe(450)
    const history = db.cursorHistory.filter((h) => h.name === indexCursorName("oracle", "testnet"))
    // The slow run did try to write an older cursor after the fast one reached the tip...
    expect(history.some((h, i) => i > 0 && h.attempted < history[i - 1].stored)).toBe(true)
    // ...and the stored cursor never went back.
    history.forEach((h, i) => {
      if (i > 0) expect(h.stored).toBeGreaterThanOrEqual(history[i - 1].stored)
    })
    expect(db.cursors.get(indexCursorName("oracle", "testnet"))?.ledger).toBe(latest)
  })

  it("cursor older than oldestLedger records a gap {from,to} and continues", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const kept = refSet(DEPLOY + 600, 10_000_000n)
    const { rpc, calls } = makeRpc({ events: [refSet(DEPLOY + 200, 1n), kept], oldest: DEPLOY + 500, latest: DEPLOY + 700 })
    const db = makeDb({ cursors: { [indexCursorName("oracle", "testnet")]: { ledger: DEPLOY + 100, cursor: null, close_time: null } } })
    const result = await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(groupOf(result, "oracle")).toEqual({ group: "oracle", indexedThrough: DEPLOY + 700, gap: { from: DEPLOY + 101, to: DEPLOY + 499 }, complete: true })
    expect(calls[0].startLedger).toBe(DEPLOY + 500)
    expect([...db.events.keys()]).toEqual([kept.id])
    expect(warn.mock.calls.flat().join(" ")).toMatch(/gap/i)
  })

  it("a start refused because the oldest ledger moved on restarts there and widens the gap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    let oldest = DEPLOY + 100
    const base = makeRpc({ events: [], oldest: DEPLOY + 300, latest: DEPLOY + 400 })
    // getHealth answers an older oldest ledger than the node accepts by the time getEvents arrives.
    const rpc: IndexerRpc = {
      getEvents: base.rpc.getEvents,
      async getHealth() {
        const h = { oldestLedger: oldest, latestLedger: DEPLOY + 400 }
        oldest = DEPLOY + 300
        return h
      },
    }
    const db = makeDb({ cursors: { [indexCursorName("oracle", "testnet")]: { ledger: DEPLOY + 50, cursor: null, close_time: null } } })
    const result = await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(groupOf(result, "oracle")).toMatchObject({ gap: { from: DEPLOY + 51, to: DEPLOY + 299 }, complete: true, indexedThrough: DEPLOY + 400 })
    expect(base.calls.map((x) => x.startLedger)).toEqual([DEPLOY + 100, DEPLOY + 300])
  })

  it("stops at the deadline with complete:false, and the next run resumes from the saved ledger", async () => {
    const events = Array.from({ length: 10 }, (_, i) => refSet(DEPLOY + 1 + i * 100, BigInt(i)))
    // 100 ledgers per call: about ten pages to reach the tip.
    const { rpc, calls } = makeRpc({ events, oldest: DEPLOY, latest: DEPLOY + 1_000, scan: 100 })
    const db = makeDb()
    let clock = 0
    const now = () => (clock += 1_000)
    // Three page checks fit before the deadline.
    const result = await indexEvents(deps(db.sql, rpc, { now }), { deadline: 3_500, groups: ["oracle"] })
    const g = groupOf(result, "oracle")
    expect(g?.complete).toBe(false)
    expect(calls).toHaveLength(3)
    // A cursor page scans from the cursor's own ledger, as the RPC does: 100, then 99 new ledgers each.
    expect(g?.indexedThrough).toBe(DEPLOY + 297)
    expect(db.cursors.get(indexCursorName("oracle", "testnet"))?.ledger).toBe(DEPLOY + 297)
    const next = await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(calls[3].startLedger).toBe(DEPLOY + 298)
    expect(groupOf(next, "oracle")).toMatchObject({ complete: true, indexedThrough: DEPLOY + 1_000 })
    expect(db.events.size).toBe(10)
  })

  it("a full page ending mid-ledger saves the ledger before it, so a run cut there misses nothing", async () => {
    // 3 events in one ledger, pages of 2 (limit): the first page stops inside that ledger.
    const same = [0, 1, 2].map((i) => refSet(DEPLOY + 5, BigInt(i), { tx: i + 1 }))
    const { rpc } = makeRpc({ events: same, oldest: DEPLOY, latest: DEPLOY + 10 })
    const db = makeDb()
    let checks = 0
    const now = () => ++checks
    const result = await indexEvents(deps(db.sql, rpc, { now }), { deadline: 2, groups: ["oracle"], pageSize: 2 })
    expect(groupOf(result, "oracle")).toMatchObject({ complete: false, indexedThrough: DEPLOY + 4 })
    await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"], pageSize: 2 })
    expect(db.events.size).toBe(3)
  })

  it("at most 5 contract ids per getEvents", async () => {
    const second: Market = {
      ...market,
      marketId: "testnet-usdy-second",
      contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract(), recoveryEscrow: randomContract(), pt: randomContract(), yt: randomContract(), config: randomContract() },
    }
    // Events on the first and the last of the six market contracts.
    const first = ev(DEPLOY + 2, c.sy, "paused", xdr.ScVal.scvBool(true))
    const last = ev(DEPLOY + 3, second.contracts.pool, "paused", xdr.ScVal.scvBool(false))
    const { rpc, calls } = makeRpc({ events: [first, last], oldest: DEPLOY, latest: DEPLOY + 10 })
    const db = makeDb()
    const result = await indexEvents(deps(db.sql, rpc, { markets: [market, second] }), { deadline: FAR, groups: ["market"] })
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.every((x) => x.contractIds.length <= 5)).toBe(true)
    expect(new Set(calls.flatMap((x) => x.contractIds)).size).toBe(6)
    expect(db.events.get(first.id)).toMatchObject({ pool: c.pool, data: { paused: true } })
    expect(db.events.get(last.id)).toMatchObject({ pool: second.contracts.pool, data: { paused: false } })
    expect(groupOf(result, "market")).toMatchObject({ complete: true, indexedThrough: DEPLOY + 10 })
  })

  it("a split group saves the ledger every chunk has reached", async () => {
    const second: Market = { ...market, marketId: "m2", contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract() } }
    // The first chunk has 5 events in 5 ledgers; pages of 2 stop it part way; the second chunk is empty.
    const events = [1, 2, 3, 4, 5].map((i) => ev(DEPLOY + i * 10, c.sy, "paused", xdr.ScVal.scvBool(true)))
    const { rpc } = makeRpc({ events, oldest: DEPLOY, latest: DEPLOY + 100 })
    const db = makeDb()
    let checks = 0
    // Two page checks: one page per chunk, round robin.
    const result = await indexEvents(deps(db.sql, rpc, { markets: [market, second], now: () => ++checks }), { deadline: 3, groups: ["market"], pageSize: 2 })
    // Chunk 1 read through ledger DEPLOY + 19 (its page ended at the event of DEPLOY + 20); chunk 2 reached the tip.
    expect(groupOf(result, "market")).toMatchObject({ complete: false, indexedThrough: DEPLOY + 19 })
    expect(db.cursors.get(indexCursorName("market", "testnet"))?.ledger).toBe(DEPLOY + 19)
  })

  it("reconcile flags record_count != indexed recovery count", async () => {
    const { rpc } = makeRpc({ events: [recovery(DEPLOY + 1, 0n)], oldest: DEPLOY, latest: DEPLOY + 5 })
    const db = makeDb()
    const result = await indexEvents(deps(db.sql, rpc, { reader: makeReader({ [c.recoveryEscrow]: 2n }) }), { deadline: FAR, groups: ["escrow"] })
    expect(result.reconcile).toEqual([{ escrow: c.recoveryEscrow, recordCount: 2, indexed: 1, ok: false }])

    // An unreadable record_count is not a match either, and says so.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const unread = await indexEvents(deps(db.sql, rpc, { reader: makeReader({ [c.recoveryEscrow]: new Error("HostError") }) }), { deadline: FAR, groups: ["escrow"] })
    expect(unread.reconcile).toEqual([{ escrow: c.recoveryEscrow, recordCount: null, indexed: 1, ok: false }])

    // Reconcile only runs with the escrow group.
    const other = await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(other.reconcile).toEqual([])
  })

  it("unknown topics are stored with data {} and topic kept", async () => {
    const unknown = ev(DEPLOY + 1, c.sy, "idx_up", xdr.ScVal.scvVec([i128(1n)]))
    // A known topic whose data does not have the contract's shape is kept the same way.
    const misshapen = ev(DEPLOY + 2, c.pool, "buy_pt", xdr.ScVal.scvVec([i128(1n)]))
    const { rpc } = makeRpc({ events: [unknown, misshapen], oldest: DEPLOY, latest: DEPLOY + 5 })
    const db = makeDb()
    expect((await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["market"] })).inserted).toBe(2)
    expect(db.events.get(unknown.id)).toMatchObject({ topic: "idx_up", data: {}, raw_xdr: unknown.value.toXDR("base64") })
    expect(db.events.get(misshapen.id)).toMatchObject({ topic: "buy_pt", data: {} })
  })

  it("close time falls back to getLedgers when an event has no ledgerClosedAt", async () => {
    const bare = refSet(DEPLOY + 7, 1n, { closedAt: null })
    const { rpc, ledgerCalls } = makeRpc({ events: [bare], oldest: DEPLOY, latest: DEPLOY + 9, getLedgers: true })
    const db = makeDb()
    await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(ledgerCalls).toEqual([DEPLOY + 7])
    expect(db.events.get(bare.id)?.close_time).toBe(iso(closeOf(DEPLOY + 7)))
  })

  it("a run whose cursor is at the tip asks nothing and is complete", async () => {
    const { rpc, calls } = makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 10 })
    const db = makeDb({ cursors: { [indexCursorName("oracle", "testnet")]: { ledger: DEPLOY + 10, cursor: null, close_time: null } } })
    const result = await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(calls).toHaveLength(0)
    expect(groupOf(result, "oracle")).toEqual({ group: "oracle", indexedThrough: DEPLOY + 10, gap: null, complete: true })
  })

  it("an RPC failure in one group is reported by name, and the other groups still run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const ok = makeRpc({ events: [refSet(DEPLOY + 1, 1n)], oldest: DEPLOY, latest: DEPLOY + 5 })
    const rpc: IndexerRpc = {
      getHealth: ok.rpc.getHealth,
      async getEvents(req) {
        if (req.filters[0].contractIds?.includes(manifest.shared.permissioning)) throw new Error("rpc https://secret.example/key failed")
        return ok.rpc.getEvents(req)
      },
    }
    const db = makeDb()
    const result = await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["permissioning", "oracle"] })
    expect(groupOf(result, "permissioning")).toMatchObject({ complete: false, error: "failed" })
    expect(groupOf(result, "oracle")).toMatchObject({ complete: true })
    expect(db.events.size).toBe(1)
    // The RPC's text (it may carry a provider URL) never reaches the log.
    expect(error.mock.calls.flat().join(" ")).not.toMatch(/secret\.example/)
  })

  it("a missing database rejects with DatabaseConfigError", async () => {
    const { rpc } = makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 5 })
    const db = makeDb({ failWith: new DatabaseConfigError() })
    await expect(indexEvents(deps(db.sql, rpc), { deadline: FAR })).rejects.toBeInstanceOf(DatabaseConfigError)
  })
})

// ---------------------------------------------------------------- reading the index

describe("getIndexedEvents", () => {
  const row = {
    id: eventId(DEPLOY + 9),
    group_name: "escrow",
    contract_id: c.recoveryEscrow,
    topic: "recovery",
    ledger: DEPLOY + 9,
    close_time: new Date(closeOf(DEPLOY + 9) * 1000),
    tx_hash: "ab".repeat(32),
    pool: c.pool,
    data: { id: "0" },
  }

  function readDb(cursors: { name: string; ledger: string; close_time: Date | null }[]) {
    const texts: string[] = []
    const values: unknown[][] = []
    const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim()
      texts.push(text)
      values.push(v)
      if (text.includes("from ingest_cursor")) return cursors
      if (text.includes("from events")) return text.includes("raw_xdr") ? [{ ...row, raw_xdr: "AAAA" }] : [row]
      throw new Error(`unexpected SQL: ${text}`)
    }) as unknown as Sql
    return { sql, texts, values }
  }

  const allCursors = (ledger: number, closeTime: Date | null) =>
    (["escrow", "oracle", "permissioning", "risk", "market"] as const).map((g) => ({ name: indexCursorName(g, "testnet"), ledger: String(ledger), close_time: closeTime }))

  it("lists rows newest first without raw xdr, with the indexed-through ledger and lag", async () => {
    const tip = DEPLOY + 20
    const db = readDb(allCursors(tip, new Date(closeOf(tip) * 1000)))
    const now = (closeOf(tip) + 42) * 1000
    const out = await getIndexedEvents(db.sql, { network: "testnet", limit: 50, now })
    expect(out).toEqual({
      rows: [
        {
          id: row.id,
          group: "escrow",
          contractId: c.recoveryEscrow,
          topic: "recovery",
          ledger: DEPLOY + 9,
          closeTime: iso(closeOf(DEPLOY + 9)),
          txHash: row.tx_hash,
          pool: c.pool,
          data: { id: "0" },
        },
      ],
      indexedThrough: tip,
      lagSeconds: 42,
    })
    const list = db.texts.find((t) => t.includes("from events")) as string
    expect(list).not.toMatch(/raw_xdr/)
    expect(list).toMatch(/order by ledger desc, id desc limit \?$/)
  })

  it("filters by group, pool and before; indexedThrough is the slowest group's", async () => {
    const cursors = allCursors(DEPLOY + 20, new Date(closeOf(DEPLOY + 20) * 1000))
    cursors[1] = { ...cursors[1], ledger: String(DEPLOY + 5), close_time: new Date(closeOf(DEPLOY + 5) * 1000) }
    const db = readDb(cursors)
    const before = eventId(DEPLOY + 15)
    const all = await getIndexedEvents(db.sql, { network: "testnet", pool: c.pool, before, limit: 10, now: closeOf(DEPLOY + 25) * 1000 })
    expect(all.indexedThrough).toBe(DEPLOY + 5)
    expect(all.lagSeconds).toBe(100)
    const params = db.values[db.texts.findIndex((t) => t.includes("from events"))]
    expect(params).toEqual(expect.arrayContaining(["testnet", c.pool, before, 10]))
    const one = await getIndexedEvents(db.sql, { network: "testnet", group: "escrow", limit: 10, now: closeOf(DEPLOY + 25) * 1000 })
    expect(one.indexedThrough).toBe(DEPLOY + 20)
  })

  it("a group never indexed: indexedThrough 0, lag unknown", async () => {
    const db = readDb([])
    expect(await getIndexedEvents(db.sql, { network: "testnet", limit: 1 })).toMatchObject({ indexedThrough: 0, lagSeconds: null })
  })

  it("one event by id carries its raw xdr", async () => {
    const db = readDb([])
    expect(await getIndexedEvent(db.sql, { network: "testnet", id: row.id })).toMatchObject({ id: row.id, group: "escrow", rawXdr: "AAAA" })
  })
})
