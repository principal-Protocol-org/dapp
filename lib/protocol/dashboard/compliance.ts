/**
 * The compliance page's read model: RecoveryEscrow records read live (D-16), `get_record(0..record_count)`,
 * joined with the indexed `recovery` and `finalize` events, which add the transaction hashes and stand
 * in for an archived record; and each underlying asset's administrator and issuer flags.
 */
import { fetchMarketCompliance, type MarketCompliance } from "../compliance"
import type { Horizon } from "../horizon"
import { allLive, dedupeReads, liveValue, readLive, toAddress, toBigint, toBool, unavailable, type ContractReader } from "../reader"
import type { Live, Manifest, ReadSource } from "../types"

/** `RecoveryRecord` (recovery_escrow 665bb67 `:161-187`, unchanged at 24d980d), in underlying units unless named. */
export type RecoveryRecordFields = {
  id: bigint
  account: string
  ledger: number
  timestamp: bigint
  /** SY shares seized directly, and the underlying they unwrapped to. */
  syShares: bigint
  underlyingFromSy: bigint
  /** LP seized, and what the pool paid out for it: PT (held), SY shares and their underlying. */
  lpAmount: bigint
  lpPt: bigint
  lpSyShares: bigint
  underlyingFromLp: bigint
  /** PT and YT seized, held in escrow until `finalize_record`. */
  ptAmount: bigint
  ytAmount: bigint
  /** Yield the seized YT had accrued at seizure (before the YT fee). */
  ytYieldAtSeize: bigint
  finalized: boolean
  underlyingFromPt: bigint
  underlyingFromYt: bigint
}

/**
 * A record read live, with the read that returned it, or one whose storage entry is archived
 * (about 30 days after its last write, `RECORD_TTL_LEDGERS`): the RPC then answers "requires
 * restoring", and the indexed row stands in for it.
 */
export type RecoveryRecord = ({ status: "live"; source?: ReadSource } & RecoveryRecordFields) | { status: "archived"; id: bigint }

/** `simulateContractRead`'s message for a simulation that needs a restore first (`stellar.ts`). */
const ARCHIVED = /requires restoring/

function parseRecord(raw: unknown): RecoveryRecordFields {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("get_record did not return a struct")
  const r = raw as Record<string, unknown>
  const ledger = r.ledger
  if (typeof ledger !== "number" || !Number.isInteger(ledger) || ledger < 0) throw new Error("record ledger is not a u32")
  return {
    id: toBigint(r.id),
    account: toAddress(r.account),
    ledger,
    timestamp: toBigint(r.timestamp),
    syShares: toBigint(r.sy_shares),
    underlyingFromSy: toBigint(r.underlying_from_sy),
    lpAmount: toBigint(r.lp_amount),
    lpPt: toBigint(r.lp_pt),
    lpSyShares: toBigint(r.lp_sy_shares),
    underlyingFromLp: toBigint(r.underlying_from_lp),
    ptAmount: toBigint(r.pt_amount),
    ytAmount: toBigint(r.yt_amount),
    ytYieldAtSeize: toBigint(r.yt_yield_at_seize),
    finalized: toBool(r.finalized),
    underlyingFromPt: toBigint(r.underlying_from_pt),
    underlyingFromYt: toBigint(r.underlying_from_yt),
  }
}

/** Records are read this many at a time, so a long list does not fire every simulation at once. */
const BATCH = 10

/**
 * Every record of `escrow`, oldest first. Unavailable when `record_count` or any record fails to
 * read for a reason other than archival: the list is never shown partial.
 */
export async function fetchEscrowRecords(reader: ContractReader, escrow: string): Promise<Live<RecoveryRecord[]>> {
  const count = await readLive<unknown, bigint>(reader, { contractId: escrow, functionName: "record_count" }, toBigint)
  if (count.status === "unavailable") return count

  const reads: Live<RecoveryRecord>[] = []
  for (let from = 0n; from < count.value; from += BigInt(BATCH)) {
    const ids: bigint[] = []
    for (let id = from; id < count.value && id < from + BigInt(BATCH); id++) ids.push(id)
    const batch = await Promise.all(
      ids.map(async (id): Promise<Live<RecoveryRecord>> => {
        const live = await readLive<unknown, RecoveryRecordFields>(
          reader,
          { contractId: escrow, functionName: "get_record", args: [{ type: "u64", value: id }] },
          parseRecord,
        )
        if (live.status === "unavailable") {
          if (ARCHIVED.test(live.error)) return liveValue({ status: "archived", id }, count.ledger)
          return unavailable(`record ${id}: ${live.error}`, live.source)
        }
        return { ...live, value: { status: "live", ...live.value, source: live.source } }
      }),
    )
    const failed = batch.find((r) => r.status === "unavailable")
    if (failed) return failed
    reads.push(...batch)
  }

  return allLive([count, ...reads] as const, ([, ...records]) => records)
}

/** An indexed RecoveryEscrow event (the fields the join reads), as the events API lists it. */
export type IndexedEscrowEvent = {
  id: string
  contractId: string
  topic: string
  ledger: number
  closeTime: string
  txHash: string
  data: Record<string, unknown>
}

/**
 * One record of an escrow, for the compliance page:
 * - `live`: read live, with its own read (the drawer's `get_record --id N`) and, from the index, the
 *   seizure and finalization events (null when the index does not hold them; `indexError` when the
 *   index could not be read; `indexPending` while it has not answered yet).
 * - `indexed`: archived on-chain, shown from its indexed `recovery` event (Review Focus 4).
 * - `waiting`: archived on-chain, and the index has not answered yet: its stand-in is still coming.
 * - `unavailable`: archived on-chain, and the index does not hold it (or could not be read).
 */
export type EscrowRow =
  | {
      kind: "live"
      id: bigint
      record: Live<RecoveryRecordFields>
      seizure: IndexedEscrowEvent | null
      finalization: IndexedEscrowEvent | null
      indexError: string | null
      indexPending: boolean
    }
  | { kind: "indexed"; id: bigint; seizure: IndexedEscrowEvent; finalization: IndexedEscrowEvent | null }
  | { kind: "waiting"; id: bigint }
  | { kind: "unavailable"; id: bigint; reason: string }

const ARCHIVED_WORDS = "is archived on-chain (its read requires restoring)"

/**
 * The records of `escrow`, oldest first, each joined with its indexed events by escrow contract and
 * record id (`data.id`, a decimal string). `index` is every indexed `recovery` and `finalize` event,
 * why the index could not be read, or "pending" before it answers: live records never wait for it
 * (D-16, live first); only an archived record's stand-in does.
 */
export function joinEscrowRecords(
  escrow: string,
  records: Extract<Live<RecoveryRecord[]>, { status: "live" }>,
  index: { events: readonly IndexedEscrowEvent[] } | { error: string } | "pending",
): EscrowRow[] {
  const pending = index === "pending"
  const events = !pending && "events" in index ? [...index.events].sort((a, b) => a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : []
  const find = (topic: string, id: bigint) => events.find((e) => e.contractId === escrow && e.topic === topic && String(e.data.id) === id.toString()) ?? null
  const indexError = !pending && "error" in index ? index.error : null
  return records.value.map((r): EscrowRow => {
    const seizure = find("recovery", r.id)
    const finalization = find("finalize", r.id)
    if (r.status === "archived") {
      if (pending) return { kind: "waiting", id: r.id }
      if (seizure) return { kind: "indexed", id: r.id, seizure, finalization }
      const why = indexError ? `the event index could not be read: ${indexError}` : "the event index holds no recovery event for it"
      return { kind: "unavailable", id: r.id, reason: `Record ${r.id} ${ARCHIVED_WORDS}, and ${why}` }
    }
    const { status, source, ...fields } = r
    void status
    const record: Live<RecoveryRecordFields> = source ? { ...liveValue(fields, source.ledger), source } : liveValue(fields, records.ledger)
    return { kind: "live", id: r.id, record, seizure, finalization, indexError, indexPending: pending }
  })
}

/** One underlying asset's compliance model and administrator, for the compliance page. */
export type AssetCompliance = {
  sac: string
  code: string
  issuer: string
  /** The markets that hold it. */
  marketIds: string[]
  /** SAC (with the issuer's flags, from Horizon) or SEP-57, read as /app reads it (`fetchMarketCompliance`). */
  model: Live<MarketCompliance>
  /** `admin()` on the asset contract, with its read (D-7). */
  admin: Live<string>
  /** The issuer's Horizon account, where the flags are read: they are account flags, not a contract view. */
  flagsUrl: string
}

/**
 * Every distinct underlying asset's model and `admin()`. The admin read is shared with the model's
 * (one call, through `dedupeReads`), so the figure keeps that read's provenance.
 */
export async function fetchAssetCompliance(horizon: Horizon, horizonUrl: string, reader: ContractReader, manifest: Manifest): Promise<AssetCompliance[]> {
  const bySac = new Map<string, { market: Manifest["markets"][number]; marketIds: string[] }>()
  for (const market of manifest.markets) {
    const entry = bySac.get(market.underlying.sac)
    if (entry) entry.marketIds.push(market.marketId)
    else bySac.set(market.underlying.sac, { market, marketIds: [market.marketId] })
  }
  const once = dedupeReads(reader)
  return Promise.all(
    [...bySac.values()].map(async ({ market, marketIds }): Promise<AssetCompliance> => {
      const { sac, code, issuer } = market.underlying
      const [model, admin] = await Promise.all([
        fetchMarketCompliance(horizon, once, market),
        readLive<unknown, string>(once, { contractId: sac, functionName: "admin" }, toAddress),
      ])
      return { sac, code, issuer, marketIds, model, admin, flagsUrl: `${horizonUrl.replace(/\/+$/, "")}/accounts/${encodeURIComponent(issuer)}` }
    }),
  )
}
