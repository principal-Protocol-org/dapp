import "server-only"

/**
 * The event indexer (spec 0004 D-13 to D-15): the protocol's contract events, read from the RPC's
 * `getEvents` into the `events` table, one row per RPC event id. It runs on the registry's
 * `discover()` pattern: pages of 200, the place saved after every page in `ingest_cursor`
 * (`events:<group>:<network>`), a deadline checked before every page, and a gap recorded when the
 * place is older than the RPC's window.
 *
 * Contracts are indexed in five groups, each with its own cursor: `market` (every market's SY,
 * manager and pool), `escrow` (every market's RecoveryEscrow), `oracle` (every oracle the manifest
 * names: its markets' and `shared.oracle`, whatever markets a run lists), and the shared
 * `permissioning` and `risk` (RiskControl). The RPC takes at most 5 contract ids per request, so a
 * larger group is read in chunks, page by page in turn; the group's cursor is the ledger every chunk
 * has read through.
 *
 * A run resumes at the ledger after its cursor, never at a stored RPC paging cursor: re-reading a
 * ledger is harmless (the RPC event id is the key, inserted once), and a cursor only moves forward
 * (the upsert refuses an older ledger), so two overlapping runs (a scheduler retry over a slow run)
 * write no duplicate and never rewind it. `pnpm indexer:reindex` is the one write that moves it back.
 *
 * A cursor also names the contracts it has read through its ledger (`members`). A contract of the
 * group that is not among them (a market listed after its creation, a market dropped from the list
 * and listed again, a new deployment or contract in the manifest) is read in its own chunks from
 * where it can first have emitted until it catches up: its creation ledger when known and later than
 * the deploy ledger, else the deploy ledger (or the RPC's oldest ledger). The creation ledger is the
 * manifest's `createdLedgers` entry for the contract, else (a market's contract) its market's
 * `createdLedger`, the ledger discovery saw the factory build it at. The cursor and its members move
 * only when every chunk has. A run whose market list is the seeds alone (the registry could not be
 * read) leaves the market and escrow groups for the next run (`runGroups`), so their members never
 * drop a market for a run.
 *
 * A gap (ledgers the RPC no longer holds) is stored on the cursor by the same guarded write that moves
 * the cursor past it (`gap_from`, `gap_to`, widened when one is open), so a cursor never passes a gap
 * without recording it. `pnpm indexer:import` clears one when the imported rows fill it, and
 * `pnpm indexer:clear-gap` clears one the operator knows to be false.
 *
 * Each row keeps the event's value as the RPC sent it, base64 XDR of the `ScVal` (`raw_xdr`), and
 * the fields decoded for the emitting contract's role (`decodeEvent`): bigints as decimal strings,
 * bytes as hex. An unknown topic is kept with `data = {}`. Every indexed contract publishes a single
 * symbol topic, kept in `topic`.
 */
import { scValToNative, type xdr } from "@stellar/stellar-sdk"
import { bytesToHex } from "@/lib/protocol/bytes"
import { cursorLedger, decodeEvent, idOf, type RawEvent, type Role } from "@/lib/protocol/events"
import { manifestOracles } from "@/lib/protocol/manifest"
import type { ContractReader } from "@/lib/protocol/reader"
import { prunedOldestOf, readRpcWindow } from "@/lib/protocol/rpc-window"
import type { Manifest, Market, Network } from "@/lib/protocol/types"
import { DatabaseConfigError, type Sql } from "./db"
import { serverReader } from "./rpc-urls"

// ---------------------------------------------------------------- groups

export type IndexGroup = "escrow" | "oracle" | "permissioning" | "risk" | "market"

export const INDEX_GROUPS: readonly IndexGroup[] = ["escrow", "oracle", "permissioning", "risk", "market"]

/** The groups whose members are the listed markets' contracts. */
const MARKET_GROUPS: readonly IndexGroup[] = ["escrow", "market"]

/** Why a run left groups out, for its answer and log. */
export type SkippedGroups = { groups: IndexGroup[]; reason: string }

export const SEEDS_ONLY_REASON = "The markets list could not be read, so only the manifest seeds were known. The market and escrow groups wait for the next run."

/**
 * The groups one run indexes, from how its market list was read (`listedMarkets`' `fromRegistry`).
 * A list from the registry: every group. The seeds alone (the registry read failed or timed out):
 * the shared groups only, so the market and escrow cursors keep every registry market as a member
 * and record no gap for it when the list comes back.
 */
export function runGroups(fromRegistry: boolean): { groups: IndexGroup[]; skipped: SkippedGroups | null } {
  if (fromRegistry) return { groups: [...INDEX_GROUPS], skipped: null }
  return { groups: INDEX_GROUPS.filter((g) => !MARKET_GROUPS.includes(g)), skipped: { groups: [...MARKET_GROUPS], reason: SEEDS_ONLY_REASON } }
}

/**
 * One indexed contract: the role its events are decoded for, its market's pool when it has one, and
 * the ledger it was created at when known (no event of it is older): the manifest's `createdLedgers`
 * entry, else its market's `createdLedger` (discovery saw the factory build it).
 */
export type IndexMember = { id: string; role: Role; pool?: string; createdLedger?: number }

/** Events per `getEvents` page. */
export const EVENTS_PAGE = 200
/** The RPC accepts at most 5 contract ids per request (checked 2026-10-27). */
export const MAX_CONTRACTS_PER_REQUEST = 5

/** The cursor row of one group on one network. */
export const indexCursorName = (group: IndexGroup, network: Network) => `events:${group}:${network}`

/**
 * The contracts of each group, each listed once. The market and escrow groups are the listed
 * `markets`' contracts; the oracle group is every oracle of the static manifest (`shared.oracle`
 * first, then its markets' in order), so it is the same whatever markets the registry listed.
 */
export function contractsOf(manifest: Manifest, markets: Market[]): Record<IndexGroup, IndexMember[]> {
  const groups: Record<IndexGroup, IndexMember[]> = { escrow: [], oracle: [], permissioning: [], risk: [], market: [] }
  const add = (group: IndexGroup, member: Omit<IndexMember, "createdLedger">, marketCreated?: number) => {
    if (groups[group].some((m) => m.id === member.id)) return
    const createdLedger = manifest.createdLedgers?.[member.id] ?? marketCreated
    groups[group].push(createdLedger === undefined ? member : { ...member, createdLedger })
  }
  for (const market of markets) {
    const k = market.contracts
    add("market", { id: k.sy, role: "sy", pool: k.pool }, market.createdLedger)
    add("market", { id: k.manager, role: "manager", pool: k.pool }, market.createdLedger)
    add("market", { id: k.pool, role: "pool", pool: k.pool }, market.createdLedger)
    add("escrow", { id: k.recoveryEscrow, role: "escrow", pool: k.pool }, market.createdLedger)
  }
  for (const id of [manifest.shared.oracle, ...manifestOracles(manifest).map((o) => o.oracle)]) add("oracle", { id, role: "oracle" })
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
  getLatestLedger?(): Promise<{ sequence: number }>
  getEvents(req: IndexerEventsRequest): Promise<{ events: RawEvent[]; cursor: string; latestLedger?: number; latestLedgerCloseTime?: string }>
  getLedgers?(req: { startLedger: number; pagination: { limit: number } }): Promise<{ ledgers: { sequence: number; ledgerCloseTime: string | number }[]; oldestLedger?: number; latestLedger?: number }>
}

export type IndexDeps = {
  sql: Sql
  rpc: IndexerRpc
  manifest: Manifest
  markets: Market[]
  /** Wall clock (ms) for the deadline; `Date.now` by default. */
  now?: () => number
  /** Reads `record_count` for the reconciliation; `serverReader(manifest)` by default. */
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

/** The last reconciliation, as stored on the escrow cursor. */
export type StoredReconcile = { at: string; results: Reconcile[] }

// ---------------------------------------------------------------- the cursor

type SavedCursor = { ledger: number; members: string[] | null }

async function readCursor(sql: Sql, name: string): Promise<SavedCursor | null> {
  const [row] = await sql<{
    ledger: string | number | null
    cursor: string | null
    close_time: Date | string | null
    gap_from: string | number | null
    gap_to: string | number | null
    members: string[] | null
  }>`
    select ledger, cursor, close_time, gap_from, gap_to, members from ingest_cursor where name = ${name}`
  if (!row || row.ledger === null) return null
  return { ledger: Number(row.ledger), members: row.members }
}

/**
 * Moves the cursor forward to `ledger`, with the contracts it has now read through it (`members`)
 * and any gap this run found: an older or equal ledger changes nothing, so a run that is behind never
 * rewinds one that is ahead. The stored gap is widened, never narrowed (`least`/`greatest` skip
 * nulls). `closeTime` (the close time of `ledger`, when known) keeps the stored one otherwise.
 */
async function saveCursor(
  sql: Sql,
  name: string,
  save: { ledger: number; cursor: string | null; closeTime: string | null; gap: IndexGap | null; members: string[] },
): Promise<void> {
  await sql`
    insert into ingest_cursor (name, ledger, cursor, close_time, gap_from, gap_to, members)
    values (${name}, ${save.ledger}, ${save.cursor}, ${save.closeTime}, ${save.gap?.from ?? null}, ${save.gap?.to ?? null}, ${save.members}::text[])
    on conflict (name) do update set
      ledger = excluded.ledger,
      cursor = excluded.cursor,
      close_time = coalesce(excluded.close_time, ingest_cursor.close_time),
      gap_from = least(ingest_cursor.gap_from, excluded.gap_from),
      gap_to = greatest(ingest_cursor.gap_to, excluded.gap_to),
      members = excluded.members
    where ingest_cursor.ledger is null or excluded.ledger > ingest_cursor.ledger`
}

/** The last reconciliation, on the escrow cursor; an older one never replaces a newer. */
async function saveReconcile(sql: Sql, name: string, reconcile: StoredReconcile): Promise<void> {
  await sql`
    insert into ingest_cursor (name, reconcile) values (${name}, ${JSON.stringify(reconcile)}::jsonb)
    on conflict (name) do update set reconcile = excluded.reconcile
    where ingest_cursor.reconcile is null or ingest_cursor.reconcile->>'at' <= excluded.reconcile->>'at'`
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

/** One request's contracts: where it wanted to start, where it starts (the RPC's window allowing). */
type Chunk = { ids: string[]; wanted: number; start: number; cursor: string | null; through: number; done: boolean }

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
  const memberIds = members.map((m) => m.id).sort()
  let oldest = health.oldestLedger

  // The contracts this cursor has read through its ledger resume after it. Any other starts where it
  // can first have emitted: its creation ledger (`contractsOf`) when that is after the deploy, else
  // the deploy (a manifest without `deployLedger`, the local stack, at the RPC's oldest ledger,
  // claiming no gap). It reads in chunks of its own, one start per chunk, so the cursor moves only
  // once it has caught up, and a gap is claimed only below that start.
  const known = new Set(saved?.members ?? [])
  const resumed = saved ? members.filter((m) => known.has(m.id)) : []
  const added = members.filter((m) => !resumed.includes(m))
  const base = manifest.deployLedger ?? oldest
  const startOf = (m: IndexMember) => (m.createdLedger === undefined ? base : Math.max(base, m.createdLedger))
  const chunks: Chunk[] = []
  const addChunks = (list: IndexMember[], wanted: number) => {
    for (let i = 0; i < list.length; i += MAX_CONTRACTS_PER_REQUEST) {
      const start = Math.max(wanted, oldest)
      const ids = list.slice(i, i + MAX_CONTRACTS_PER_REQUEST).map((m) => m.id)
      chunks.push({ ids, wanted, start, cursor: null, through: start - 1, done: start > health.latestLedger })
    }
  }
  if (saved) addChunks(resumed, saved.ledger + 1)
  for (const wanted of [...new Set(added.map(startOf))].sort((a, b) => a - b)) {
    addChunks(
      added.filter((m) => startOf(m) === wanted),
      wanted,
    )
  }

  /** The ledgers some chunk wanted but the RPC no longer holds, as one range. */
  const recordGap = () => {
    let from: number | null = null
    let to: number | null = null
    for (const c of chunks) {
      if (c.wanted >= c.start) continue
      from = from === null ? c.wanted : Math.min(from, c.wanted)
      to = to === null ? c.start - 1 : Math.max(to, c.start - 1)
    }
    if (from === null || to === null || (progress.gap?.from === from && progress.gap?.to === to)) return
    const gap: IndexGap = { from, to }
    progress.gap = gap
    console.warn(
      `indexer: gap: ${group} (${network}) ledgers ${gap.from}-${gap.to} are older than the RPC's oldest ledger ${oldest}; ` +
        "indexing from there. Their events are missing until a capture is imported (pnpm indexer:import).",
    )
  }
  recordGap()
  const result = (complete: boolean): GroupResult => ({
    group,
    indexedThrough: progress.saved ?? saved?.ledger ?? (chunks.length > 0 ? Math.min(...chunks.map((c) => c.through)) : oldest - 1),
    gap: progress.gap,
    complete,
  })
  if (chunks.every((c) => c.done)) return result(true)

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
      const from = chunk.through + 1
      try {
        return await rpc.getEvents({ startLedger: from, filters, limit: ctx.pageSize })
      } catch (error) {
        // The RPC drops its oldest ledger as new ones close: a start read from `getHealth` a moment
        // ago may be refused. Every chunk not yet started starts again at the new oldest ledger,
        // which widens the gap.
        if (attempt === START_ATTEMPTS) throw error
        // dRPC names its first available state in the refusal; the window it reports can be a few ledgers older.
        const newOldest = prunedOldestOf(error) ?? (await readRpcWindow(rpc)).oldestLedger
        if (newOldest <= from) throw error
        oldest = newOldest
        for (const c of chunks) {
          if (c.cursor !== null || c.start >= oldest) continue
          c.start = oldest
          c.through = Math.max(c.through, oldest - 1)
        }
        recordGap()
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

      // Every chunk has read through `through`, each from where it started (or a recorded gap):
      // the cursor moves there with all the group's contracts as members, and this run's gap.
      const through = Math.min(...chunks.map((c) => c.through))
      if (through > (progress.saved ?? saved?.ledger ?? -1)) {
        await saveCursor(sql, name, {
          ledger: through,
          cursor: chunks.length === 1 ? res.cursor : null,
          closeTime: closeTimeAt(through),
          gap: progress.gap,
          members: memberIds,
        })
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
  const health = await readRpcWindow(rpc)

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

  // The reconciliation runs when the escrow group finished within the deadline, and is kept on its cursor.
  const escrow = results.find((r) => r.group === "escrow")
  let reconciled: Reconcile[] = []
  if (escrow?.complete && !ctx.late()) {
    reconciled = await reconcile(sql, deps.reader ?? serverReader(manifest), network, markets)
    await saveReconcile(sql, indexCursorName("escrow", network), { at: new Date().toISOString(), results: reconciled })
  }
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

/** A stored gap of one group: ledgers whose events the index may lack (inclusive). */
export type GroupGap = { group: IndexGroup; from: number; to: number }

export type IndexedEvents = {
  rows: IndexedEvent[]
  /** The ledger the slowest group asked has indexed through; 0 when one never ran. */
  indexedThrough: number
  /** That ledger's close time (ISO): a client computes a fresh lag from it, whatever the cache's age. */
  indexedThroughCloseTime: string | null
  /** Seconds from that close time to now; null when unknown. */
  lagSeconds: number | null
  /** The stored gaps of the groups asked. */
  gaps: GroupGap[]
  /** The groups asked that no run has indexed yet (no cursor ledger): `indexedThrough` is 0 while any is. */
  pendingGroups: IndexGroup[]
  /** The last RecoveryEscrow reconciliation; null before the first. */
  reconcile: StoredReconcile | null
}

/**
 * Indexed events, newest first, without their raw XDR (lists stay small; one event's XDR is
 * `getIndexedEvent`). `before` is an event id: the rows strictly older (RPC event ids are fixed-width
 * TOIDs, so they sort as the chain does). The index's state comes with them: how far the groups asked
 * are indexed and how long ago that ledger closed, their stored gaps, and the last reconciliation.
 */
export async function getIndexedEvents(
  sql: Sql,
  q: {
    network: Network
    group?: IndexGroup
    pool?: string
    /** Only this contract's events (one oracle's history). */
    contract?: string
    /** Only these topics (`cb_limit`, `ast_limit`…): filtered in the query, so a page holds only them. */
    topics?: readonly string[]
    before?: string
    limit: number
    /** ms; `Date.now()` by default. */
    now?: number
  },
): Promise<IndexedEvents> {
  const group = q.group ?? null
  const pool = q.pool ?? null
  const contract = q.contract ?? null
  const topics = q.topics && q.topics.length > 0 ? [...q.topics] : null
  const before = q.before ?? null
  const rows = await sql<EventRowIn>`
    select id, group_name, contract_id, topic, ledger, close_time, tx_hash, pool, data
    from events
    where network = ${q.network}
      and (${group}::text is null or group_name = ${group})
      and (${pool}::text is null or pool = ${pool})
      and (${contract}::text is null or contract_id = ${contract})
      and (${topics}::text[] is null or topic = any(${topics}::text[]))
      and (${before}::text is null or id < ${before})
    order by ledger desc, id desc
    limit ${q.limit}`

  const asked = q.group ? [q.group] : INDEX_GROUPS
  const escrowName = indexCursorName("escrow", q.network)
  const names = [...new Set([...asked.map((g) => indexCursorName(g, q.network)), escrowName])]
  const cursors = await sql<{
    name: string
    ledger: string | number | null
    close_time: Date | string | null
    gap_from: string | number | null
    gap_to: string | number | null
    reconcile: StoredReconcile | null
  }>`
    select name, ledger, close_time, gap_from, gap_to, reconcile from ingest_cursor where name = any(${names}::text[])`
  const byName = new Map(cursors.map((c) => [c.name, c]))
  const mine = asked.map((g) => byName.get(indexCursorName(g, q.network)))
  const now = q.now ?? Date.now()
  let indexedThrough = 0
  let indexedThroughCloseTime: string | null = null
  let lagSeconds: number | null = null
  if (mine.every((c) => c && c.ledger != null)) {
    indexedThrough = Math.min(...mine.map((c) => Number(c?.ledger)))
    if (mine.every((c) => c?.close_time != null)) {
      const closed = Math.min(...mine.map((c) => new Date(c?.close_time as Date | string).getTime()))
      indexedThroughCloseTime = new Date(closed).toISOString()
      lagSeconds = Math.max(0, Math.round((now - closed) / 1000))
    }
  }
  const gaps = asked.flatMap((g): GroupGap[] => {
    const c = byName.get(indexCursorName(g, q.network))
    return c && c.gap_from != null && c.gap_to != null ? [{ group: g, from: Number(c.gap_from), to: Number(c.gap_to) }] : []
  })
  const pendingGroups = asked.filter((g, i) => mine[i]?.ledger == null)
  return {
    rows: rows.map(toIndexed),
    indexedThrough,
    indexedThroughCloseTime,
    lagSeconds,
    gaps,
    pendingGroups,
    reconcile: byName.get(escrowName)?.reconcile ?? null,
  }
}

/**
 * How many events the index holds per topic, for the group, pool and contract asked: every row, not
 * one page (the Permissioning counts on the compliance page). A topic with no event is absent.
 */
export async function getEventCounts(
  sql: Sql,
  q: { network: Network; group?: IndexGroup; pool?: string; contract?: string },
): Promise<Record<string, number>> {
  const group = q.group ?? null
  const pool = q.pool ?? null
  const contract = q.contract ?? null
  const rows = await sql<{ topic: string; n: string | number }>`
    select topic, count(*) as n
    from events
    where network = ${q.network}
      and (${group}::text is null or group_name = ${group})
      and (${pool}::text is null or pool = ${pool})
      and (${contract}::text is null or contract_id = ${contract})
    group by topic`
  return Object.fromEntries(rows.map((r) => [r.topic, Number(r.n)]))
}

/** One indexed event with its raw XDR (base64 `ScVal`), or null when the index does not hold it. */
export async function getIndexedEvent(sql: Sql, q: { network: Network; id: string }): Promise<(IndexedEvent & { rawXdr: string }) | null> {
  const [row] = await sql<EventRowIn & { raw_xdr: string }>`
    select id, group_name, contract_id, topic, ledger, close_time, tx_hash, pool, data, raw_xdr
    from events where network = ${q.network} and id = ${q.id}`
  return row ? { ...toIndexed(row), rawXdr: row.raw_xdr } : null
}
