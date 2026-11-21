// @vitest-environment node
import { randomBytes } from "node:crypto"
import { Address, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import mainnetJson from "@/config/manifests/mainnet.json"
import testnetJson from "@/config/manifests/testnet.json"
import { cursorLedger, type RawEvent } from "@/lib/protocol/events"
import { manifestOracles, parseManifest } from "@/lib/protocol/manifest"
import type { ContractReader } from "@/lib/protocol/reader"
import type { Manifest, Market } from "@/lib/protocol/types"

vi.mock("server-only", () => ({}))

import { DatabaseConfigError, type Sql } from "@/lib/server/db"
import {
  contractsOf,
  getEventCounts,
  getIndexedEvent,
  getIndexedEvents,
  indexCursorName,
  indexEvents,
  runGroups,
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
type CursorRow = {
  ledger: number | null
  cursor: string | null
  close_time: string | null
  gap_from?: number | null
  gap_to?: number | null
  members?: string[] | null
  reconcile?: { at: string; results: unknown[] } | null
}

const least = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.min(a, b))
const greatest = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b ?? null) : b == null ? a : Math.max(a, b))
const sorted = (ids: string[]) => [...ids].sort()

/**
 * The `events` and `ingest_cursor` tables in memory, keyed as the real ones (events by id, cursors by
 * name), with the statements' conflict rules: an event id is inserted once; a cursor only moves
 * forward, and the move writes its members and widens the stored gap (Postgres `least`/`greatest`
 * skip nulls). `cursorHistory` records the stored value after every cursor write.
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
    if (/^select ledger, cursor, close_time, gap_from, gap_to, members from ingest_cursor where name = \?$/i.test(text)) {
      const row = cursors.get(values[0] as string)
      // pg answers bigint columns as strings.
      const str = (v: number | null | undefined) => (v == null ? null : String(v))
      return row ? [{ ...row, ledger: str(row.ledger), gap_from: str(row.gap_from), gap_to: str(row.gap_to), members: row.members ?? null }] : []
    }
    if (/^insert into ingest_cursor \(name, ledger, /i.test(text)) {
      // The cursor never moves backwards: an overlapping run that is behind cannot rewind it.
      expect(text).toMatch(/where ingest_cursor\.ledger is null or excluded\.ledger > ingest_cursor\.ledger/i)
      // A gap travels with the move that passes it, and an open one is widened, never narrowed.
      expect(text).toMatch(/gap_from = least\(ingest_cursor\.gap_from, excluded\.gap_from\)/i)
      expect(text).toMatch(/gap_to = greatest\(ingest_cursor\.gap_to, excluded\.gap_to\)/i)
      const [name, ledger, cursor, closeTime, gapFrom, gapTo, members] = values as [string, number, string | null, string | null, number | null, number | null, string[]]
      const current = cursors.get(name)
      if (!current || current.ledger === null || ledger > current.ledger) {
        cursors.set(name, {
          ...current,
          ledger,
          cursor,
          close_time: closeTime ?? current?.close_time ?? null,
          gap_from: least(current?.gap_from, gapFrom),
          gap_to: greatest(current?.gap_to, gapTo),
          members,
        })
      }
      cursorHistory.push({ name, attempted: ledger, stored: (cursors.get(name) as CursorRow).ledger as number })
      return []
    }
    if (/^insert into ingest_cursor \(name, reconcile\)/i.test(text)) {
      expect(text).toMatch(/where ingest_cursor\.reconcile is null or ingest_cursor\.reconcile->>'at' <= excluded\.reconcile->>'at'/i)
      const [name, json] = values as [string, string]
      const reconcile = JSON.parse(json) as { at: string; results: unknown[] }
      const current = cursors.get(name)
      if (!current?.reconcile || current.reconcile.at <= reconcile.at) cursors.set(name, { ...(current ?? { ledger: null, cursor: null, close_time: null }), reconcile })
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

/** A stored oracle cursor whose members are the manifest's oracle. */
const oracleCursor = (ledger: number, extra: Partial<CursorRow> = {}): Record<string, CursorRow> => ({
  [indexCursorName("oracle", "testnet")]: { ledger, cursor: null, close_time: null, members: [manifest.shared.oracle], ...extra },
})

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

  it("a market's creation ledger travels with each of its contracts", () => {
    const groups = contractsOf(manifest, [{ ...market, createdLedger: DEPLOY + 40 }])
    expect(groups.market.map((m) => m.createdLedger)).toEqual([DEPLOY + 40, DEPLOY + 40, DEPLOY + 40])
    expect(groups.escrow).toEqual([{ id: c.recoveryEscrow, role: "escrow", pool: c.pool, createdLedger: DEPLOY + 40 }])
  })

  it("on the Mainnet manifest: the oracle group holds its five oracles, from the manifest, not the markets listed", () => {
    const mainnet = parseManifest(mainnetJson)
    const groups = contractsOf(mainnet, mainnet.markets)
    expect(groups.oracle).toHaveLength(5)
    // The four v2 oracles carry their creation ledger (`createdLedgers`); MOCKUSDY's, the one that was not redeployed, none.
    expect(groups.oracle).toEqual(
      manifestOracles(mainnet).map((o) => {
        const createdLedger = mainnet.createdLedgers?.[o.oracle]
        return createdLedger === undefined ? { id: o.oracle, role: "oracle" } : { id: o.oracle, role: "oracle", createdLedger }
      }),
    )
    expect(groups.escrow).toHaveLength(5)
    expect(groups.market).toHaveLength(15)
    // The registry may list fewer markets (or none, on the seeds-only fallback): the oracle group is the manifest's.
    expect(contractsOf(mainnet, []).oracle).toEqual(groups.oracle)
    expect(contractsOf(mainnet, mainnet.markets.slice(0, 1)).oracle).toEqual(groups.oracle)
  })

  it("the manifest's shared oracle is a member even when no manifest market uses it", () => {
    const standalone = randomContract()
    const groups = contractsOf({ ...manifest, shared: { ...manifest.shared, oracle: standalone } }, [])
    expect(groups.oracle).toEqual([
      { id: standalone, role: "oracle" },
      { id: manifest.shared.oracle, role: "oracle" },
    ])
  })

  it("a member's creation ledger: the manifest's createdLedgers entry first, else its market's; a shared contract reads the entry only", () => {
    const m: Manifest = {
      ...manifest,
      createdLedgers: { [c.pool]: DEPLOY + 7, [c.recoveryEscrow]: DEPLOY + 8, [manifest.shared.oracle]: DEPLOY + 3, [manifest.shared.permissioning]: DEPLOY + 1 },
    }
    const built = contractsOf(m, [{ ...market, createdLedger: DEPLOY + 40 }])
    expect(built.market.map((x) => x.createdLedger)).toEqual([DEPLOY + 40, DEPLOY + 40, DEPLOY + 7])
    expect(built.escrow).toEqual([{ id: c.recoveryEscrow, role: "escrow", pool: c.pool, createdLedger: DEPLOY + 8 }])
    // The oracle is not its market's: the market's creation ledger never applies to it.
    expect(built.oracle).toEqual([{ id: manifest.shared.oracle, role: "oracle", createdLedger: DEPLOY + 3 }])
    expect(built.permissioning).toEqual([{ id: manifest.shared.permissioning, role: "permissioning", createdLedger: DEPLOY + 1 }])
    expect(built.risk).toEqual([{ id: manifest.shared.riskControl, role: "riskControl" }])
    // A market without a creation ledger of its own: the entries alone, and no key where there is none.
    const seed = contractsOf(m, [market])
    expect(seed.market).toEqual([
      { id: c.sy, role: "sy", pool: c.pool },
      { id: c.manager, role: "manager", pool: c.pool },
      { id: c.pool, role: "pool", pool: c.pool, createdLedger: DEPLOY + 7 },
    ])
    expect(contractsOf(m, [{ ...market, createdLedger: DEPLOY + 40 }]).oracle).toEqual(built.oracle)
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
    const db2 = makeDb()
    const r2 = await indexEvents(deps(db2.sql, outside.rpc), { deadline: FAR, groups: ["oracle"] })
    expect(outside.calls[0].startLedger).toBe(DEPLOY + 100)
    expect(groupOf(r2, "oracle")?.gap).toEqual({ from: DEPLOY, to: DEPLOY + 99 })
    // Stored with the cursor that passed it.
    expect(db2.cursors.get(indexCursorName("oracle", "testnet"))).toMatchObject({ ledger: DEPLOY + 150, gap_from: DEPLOY, gap_to: DEPLOY + 99 })

    // No deployLedger in the manifest (a local stack): from the oldest ledger, no gap claimed.
    const local = { ...manifest, deployLedger: undefined }
    const none = makeRpc({ events: [], oldest: 1_000, latest: 1_010 })
    const r3 = await indexEvents(deps(makeDb().sql, none.rpc, { manifest: local }), { deadline: FAR, groups: ["oracle"] })
    expect(none.calls[0].startLedger).toBe(1_000)
    expect(groupOf(r3, "oracle")?.gap).toBeNull()
  })

  it("a gap is stored by the save that passes it, widening an open one; a run that saves nothing stores none", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const db = makeDb({ cursors: oracleCursor(DEPLOY + 100, { gap_from: DEPLOY + 10, gap_to: DEPLOY + 20 }) })
    const name = indexCursorName("oracle", "testnet")
    // Cut before its first page: the cursor does not move, so the gap is not passed and not stored.
    const cut = makeRpc({ events: [], oldest: DEPLOY + 500, latest: DEPLOY + 700 })
    const r1 = await indexEvents(deps(db.sql, cut.rpc, { now: () => 1 }), { deadline: 0, groups: ["oracle"] })
    expect(groupOf(r1, "oracle")).toMatchObject({ complete: false, indexedThrough: DEPLOY + 100, gap: { from: DEPLOY + 101, to: DEPLOY + 499 } })
    expect(db.cursors.get(name)).toMatchObject({ ledger: DEPLOY + 100, gap_from: DEPLOY + 10, gap_to: DEPLOY + 20 })
    // The next run passes it: the open gap is widened to cover both.
    await indexEvents(deps(db.sql, cut.rpc), { deadline: FAR, groups: ["oracle"] })
    expect(db.cursors.get(name)).toMatchObject({ ledger: DEPLOY + 700, gap_from: DEPLOY + 10, gap_to: DEPLOY + 499 })
    // A later run with no gap keeps it.
    await indexEvents(deps(db.sql, makeRpc({ events: [], oldest: DEPLOY + 500, latest: DEPLOY + 710 }).rpc), { deadline: FAR, groups: ["oracle"] })
    expect(db.cursors.get(name)).toMatchObject({ ledger: DEPLOY + 710, gap_from: DEPLOY + 10, gap_to: DEPLOY + 499 })
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
    expect(db.cursors.get(indexCursorName("oracle", "testnet"))).toMatchObject({ ledger: DEPLOY + 20, close_time: iso(closeOf(DEPLOY + 20)), gap_from: null, gap_to: null })
    // Each cursor names the contracts it has read through its ledger.
    expect(db.cursors.get(indexCursorName("market", "testnet"))?.members).toEqual(sorted([c.sy, c.manager, c.pool]))
    expect(db.cursors.get(indexCursorName("escrow", "testnet"))?.members).toEqual([c.recoveryEscrow])
    expect(db.cursors.get(indexCursorName("risk", "testnet"))?.members).toEqual([manifest.shared.riskControl])
    expect(result.reconcile).toEqual([{ escrow: c.recoveryEscrow, recordCount: 1, indexed: 1, ok: true }])
    // The last reconcile is kept on the escrow cursor.
    const stored = db.cursors.get(indexCursorName("escrow", "testnet"))?.reconcile
    expect(stored?.results).toEqual(result.reconcile)
    expect(Date.parse(stored?.at as string)).toBeGreaterThan(Date.now() - 60_000)
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
    db.cursors.set(indexCursorName("oracle", "testnet"), { ledger: DEPLOY - 1, cursor: null, close_time: null, members: [manifest.shared.oracle] })
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
    const db = makeDb({ cursors: oracleCursor(DEPLOY + 100) })
    const result = await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(groupOf(result, "oracle")).toEqual({ group: "oracle", indexedThrough: DEPLOY + 700, gap: { from: DEPLOY + 101, to: DEPLOY + 499 }, complete: true })
    expect(calls[0].startLedger).toBe(DEPLOY + 500)
    expect([...db.events.keys()]).toEqual([kept.id])
    expect(warn.mock.calls.flat().join(" ")).toMatch(/gap/i)
    expect(db.cursors.get(indexCursorName("oracle", "testnet"))).toMatchObject({ ledger: DEPLOY + 700, gap_from: DEPLOY + 101, gap_to: DEPLOY + 499 })
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
    const db = makeDb({ cursors: oracleCursor(DEPLOY + 50) })
    const result = await indexEvents(deps(db.sql, rpc), { deadline: FAR, groups: ["oracle"] })
    expect(groupOf(result, "oracle")).toMatchObject({ gap: { from: DEPLOY + 51, to: DEPLOY + 299 }, complete: true, indexedThrough: DEPLOY + 400 })
    expect(base.calls.map((x) => x.startLedger)).toEqual([DEPLOY + 100, DEPLOY + 300])
    expect(db.cursors.get(indexCursorName("oracle", "testnet"))).toMatchObject({ gap_from: DEPLOY + 51, gap_to: DEPLOY + 299 })
  })

  it("a pool added later is backfilled from deployLedger", async () => {
    const second: Market = { ...market, marketId: "m2", contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract(), recoveryEscrow: randomContract() } }
    // The second market's first event is older than the cursor its group reaches without it.
    const early = ev(DEPLOY + 5, second.contracts.pool, "paused", xdr.ScVal.scvBool(true))
    const name = indexCursorName("market", "testnet")
    const db = makeDb()
    await indexEvents(deps(db.sql, makeRpc({ events: [early], oldest: DEPLOY, latest: DEPLOY + 50 }).rpc), { deadline: FAR, groups: ["market"] })
    expect(db.events.has(early.id)).toBe(false)
    expect(db.cursors.get(name)).toMatchObject({ ledger: DEPLOY + 50, members: sorted([c.sy, c.manager, c.pool]) })

    const later = makeRpc({ events: [early], oldest: DEPLOY, latest: DEPLOY + 60 })
    const result = await indexEvents(deps(db.sql, later.rpc, { markets: [market, second] }), { deadline: FAR, groups: ["market"] })
    expect(db.events.get(early.id)).toMatchObject({ pool: second.contracts.pool, data: { paused: true } })
    // The known contracts resume after the cursor; the new ones read from deployLedger in their own chunk.
    expect(later.calls.filter((x) => x.startLedger !== undefined)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ startLedger: DEPLOY + 51, contractIds: [c.sy, c.manager, c.pool] }),
        expect.objectContaining({ startLedger: DEPLOY, contractIds: [second.contracts.sy, second.contracts.manager, second.contracts.pool] }),
      ]),
    )
    expect(groupOf(result, "market")).toMatchObject({ complete: true, indexedThrough: DEPLOY + 60, gap: null })
    expect(db.cursors.get(name)).toMatchObject({
      ledger: DEPLOY + 60,
      members: sorted([c.sy, c.manager, c.pool, second.contracts.sy, second.contracts.manager, second.contracts.pool]),
    })
  })

  it("a market with no known creation ledger, added after deployLedger left the window, starts at the oldest ledger, and its gap is stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const second: Market = { ...market, marketId: "m2", contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract() } }
    const db = makeDb()
    await indexEvents(deps(db.sql, makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 50 }).rpc), { deadline: FAR, groups: ["market"] })
    const later = makeRpc({ events: [], oldest: DEPLOY + 30, latest: DEPLOY + 60 })
    const result = await indexEvents(deps(db.sql, later.rpc, { markets: [market, second] }), { deadline: FAR, groups: ["market"] })
    expect(later.calls.find((x) => x.contractIds.includes(second.contracts.pool))?.startLedger).toBe(DEPLOY + 30)
    expect(groupOf(result, "market")?.gap).toEqual({ from: DEPLOY, to: DEPLOY + 29 })
    expect(db.cursors.get(indexCursorName("market", "testnet"))).toMatchObject({ ledger: DEPLOY + 60, gap_from: DEPLOY, gap_to: DEPLOY + 29 })
  })

  it("a run that lists fewer markets (one marked invalid) does not advance cursors for the pools it did not read", async () => {
    const registry: Market = { ...market, marketId: "registry", contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract(), recoveryEscrow: randomContract() } }
    const reader = makeReader({ [c.recoveryEscrow]: 0n, [registry.contracts.recoveryEscrow]: 0n })
    // The registry market's pool emits while the registry cannot be read.
    const during = ev(DEPLOY + 30, registry.contracts.pool, "paused", xdr.ScVal.scvBool(true))
    const groups: IndexGroup[] = ["market", "escrow"]
    const db = makeDb()
    await indexEvents(deps(db.sql, makeRpc({ events: [during], oldest: DEPLOY, latest: DEPLOY + 20 }).rpc, { markets: [market, registry], reader }), { deadline: FAR, groups })
    expect(db.cursors.get(indexCursorName("escrow", "testnet"))?.members).toEqual(sorted([c.recoveryEscrow, registry.contracts.recoveryEscrow]))

    // The registry market is not in this run's list (the route never runs these groups on the seeds alone: runGroups).
    const fallback = makeRpc({ events: [during], oldest: DEPLOY, latest: DEPLOY + 40 })
    await indexEvents(deps(db.sql, fallback.rpc, { markets: [market], reader }), { deadline: FAR, groups })
    expect(fallback.calls.flatMap((x) => x.contractIds)).not.toContain(registry.contracts.pool)
    expect(db.events.has(during.id)).toBe(false)
    // The cursors moved for the contracts the run read, and no longer claim the registry market's.
    expect(db.cursors.get(indexCursorName("market", "testnet"))).toMatchObject({ ledger: DEPLOY + 40, members: sorted([c.sy, c.manager, c.pool]) })
    expect(db.cursors.get(indexCursorName("escrow", "testnet"))).toMatchObject({ ledger: DEPLOY + 40, members: [c.recoveryEscrow] })

    // Back in the list: its contracts are read again from deployLedger, so the event is not lost.
    const back = makeRpc({ events: [during], oldest: DEPLOY, latest: DEPLOY + 45 })
    await indexEvents(deps(db.sql, back.rpc, { markets: [market, registry], reader }), { deadline: FAR, groups })
    expect(db.events.has(during.id)).toBe(true)
    expect(back.calls.find((x) => x.contractIds.includes(registry.contracts.pool))?.startLedger).toBe(DEPLOY)
  })

  it("a market listed after deployLedger left the window, created inside it, starts at its creation ledger: no gap (I-1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const second: Market = { ...market, marketId: "m2", createdLedger: DEPLOY + 40, contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract(), recoveryEscrow: randomContract() } }
    const seeded = ev(DEPLOY + 45, second.contracts.pool, "paused", xdr.ScVal.scvBool(false))
    const recorded = recovery(DEPLOY + 50, 0n, second.contracts.recoveryEscrow)
    const groups: IndexGroup[] = ["market", "escrow"]
    const reader = makeReader({ [c.recoveryEscrow]: 0n, [second.contracts.recoveryEscrow]: 1n })
    const db = makeDb()
    await indexEvents(deps(db.sql, makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 35 }).rpc), { deadline: FAR, groups })
    // The RPC has dropped deployLedger since (the cursors are still inside its window); the new market was built at DEPLOY + 40.
    const later = makeRpc({ events: [seeded, recorded], oldest: DEPLOY + 30, latest: DEPLOY + 60 })
    const result = await indexEvents(deps(db.sql, later.rpc, { markets: [market, second], reader }), { deadline: FAR, groups })
    expect(later.calls.find((x) => x.contractIds.includes(second.contracts.pool))?.startLedger).toBe(DEPLOY + 40)
    expect(later.calls.find((x) => x.contractIds.includes(second.contracts.recoveryEscrow))?.startLedger).toBe(DEPLOY + 40)
    expect(groupOf(result, "market")).toMatchObject({ gap: null, complete: true, indexedThrough: DEPLOY + 60 })
    expect(groupOf(result, "escrow")).toMatchObject({ gap: null, complete: true, indexedThrough: DEPLOY + 60 })
    expect(db.events.has(seeded.id) && db.events.has(recorded.id)).toBe(true)
    for (const g of groups) expect(db.cursors.get(indexCursorName(g, "testnet"))).toMatchObject({ ledger: DEPLOY + 60, gap_from: null, gap_to: null })
    expect(db.cursors.get(indexCursorName("market", "testnet"))?.members).toEqual(
      sorted([c.sy, c.manager, c.pool, second.contracts.sy, second.contracts.manager, second.contracts.pool]),
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it("a creation ledger outside the window still records a real gap, from that ledger, not from deployLedger (I-1)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const second: Market = { ...market, marketId: "m2", createdLedger: DEPLOY + 10, contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract() } }
    const db = makeDb()
    await indexEvents(deps(db.sql, makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 50 }).rpc), { deadline: FAR, groups: ["market"] })
    const later = makeRpc({ events: [], oldest: DEPLOY + 30, latest: DEPLOY + 60 })
    const result = await indexEvents(deps(db.sql, later.rpc, { markets: [market, second] }), { deadline: FAR, groups: ["market"] })
    expect(later.calls.find((x) => x.contractIds.includes(second.contracts.pool))?.startLedger).toBe(DEPLOY + 30)
    expect(groupOf(result, "market")?.gap).toEqual({ from: DEPLOY + 10, to: DEPLOY + 29 })
    expect(db.cursors.get(indexCursorName("market", "testnet"))).toMatchObject({ ledger: DEPLOY + 60, gap_from: DEPLOY + 10, gap_to: DEPLOY + 29 })
  })

  it("a creation ledger before deployLedger changes nothing: the market starts at deployLedger", async () => {
    const second: Market = { ...market, marketId: "m2", createdLedger: DEPLOY - 100, contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract() } }
    const db = makeDb()
    await indexEvents(deps(db.sql, makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 50 }).rpc), { deadline: FAR, groups: ["market"] })
    const later = makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 60 })
    const result = await indexEvents(deps(db.sql, later.rpc, { markets: [market, second] }), { deadline: FAR, groups: ["market"] })
    expect(later.calls.find((x) => x.contractIds.includes(second.contracts.pool))?.startLedger).toBe(DEPLOY)
    expect(groupOf(result, "market")?.gap).toBeNull()
  })

  it("two new markets built at different ledgers each start at their own, in chunks of their own", async () => {
    const make = (id: string, createdLedger: number): Market => ({ ...market, marketId: id, createdLedger, contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract() } })
    const [a, b] = [make("a", DEPLOY + 35), make("b", DEPLOY + 55)]
    const db = makeDb()
    await indexEvents(deps(db.sql, makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 32 }).rpc), { deadline: FAR, groups: ["market"] })
    const later = makeRpc({ events: [], oldest: DEPLOY + 30, latest: DEPLOY + 60 })
    const result = await indexEvents(deps(db.sql, later.rpc, { markets: [market, a, b] }), { deadline: FAR, groups: ["market"] })
    const starts = later.calls.filter((x) => x.startLedger !== undefined)
    expect(starts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ startLedger: DEPLOY + 33, contractIds: [c.sy, c.manager, c.pool] }),
        expect.objectContaining({ startLedger: DEPLOY + 35, contractIds: [a.contracts.sy, a.contracts.manager, a.contracts.pool] }),
        expect.objectContaining({ startLedger: DEPLOY + 55, contractIds: [b.contracts.sy, b.contracts.manager, b.contracts.pool] }),
      ]),
    )
    expect(groupOf(result, "market")).toMatchObject({ gap: null, complete: true, indexedThrough: DEPLOY + 60 })
  })

  it("a seeds-fallback run, then a registry run: no gap, and the members are unchanged (I-1, runGroups)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const registry: Market = { ...market, marketId: "registry", contracts: { ...c, sy: randomContract(), manager: randomContract(), pool: randomContract(), recoveryEscrow: randomContract() } }
    const reader = makeReader({ [c.recoveryEscrow]: 0n, [registry.contracts.recoveryEscrow]: 0n })
    const during = ev(DEPLOY + 30, registry.contracts.pool, "paused", xdr.ScVal.scvBool(true))
    const marketCursor = indexCursorName("market", "testnet")
    const escrowCursor = indexCursorName("escrow", "testnet")
    const db = makeDb()
    // A registry run: every group, both markets.
    const all = runGroups(true)
    expect(all).toEqual({ groups: ["escrow", "oracle", "permissioning", "risk", "market"], skipped: null })
    await indexEvents(deps(db.sql, makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 28 }).rpc, { markets: [market, registry], reader }), { deadline: FAR, groups: all.groups })
    const before = { market: { ...db.cursors.get(marketCursor) }, escrow: { ...db.cursors.get(escrowCursor) } }
    expect(before.market.members).toEqual(sorted([c.sy, c.manager, c.pool, registry.contracts.sy, registry.contracts.manager, registry.contracts.pool]))

    // The registry read fails: the seeds alone. The market and escrow groups are left for the next run.
    const fallback = runGroups(false)
    expect(fallback.groups).toEqual(["oracle", "permissioning", "risk"])
    expect(fallback.skipped?.groups).toEqual(["escrow", "market"])
    const seedsOnly = makeRpc({ events: [during], oldest: DEPLOY, latest: DEPLOY + 40 })
    const skippedRun = await indexEvents(deps(db.sql, seedsOnly.rpc, { markets: [market], reader }), { deadline: FAR, groups: fallback.groups })
    expect(skippedRun.groups.map((g) => g.group)).toEqual(["oracle", "permissioning", "risk"])
    expect(skippedRun.reconcile).toEqual([])
    expect(seedsOnly.calls.flatMap((x) => x.contractIds)).not.toContain(c.pool)
    expect(db.cursors.get(marketCursor)).toEqual(before.market)
    expect(db.cursors.get(escrowCursor)).toEqual(before.escrow)

    // The registry is back, and the RPC has dropped deployLedger meanwhile: nothing was ever dropped, so no gap.
    const back = makeRpc({ events: [during], oldest: DEPLOY + 25, latest: DEPLOY + 45 })
    const result = await indexEvents(deps(db.sql, back.rpc, { markets: [market, registry], reader }), { deadline: FAR, groups: all.groups })
    for (const g of ["market", "escrow"] as const) expect(groupOf(result, g)).toMatchObject({ gap: null, complete: true, indexedThrough: DEPLOY + 45 })
    expect(db.cursors.get(marketCursor)).toMatchObject({ ledger: DEPLOY + 45, gap_from: null, gap_to: null, members: before.market.members })
    expect(db.cursors.get(escrowCursor)).toMatchObject({ ledger: DEPLOY + 45, gap_from: null, gap_to: null, members: before.escrow.members })
    // The registry market resumed with the others, after the cursor: its event during the fallback is indexed.
    expect(back.calls.find((x) => x.contractIds.includes(registry.contracts.pool))?.startLedger).toBe(DEPLOY + 29)
    expect(db.events.has(during.id)).toBe(true)
  })

  it("a manifest switch indexes the new shared contracts from deployLedger", async () => {
    const db = makeDb()
    const name = indexCursorName("oracle", "testnet")
    await indexEvents(deps(db.sql, makeRpc({ events: [], oldest: DEPLOY, latest: DEPLOY + 500 }).rpc), { deadline: FAR, groups: ["oracle"] })
    expect(db.cursors.get(name)).toMatchObject({ ledger: DEPLOY + 500, members: [manifest.shared.oracle] })

    // A new deployment on the same network: a new oracle, deployed at DEPLOY + 200, before the cursor.
    const newOracle = randomContract()
    const switched: Manifest = {
      ...manifest,
      deployLedger: DEPLOY + 200,
      shared: { ...manifest.shared, oracle: newOracle },
      markets: manifest.markets.map((m) => ({ ...m, contracts: { ...m.contracts, oracle: newOracle } })),
    }
    const first = ev(DEPLOY + 210, newOracle, "ref_set", xdr.ScVal.scvVec([i128(10_000_000n), u64(1n)]))
    const rpc = makeRpc({ events: [first], oldest: DEPLOY, latest: DEPLOY + 520 })
    const result = await indexEvents(deps(db.sql, rpc.rpc, { manifest: switched }), { deadline: FAR, groups: ["oracle"] })
    expect(rpc.calls[0]).toMatchObject({ startLedger: DEPLOY + 200, contractIds: [newOracle] })
    expect(db.events.get(first.id)).toMatchObject({ contract_id: newOracle, topic: "ref_set" })
    expect(groupOf(result, "oracle")).toMatchObject({ complete: true, indexedThrough: DEPLOY + 520 })
    expect(db.cursors.get(name)).toMatchObject({ ledger: DEPLOY + 520, members: [newOracle] })
  })

  /** The testnet manifest after a swap: oracles A (the manifest's) and B, deployed at ledger 100. */
  const swappedManifest = (b: string, createdLedgers?: Record<string, number>): Manifest => ({
    ...manifest,
    deployLedger: 100,
    ...(createdLedgers ? { createdLedgers } : {}),
    markets: [market, { ...market, marketId: "testnet-b", contracts: { ...c, oracle: b } }],
  })

  it("a swapped manifest starts new members at their created ledger", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const A = manifest.shared.oracle
    const B = randomContract()
    const swapped = swappedManifest(B, { [B]: 900 })
    const name = indexCursorName("oracle", "testnet")
    // The saved cursor's members are oracle A, inside the RPC's window (oldest 500).
    const db = makeDb({ cursors: oracleCursor(1_000) })
    const firstOfB = ev(950, B, "ref_set", xdr.ScVal.scvVec([i128(10_000_000n), u64(1n)]))
    const { rpc, calls } = makeRpc({ events: [firstOfB], oldest: 500, latest: 1_100 })
    // The markets listed do not matter: the oracle group is the manifest's.
    const result = await indexEvents(deps(db.sql, rpc, { manifest: swapped, markets: [] }), { deadline: FAR, groups: ["oracle"] })
    expect(calls.find((x) => x.contractIds.includes(B))).toMatchObject({ startLedger: 900, contractIds: [B] })
    expect(calls.find((x) => x.contractIds.includes(A))).toMatchObject({ startLedger: 1_001, contractIds: [A] })
    expect(groupOf(result, "oracle")).toEqual({ group: "oracle", indexedThrough: 1_100, gap: null, complete: true })
    expect(db.cursors.get(name)).toMatchObject({ ledger: 1_100, gap_from: null, gap_to: null, members: sorted([A, B]) })
    expect(db.events.get(firstOfB.id)).toMatchObject({ contract_id: B, group_name: "oracle", topic: "ref_set" })
    expect(warn).not.toHaveBeenCalled()
  })

  it("a swapped manifest without a createdLedgers entry starts the new member at deployLedger and records the gap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const B = randomContract()
    const db = makeDb({ cursors: oracleCursor(1_000) })
    const { rpc, calls } = makeRpc({ events: [], oldest: 500, latest: 1_100 })
    const result = await indexEvents(deps(db.sql, rpc, { manifest: swappedManifest(B), markets: [] }), { deadline: FAR, groups: ["oracle"] })
    // It wanted deployLedger (100); the RPC holds 500 onwards.
    expect(calls.find((x) => x.contractIds.includes(B))).toMatchObject({ startLedger: 500, contractIds: [B] })
    expect(groupOf(result, "oracle")).toEqual({ group: "oracle", indexedThrough: 1_100, gap: { from: 100, to: 499 }, complete: true })
    expect(db.cursors.get(indexCursorName("oracle", "testnet"))).toMatchObject({ ledger: 1_100, gap_from: 100, gap_to: 499 })
    expect(warn.mock.calls.flat().join(" ")).toMatch(/gap/i)
  })

  it("five oracles, one created later: a request of four from deployLedger, one of its own from its creation ledger", async () => {
    // The committed manifest's own `createdLedgers` (the v2 oracles) are set aside: this case sets its own.
    const mainnet: Manifest = { ...parseManifest(mainnetJson), createdLedgers: undefined }
    const start = mainnet.deployLedger as number
    const oracles = manifestOracles(mainnet).map((o) => o.oracle)
    const late = oracles[3]
    const m: Manifest = { ...mainnet, createdLedgers: { [late]: start + 40 } }
    const early = ev(start + 2, oracles[0], "ref_set", xdr.ScVal.scvVec([i128(1n), u64(1n)]))
    const fromLate = ev(start + 45, late, "ref_set", xdr.ScVal.scvVec([i128(2n), u64(2n)]))
    const { rpc, calls } = makeRpc({ events: [early, fromLate], oldest: start, latest: start + 60 })
    const db = makeDb()
    const result = await indexEvents(deps(db.sql, rpc, { manifest: m, markets: m.markets }), { deadline: FAR, groups: ["oracle"] })
    expect(calls.every((x) => x.contractIds.length <= 5)).toBe(true)
    expect(calls.filter((x) => x.startLedger !== undefined)).toEqual([
      expect.objectContaining({ startLedger: start, contractIds: oracles.filter((o) => o !== late) }),
      expect.objectContaining({ startLedger: start + 40, contractIds: [late] }),
    ])
    expect(groupOf(result, "oracle")).toEqual({ group: "oracle", indexedThrough: start + 60, gap: null, complete: true })
    expect(db.cursors.get(indexCursorName("oracle", "mainnet"))).toMatchObject({ ledger: start + 60, gap_from: null, gap_to: null, members: sorted(oracles) })
    expect(db.events.has(early.id) && db.events.has(fromLate.id)).toBe(true)

    // Without the entry, the five start together: one request.
    const together = makeRpc({ events: [], oldest: start, latest: start + 60 })
    await indexEvents(deps(makeDb().sql, together.rpc, { manifest: mainnet, markets: mainnet.markets }), { deadline: FAR, groups: ["oracle"] })
    expect(together.calls).toEqual([expect.objectContaining({ startLedger: start, contractIds: oracles })])
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
    const db = makeDb({ cursors: oracleCursor(DEPLOY + 10) })
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

  type ReadCursor = { name: string; ledger: string; close_time: Date | null; gap_from?: string | null; gap_to?: string | null; reconcile?: unknown }
  function readDb(cursors: ReadCursor[]) {
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

  const allCursors = (ledger: number, closeTime: Date | null): ReadCursor[] =>
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
      // The close time of that ledger: a client recomputes the lag from it, whatever the cache's age.
      indexedThroughCloseTime: iso(closeOf(tip)),
      lagSeconds: 42,
      gaps: [],
      pendingGroups: [],
      reconcile: null,
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
    expect(all.indexedThroughCloseTime).toBe(iso(closeOf(DEPLOY + 5)))
    expect(all.lagSeconds).toBe(100)
    const params = db.values[db.texts.findIndex((t) => t.includes("from events"))]
    expect(params).toEqual(expect.arrayContaining(["testnet", c.pool, before, 10]))
    const one = await getIndexedEvents(db.sql, { network: "testnet", group: "escrow", limit: 10, now: closeOf(DEPLOY + 25) * 1000 })
    expect(one.indexedThrough).toBe(DEPLOY + 20)
  })

  it("a group never indexed: indexedThrough 0, lag unknown, and the groups no run has indexed are named", async () => {
    const db = readDb([])
    expect(await getIndexedEvents(db.sql, { network: "testnet", limit: 1 })).toMatchObject({
      indexedThrough: 0,
      indexedThroughCloseTime: null,
      lagSeconds: null,
      pendingGroups: ["escrow", "oracle", "permissioning", "risk", "market"],
    })
    // Only market and escrow have no cursor (no market listed yet): those two are pending.
    const shared = readDb(allCursors(DEPLOY + 20, new Date(closeOf(DEPLOY + 20) * 1000)).filter((x) => !/:(market|escrow):/.test(x.name)))
    expect((await getIndexedEvents(shared.sql, { network: "testnet", limit: 1 })).pendingGroups).toEqual(["escrow", "market"])
    expect((await getIndexedEvents(shared.sql, { network: "testnet", group: "oracle", limit: 1 })).pendingGroups).toEqual([])
  })

  it("returns the stored gaps of the groups asked, and the last reconcile", async () => {
    const cursors = allCursors(DEPLOY + 20, new Date(closeOf(DEPLOY + 20) * 1000))
    const reconcile = { at: "2026-11-14T02:00:00.000Z", results: [{ escrow: c.recoveryEscrow, recordCount: 2, indexed: 1, ok: false }] }
    cursors[0] = { ...cursors[0], gap_from: String(DEPLOY), gap_to: String(DEPLOY + 9), reconcile }
    cursors[4] = { ...cursors[4], gap_from: String(DEPLOY + 3), gap_to: String(DEPLOY + 4) }
    const db = readDb(cursors)
    const all = await getIndexedEvents(db.sql, { network: "testnet", limit: 10 })
    expect(all.gaps).toEqual([
      { group: "escrow", from: DEPLOY, to: DEPLOY + 9 },
      { group: "market", from: DEPLOY + 3, to: DEPLOY + 4 },
    ])
    expect(all.reconcile).toEqual(reconcile)
    const oracle = await getIndexedEvents(db.sql, { network: "testnet", group: "oracle", limit: 10 })
    expect(oracle.gaps).toEqual([])
    // The reconcile is the escrow cursor's, whatever the group asked.
    expect(oracle.reconcile).toEqual(reconcile)
  })

  it("one event by id carries its raw xdr", async () => {
    const db = readDb([])
    expect(await getIndexedEvent(db.sql, { network: "testnet", id: row.id })).toMatchObject({ id: row.id, group: "escrow", rawXdr: "AAAA" })
  })

  it("filters by topics in the query, so a page holds only those topics; no topic filter passes null", async () => {
    const db = readDb(allCursors(DEPLOY + 20, null))
    await getIndexedEvents(db.sql, { network: "testnet", group: "risk", topics: ["cb_limit", "ast_limit", "cb_window"], limit: 20 })
    const i = db.texts.findIndex((t) => t.includes("from events"))
    expect(db.texts[i]).toMatch(/topic = any\(\?::text\[\]\)/)
    expect(db.values[i]).toContainEqual(["cb_limit", "ast_limit", "cb_window"])
    const plain = readDb(allCursors(DEPLOY + 20, null))
    await getIndexedEvents(plain.sql, { network: "testnet", group: "risk", limit: 20 })
    const j = plain.texts.findIndex((t) => t.includes("from events"))
    expect(plain.values[j]).not.toContainEqual(expect.any(Array))
  })

  it("filters by contract in the query (one oracle's history); no contract filter passes null", async () => {
    const oracle = manifest.shared.oracle
    const db = readDb(allCursors(DEPLOY + 20, null))
    await getIndexedEvents(db.sql, { network: "testnet", group: "oracle", contract: oracle, topics: ["ref_set"], limit: 20 })
    const i = db.texts.findIndex((t) => t.includes("from events"))
    expect(db.texts[i]).toMatch(/\(\?::text is null or contract_id = \?\)/)
    expect(db.values[i]).toEqual(expect.arrayContaining(["testnet", "oracle", oracle, ["ref_set"], 20]))
    expect(db.texts[i]).not.toContain(oracle)
    const plain = readDb(allCursors(DEPLOY + 20, null))
    await getIndexedEvents(plain.sql, { network: "testnet", group: "oracle", limit: 20 })
    const j = plain.texts.findIndex((t) => t.includes("from events"))
    expect(plain.texts[j]).toMatch(/contract_id = \?/)
    expect(plain.values[j]).not.toContain(oracle)
  })

  it("counts every indexed event per topic for the group and pool asked, not only one page", async () => {
    const db = readDb([])
    const inner = db.sql
    const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const text = strings.join("?").replace(/\s+/g, " ").trim()
      if (text.includes("group by topic")) {
        db.texts.push(text)
        db.values.push(v)
        return [
          { topic: "acc_grant", n: "37" },
          { topic: "ast_grant", n: 68 },
        ]
      }
      return (inner as unknown as (s: TemplateStringsArray, ...x: unknown[]) => Promise<unknown>)(strings, ...v)
    }) as unknown as Sql
    expect(await getEventCounts(sql, { network: "testnet", group: "permissioning" })).toEqual({ acc_grant: 37, ast_grant: 68 })
    const i = db.texts.findIndex((t) => t.includes("group by topic"))
    expect(db.texts[i]).toMatch(/count\(\*\)/)
    expect(db.texts[i]).not.toMatch(/limit/)
    expect(db.values[i]).toEqual(expect.arrayContaining(["testnet", "permissioning"]))
    // One contract's counts: filtered in the query too.
    const oracle = manifest.shared.oracle
    await getEventCounts(sql, { network: "testnet", group: "oracle", contract: oracle })
    const j = db.texts.length - 1
    expect(db.texts[j]).toMatch(/\(\?::text is null or contract_id = \?\)/)
    expect(db.values[j]).toEqual(expect.arrayContaining(["testnet", "oracle", oracle]))
  })
})
