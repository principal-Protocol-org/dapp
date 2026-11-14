import "server-only"

/**
 * The event indexer (spec 0004 D-13 to D-15): the protocol's contract events, read from the RPC's
 * `getEvents` into the `events` table, one row per RPC event id. It runs on the registry's
 * `discover()` pattern: pages of 200, the place saved after every page in `ingest_cursor`
 * (`events:<group>:<network>`), a deadline checked before every page, and a gap recorded when the
 * place is older than the RPC's window.
 *
 * Contracts are indexed in five groups, each with its own cursor: `market` (every market's SY,
 * manager and pool), `escrow` (every market's RecoveryEscrow), and the shared `oracle`,
 * `permissioning` and `risk` (RiskControl). The RPC takes at most 5 contract ids per request, so a
 * larger group is read in chunks, page by page in turn; the group's cursor is the ledger every chunk
 * has read through.
 *
 * A run resumes at the ledger after its cursor, never at a stored RPC paging cursor: re-reading a
 * ledger is harmless (the RPC event id is the key, inserted once), and a cursor only moves forward
 * (the upsert refuses an older ledger), so two overlapping runs (a scheduler retry over a slow run)
 * write no duplicate and never rewind it. `pnpm indexer:reindex` is the one write that moves it back.
 *
 * Each row keeps the event's value as the RPC sent it, base64 XDR of the `ScVal` (`raw_xdr`), and
 * the fields decoded for the emitting contract's role (`decodeEvent`): bigints as decimal strings,
 * bytes as hex. An unknown topic is kept with `data = {}`. Every indexed contract publishes a single
 * symbol topic, kept in `topic`.
 */
import { scValToNative, type xdr } from "@stellar/stellar-sdk"
import { bytesToHex } from "@/lib/protocol/bytes"
import { cursorLedger, decodeEvent, idOf, type RawEvent, type Role } from "@/lib/protocol/events"
import { createRpcReader, type ContractReader } from "@/lib/protocol/reader"
import type { Manifest, Market, Network } from "@/lib/protocol/types"
import { DatabaseConfigError, type Sql } from "./db"

// ---------------------------------------------------------------- groups

export type IndexGroup = "escrow" | "oracle" | "permissioning" | "risk" | "market"

export const INDEX_GROUPS: readonly IndexGroup[] = ["escrow", "oracle", "permissioning", "risk", "market"]

/** One indexed contract: the role its events are decoded for, and its market's pool when it has one. */
export type IndexMember = { id: string; role: Role; pool?: string }

/** Events per `getEvents` page. */
export const EVENTS_PAGE = 200
/** The RPC accepts at most 5 contract ids per request (checked 2026-10-27). */
export const MAX_CONTRACTS_PER_REQUEST = 5

/** The cursor row of one group on one network. */
export const indexCursorName = (group: IndexGroup, network: Network) => `events:${group}:${network}`

/** The contracts of each group, each listed once. */
export function contractsOf(manifest: Manifest, markets: Market[]): Record<IndexGroup, IndexMember[]> {
  const groups: Record<IndexGroup, IndexMember[]> = { escrow: [], oracle: [], permissioning: [], risk: [], market: [] }
  const add = (group: IndexGroup, member: IndexMember) => {
    if (!groups[group].some((m) => m.id === member.id)) groups[group].push(member)
  }
  for (const market of markets) {
    const k = market.contracts
    add("market", { id: k.sy, role: "sy", pool: k.pool })
    add("market", { id: k.manager, role: "manager", pool: k.pool })
    add("market", { id: k.pool, role: "pool", pool: k.pool })
    add("escrow", { id: k.recoveryEscrow, role: "escrow", pool: k.pool })
  }
  add("oracle", { id: manifest.shared.oracle, role: "oracle" })
  add("permissioning", { id: manifest.shared.permissioning, role: "permissioning" })
  add("risk", { id: manifest.shared.riskControl, role: "riskControl" })
  return groups
}

// ---------------------------------------------------------------- types

type EventFilter = { type: "contract"; contractIds: string[] }
export type IndexerEventsRequest =
  | { filters: EventFilter[]; limit: number; startLedger: number; cursor?: never }
  | { filters: EventFilter[]; limit: number; cursor: string; startLedger?: never }

/**
 * The RPC calls the indexer makes; the SDK's `rpc.Server` (SDK 17) satisfies it, tests inject a
 * fake. `getEvents` answers each event's `ledgerClosedAt`; `getLedgers` is asked only for an event
 * without one.
 */
export type IndexerRpc = {
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>
  getEvents(req: IndexerEventsRequest): Promise<{ events: RawEvent[]; cursor: string; latestLedger?: number; latestLedgerCloseTime?: string }>
  getLedgers?(req: { startLedger: number; pagination: { limit: number } }): Promise<{ ledgers: { sequence: number; ledgerCloseTime: string | number }[] }>
}

export type IndexDeps = {
  sql: Sql
  rpc: IndexerRpc
  manifest: Manifest
  markets: Market[]
  /** Wall clock (ms) for the deadline; `Date.now` by default. */
  now?: () => number
  /** Reads `record_count` for the reconciliation; `createRpcReader(manifest)` by default. */
  reader?: ContractReader
}

/** Ledgers the RPC no longer holds, so their events are missing from the index (inclusive). */
export type IndexGap = { from: number; to: number }

export type GroupResult = {
  group: IndexGroup
  /** Every event of the group up to and including this ledger is indexed. */
  indexedThrough: number
  gap: IndexGap | null
  /** False when the run stopped at its deadline or failed; the next run resumes at the cursor. */
  complete: boolean
  /** Set when the group failed this run (the RPC failed): the server log has the error's name. */
  error?: "failed"
}

/** RecoveryEscrow `record_count` against the indexed `recovery` events (D-15). */
export type Reconcile = {
  escrow: string
  /** Null when `record_count` could not be read. */
  recordCount: number | null
  indexed: number
  ok: boolean
}

export type IndexResult = { inserted: number; groups: GroupResult[]; reconcile: Reconcile[] }

// ---------------------------------------------------------------- the cursor

type SavedCursor = { ledger: number; cursor: string | null; closeTime: string | null }

async function readCursor(sql: Sql, name: string): Promise<SavedCursor | null> {
  const [row] = await sql<{ ledger: string | number | null; cursor: string | null; close_time: Date | string | null }>`
    select ledger, cursor, close_time from ingest_cursor where name = ${name}`
  if (!row || row.ledger === null) return null
  return { ledger: Number(row.ledger), cursor: row.cursor, closeTime: row.close_time === null ? null : new Date(row.close_time).toISOString() }
}

/**
 * Moves the cursor forward to `ledger`; an older or equal ledger changes nothing, so a run that is
 * behind never rewinds one that is ahead. `closeTime` (the close time of `ledger`, when known)
 * keeps the stored one otherwise.
 */
async function saveCursor(sql: Sql, name: string, ledger: number, cursor: string | null, closeTime: string | null): Promise<void> {
  await sql`
    insert into ingest_cursor (name, ledger, cursor, close_time) values (${name}, ${ledger}, ${cursor}, ${closeTime})
    on conflict (name) do update set
      ledger = excluded.ledger,
      cursor = excluded.cursor,
      close_time = coalesce(excluded.close_time, ingest_cursor.close_time)
    where ingest_cursor.ledger is null or excluded.ledger > ingest_cursor.ledger`
}

// ---------------------------------------------------------------- rows

/** JSON for the `data` column: bigints as decimal strings, bytes as hex, the rest as is. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Uint8Array) return bytesToHex(value)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]))
  return value
}

function native(value: xdr.ScVal | undefined): unknown {
  try {
    return value === undefined ? undefined : scValToNative(value)
  } catch {
    return undefined
  }
}

/** A close time as ISO 8601, from ISO text or unix seconds; null when unreadable. */
function isoTime(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null
  const ms = typeof value === "number" || /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

type EventRowOut = {
  id: string
  network: Network
  contract_id: string
  group_name: IndexGroup
  topic: string
  ledger: number
  close_time: string
  tx_hash: string
  pool: string | null
  data: unknown
  raw_xdr: string
}

// ---------------------------------------------------------------- one group

/** The RPC's end-of-scan cursor (event index 2^32 - 1): every event through its ledger was read. */
const END_OF_SCAN = "-4294967295"
/** A start refused because the RPC's oldest ledger moved is asked again this many times. */
const START_ATTEMPTS = 3

type Ctx = {
  sql: Sql
  rpc: IndexerRpc
  manifest: Manifest
  late: () => boolean
  pageSize: number
}

/** What a group run has done so far; read back when it fails part way. */
type Progress = { inserted: number; saved: number | null; gap: IndexGap | null }

type Chunk = { ids: string[]; cursor: string | null; through: number; done: boolean }

async function indexGroup(
  ctx: Ctx,
  group: IndexGroup,
  members: IndexMember[],
  saved: SavedCursor | null,
  health: { oldestLedger: number; latestLedger: number },
  progress: Progress,
): Promise<GroupResult> {
  const { sql, rpc, manifest } = ctx
  const network = manifest.network
  const name = indexCursorName(group, network)
  const byId = new Map(members.map((m) => [m.id, m]))

  // Where this group wants to start: after its cursor, or at the deploy on a first run (a manifest
  // without `deployLedger`, the local stack, starts at the RPC's oldest ledger and claims no gap).
  const wanted = saved ? saved.ledger + 1 : (manifest.deployLedger ?? health.oldestLedger)
  let start = Math.max(wanted, health.oldestLedger)
  const recordGap = (oldest: number) => {
    if (wanted >= start) return
    progress.gap = { from: wanted, to: start - 1 }
    console.warn(
      `indexer: gap: ${group} (${network}) ledgers ${wanted}-${start - 1} are older than the RPC's oldest ledger ${oldest}; ` +
        "indexing from there. Their events are missing until a capture is imported (pnpm indexer:import).",
    )
  }
  recordGap(health.oldestLedger)
  const result = (complete: boolean): GroupResult => ({
    group,
    indexedThrough: progress.saved ?? saved?.ledger ?? start - 1,
    gap: progress.gap,
    complete,
  })
  if (start > health.latestLedger) return result(true)

  const chunks: Chunk[] = []
  for (let i = 0; i < members.length; i += MAX_CONTRACTS_PER_REQUEST) {
    chunks.push({ ids: members.slice(i, i + MAX_CONTRACTS_PER_REQUEST).map((m) => m.id), cursor: null, through: start - 1, done: false })
  }
  /** Close times known this run, by ledger: each event's, and the tip's from each page. */
  const closeTimes = new Map<number, string>()
  const closeTimeAt = (ledger: number): string | null => {
    let best = -1
    for (const l of closeTimes.keys()) if (l <= ledger && l > best) best = l
    return best === -1 ? null : (closeTimes.get(best) as string)
  }

  const fetchPage = async (chunk: Chunk) => {
    const filters = [{ type: "contract" as const, contractIds: chunk.ids }]
    if (chunk.cursor !== null) return rpc.getEvents({ cursor: chunk.cursor, filters, limit: ctx.pageSize })
    for (let attempt = 1; ; attempt++) {
      const from = Math.max(start, chunk.through + 1)
      try {
        return await rpc.getEvents({ startLedger: from, filters, limit: ctx.pageSize })
      } catch (error) {
        // The RPC drops its oldest ledger as new ones close: a start read from `getHealth` a moment
        // ago may be refused. Start again at its new oldest ledger, which widens the gap.
        if (attempt === START_ATTEMPTS) throw error
        const now = await rpc.getHealth()
        if (now.oldestLedger <= from) throw error
        start = now.oldestLedger
        recordGap(now.oldestLedger)
        for (const c of chunks) c.through = Math.max(c.through, start - 1)
      }
    }
  }

  const store = async (events: RawEvent[]): Promise<number> => {
    const rows: EventRowOut[] = []
    for (const e of events) {
      if (e.inSuccessfulContractCall === false) continue
      const contract = idOf(e.contractId)
      const member = contract ? byId.get(contract) : undefined
      if (!contract || !member) continue
      const symbol = native(e.topic[0])
      const topic = typeof symbol === "string" ? symbol : "?"
      const value = native(e.value)
      const decoded = typeof symbol === "string" && value !== undefined ? decodeEvent(member.role, symbol, value) : null
      const closeTime = await closeTimeOf(e)
      closeTimes.set(e.ledger, closeTime)
      rows.push({
        id: e.id,
        network,
        contract_id: contract,
        group_name: group,
        topic,
        ledger: e.ledger,
        close_time: closeTime,
        tx_hash: e.txHash,
        pool: member.pool ?? null,
        data: decoded ? jsonSafe(decoded.fields) : {},
        raw_xdr: e.value.toXDR("base64"),
      })
    }
    if (rows.length === 0) return 0
    const inserted = await sql<{ id: string }>`
      insert into events (id, network, contract_id, group_name, topic, ledger, close_time, tx_hash, pool, data, raw_xdr)
      select id, network, contract_id, group_name, topic, ledger, close_time, tx_hash, pool, data, raw_xdr
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as r(
        id text, network text, contract_id text, group_name text, topic text, ledger integer,
        close_time timestamptz, tx_hash text, pool text, data jsonb, raw_xdr text)
      on conflict (id) do nothing returning id`
    return inserted.length
  }

  const ledgerCloseTimes = new Map<number, string>()
  const closeTimeOf = async (e: RawEvent): Promise<string> => {
    const fromEvent = isoTime(e.ledgerClosedAt)
    if (fromEvent) return fromEvent
    const known = ledgerCloseTimes.get(e.ledger)
    if (known) return known
    if (!rpc.getLedgers) throw new Error(`no close time for ledger ${e.ledger}`)
    const page = await rpc.getLedgers({ startLedger: e.ledger, pagination: { limit: 1 } })
    const found = isoTime(page.ledgers.find((l) => l.sequence === e.ledger)?.ledgerCloseTime)
    if (!found) throw new Error(`ledger ${e.ledger} not found on the RPC node`)
    ledgerCloseTimes.set(e.ledger, found)
    return found
  }

  while (chunks.some((c) => !c.done)) {
    for (const chunk of chunks) {
      if (chunk.done) continue
      if (ctx.late()) return result(false)
      const res = await fetchPage(chunk)
      const latest = res.latestLedger ?? health.latestLedger
      const tipTime = isoTime(res.latestLedgerCloseTime)
      if (tipTime) closeTimes.set(latest, tipTime)
      progress.inserted += await store(res.events)

      // How far this page read: a full page stops at its last event, whose ledger may hold more
      // events (so through the ledger before it); a short one ends at the end of its scan.
      const full = res.events.length >= ctx.pageSize
      const at = cursorLedger(res.cursor)
      const readable = Number.isFinite(at)
      if (readable) {
        const reached = full || !res.cursor.endsWith(END_OF_SCAN) ? at - 1 : at
        chunk.through = Math.max(chunk.through, Math.min(reached, latest))
      }
      const stalled = res.cursor === chunk.cursor
      chunk.cursor = res.cursor
      if (!full && (chunk.through >= latest || stalled || !readable)) chunk.done = true

      const through = Math.min(...chunks.map((c) => c.through))
      if (progress.saved === null ? through > (saved?.ledger ?? -1) : through > progress.saved) {
        await saveCursor(sql, name, through, chunks.length === 1 ? res.cursor : null, closeTimeAt(through))
        progress.saved = through
      }
    }
  }
  return result(true)
}

// ---------------------------------------------------------------- reconciliation

async function reconcile(sql: Sql, reader: ContractReader, network: Network, markets: Market[]): Promise<Reconcile[]> {
  const escrows = [...new Set(markets.map((m) => m.contracts.recoveryEscrow))]
  const out: Reconcile[] = []
  for (const escrow of escrows) {
    const [row] = await sql<{ n: number | string }>`
      select count(*)::int as n from events where network = ${network} and contract_id = ${escrow} and topic = 'recovery'`
    const indexed = Number(row?.n ?? 0)
    let recordCount: number | null = null
    try {
      const { value } = await reader<unknown>({ contractId: escrow, functionName: "record_count" })
      if (typeof value === "bigint" || typeof value === "number") recordCount = Number(value)
    } catch (error) {
      console.error(`indexer: record_count of ${escrow} could not be read (${error instanceof Error ? error.name : "unknown"})`)
    }
    out.push({ escrow, recordCount, indexed, ok: recordCount === indexed })
  }
  return out
}

// ---------------------------------------------------------------- the run

/**
 * Indexes every group (or `opts.groups`) from its cursor towards the RPC's latest ledger, the groups
 * side by side, until `opts.deadline` (ms): no page starts after it. A group the RPC fails is
 * reported (`error: "failed"`, its name logged, never the RPC's text) and the others go on; a
 * missing database rejects (`DatabaseConfigError`). When the escrow group completes, each escrow's
 * `record_count` is compared with its indexed `recovery` events.
 */
export async function indexEvents(
  deps: IndexDeps,
  opts: { deadline: number; groups?: IndexGroup[]; /** Test hook: events per page. */ pageSize?: number },
): Promise<IndexResult> {
  const { sql, rpc, manifest, markets } = deps
  const network = manifest.network
  const groups = opts.groups ?? INDEX_GROUPS
  const members = contractsOf(manifest, markets)
  const now = deps.now ?? Date.now
  const ctx: Ctx = { sql, rpc, manifest, late: () => now() >= opts.deadline, pageSize: opts.pageSize ?? EVENTS_PAGE }

  // The cursors first: a missing database is reported as such, whatever the RPC does.
  const saved = await Promise.all(groups.map((g) => readCursor(sql, indexCursorName(g, network))))
  const health = await rpc.getHealth()

  const progress: Progress[] = groups.map(() => ({ inserted: 0, saved: null, gap: null }))
  const results = await Promise.all(
    groups.map(async (group, i): Promise<GroupResult> => {
      try {
        return await indexGroup(ctx, group, members[group], saved[i], health, progress[i])
      } catch (error) {
        if (error instanceof DatabaseConfigError) throw error
        console.error(`indexer: ${group} (${network}) failed (${error instanceof Error ? error.name : "unknown"}); the next run resumes at its cursor`)
        const p = progress[i]
        return { group, indexedThrough: p.saved ?? saved[i]?.ledger ?? 0, gap: p.gap, complete: false, error: "failed" }
      }
    }),
  )

  const escrow = results.find((r) => r.group === "escrow")
  const reconciled =
    escrow?.complete && !ctx.late() ? await reconcile(sql, deps.reader ?? createRpcReader(manifest), network, markets) : []
  return { inserted: progress.reduce((n, p) => n + p.inserted, 0), groups: results, reconcile: reconciled }
}

// ---------------------------------------------------------------- reading the index

export type IndexedEvent = {
  id: string
  group: IndexGroup
  contractId: string
  topic: string
  ledger: number
  closeTime: string
  txHash: string
  pool: string | null
  data: Record<string, unknown>
}

type EventRowIn = {
  id: string
  group_name: string
  contract_id: string
  topic: string
  ledger: number | string
  close_time: Date | string
  tx_hash: string
  pool: string | null
  data: Record<string, unknown> | null
}

const toIndexed = (r: EventRowIn): IndexedEvent => ({
  id: r.id,
  group: r.group_name as IndexGroup,
  contractId: r.contract_id,
  topic: r.topic,
  ledger: Number(r.ledger),
  closeTime: new Date(r.close_time).toISOString(),
  txHash: r.tx_hash,
  pool: r.pool ?? null,
  data: r.data ?? {},
})

/**
 * Indexed events, newest first, without their raw XDR (lists stay small; one event's XDR is
 * `getIndexedEvent`). `before` is an event id: the rows strictly older (RPC event ids are fixed-width
 * TOIDs, so they sort as the chain does). `indexedThrough` is the ledger the slowest group asked has
 * indexed through (0 when one never ran), and `lagSeconds` how long ago that ledger closed (null when
 * unknown).
 */
export async function getIndexedEvents(
  sql: Sql,
  q: { network: Network; group?: IndexGroup; pool?: string; before?: string; limit: number; /** ms; `Date.now()` by default. */ now?: number },
): Promise<{ rows: IndexedEvent[]; indexedThrough: number; lagSeconds: number | null }> {
  const group = q.group ?? null
  const pool = q.pool ?? null
  const before = q.before ?? null
  const rows = await sql<EventRowIn>`
    select id, group_name, contract_id, topic, ledger, close_time, tx_hash, pool, data
    from events
    where network = ${q.network}
      and (${group}::text is null or group_name = ${group})
      and (${pool}::text is null or pool = ${pool})
      and (${before}::text is null or id < ${before})
    order by ledger desc, id desc
    limit ${q.limit}`

  const names = (q.group ? [q.group] : INDEX_GROUPS).map((g) => indexCursorName(g, q.network))
  const cursors = await sql<{ name: string; ledger: string | number | null; close_time: Date | string | null }>`
    select name, ledger, close_time from ingest_cursor where name = any(${names}::text[])`
  const byName = new Map(cursors.map((c) => [c.name, c]))
  const mine = names.map((n) => byName.get(n))
  const now = q.now ?? Date.now()
  let indexedThrough = 0
  let lagSeconds: number | null = null
  if (mine.every((c) => c && c.ledger !== null)) {
    indexedThrough = Math.min(...mine.map((c) => Number(c?.ledger)))
    if (mine.every((c) => c?.close_time != null)) {
      lagSeconds = Math.max(...mine.map((c) => Math.max(0, Math.round((now - new Date(c?.close_time as Date | string).getTime()) / 1000))))
    }
  }
  return { rows: rows.map(toIndexed), indexedThrough, lagSeconds }
}

/** One indexed event with its raw XDR (base64 `ScVal`), or null when the index does not hold it. */
export async function getIndexedEvent(sql: Sql, q: { network: Network; id: string }): Promise<(IndexedEvent & { rawXdr: string }) | null> {
  const [row] = await sql<EventRowIn & { raw_xdr: string }>`
    select id, group_name, contract_id, topic, ledger, close_time, tx_hash, pool, data, raw_xdr
    from events where network = ${q.network} and id = ${q.id}`
  return row ? { ...toIndexed(row), rawXdr: row.raw_xdr } : null
}
