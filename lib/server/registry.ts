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
 * Reasons are this module's own words, addresses and hashes: RPC text goes to the server log only.
 *
 * Every wait is bounded (R2-40): discovery and re-validation stop at a deadline and save their
 * place, re-validation re-checks the listed markets each run and invalid ones a few at a time, and
 * reading the list gives up on a slow database and lists the seeds.
 */
import { Asset, StrKey, scValToNative, type xdr } from "@stellar/stellar-sdk"
import { cursorLedger, idOf, type RawEvent } from "@/lib/protocol/events"
import { parseMarket } from "@/lib/protocol/manifest"
import { fetchTopology } from "@/lib/protocol/market-state"
import { isContractError, readLive, toBool, type ContractReader } from "@/lib/protocol/reader"
import type { Manifest, Market, MarketContractName } from "@/lib/protocol/types"
import { contractWasmHash, WasmReadError, type LedgerEntriesRpc } from "@/lib/protocol/wasm"
import { DatabaseConfigError, type Sql } from "./db"
import { createRollingLimiter, redact } from "./request"

export const MARKET_KINDS: readonly MarketContractName[] = ["sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow"]

/** `reason` text is capped: it is stored and shown in the manager view, never a log dump. */
const MAX_REASON = 1_000

// ---------------------------------------------------------------- types

export type Validation = {
  valid: boolean
  reason?: string
  /** The check could not finish (an RPC failure, not an answer from the chain). */
  unreadable?: true
  /** What the RPC said about the reads that failed: for server logs only, never shown or stored. */
  detail?: string
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
  /** ISO time of the last write; re-checks of invalid rows go oldest first. */
  updatedAt: string | null
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

export type RegistryDeps = {
  store: RegistryStore
  reader: ContractReader
  rpc: RegistryRpc
  manifest: Manifest
  /** Wall clock (ms) for deadlines; `Date.now` by default. */
  now?: () => number
}

// ---------------------------------------------------------------- reads

/** A failure building a market from its pool: `unreadable` when the RPC, not the chain, failed. */
export class PoolReadError extends Error {
  constructor(
    message: string,
    readonly unreadable: boolean,
    /** The RPC's own words, for the server log only. */
    readonly detail?: string,
  ) {
    super(message)
    this.name = "PoolReadError"
  }
}

/** `wrongType`: the view answered, with a value of another type (`error` is this module's words then). */
type Read<T> = { ok: true; value: T } | { ok: false; error: string; unreadable: boolean; wrongType?: true }

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
    return { ok: false, error: error instanceof Error ? error.message : String(error), unreadable: false, wrongType: true }
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

/**
 * A failed read in this module's words: what was read, and whether the contract trapped or answered
 * a value of the wrong type ("expected a contract address" from the mappers below reads "is not a
 * contract address").
 */
function failure(what: string, r: { unreadable: boolean; wrongType?: true; error?: string }): string {
  if (r.unreadable) return what
  if (r.wrongType) return `${what} ${(r.error ?? "").replace(/^expected (.*?)(, got .*)?$/, "is not $1")}`
  return `${what} was refused by the contract`
}

function value<T>(r: Read<T>, what: string): T {
  if (r.ok) return r.value
  const message = r.unreadable ? `could not be checked: ${what}` : `${failure(what, r)}.`
  throw new PoolReadError(message, r.unreadable, `${what}: ${r.error}`)
}

/** The pinned hash for a kind, lower-case, or undefined when the manifest pins none. */
const pinOf = (manifest: Manifest, kind: MarketContractName) => manifest.wasmHashes[kind]?.toLowerCase()

/** The contract's Wasm hash against the manifest's pin for its kind: a problem, an unread note, or null. */
async function checkCode(
  rpc: LedgerEntriesRpc,
  manifest: Manifest,
  kind: MarketContractName,
  contractId: string,
): Promise<{ problem?: string; unread?: string; detail?: string }> {
  const pinned = pinOf(manifest, kind)
  if (!pinned) return { problem: `the manifest pins no Wasm for ${kind}, so ${contractId} cannot be trusted` }
  try {
    const actual = await contractWasmHash(rpc, contractId)
    if (actual !== pinned) return { problem: `${kind} (${contractId}) runs Wasm ${actual}, which the manifest does not pin for ${kind}` }
    return {}
  } catch (error) {
    if (error instanceof WasmReadError) return { problem: `${kind}: ${error.message}` }
    return { unread: `${kind} code`, detail: `${kind} code: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` }
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
  if (code.unread) throw new PoolReadError("could not be checked: the pool's code", true, code.detail)

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
  const wasmHashes = currentPins(manifest) ?? {}

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

/** Problems (answers from the chain), unread notes (RPC failures) and their RPC detail. */
type Findings = { problems: string[]; unread: string[]; detail: string[] }

function readWires(reader: ContractReader, c: Market["contracts"], wires: Wire[]) {
  return Promise.all(
    wires.map(([kind, fn, expected, option]) =>
      read<string | bigint | null>(reader, c[kind], fn, (v) => (typeof expected === "bigint" ? u64(v) : option ? optionalAddress(v) : address(v))),
    ),
  )
}

function judgeWires(f: Findings, wires: Wire[], results: Read<string | bigint | null>[]): void {
  results.forEach((r, i) => {
    const [kind, fn, expected] = wires[i]
    if (!r.ok) {
      ;(r.unreadable ? f.unread : f.problems).push(failure(`${kind} ${fn}`, r))
      f.detail.push(`${kind} ${fn}: ${r.error}`)
    } else if (r.value !== expected) {
      f.problems.push(`${kind} ${fn} is ${r.value === null ? "unset" : String(r.value)}, not ${String(expected)}`)
    }
  })
}

function verdict(f: Findings): Validation | null {
  const detail = f.detail.length > 0 ? { detail: f.detail.join("; ") } : {}
  if (f.problems.length > 0) return { valid: false, reason: cap(f.problems.join("; ")), ...detail }
  if (f.unread.length > 0) return { valid: false, unreadable: true, reason: cap(`could not be checked: ${f.unread.join(", ")}`), ...detail }
  return null
}

/**
 * 0001's topology rule (`Router.market(pool)` and the manager's maturity) plus: the market is
 * registered with this network's Router; each contract is wired to this network's oracle,
 * Permissioning and RiskControl and to the market's own config, recovery escrow and manager (PT
 * and YT are minted by the manager only); the underlying is the Stellar asset contract of its code
 * and issuer; and every market contract runs the Wasm the manifest pins for its kind. A market
 * wired to foreign infrastructure is invalid.
 *
 * In three steps, each returning early on a definite problem (R2-40): what needs no read (the
 * market's Router and oracle, its underlying); then the Router registration and the manager's
 * shared contracts (four reads); then the rest (about 25 reads).
 */
export async function validateMarket(reader: ContractReader, rpc: LedgerEntriesRpc, manifest: Manifest, market: Market): Promise<Validation> {
  const f: Findings = { problems: [], unread: [], detail: [] }
  const c = market.contracts
  const s = manifest.shared
  const sac = market.underlying.sac

  if (c.router !== s.router) f.problems.push(`its Router (${c.router}) is not this network's Router`)
  if (c.oracle !== s.oracle) f.problems.push(`its oracle (${c.oracle}) is not this network's oracle`)
  try {
    const derived = new Asset(market.underlying.code, market.underlying.issuer).contractId(manifest.networkPassphrase)
    if (derived !== sac) f.problems.push(`its underlying ${sac} is not the asset contract of ${market.underlying.code}:${market.underlying.issuer}`)
  } catch {
    f.problems.push(`its underlying ${market.underlying.code}:${market.underlying.issuer} is not a valid asset`)
  }
  if (f.problems.length > 0) return verdict(f) as Validation

  const shared: Wire[] = [
    ["manager", "oracle_address", s.oracle],
    ["manager", "permissioning_address", s.permissioning],
    ["manager", "risk_control", s.riskControl, "option"],
  ]
  const [registered, sharedReads] = await Promise.all([
    read(reader, s.router, "is_registered", toBool, [{ type: "address", value: c.pool }]),
    readWires(reader, c, shared),
  ])
  if (!registered.ok) {
    ;(registered.unreadable ? f.unread : f.problems).push(failure("Router is_registered", registered))
    f.detail.push(`Router is_registered: ${registered.error}`)
  } else if (!registered.value) {
    f.problems.push("the pool is not registered with the Router")
  }
  judgeWires(f, shared, sharedReads)
  if (f.problems.length > 0) return verdict(f) as Validation

  const wires: Wire[] = [
    ["pool", "config_address", c.config],
    ["pool", "recovery_escrow", c.recoveryEscrow, "option"],
    ["manager", "config_address", c.config],
    ["sy", "underlying_address", sac],
    ["sy", "permissioning_address", s.permissioning],
    ["sy", "risk_control", s.riskControl, "option"],
    ["sy", "recovery_escrow", c.recoveryEscrow],
    ["pt", "permissioning_address", s.permissioning],
    ["pt", "recovery_escrow", c.recoveryEscrow],
    ["pt", "minter", c.manager],
    ["yt", "permissioning_address", s.permissioning],
    ["yt", "oracle_address", s.oracle],
    ["yt", "recovery_escrow", c.recoveryEscrow],
    ["yt", "minter", c.manager],
    ["config", "underlying", sac],
    ["config", "maturity", BigInt(market.maturity)],
    ["recoveryEscrow", "underlying_address", sac],
  ]
  const [topology, wired, code] = await Promise.all([
    fetchTopology(reader, market),
    readWires(reader, c, wires),
    Promise.all(MARKET_KINDS.map((kind) => checkCode(rpc, manifest, kind, c[kind]))),
  ])
  if (topology.status === "unavailable") {
    const refused = isContractError(topology.error)
    ;(refused ? f.problems : f.unread).push(failure("Router market", { unreadable: !refused }))
    f.detail.push(`Router market: ${topology.error}`)
  } else if (!topology.value.matches) {
    f.problems.push(`the Router lists different contracts for this pool: ${topology.value.mismatches.join(", ")}`)
  }
  judgeWires(f, wires, wired)
  for (const r of code) {
    if (r.problem) f.problems.push(r.problem)
    if (r.unread) f.unread.push(r.unread)
    if (r.detail) f.detail.push(r.detail)
  }
  return verdict(f) ?? { valid: true }
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

/** A stored market wired to another Router or oracle: never listed under this manifest, never re-checked. */
const isForeign = (manifest: Manifest, market: Market | null) =>
  market !== null && (market.contracts.router !== manifest.shared.router || market.contracts.oracle !== manifest.shared.oracle)

export type Outcome =
  | { status: "valid"; market: Market }
  | { status: "invalid" | "unreadable"; reason: string; market: Market | null; detail?: string }

const unreadableReason = (what: string) => cap(what.startsWith("could not be checked") ? what : `could not be checked: ${what}`)

/**
 * Builds (unless known) and validates one pool; writes nothing. A pool not built yet must first be
 * registered with the Router: one read, so a flood of factory markets nobody registered stays cheap.
 */
async function check(deps: RegistryDeps, pool: string, known: Market[], stored: Market | null): Promise<Outcome> {
  const { reader, rpc, manifest } = deps
  let market = manifest.markets.find((m) => m.contracts.pool === pool) ?? stored
  if (!market) {
    if (!isContract(pool)) return { status: "invalid", reason: `${pool} is not a contract address.`, market: null }
    const registered = await read(reader, manifest.shared.router, "is_registered", toBool, [{ type: "address", value: pool }])
    if (!registered.ok) {
      const reason = registered.unreadable ? unreadableReason("Router is_registered") : `${failure("Router is_registered", registered)}.`
      return { status: registered.unreadable ? "unreadable" : "invalid", reason, market: null, detail: `Router is_registered: ${registered.error}` }
    }
    if (!registered.value) return { status: "invalid", reason: "the pool is not registered with the Router", market: null }
    try {
      market = await marketFromPool(reader, rpc, { ...manifest, markets: known }, pool)
    } catch (error) {
      const ours = error instanceof PoolReadError
      const unreadable = !ours || error.unreadable
      const message = error instanceof Error ? error.message : String(error)
      // An unexpected error's text is not this module's: it goes to the log, not into the reason.
      const reason = ours ? (unreadable ? unreadableReason(message) : cap(message)) : unreadableReason("the pool")
      return { status: unreadable ? "unreadable" : "invalid", reason, market: null, detail: ours ? error.detail : message }
    }
  }
  const v = await validateMarket(reader, rpc, manifest, market)
  if (v.valid) return { status: "valid", market }
  return { status: v.unreadable ? "unreadable" : "invalid", reason: v.reason ?? "invalid", market, ...(v.detail ? { detail: v.detail } : {}) }
}

/** The RPC's words behind a verdict: logged server-side only, redacted (R2-40, R2-41). */
export function logOutcome(where: string, pool: string, outcome: Outcome): void {
  if (outcome.status === "unreadable") console.error(`${where}: ${pool} could not be checked: ${redact(outcome.detail ?? outcome.reason)}`)
  else if (outcome.status === "invalid" && outcome.detail) console.error(`${where}: ${pool} is invalid: ${redact(outcome.detail)}`)
}

function write(store: RegistryStore, pool: string, source: RegistrySource, outcome: Outcome): Promise<void> {
  if (outcome.status === "valid") return store.record({ pool, source, valid: true, reason: null, market: outcome.market })
  logOutcome("registry", pool, outcome)
  return store.record({ pool, source, valid: outcome.status === "unreadable" ? null : false, reason: outcome.reason, market: outcome.market })
}

const sourceFor = (manifest: Manifest, pool: string): RegistrySource =>
  manifest.markets.some((m) => m.contracts.pool === pool) ? "seed" : "discovered"

const late = (deps: RegistryDeps, deadline?: number) => deadline !== undefined && (deps.now ?? Date.now)() >= deadline

// ---------------------------------------------------------------- discovery

/** Events per page, and pages per run: the recorder route has a time budget (maxDuration). */
const EVENTS_PAGE = 200
const MAX_EVENT_PAGES = 40

export type DiscoverResult = {
  /** Pools named by the events applied this run, in event order; each was checked or marked. */
  checked: string[]
  /** True when the stored cursor was older than the RPC's retention: events in between are lost. */
  gap: boolean
  /** False when the scan stopped at its deadline (or page cap); the next run resumes at the cursor. */
  complete: boolean
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

type Step = { pool: string; action: "check" | "unregistered"; at: string }

/** One page's events as steps: the last event per pool wins, in the order of those last events. */
function stepsOf(manifest: Manifest, events: RawEvent[]): Step[] {
  const router = manifest.shared.router
  const factory = manifest.shared.factory
  const steps = new Map<string, Step>()
  for (const e of [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (e.inSuccessfulContractCall === false) continue
    const from = idOf(e.contractId)
    const topic = symbol(e.topic[0])
    const data = native(e.value)
    let step: Step | null = null
    if (from === router && topic === "mkt_reg" && isContract(data)) step = { pool: data, action: "check", at: e.id }
    else if (from === router && topic === "mkt_unreg" && isContract(data)) step = { pool: data, action: "unregistered", at: e.id }
    else if (factory && from === factory && topic === "mkt_new" && Array.isArray(data) && isContract(data[1])) {
      const pending = steps.get(data[1])
      step = { pool: data[1], action: pending?.action ?? "check", at: e.id }
    }
    if (step) {
      steps.delete(step.pool)
      steps.set(step.pool, step)
    }
  }
  return [...steps.values()]
}

/**
 * Scans the Router's and the factory's events since the stored cursor (`ingest_cursor`) and checks
 * every pool they name: `mkt_reg` and the factory's `mkt_new` (pool, escrow) are checked;
 * `mkt_unreg` marks the pool invalid. Events are applied page by page in id order, so the last one
 * wins. If the cursor is older than the RPC's oldest ledger the scan restarts there and the gap is
 * logged and reported; markets are never invented to fill it.
 *
 * Bounded (R2-40): the cursor is saved after each pool (at that pool's event) and after each page,
 * so a run cut short is resumed, never repeated; with `deadline` (ms) the scan starts no new page or
 * pool after it and returns `complete: false`.
 */
export async function discover(deps: RegistryDeps, opts: { deadline?: number } = {}): Promise<DiscoverResult> {
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

  const checked: string[] = []
  let rows: RegistryRow[] | null = null
  let known: Market[] = []
  const save = (cursor: string, latestLedger: number) => store.saveCursor(name, Math.min(cursorLedger(cursor) || latestLedger, latestLedger), cursor)

  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    if (late(deps, opts.deadline)) return { checked, gap, complete: false }
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

    for (const step of stepsOf(manifest, res.events)) {
      if (late(deps, opts.deadline)) return { checked, gap, complete: false }
      if (!rows) {
        rows = await store.rows()
        known = knownMarkets(manifest, rows)
      }
      const source = sourceFor(manifest, step.pool)
      if (step.action === "unregistered") {
        await store.record({ pool: step.pool, source, valid: false, reason: "Unregistered from the Router.", market: null })
      } else {
        const stored = storedMarket(rows.find((r) => r.pool === step.pool)?.market)
        const outcome = await check(deps, step.pool, known, stored)
        // A market built in this run holds its id for the next one (R2-37 collisions).
        if (outcome.market && !known.some((m) => m.contracts.pool === step.pool)) known.push(outcome.market)
        await write(store, step.pool, source, outcome)
      }
      checked.push(step.pool)
      await save(step.at, res.latestLedger)
    }
    await save(res.cursor, res.latestLedger)

    const previous = request.cursor
    // An empty page is not the end: the RPC caps the ledgers scanned per call and hands back an
    // advanced cursor. The scan is done when the cursor reaches the tip or stops moving.
    if (res.events.length < EVENTS_PAGE && (res.cursor === previous || cursorLedger(res.cursor) >= res.latestLedger)) {
      return { checked, gap, complete: true }
    }
    if (res.cursor === previous) return { checked, gap, complete: true }
    request = { cursor: res.cursor, filters, limit: EVENTS_PAGE }
  }
  return { checked, gap, complete: false }
}

/** Invalid rows re-checked per run, oldest first: they are re-checked at once when an event names them. */
export const INVALID_RECHECKS_PER_RUN = 2

/**
 * Re-validates the listed markets each recorder run (R2-36): every seed and every row whose
 * verdict is `valid = true` or not known yet (`null`), so a market that turns invalid drops off.
 * Invalid rows are re-checked a few per run, oldest first (R2-40), so a factory market the Router
 * has since registered appears without every junk row costing reads each run; rows of another
 * Router or oracle are skipped. Stored markets are re-checked as stored; `skip` names pools this
 * run already checked; nothing new starts after `deadline` (ms).
 */
export async function revalidate(
  deps: RegistryDeps,
  opts: { skip?: ReadonlySet<string>; deadline?: number } = {},
): Promise<{ checked: string[]; complete: boolean }> {
  const { store, manifest } = deps
  const rows = await store.rows()
  const known = knownMarkets(manifest, rows)
  const seedPools = new Set(manifest.markets.map((m) => m.contracts.pool))
  const queue: { pool: string; source: RegistrySource; stored: Market | null }[] = manifest.markets.map((m) => ({
    pool: m.contracts.pool,
    source: "seed",
    stored: null,
  }))
  const others = rows
    .filter((r) => !seedPools.has(r.pool))
    .map((r) => ({ row: r, stored: storedMarket(r.market) }))
    .filter(({ stored }) => !isForeign(manifest, stored))
  for (const { row, stored } of others) if (row.valid !== false) queue.push({ pool: row.pool, source: row.source, stored })
  const oldest = others
    .filter(({ row }) => row.valid === false)
    .sort((a, b) => (a.row.updatedAt ?? "").localeCompare(b.row.updatedAt ?? ""))
    .slice(0, INVALID_RECHECKS_PER_RUN)
  for (const { row, stored } of oldest) queue.push({ pool: row.pool, source: row.source, stored })

  const checked: string[] = []
  for (const { pool, source, stored } of queue) {
    if (opts.skip?.has(pool)) continue
    if (late(deps, opts.deadline)) return { checked, complete: false }
    const outcome = await check(deps, pool, known, stored)
    if (outcome.market && !known.some((m) => m.contracts.pool === pool)) known.push(outcome.market)
    await write(store, pool, source, outcome)
    checked.push(pool)
  }
  return { checked, complete: true }
}

// ---------------------------------------------------------------- reading the list

let loggedNotConfigured = false

/** How long a page waits for the registry before it lists the seeds (R2-40). */
export const ROWS_TIMEOUT_MS = 1_500

class RegistryTimeout extends Error {}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RegistryTimeout()), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** The manifest's current pins for the market kinds (R2-12), or undefined when it pins none. */
function currentPins(manifest: Manifest): Record<string, string> | undefined {
  const pins = Object.fromEntries(MARKET_KINDS.flatMap((k) => (manifest.wasmHashes[k] ? [[k, manifest.wasmHashes[k]]] : [])))
  return Object.keys(pins).length > 0 ? pins : undefined
}

/**
 * The markets clients see: the manifest seeds, minus those whose cached verdict is `valid = false`,
 * then every other registry row with `valid = true` whose market parses and is wired to this
 * manifest's Router and oracle (a row left from another deployment is not listed). Ids are unique,
 * seeds first. A registry market carries the manifest's current pins, never stored ones: the
 * restore path trusts them (R29b, R2-40). With the database down, not configured, or slower than
 * `timeoutMs`, the seeds alone (R2-36, R2-40).
 */
export async function resolvedMarkets(deps: { store: RegistryStore; manifest: Manifest; timeoutMs?: number }): Promise<Market[]> {
  const { store, manifest } = deps
  const seeds = manifest.markets
  let rows: RegistryRow[]
  try {
    rows = await within(store.rows(), deps.timeoutMs ?? ROWS_TIMEOUT_MS)
  } catch (error) {
    if (error instanceof RegistryTimeout) console.error("registry: the markets read timed out; listing the manifest seeds")
    else if (!(error instanceof DatabaseConfigError)) console.error(`registry: markets could not be read (${dbCode(error)}); listing the manifest seeds`)
    else if (!loggedNotConfigured) {
      loggedNotConfigured = true
      console.error("registry: DATABASE_URL is not set; listing the manifest seeds")
    }
    return seeds
  }
  const pins = currentPins(manifest)
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
    if (c.pool !== row.pool || isForeign(manifest, market)) continue
    if (ids.has(market.marketId)) continue
    ids.add(market.marketId)
    const current: Market = { ...market }
    delete current.wasmHashes
    if (pins) current.wasmHashes = pins
    listed.push(current)
  }
  return listed
}

/** A registry market the app does not list, with why (R2-38): this app's own words, never RPC text. */
export type InvalidMarket = { pool: string; name: string | null; reason: string }

/**
 * The rows the registry holds as `valid = false` (a hidden seed too), for the manager view
 * (R2-38). Their reasons were written by this module's checks (Task 11: no RPC text). When the
 * registry cannot be read, or is slower than `timeoutMs`, the answer is `unavailable`, never an
 * empty list that would read as "nothing is invalid".
 */
export async function invalidMarkets(deps: {
  store: RegistryStore
  manifest: Manifest
  timeoutMs?: number
}): Promise<{ status: "ok"; rows: InvalidMarket[] } | { status: "unavailable" }> {
  let rows: RegistryRow[]
  try {
    rows = await within(deps.store.rows(), deps.timeoutMs ?? ROWS_TIMEOUT_MS)
  } catch (error) {
    if (!(error instanceof DatabaseConfigError) && !(error instanceof RegistryTimeout)) {
      console.error(`registry: invalid markets could not be read (${dbCode(error)})`)
    }
    return { status: "unavailable" }
  }
  const seedNames = new Map(deps.manifest.markets.map((m) => [m.contracts.pool, m.displayName]))
  const invalid = rows.filter((r) => r.valid === false)
  return {
    status: "ok",
    rows: invalid.map((r) => {
      let name: string | null = seedNames.get(r.pool) ?? null
      if (name === null && r.market) {
        try {
          name = parseMarket(r.market).displayName
        } catch {
          name = null
        }
      }
      return { pool: r.pool, name, reason: r.reason ?? "it did not pass the registry's checks" }
    }),
  }
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
      const rows = await sql<{
        pool: string
        market_id: string | null
        source: RegistrySource
        valid: boolean | null
        reason: string | null
        market: unknown
        updated_at: Date | string | null
      }>`
        select pool, market_id, source, valid, reason, market, updated_at from market_registry order by market_id nulls last, pool`
      return rows.map((r) => ({
        pool: r.pool,
        marketId: r.market_id,
        source: r.source,
        valid: r.valid,
        reason: r.reason,
        market: r.market,
        updatedAt: r.updated_at == null ? null : new Date(r.updated_at).toISOString(),
      }))
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
