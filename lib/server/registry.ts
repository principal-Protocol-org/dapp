import "server-only"

/**
 * The market registry (spec 0002 §1). The manifest stays the trust anchor: it names the shared
 * contracts and pins the Wasm hash of every market contract kind, and its `markets[]` are seeds.
 * Other markets are discovered from the Router's `mkt_reg` / `mkt_unreg` and the factory's
 * `mkt_new` events, or published by the wizard (`POST /api/markets`), and cached in
 * `market_registry` keyed by pool.
 *
 * A market is listed only after it passes `validateMarket`: 0001's topology rule, wiring to this
 * network's Router, oracle, Permissioning and RiskControl, and every contract running the code the
 * manifest pins for its kind. Validation runs on discovery, on publish and on every recorder run;
 * pages read the cached verdicts and never validate inline (R2-36).
 *
 * Verdicts are three-state: `valid = true` lists a market, `false` hides it (a seed too), and
 * `null` means the check could not finish (the RPC failed, which is not an answer): an existing
 * verdict is kept and only the reason is updated, so a flaky RPC never hides a trusted market.
 */
import { Asset, StrKey, scValToNative, type xdr } from "@stellar/stellar-sdk"
import { cursorLedger, idOf, type RawEvent } from "@/lib/protocol/events"
import { parseMarket } from "@/lib/protocol/manifest"
import { fetchTopology } from "@/lib/protocol/market-state"
import { isContractError, readLive, toBool, type ContractReader } from "@/lib/protocol/reader"
import type { Manifest, Market, MarketContractName } from "@/lib/protocol/types"
import { contractWasmHash, WasmReadError, type LedgerEntriesRpc } from "@/lib/protocol/wasm"
import { DatabaseConfigError, type Sql } from "./db"
import { createRollingLimiter } from "./request"

export const MARKET_KINDS: readonly MarketContractName[] = ["sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow"]

/** `reason` text is capped: it is stored and shown in the manager view, never a log dump. */
const MAX_REASON = 1_000

// ---------------------------------------------------------------- types

export type Validation = {
  valid: boolean
  reason?: string
  /** The check could not finish (an RPC failure, not an answer from the chain). */
  unreadable?: true
}

type EventsRequest =
  | { filters: { type: "contract"; contractIds: string[] }[]; limit: number; startLedger: number; cursor?: never }
  | { filters: { type: "contract"; contractIds: string[] }[]; limit: number; cursor: string; startLedger?: never }

/** The RPC calls the registry makes; the SDK's `rpc.Server` satisfies it, tests inject a fake. */
export type RegistryRpc = LedgerEntriesRpc & {
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>
  getEvents(req: EventsRequest): Promise<{ events: RawEvent[]; cursor: string; latestLedger: number }>
}

export type RegistrySource = "seed" | "discovered" | "published"

/** One `market_registry` row. `market` is the stored JSON, parsed only when it is listed. */
export type RegistryRow = {
  pool: string
  marketId: string | null
  source: RegistrySource
  valid: boolean | null
  reason: string | null
  market: unknown
}

export type RegistryWrite = {
  pool: string
  source: RegistrySource
  valid: boolean | null
  reason: string | null
  market: Market | null
}

export type RegistryStore = {
  rows(): Promise<RegistryRow[]>
  /**
   * Upserts by pool. Source precedence: seed > published > discovered. `valid: null` on an existing
   * row keeps its verdict and market and updates the reason; `market: null` keeps a stored market.
   */
  record(row: RegistryWrite): Promise<void>
  cursor(name: string): Promise<{ ledger: number; cursor: string | null } | null>
  saveCursor(name: string, ledger: number, cursor: string | null): Promise<void>
}

export type RegistryDeps = { store: RegistryStore; reader: ContractReader; rpc: RegistryRpc; manifest: Manifest }

// ---------------------------------------------------------------- reads

/** A failure building a market from its pool: `unreadable` when the RPC, not the chain, failed. */
export class PoolReadError extends Error {
  constructor(
    message: string,
    readonly unreadable: boolean,
  ) {
    super(message)
    this.name = "PoolReadError"
  }
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string; unreadable: boolean }

/** One view call. A contract trap is an answer (`unreadable: false`); a transport failure is not. */
async function read<T>(
  reader: ContractReader,
  contractId: string,
  functionName: string,
  map: (value: unknown) => T,
  args?: Parameters<ContractReader>[0]["args"],
): Promise<Read<T>> {
  const live = await readLive<unknown>(reader, { contractId, functionName, args })
  if (live.status === "unavailable") return { ok: false, error: live.error, unreadable: !isContractError(live.error) }
  try {
    return { ok: true, value: map(live.value) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), unreadable: false }
  }
}

const isContract = (v: unknown): v is string => typeof v === "string" && StrKey.isValidContract(v)

function address(v: unknown): string {
  if (isContract(v)) return v
  throw new Error("expected a contract address")
}

/** `Option<Address>`: `null` for None. */
function optionalAddress(v: unknown): string | null {
  return v === null || v === undefined ? null : address(v)
}

function u64(v: unknown): bigint {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v)
  throw new Error("expected an integer")
}

function text(v: unknown): string {
  if (typeof v === "string") return v
  throw new Error("expected a string")
}

function value<T>(r: Read<T>, what: string): T {
  if (r.ok) return r.value
  throw new PoolReadError(`${what} could not be read: ${r.error}`, r.unreadable)
}

/** The pinned hash for a kind, lower-case, or undefined when the manifest pins none. */
const pinOf = (manifest: Manifest, kind: MarketContractName) => manifest.wasmHashes[kind]?.toLowerCase()

/** The contract's Wasm hash against the manifest's pin for its kind: a problem, an unread note, or null. */
async function checkCode(
  rpc: LedgerEntriesRpc,
  manifest: Manifest,
  kind: MarketContractName,
  contractId: string,
): Promise<{ problem?: string; unread?: string }> {
  const pinned = pinOf(manifest, kind)
  if (!pinned) return { problem: `the manifest pins no Wasm for ${kind}, so ${contractId} cannot be trusted` }
  try {
    const actual = await contractWasmHash(rpc, contractId)
    if (actual !== pinned) return { problem: `${kind} (${contractId}) runs Wasm ${actual}, which the manifest does not pin for ${kind}` }
    return {}
  } catch (error) {
    if (error instanceof WasmReadError) return { problem: `${kind}: ${error.message}` }
    return { unread: `${kind} code (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` }
  }
}

// ---------------------------------------------------------------- marketFromPool

/**
 * Builds a `Market` from a pool address (spec §1): the pool's `config_address`, `recovery_escrow`,
 * `sy_address`, `pt_address`, `yt_address`, `manager_address` and `maturity`, the manager's
 * `oracle_address`, and the underlying from the SY wrapper's `underlying_address` and the SAC's
 * `name()` ("CODE:ISSUER") and `decimals()` (R2-37). `manifest.markets` are the markets already
 * known, for the id: an id another pool holds gets the pool's suffix; a known pool keeps its id.
 * The pool must run the pinned MarketPool code first, so a random address costs one read.
 * `wasmHashes` are the manifest's market-kind pins, for 0001's restore path (R2-12).
 */
export async function marketFromPool(reader: ContractReader, rpc: LedgerEntriesRpc, manifest: Manifest, pool: string): Promise<Market> {
  if (!isContract(pool)) throw new PoolReadError(`${pool} is not a contract address.`, false)
  const code = await checkCode(rpc, manifest, "pool", pool)
  if (code.problem) throw new PoolReadError(code.problem.replace(/^pool: /, ""), false)
  if (code.unread) throw new PoolReadError(`The pool could not be read: ${code.unread}.`, true)

  const [config, escrow, sy, pt, yt, manager, maturity] = await Promise.all([
    read(reader, pool, "config_address", address),
    read(reader, pool, "recovery_escrow", optionalAddress),
    read(reader, pool, "sy_address", address),
    read(reader, pool, "pt_address", address),
    read(reader, pool, "yt_address", address),
    read(reader, pool, "manager_address", address),
    read(reader, pool, "maturity", u64),
  ])
  const c = {
    config: value(config, "The pool's config"),
    recoveryEscrow: value(escrow, "The pool's recovery escrow"),
    sy: value(sy, "The pool's SY"),
    pt: value(pt, "The pool's PT"),
    yt: value(yt, "The pool's YT"),
    manager: value(manager, "The pool's manager"),
  }
  if (!c.recoveryEscrow) throw new PoolReadError("The pool has no recovery escrow yet: the market is not finished.", false)
  const maturitySeconds = Number(value(maturity, "The pool's maturity"))
  if (!Number.isSafeInteger(maturitySeconds) || maturitySeconds <= 0) throw new PoolReadError("The pool's maturity is out of range.", false)

  const [oracle, sac] = await Promise.all([read(reader, c.manager, "oracle_address", address), read(reader, c.sy, "underlying_address", address)])
  const underlyingSac = value(sac, "The SY's underlying")
  const [name, decimals] = await Promise.all([
    read(reader, underlyingSac, "name", text),
    read(reader, underlyingSac, "decimals", (v) => Number(u64(v))),
  ])
  const assetName = value(name, "The underlying's name")
  const [assetCode, issuer, ...rest] = assetName.split(":")
  if (rest.length > 0 || !issuer || !StrKey.isValidEd25519PublicKey(issuer) || !/^[A-Za-z0-9]{1,12}$/.test(assetCode)) {
    throw new PoolReadError(`The underlying "${assetName.slice(0, 80)}" is not a classic asset (CODE:ISSUER); only those are supported.`, false)
  }

  const existing = manifest.markets.find((m) => m.contracts.pool === pool)
  const base = `${manifest.network}-${assetCode.toLowerCase()}-${maturitySeconds}`
  const taken = manifest.markets.some((m) => m.marketId === base && m.contracts.pool !== pool)
  const marketId = existing?.marketId ?? (taken ? `${base}-${pool.slice(1, 7).toLowerCase()}` : base)
  const t = manifest.testAsset
  const isTest = t !== undefined && t.code === assetCode && t.issuer === issuer && t.sac === underlyingSac
  const wasmHashes = Object.fromEntries(MARKET_KINDS.flatMap((k) => (manifest.wasmHashes[k] ? [[k, manifest.wasmHashes[k]]] : [])))

  try {
    return parseMarket({
      marketId,
      displayName: isTest ? `${assetCode} (test)` : assetCode,
      underlying: { code: assetCode, issuer, sac: underlyingSac, decimals: value(decimals, "The underlying's decimals") },
      maturity: maturitySeconds,
      contracts: { router: manifest.shared.router, oracle: value(oracle, "The manager's oracle"), ...c, pool, recoveryEscrow: c.recoveryEscrow },
      wasmHashes,
    })
  } catch (error) {
    throw new PoolReadError(error instanceof Error ? error.message : String(error), false)
  }
}

// ---------------------------------------------------------------- validateMarket

/** `[contract kind, view, expected value]`; `Option<Address>` views read None as "unset". */
type Wire = [MarketContractName, string, string | bigint, "option"?]

/**
 * 0001's topology rule (`Router.market(pool)` and the manager's maturity) plus: the market is
 * registered with this network's Router; each contract is wired to this network's oracle,
 * Permissioning and RiskControl and to the market's own config and recovery escrow; the underlying
 * is the Stellar asset contract of its code and issuer; and every market contract runs the Wasm the
 * manifest pins for its kind. A market wired to foreign infrastructure is invalid.
 */
export async function validateMarket(reader: ContractReader, rpc: LedgerEntriesRpc, manifest: Manifest, market: Market): Promise<Validation> {
  const problems: string[] = []
  const unread: string[] = []
  const c = market.contracts
  const s = manifest.shared
  const sac = market.underlying.sac

  if (c.router !== s.router) problems.push(`its Router (${c.router}) is not this network's Router`)
  if (c.oracle !== s.oracle) problems.push(`its oracle (${c.oracle}) is not this network's oracle`)
  try {
    const derived = new Asset(market.underlying.code, market.underlying.issuer).contractId(manifest.networkPassphrase)
    if (derived !== sac) problems.push(`its underlying ${sac} is not the asset contract of ${market.underlying.code}:${market.underlying.issuer}`)
  } catch {
    problems.push(`its underlying ${market.underlying.code}:${market.underlying.issuer} is not a valid asset`)
  }

  const wires: Wire[] = [
    ["pool", "config_address", c.config],
    ["pool", "recovery_escrow", c.recoveryEscrow, "option"],
    ["manager", "oracle_address", s.oracle],
    ["manager", "permissioning_address", s.permissioning],
    ["manager", "risk_control", s.riskControl, "option"],
    ["manager", "config_address", c.config],
    ["sy", "underlying_address", sac],
    ["sy", "permissioning_address", s.permissioning],
    ["sy", "risk_control", s.riskControl, "option"],
    ["sy", "recovery_escrow", c.recoveryEscrow],
    ["pt", "permissioning_address", s.permissioning],
    ["pt", "recovery_escrow", c.recoveryEscrow],
    ["yt", "permissioning_address", s.permissioning],
    ["yt", "oracle_address", s.oracle],
    ["yt", "recovery_escrow", c.recoveryEscrow],
    ["config", "underlying", sac],
    ["config", "maturity", BigInt(market.maturity)],
    ["recoveryEscrow", "underlying_address", sac],
  ]

  const [registered, topology, wired, code] = await Promise.all([
    read(reader, s.router, "is_registered", toBool, [{ type: "address", value: c.pool }]),
    fetchTopology(reader, market),
    Promise.all(
      wires.map(([kind, fn, expected, option]) =>
        read<string | bigint | null>(reader, c[kind], fn, (v) => (typeof expected === "bigint" ? u64(v) : option ? optionalAddress(v) : address(v))),
      ),
    ),
    Promise.all(MARKET_KINDS.map((kind) => checkCode(rpc, manifest, kind, c[kind]))),
  ])

  if (!registered.ok) {
    ;(registered.unreadable ? unread : problems).push(`Router.is_registered: ${registered.error}`)
  } else if (!registered.value) {
    problems.push("the pool is not registered with the Router")
  } else if (topology.status === "unavailable") {
    ;(isContractError(topology.error) ? problems : unread).push(`Router.market: ${topology.error}`)
  } else if (!topology.value.matches) {
    problems.push(`the Router lists different contracts for this pool: ${topology.value.mismatches.join(", ")}`)
  }

  wired.forEach((r, i) => {
    const [kind, fn, expected] = wires[i]
    if (!r.ok) (r.unreadable ? unread : problems).push(`${kind} ${fn}: ${r.error}`)
    else if (r.value !== expected) problems.push(`${kind} ${fn} is ${r.value === null ? "unset" : String(r.value)}, not ${String(expected)}`)
  })
  for (const r of code) {
    if (r.problem) problems.push(r.problem)
    if (r.unread) unread.push(r.unread)
  }

  if (problems.length > 0) return { valid: false, reason: cap(problems.join("; ")) }
  if (unread.length > 0) return { valid: false, unreadable: true, reason: cap(`could not be checked: ${unread.join("; ")}`) }
  return { valid: true }
}

const cap = (reason: string) => (reason.length <= MAX_REASON ? reason : `${reason.slice(0, MAX_REASON - 1)}…`)

// ---------------------------------------------------------------- checking one pool

function storedMarket(raw: unknown): Market | null {
  try {
    return raw ? parseMarket(raw) : null
  } catch {
    return null
  }
}

/** Seeds plus every stored market: the ids a new market must not take. */
function knownMarkets(manifest: Manifest, rows: RegistryRow[]): Market[] {
  const seeds = new Set(manifest.markets.map((m) => m.contracts.pool))
  return [...manifest.markets, ...rows.flatMap((r) => (seeds.has(r.pool) ? [] : (storedMarket(r.market) ?? [])))]
}

type Outcome = { status: "valid"; market: Market } | { status: "invalid" | "unreadable"; reason: string; market: Market | null }

/** Builds (unless known) and validates one pool; writes nothing. */
async function check(deps: RegistryDeps, pool: string, known: Market[], stored: Market | null): Promise<Outcome> {
  const { reader, rpc, manifest } = deps
  let market = manifest.markets.find((m) => m.contracts.pool === pool) ?? stored
  if (!market) {
    try {
      market = await marketFromPool(reader, rpc, { ...manifest, markets: known }, pool)
    } catch (error) {
      const unreadable = !(error instanceof PoolReadError) || error.unreadable
      const reason = cap(unreadable ? `could not be checked: ${error instanceof Error ? error.message : String(error)}` : (error as Error).message)
      return { status: unreadable ? "unreadable" : "invalid", reason, market: null }
    }
  }
  const v = await validateMarket(reader, rpc, manifest, market)
  if (v.valid) return { status: "valid", market }
  return { status: v.unreadable ? "unreadable" : "invalid", reason: v.reason ?? "invalid", market }
}

function write(store: RegistryStore, pool: string, source: RegistrySource, outcome: Outcome): Promise<void> {
  if (outcome.status === "valid") return store.record({ pool, source, valid: true, reason: null, market: outcome.market })
  return store.record({ pool, source, valid: outcome.status === "unreadable" ? null : false, reason: outcome.reason, market: outcome.market })
}

const sourceFor = (manifest: Manifest, pool: string): RegistrySource =>
  manifest.markets.some((m) => m.contracts.pool === pool) ? "seed" : "discovered"

// ---------------------------------------------------------------- discovery

/** Events per page, and pages per run: the recorder route has a time budget (maxDuration). */
const EVENTS_PAGE = 200
const MAX_EVENT_PAGES = 40

export type DiscoverResult = {
  /** Pools seen in this run's events, in ledger order; each was checked (or marked unregistered). */
  checked: string[]
  /** True when the stored cursor was older than the RPC's retention: events in between are lost. */
  gap: boolean
}

/** The cursor row: one per Router, so a redeploy with a new Router scans afresh. */
export const cursorName = (manifest: Manifest) => `markets:${manifest.shared.router}`

function symbol(topic: xdr.ScVal | undefined): string | null {
  try {
    const v = topic ? scValToNative(topic) : null
    return typeof v === "string" ? v : null
  } catch {
    return null
  }
}

function native(v: xdr.ScVal): unknown {
  try {
    return scValToNative(v)
  } catch {
    return undefined
  }
}

/**
 * Scans the Router's and the factory's events since the stored cursor (`ingest_cursor`) and checks
 * every pool they name: `mkt_reg` and the factory's `mkt_new` (pool, escrow) are checked;
 * `mkt_unreg` marks the pool invalid. Events are applied in id order, so the last one wins. If the
 * cursor is older than the RPC's oldest ledger the scan restarts there and the gap is logged and
 * reported; markets are never invented to fill it. The cursor is saved after the checks are
 * written, so a failed run is repeated, not skipped.
 */
export async function discover(deps: RegistryDeps): Promise<DiscoverResult> {
  const { store, rpc, manifest } = deps
  const router = manifest.shared.router
  const factory = manifest.shared.factory
  const filters = [{ type: "contract" as const, contractIds: factory ? [router, factory] : [router] }]
  const name = cursorName(manifest)
  const [saved, health] = await Promise.all([store.cursor(name), rpc.getHealth()])

  let gap = false
  let request: EventsRequest
  if (saved?.cursor && saved.ledger >= health.oldestLedger) {
    request = { cursor: saved.cursor, filters, limit: EVENTS_PAGE }
  } else {
    if (saved) {
      gap = true
      console.warn(
        `registry: gap: the stored cursor (ledger ${saved.ledger}) is older than the RPC's oldest ledger ${health.oldestLedger}; ` +
          "scanning from there. Markets registered in between are missing until they are published or seeded.",
      )
    } else {
      console.info(`registry: first scan, from ledger ${health.oldestLedger} (older markets come from the manifest seeds)`)
    }
    request = { startLedger: health.oldestLedger, filters, limit: EVENTS_PAGE }
  }

  const events: RawEvent[] = []
  let last: { cursor: string; latestLedger: number } | null = null
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    let res: Awaited<ReturnType<RegistryRpc["getEvents"]>>
    try {
      res = await rpc.getEvents(request)
    } catch (error) {
      // The oldest ledger moves on a busy node: a start just behind it is refused once; start after it.
      if (request.startLedger === undefined || page > 0) throw error
      const now = await rpc.getHealth()
      request = { startLedger: now.oldestLedger + 1, filters, limit: EVENTS_PAGE }
      res = await rpc.getEvents(request)
    }
    events.push(...res.events)
    last = res
    const previous = request.cursor
    // An empty page is not the end: the RPC caps the ledgers scanned per call and hands back an
    // advanced cursor. The scan is done when the cursor reaches the tip or stops moving.
    if (res.events.length < EVENTS_PAGE && (res.cursor === previous || cursorLedger(res.cursor) >= res.latestLedger)) break
    if (res.cursor === previous) break
    request = { cursor: res.cursor, filters, limit: EVENTS_PAGE }
  }

  const actions = new Map<string, "check" | "unregistered">()
  const set = (pool: string, action: "check" | "unregistered") => {
    actions.delete(pool)
    actions.set(pool, action)
  }
  for (const e of [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (e.inSuccessfulContractCall === false) continue
    const from = idOf(e.contractId)
    const topic = symbol(e.topic[0])
    const data = native(e.value)
    if (from === router && topic === "mkt_reg" && isContract(data)) set(data, "check")
    else if (from === router && topic === "mkt_unreg" && isContract(data)) set(data, "unregistered")
    else if (factory && from === factory && topic === "mkt_new" && Array.isArray(data) && isContract(data[1]) && !actions.has(data[1])) {
      set(data[1], "check")
    }
  }

  if (actions.size > 0) {
    const rows = await store.rows()
    const known = knownMarkets(manifest, rows)
    for (const [pool, action] of actions) {
      const source = sourceFor(manifest, pool)
      if (action === "unregistered") {
        await store.record({ pool, source, valid: false, reason: "Unregistered from the Router.", market: null })
        continue
      }
      const stored = storedMarket(rows.find((r) => r.pool === pool)?.market)
      const outcome = await check(deps, pool, known, stored)
      // A market built in this batch holds its id for the next one (R2-37 collisions).
      if (outcome.market && !known.some((m) => m.contracts.pool === pool)) known.push(outcome.market)
      await write(store, pool, source, outcome)
    }
  }
  if (last) await store.saveCursor(name, Math.min(cursorLedger(last.cursor) || last.latestLedger, last.latestLedger), last.cursor)
  return { checked: [...actions.keys()], gap }
}

/**
 * Re-validates every seed and every registry row (R2-36: on every recorder run), so a market that
 * turns invalid drops off and a factory market the Router has since registered appears. Stored
 * markets are re-checked as stored; `skip` names pools this run already checked.
 */
export async function revalidate(deps: RegistryDeps, opts: { skip?: ReadonlySet<string> } = {}): Promise<void> {
  const { store, manifest } = deps
  const rows = await store.rows()
  const known = knownMarkets(manifest, rows)
  const pools = new Map<string, { source: RegistrySource; stored: Market | null }>()
  for (const seed of manifest.markets) pools.set(seed.contracts.pool, { source: "seed", stored: null })
  for (const row of rows) if (!pools.has(row.pool)) pools.set(row.pool, { source: row.source, stored: storedMarket(row.market) })
  for (const [pool, { source, stored }] of pools) {
    if (opts.skip?.has(pool)) continue
    const outcome = await check(deps, pool, known, stored)
    if (outcome.market && !known.some((m) => m.contracts.pool === pool)) known.push(outcome.market)
    await write(store, pool, source, outcome)
  }
}

// ---------------------------------------------------------------- reading the list

let loggedNotConfigured = false

/**
 * The markets clients see: the manifest seeds, minus those whose cached verdict is `valid = false`,
 * then every other registry row with `valid = true` whose market parses and is wired to this
 * manifest's Router and oracle (a row left from another deployment is not listed). Ids are unique,
 * seeds first. With the database down or not configured, the seeds alone (R2-36).
 */
export async function resolvedMarkets(deps: { store: RegistryStore; manifest: Manifest }): Promise<Market[]> {
  const { store, manifest } = deps
  const seeds = manifest.markets
  let rows: RegistryRow[]
  try {
    rows = await store.rows()
  } catch (error) {
    if (!(error instanceof DatabaseConfigError)) console.error(`registry: markets could not be read (${dbCode(error)}); listing the manifest seeds`)
    else if (!loggedNotConfigured) {
      loggedNotConfigured = true
      console.error("registry: DATABASE_URL is not set; listing the manifest seeds")
    }
    return seeds
  }
  const verdicts = new Map(rows.map((r) => [r.pool, r.valid]))
  const seedPools = new Set(seeds.map((m) => m.contracts.pool))
  const listed = seeds.filter((m) => verdicts.get(m.contracts.pool) !== false)
  const ids = new Set(seeds.map((m) => m.marketId))
  for (const row of rows) {
    if (row.valid !== true || seedPools.has(row.pool)) continue
    let market: Market
    try {
      market = parseMarket(row.market)
    } catch {
      console.error(`registry: the stored market of ${row.pool} does not parse; not listed`)
      continue
    }
    const c = market.contracts
    if (c.pool !== row.pool || c.router !== manifest.shared.router || c.oracle !== manifest.shared.oracle) continue
    if (ids.has(market.marketId)) continue
    ids.add(market.marketId)
    listed.push(market)
  }
  return listed
}

/** A database failure by its code only: its message can carry the host or the connection string. */
function dbCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "unknown"
}

// ---------------------------------------------------------------- publishing

/**
 * `POST /api/markets {pool}`: validates first and writes only a valid market, as `published`
 * (a seed stays a seed). An invalid or unverifiable pool writes nothing.
 */
export async function publishMarket(deps: RegistryDeps, pool: string): Promise<Outcome> {
  const rows = await deps.store.rows()
  const stored = storedMarket(rows.find((r) => r.pool === pool)?.market)
  const outcome = await check(deps, pool, knownMarkets(deps.manifest, rows), stored)
  if (outcome.status === "valid") {
    await deps.store.record({ pool, source: sourceFor(deps.manifest, pool) === "seed" ? "seed" : "published", valid: true, reason: null, market: outcome.market })
  }
  return outcome
}

/** Per IP and per instance (the faucet's approach, R42/R42c): each publish costs ~40 RPC reads. */
export const PUBLISH_WINDOW_MS = 60_000
export const PUBLISH_PER_IP = 5
export const PUBLISH_PER_INSTANCE = 30
const publishLimiter = createRollingLimiter({ windowMs: PUBLISH_WINDOW_MS, perKey: PUBLISH_PER_IP, global: PUBLISH_PER_INSTANCE })

export const takePublishSlot = (ip: string, now: number): boolean => publishLimiter.take(ip, now)
export const resetPublishLimitsForTests = (): void => publishLimiter.reset()

// ---------------------------------------------------------------- the SQL store

/** `market_registry` and `ingest_cursor` (db/migrations 0001, 0002) behind `RegistryStore`. */
export function sqlRegistryStore(sql: Sql): RegistryStore {
  return {
    async rows() {
      const rows = await sql<{ pool: string; market_id: string | null; source: RegistrySource; valid: boolean | null; reason: string | null; market: unknown }>`
        select pool, market_id, source, valid, reason, market from market_registry order by market_id nulls last, pool`
      return rows.map((r) => ({ pool: r.pool, marketId: r.market_id, source: r.source, valid: r.valid, reason: r.reason, market: r.market }))
    },
    async record(row) {
      const market = row.market ? JSON.stringify(row.market) : null
      await sql`
        insert into market_registry (pool, market_id, source, valid, reason, market, updated_at)
        values (${row.pool}, ${row.market?.marketId ?? null}, ${row.source}, ${row.valid}, ${row.reason}, ${market}::jsonb, now())
        on conflict (pool) do update set
          source = case
            when market_registry.source = 'seed' or excluded.source = 'seed' then 'seed'
            when market_registry.source = 'published' or excluded.source = 'published' then 'published'
            else 'discovered' end,
          valid = coalesce(excluded.valid, market_registry.valid),
          market = case when excluded.valid is null then market_registry.market else coalesce(excluded.market, market_registry.market) end,
          market_id = case when excluded.valid is null then market_registry.market_id else coalesce(excluded.market_id, market_registry.market_id) end,
          reason = excluded.reason,
          updated_at = excluded.updated_at`
    },
    async cursor(name) {
      const [row] = await sql<{ ledger: string | number | null; cursor: string | null }>`
        select ledger, cursor from ingest_cursor where name = ${name}`
      return row ? { ledger: Number(row.ledger ?? 0), cursor: row.cursor } : null
    },
    async saveCursor(name, ledger, cursor) {
      await sql`
        insert into ingest_cursor (name, ledger, cursor) values (${name}, ${ledger}, ${cursor})
        on conflict (name) do update set ledger = excluded.ledger, cursor = excluded.cursor`
    },
  }
}
