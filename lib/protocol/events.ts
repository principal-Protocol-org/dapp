import { scValToNative, type xdr } from "@stellar/stellar-sdk"
import { formatAmount, shorten } from "./format"
import { getMarket } from "./manifest"
import { createRpcServer } from "./stellar"
import type { Manifest, Market } from "./types"

/**
 * Event-based transaction history (spec §8). Shapes and topic symbols are read from the contracts
 * at `org/principal` `origin/feat/tranche-1-mvp` (`env.events().publish((symbol_short!(..),), data)`).
 * Topic names collide across contracts (`mint`, `transfer`, `burn`, `seize`, `paused`), so every
 * event is decoded per contract role, never by topic alone.
 */

export type Role = "sy" | "manager" | "pt" | "yt" | "pool" | "escrow" | "oracle"

export type DecodedEvent = { role: Role; topic: string; fields: Record<string, unknown> }

export type HistoryKind =
  | "deposit"
  | "withdraw"
  | "mint"
  | "buy_pt"
  | "sell_pt"
  | "buy_yt"
  | "sell_yt"
  | "add_liquidity"
  | "remove_liquidity"
  | "recombine"
  | "claim"
  | "redeem"
  | "transfer"
  /** Not a known combination: every decoded event is listed instead. */
  | "other"

export type HistoryEntry = {
  hash: string
  ledger: number
  /** Ledger close time of the first event, ISO 8601. */
  at: string
  kind: HistoryKind
  lines: string[]
  /** Raw event amounts (SCALE-free, token units) for the entry figures on the portfolio. */
  facts?: EntryFacts
}

export type EntryFacts = {
  /** `manager.mint`: SY shares in, notional minted, fee in SY shares. Mint entries only. */
  mint?: { notional: bigint; syShares: bigint; feeShares: bigint }
  /** `pool.buy_pt`: SY paid in and PT received. Buy PT entries only. */
  buyPt?: { syIn: bigint; ptOut: bigint }
}

export type OracleUpdate = { ledger: number; value: bigint }

export type AccountHistory = {
  entries: HistoryEntry[]
  window: { oldestLedger: number; latestLedger: number }
  oracleUpdates: OracleUpdate[]
  /** True when pagination stopped at MAX_PAGES: older entries may be missing. */
  truncated: boolean
}

/** Data field names per role and topic, in the contract's tuple order. */
const SHAPES: Record<Role, Record<string, readonly string[]>> = {
  // market_pool/src/lib.rs
  pool: {
    buy_pt: ["from", "to", "sy_in", "pt_out", "fee_shares"], // :303
    sell_pt: ["from", "to", "pt_in", "sy_out", "fee_shares"], // :332
    sell_yt: ["from", "to", "yt_in", "sy_out", "fee_shares"], // :377
    add_liq: ["from", "pt_used", "sy_used", "lp"], // :449
    zap_liq: ["from", "pt_used", "sy_used", "lp"], // :505
    rem_liq: ["from", "to", "lp", "pt_out", "sy_out"], // :1106
    lp_xfer: ["from", "to", "amount"], // :558
    lp_seize: ["caller", "account", "amount"], // :584
  },
  // principal_manager/src/lib.rs
  manager: {
    mint: ["from", "sy_shares", "notional", "fee_shares"], // :410
    recombine: ["from", "amount", "shares"], // :453
    redeem: ["from", "pt_amount", "yt_amount", "from_pt", "from_yt"], // :520
    yt_claim: ["from", "gross", "paid"], // :549
  },
  // sy_wrapper/src/lib.rs
  sy: {
    deposit: ["from", "amount", "shares"], // :270
    withdraw: ["from", "shares", "underlying_out"], // :338
    sy_xfer: ["from", "to", "amount"], // :197
    seize: ["caller", "account", "shares"], // :511
  },
  // pt_token/src/lib.rs
  pt: {
    transfer: ["from", "to", "amount"], // :206, :243
    mint: ["to", "amount"], // :315
    burn: ["from", "amount"], // :340
    seize: ["caller", "account", "amount"], // :369
  },
  // yt_token/src/lib.rs
  yt: {
    transfer: ["from", "to", "amount"], // :300, :338
    mint: ["to", "amount"], // :412
    burn: ["from", "amount"], // :439
    seize: ["caller", "account", "amount"], // :487
    claim: ["from", "amount"], // :534
  },
  // recovery_escrow/src/lib.rs
  escrow: {
    finalize: ["id", "account", "underlying_from_pt", "underlying_from_yt"], // :339
    recovery: ["caller", "id", "account", "sy_shares", "pt_amount", "yt_amount", "lp_amount"], // :499
  },
  // oracle_adapter/src/lib.rs
  oracle: {
    ref_set: ["value", "timestamp"], // :90
  },
}

/** Decodes one event for the contract role that emitted it; null for an unknown topic or shape. */
export function decodeEvent(role: Role, topic: string, data: unknown): DecodedEvent | null {
  const names = Object.hasOwn(SHAPES[role], topic) ? SHAPES[role][topic] : undefined
  if (!names || !Array.isArray(data) || data.length !== names.length) return null
  const fields: Record<string, unknown> = {}
  names.forEach((name, i) => {
    fields[name] = data[i]
  })
  return { role, topic, fields }
}

// ---- fetching ----

export const EVENTS_LIMIT = 1000
/**
 * Request budget per contract group (5 contract IDs each), counting every `getEvents` call. The
 * walk goes newest window first, so when the budget runs out only the OLDEST activity is lost and
 * `truncated` is set. A window cut off mid-way is dropped whole, so the loss stays contiguous.
 */
export const MAX_PAGES = 60
/** Ledgers per scanned window (about 14 hours at 5 s per ledger). */
export const WINDOW_LEDGERS = 10_000

export type RawEvent = {
  id: string
  ledger: number
  ledgerClosedAt: string
  txHash: string
  contractId?: string | { contractId(): string } | { toString(): string }
  topic: xdr.ScVal[]
  value: xdr.ScVal
  inSuccessfulContractCall?: boolean
}

type EventFilters = { type: "contract"; contractIds: string[] }[]
type EventsRequest =
  | { filters: EventFilters; limit: number; startLedger: number; endLedger?: number; cursor?: never }
  | { filters: EventFilters; limit: number; cursor: string; startLedger?: never; endLedger?: never }

/** The RPC calls used here; `createRpcServer` satisfies it, tests inject a fake. */
export type EventsRpcServer = {
  getHealth(): Promise<{ oldestLedger: number; latestLedger: number }>
  getEvents(req: EventsRequest): Promise<{ events: RawEvent[]; cursor: string }>
}

/** The emitting contract's id, whichever shape the RPC client gives it. */
export function idOf(c: RawEvent["contractId"]): string | undefined {
  if (!c) return undefined
  if (typeof c === "string") return c
  if ("contractId" in c && typeof c.contractId === "function") return c.contractId()
  return String(c)
}

/** The ledger a Soroban event id / cursor points at (TOID: ledger in the high 32 bits); NaN if unreadable. */
export function cursorLedger(cursor: string): number {
  try {
    return Number(BigInt(cursor.split("-")[0]) >> 32n)
  } catch {
    return Number.NaN
  }
}

type Scan = { maxPages: number; windowLedgers: number }

async function fetchGroup(
  server: EventsRpcServer,
  contractIds: string[],
  window: { oldestLedger: number; latestLedger: number },
  scan: Scan,
) {
  const filters = [{ type: "contract" as const, contractIds }]
  const events: RawEvent[] = []
  let calls = 0
  for (let end = window.latestLedger + 1; end > window.oldestLedger; end -= scan.windowLedgers) {
    const start = Math.max(window.oldestLedger, end - scan.windowLedgers)
    const inWindow: RawEvent[] = []
    let cursor: string | undefined
    for (;;) {
      if (calls >= scan.maxPages) return { events, truncated: true }
      calls++
      const res = await server.getEvents(
        cursor === undefined
          ? { startLedger: start, endLedger: end, filters, limit: EVENTS_LIMIT }
          : { cursor, filters, limit: EVENTS_LIMIT },
      )
      let pastEnd = false
      for (const e of res.events) {
        if (e.ledger >= end) pastEnd = true
        else inWindow.push(e)
      }
      // An empty page is not the end: the RPC may cap the range scanned per call and hand back an
      // advanced cursor. The window is done when the cursor stops moving or reaches its end.
      if (pastEnd || res.cursor === cursor || cursorLedger(res.cursor) >= end) break
      cursor = res.cursor
    }
    events.push(...inWindow)
  }
  return { events, truncated: false }
}

function mentions(value: unknown, account: string): boolean {
  if (typeof value === "string") return value === account
  if (Array.isArray(value)) return value.some((v) => mentions(v, account))
  if (value && typeof value === "object") return Object.values(value).some((v) => mentions(v, account))
  return false
}

type Item = {
  id: string
  ledger: number
  at: string
  hash: string
  role: Role
  topic: string
  data: unknown
  decoded: DecodedEvent | null
}

const key = (i: Pick<Item, "role" | "topic">) => `${i.role}.${i.topic}`

// ---- grouping ----

/** Token-level bookkeeping events that accompany an action; they never decide its kind. */
const SECONDARY = new Set(["pt.transfer", "yt.transfer", "pt.mint", "yt.mint", "pt.burn", "yt.burn", "sy.sy_xfer", "pool.lp_xfer"])
const TRANSFERS = new Set(["pt.transfer", "yt.transfer", "sy.sy_xfer", "pool.lp_xfer"])

/** First match wins. `needs` must all be present; every other non-secondary event must be in `allowed`. */
const RULES: { kind: HistoryKind; needs: string[]; allowed: string[] }[] = [
  { kind: "redeem", needs: ["manager.redeem"], allowed: ["manager.redeem", "yt.claim", "sy.withdraw"] },
  { kind: "recombine", needs: ["manager.recombine"], allowed: ["manager.recombine"] },
  { kind: "claim", needs: ["manager.yt_claim"], allowed: ["manager.yt_claim", "yt.claim", "sy.withdraw"] },
  { kind: "buy_yt", needs: ["manager.mint", "pool.sell_pt"], allowed: ["manager.mint", "pool.sell_pt"] },
  { kind: "mint", needs: ["manager.mint"], allowed: ["manager.mint", "sy.deposit"] },
  { kind: "sell_yt", needs: ["pool.sell_yt"], allowed: ["pool.sell_yt"] },
  { kind: "buy_pt", needs: ["pool.buy_pt"], allowed: ["pool.buy_pt"] },
  { kind: "sell_pt", needs: ["pool.sell_pt"], allowed: ["pool.sell_pt"] },
  { kind: "remove_liquidity", needs: ["pool.rem_liq"], allowed: ["pool.rem_liq"] },
  { kind: "claim", needs: ["yt.claim"], allowed: ["yt.claim"] },
  { kind: "deposit", needs: ["sy.deposit"], allowed: ["sy.deposit"] },
  { kind: "withdraw", needs: ["sy.withdraw"], allowed: ["sy.withdraw"] },
]

function classify(items: Item[]): HistoryKind {
  const keys = new Set(items.map(key))
  if (items.every((i) => TRANSFERS.has(key(i)))) return "transfer"
  const primary = [...keys].filter((k) => !SECONDARY.has(k))
  // add_liq and zap_liq are one kind with two topics.
  if (primary.length > 0 && primary.every((k) => k === "pool.add_liq" || k === "pool.zap_liq")) return "add_liquidity"
  for (const r of RULES) {
    if (!r.needs.every((n) => keys.has(n))) continue
    return primary.every((k) => r.allowed.includes(k)) ? r.kind : "other"
  }
  return "other"
}

type Ctx = { account: string; code: string; decimals: number }

function lineFor(i: Item, kind: HistoryKind, c: Ctx): string | null {
  const f = i.decoded?.fields
  if (!f) return null
  const amt = (k: string) => formatAmount(f[k] as bigint, c.decimals)
  switch (key(i)) {
    case "sy.deposit":
      return `Deposited ${amt("amount")} ${c.code}`
    case "sy.withdraw":
      return kind === "withdraw" ? `Withdrew ${amt("shares")} SY for ${amt("underlying_out")} ${c.code}` : null
    case "manager.mint":
      return `Minted ${amt("notional")} PT + ${amt("notional")} YT`
    case "manager.recombine":
      return `Recombined ${amt("amount")} PT + ${amt("amount")} YT into ${amt("shares")} SY`
    case "manager.redeem": {
      const out = (f.from_pt as bigint) + (f.from_yt as bigint)
      return `Redeemed ${amt("pt_amount")} PT + ${amt("yt_amount")} YT. Received ${formatAmount(out, c.decimals)} ${c.code}`
    }
    case "manager.yt_claim":
      return `Claimed ${amt("paid")} ${c.code} of yield`
    case "pool.buy_pt":
      return `Bought ${amt("pt_out")} PT for ${amt("sy_in")} SY`
    case "pool.sell_pt":
      return `Sold ${amt("pt_in")} PT for ${amt("sy_out")} SY`
    case "pool.sell_yt":
      return `Sold ${amt("yt_in")} YT for ${amt("sy_out")} SY`
    case "pool.add_liq":
    case "pool.zap_liq":
      return `Added ${amt("pt_used")} PT + ${amt("sy_used")} SY, received ${amt("lp")} LP`
    case "pool.rem_liq":
      return `Removed ${amt("lp")} LP, received ${amt("pt_out")} PT + ${amt("sy_out")} SY`
    default:
      return null
  }
}

const TOKEN: Partial<Record<Role, string>> = { pt: "PT", yt: "YT", sy: "SY", pool: "LP" }

function transferLine(i: Item, c: Ctx): string {
  const f = i.decoded?.fields ?? {}
  const amount = formatAmount(f.amount as bigint, c.decimals)
  const token = TOKEN[i.role] ?? ""
  return f.from === c.account
    ? `Sent ${amount} ${token} to ${shorten(String(f.to))}`
    : `Received ${amount} ${token} from ${shorten(String(f.from))}`
}

function show(v: unknown): string {
  if (typeof v === "string") return /^[GC][A-Z2-7]{55}$/.test(v) ? shorten(v) : v
  return String(v)
}

function genericLine(i: Item): string {
  if (!i.decoded) return `${i.role} ${i.topic} (unrecognised event)`
  const fields = Object.entries(i.decoded.fields).map(([k, v]) => `${k}=${show(v)}`)
  return `${i.role} ${i.topic}: ${fields.join(", ")}`
}

/** The raw amounts the portfolio needs; only for a plain mint or buy_pt. A missing or mistyped field omits the facts. */
function factsOf(items: Item[], kind: HistoryKind): { facts: EntryFacts } | Record<string, never> {
  const find = (k: string) => items.find((i) => key(i) === k)?.decoded?.fields
  const big = (...v: unknown[]) => v.every((x) => typeof x === "bigint")
  if (kind === "mint") {
    const f = find("manager.mint")
    if (f && big(f.notional, f.sy_shares, f.fee_shares)) {
      return { facts: { mint: { notional: f.notional as bigint, syShares: f.sy_shares as bigint, feeShares: f.fee_shares as bigint } } }
    }
  }
  if (kind === "buy_pt") {
    const f = find("pool.buy_pt")
    if (f && big(f.sy_in, f.pt_out)) return { facts: { buyPt: { syIn: f.sy_in as bigint, ptOut: f.pt_out as bigint } } }
  }
  return {}
}

function toEntry(items: Item[], c: Ctx): HistoryEntry {
  const kind = classify(items)
  let lines: string[]
  if (kind === "other") lines = items.map(genericLine)
  else if (kind === "transfer") lines = items.map((i) => transferLine(i, c))
  else lines = items.flatMap((i) => lineFor(i, kind, c) ?? [])
  if (lines.length === 0) lines = items.map(genericLine)
  const first = items[0]
  return { hash: first.hash, ledger: first.ledger, at: first.at, kind, lines, ...factsOf(items, kind) }
}

export async function fetchAccountHistory(p: {
  manifest: Manifest
  marketId: string
  account: string
  server?: EventsRpcServer
  /** The RPC window, when the caller already read `getHealth` (shared across markets). */
  window?: { oldestLedger: number; latestLedger: number }
  /** Test hooks: request budget and window size. */
  maxPages?: number
  windowLedgers?: number
}): Promise<AccountHistory> {
  const market: Market | undefined = getMarket(p.manifest, p.marketId)
  if (!market) throw new Error(`Unknown market "${p.marketId}".`)
  const server = p.server ?? (createRpcServer(p.manifest.rpcUrl))
  const k = market.contracts
  const roleOf = new Map<string, Role>([
    [k.sy, "sy"],
    [k.manager, "manager"],
    [k.pt, "pt"],
    [k.yt, "yt"],
    [k.pool, "pool"],
    [k.recoveryEscrow, "escrow"],
    [k.oracle, "oracle"],
  ])

  const health = p.window ?? (await server.getHealth())
  const window = { oldestLedger: health.oldestLedger, latestLedger: health.latestLedger }
  const scan = { maxPages: p.maxPages ?? MAX_PAGES, windowLedgers: p.windowLedgers ?? WINDOW_LEDGERS }
  // The RPC accepts at most 5 contract IDs per request (checked 2026-10-27): two requests.
  const groups = await Promise.all([
    fetchGroup(server, [k.sy, k.manager, k.pt, k.yt, k.pool], window, scan),
    fetchGroup(server, [k.recoveryEscrow, k.oracle], window, scan),
  ])

  const seen = new Set<string>()
  const items: Item[] = []
  for (const e of groups.flatMap((g) => g.events)) {
    const contract = idOf(e.contractId)
    const role = contract ? roleOf.get(contract) : undefined
    if (!role || e.inSuccessfulContractCall === false || seen.has(e.id)) continue
    seen.add(e.id)
    const topic = e.topic.length > 0 ? scValToNative(e.topic[0]) : undefined
    if (typeof topic !== "string") continue
    const data: unknown = scValToNative(e.value)
    items.push({ id: e.id, ledger: e.ledger, at: e.ledgerClosedAt, hash: e.txHash, role, topic, data, decoded: decodeEvent(role, topic, data) })
  }
  items.sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const oracleUpdates: OracleUpdate[] = []
  const byHash = new Map<string, Item[]>()
  for (const i of items) {
    if (i.role === "oracle") {
      if (i.topic === "ref_set" && i.decoded) oracleUpdates.push({ ledger: i.ledger, value: i.decoded.fields.value as bigint })
      continue
    }
    if (!mentions(i.data, p.account)) continue
    const list = byHash.get(i.hash)
    if (list) list.push(i)
    else byHash.set(i.hash, [i])
  }

  const ctx: Ctx = { account: p.account, code: market.underlying.code, decimals: market.underlying.decimals }
  const entries = [...byHash.values()].map((g) => toEntry(g, ctx)).reverse()
  return { entries, window, oracleUpdates, truncated: groups.some((g) => g.truncated) }
}
