/**
 * RecoveryEscrow records read live (D-16): `get_record(0..record_count)`. The indexed `recovery`
 * events add the transaction hash and stand in for an archived record (Task 7).
 */
import { allLive, liveValue, readLive, toAddress, toBigint, toBool, unavailable, type ContractReader } from "../reader"
import type { Live, ReadSource } from "../types"

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
