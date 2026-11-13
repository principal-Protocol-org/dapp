/**
 * Calls that need a market's admin powers, on a market the run deployed itself (Suite B; R7-2, R7-5):
 * the SAC admin's `set_authorized`, the RecoveryEscrow's seizure and settlement (`seize_all_positions`,
 * `finalize_record`, read back with `get_record` and `account_records`), and the oracle admin's value
 * and freshness window. Each is signed by a keypair the caller holds and sent as the app sends a
 * transaction: built, prepared by the RPC and checked against what was built (`assertPreparedMatches`),
 * given the app's resource-fee headroom (these calls follow one another on the same entries: Task 3,
 * finding 2), signed, sent and confirmed.
 *
 * No server code here (`pnpm test` loads `tests/live/`), and no secret is ever printed.
 */
import { Address, BASE_FEE, Contract, type Keypair, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { createRpcReader, type ContractReader } from "@/lib/protocol/reader"
import { assertPreparedMatches, withResourceFeeHeadroom } from "@/lib/protocol/review"
import {
  createRpcServer,
  failedTransactionReason,
  pollTransactionStatus,
  submitSignedTransaction,
  type ScArg,
} from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"
import { json, sleep } from "./util"

type Network = Pick<Manifest, "rpcUrl" | "networkPassphrase">

/** A confirmed transaction: its hash, the ledger it landed in and the call's return value. */
export type Sent = { hash: string; ledger: number; returnValue: unknown }

const TX_TIMEOUT_SECONDS = 120

export const scAddress = (account: string) => new Address(account).toScVal()
export const scI128 = (value: bigint) => nativeToScVal(value, { type: "i128" })
export const scU64 = (value: bigint | number) => nativeToScVal(BigInt(value), { type: "u64" })
export const scBool = (value: boolean) => xdr.ScVal.scvBool(value)
export const scBytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"))
export const scAddressVec = (accounts: string[]) => xdr.ScVal.scvVec(accounts.map(scAddress))

/** The ledger a transaction landed in, asked again while the RPC node asked does not know it yet. */
async function ledgerOf(rpcUrl: string, hash: string): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    const tx = await createRpcServer(rpcUrl).getTransaction(hash)
    if (tx.status !== "NOT_FOUND") return tx.ledger
    if (attempt === 30) throw new Error(`transaction ${hash} confirmed, then not found by the RPC ${attempt} times`)
    await sleep(1_000)
  }
}

/** `contractId.method(args)` signed by `signer`, sent and confirmed; throws unless it succeeded. */
export async function sendAs(p: { manifest: Network; signer: Keypair; contractId: string; method: string; args: xdr.ScVal[] }): Promise<Sent> {
  const { rpcUrl, networkPassphrase } = p.manifest
  const call = `${p.contractId}.${p.method}`
  const server = createRpcServer(rpcUrl)
  const account = await server.getAccount(p.signer.publicKey())
  const built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(p.contractId).call(p.method, ...p.args))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build()
  const fromRpc = await server.prepareTransaction(built)
  // RPC may add footprint, resources and fee; it may not change the call or authorize anything else.
  assertPreparedMatches(built, fromRpc)
  const prepared = withResourceFeeHeadroom(fromRpc)
  assertPreparedMatches(built, prepared)
  prepared.sign(p.signer)
  const { hash, status } = await submitSignedTransaction({ rpcUrl, networkPassphrase, signedXdr: prepared.toXDR() })
  // Not taken: nothing of it can land (a caller may retry it once, `tests/live/retry.ts`).
  if (status === "TRY_AGAIN_LATER") throw new Error(`${call} ${hash}: TRY_AGAIN_LATER, the network is busy and did not accept it`)
  const polled = await pollTransactionStatus({ rpcUrl, hash, attempts: 30, intervalMs: 2_000 })
  if (polled.status !== "SUCCESS") {
    const why = polled.status === "FAILED" ? `: ${failedTransactionReason(polled.failure)}` : ""
    throw new Error(`${call} ${hash} ${polled.status}${why}`)
  }
  if (polled.decodeError) throw new Error(`${call} ${hash}: ${polled.decodeError}`)
  return { hash, ledger: await ledgerOf(rpcUrl, hash), returnValue: polled.returnValue }
}

/** A read of `contractId.functionName(args)`, asked again until it is from `minLedger` or later. */
export async function readAt<T>(reader: ContractReader, call: { contractId: string; functionName: string; args?: ScArg[] }, minLedger = 0): Promise<{ value: T; ledger: number }> {
  for (let attempt = 1; ; attempt++) {
    const r = await reader<T>(call)
    if (r.latestLedger >= minLedger) return { value: r.value, ledger: r.latestLedger }
    if (attempt === 30) throw new Error(`${call.contractId}.${call.functionName} still read before ledger ${minLedger} (at ${r.latestLedger})`)
    await sleep(1_000)
  }
}

// --- the SAC ---------------------------------------------------------------------------------------

/** `SAC.set_authorized(account, authorize)`, signed by the SAC admin. */
export function sacSetAuthorized(p: { manifest: Network; admin: Keypair; sac: string; account: string; authorize: boolean }): Promise<Sent> {
  return sendAs({ manifest: p.manifest, signer: p.admin, contractId: p.sac, method: "set_authorized", args: [scAddress(p.account), scBool(p.authorize)] })
}

// --- the oracle ------------------------------------------------------------------------------------

/** The oracle's primary source id (R4-8), hex: the source every value is sent under. */
export async function oraclePrimarySource(reader: ContractReader, oracle: string): Promise<string> {
  const { value } = await reader<unknown>({ contractId: oracle, functionName: "get_primary_source" })
  const hex = value instanceof Uint8Array ? Buffer.from(value).toString("hex") : typeof value === "string" ? value.toLowerCase() : ""
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`the oracle has no primary source (${json(value)})`)
  return hex
}

/**
 * `OracleAdapter.set_reference_value(admin, primary source, value, timestamp)`, signed by the oracle
 * admin, as the keeper sends it (`lib/server/oracle-keeper.ts`). `accepted` is its return value: the
 * oracle refuses a value by returning false in a successful transaction (R4-8).
 */
export async function oracleSetValue(p: { manifest: Manifest; oracleAdmin: Keypair; value: bigint; timestamp: number }): Promise<Sent & { accepted: boolean }> {
  const oracle = p.manifest.shared.oracle
  const source = await oraclePrimarySource(createRpcReader(p.manifest), oracle)
  const sent = await sendAs({
    manifest: p.manifest,
    signer: p.oracleAdmin,
    contractId: oracle,
    method: "set_reference_value",
    args: [scAddress(p.oracleAdmin.publicKey()), scBytes(source), scI128(p.value), scU64(p.timestamp)],
  })
  return { ...sent, accepted: sent.returnValue === true }
}

/** `OracleAdapter.set_safety_params(admin, max_stale_seconds, max_deviation_bps)`, signed by the oracle admin. */
export function oracleSetSafetyParams(p: { manifest: Manifest; oracleAdmin: Keypair; maxStaleSeconds: number; maxDeviationBps: number }): Promise<Sent> {
  return sendAs({
    manifest: p.manifest,
    signer: p.oracleAdmin,
    contractId: p.manifest.shared.oracle,
    method: "set_safety_params",
    args: [scAddress(p.oracleAdmin.publicKey()), scU64(p.maxStaleSeconds), nativeToScVal(p.maxDeviationBps, { type: "u32" })],
  })
}

// --- the RecoveryEscrow ----------------------------------------------------------------------------

/** `RecoveryEscrow.RecoveryRecord` (principal 665bb67, `contracts/recovery_escrow/src/lib.rs`). */
export type RecoveryRecord = {
  id: bigint
  account: string
  ledger: number
  timestamp: bigint
  sy_shares: bigint
  underlying_from_sy: bigint
  lp_amount: bigint
  lp_pt: bigint
  lp_sy_shares: bigint
  underlying_from_lp: bigint
  pt_amount: bigint
  yt_amount: bigint
  yt_yield_at_seize: bigint
  finalized: boolean
  underlying_from_pt: bigint
  underlying_from_yt: bigint
}

const RECORD_AMOUNTS = [
  "sy_shares",
  "underlying_from_sy",
  "lp_amount",
  "lp_pt",
  "lp_sy_shares",
  "underlying_from_lp",
  "pt_amount",
  "yt_amount",
  "yt_yield_at_seize",
  "underlying_from_pt",
  "underlying_from_yt",
] as const

/** A record as `scValToNative` decodes it, checked field by field. */
export function parseRecoveryRecord(raw: unknown): RecoveryRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`a recovery record is a struct, got ${json(raw)}`)
  const r = raw as Record<string, unknown>
  const expected = ["id", "account", "ledger", "timestamp", "finalized", ...RECORD_AMOUNTS].sort()
  if (json(Object.keys(r).sort()) !== json(expected)) throw new Error(`unexpected recovery record fields: ${Object.keys(r).sort().join(", ")}`)
  const big = (k: string) => {
    if (typeof r[k] !== "bigint") throw new Error(`recovery record ${k} is not an integer: ${json(r[k])}`)
    return r[k] as bigint
  }
  if (typeof r.account !== "string") throw new Error(`recovery record account is not an address: ${json(r.account)}`)
  if (typeof r.finalized !== "boolean") throw new Error(`recovery record finalized is not a boolean: ${json(r.finalized)}`)
  if (typeof r.ledger !== "number") throw new Error(`recovery record ledger is not a u32: ${json(r.ledger)}`)
  const amounts = Object.fromEntries(RECORD_AMOUNTS.map((k) => [k, big(k)])) as Record<(typeof RECORD_AMOUNTS)[number], bigint>
  return { id: big("id"), account: r.account, ledger: r.ledger, timestamp: big("timestamp"), finalized: r.finalized, ...amounts }
}

/** `seize_all_positions(admin, accounts)`, signed by the issuer authority (the SAC admin). Returns the record ids. */
export async function seizeAllPositions(p: { manifest: Manifest; market: Market; admin: Keypair; accounts: string[] }): Promise<Sent & { ids: bigint[] }> {
  const sent = await sendAs({
    manifest: p.manifest,
    signer: p.admin,
    contractId: p.market.contracts.recoveryEscrow,
    method: "seize_all_positions",
    args: [scAddress(p.admin.publicKey()), scAddressVec(p.accounts)],
  })
  const ids = sent.returnValue
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "bigint")) throw new Error(`seize_all_positions returned ${json(ids)}, not record ids`)
  return { ...sent, ids: ids as bigint[] }
}

/** `finalize_record(admin, id)`: settles the PT and YT the record holds; returns what each settled into. */
export async function finalizeRecord(p: { manifest: Manifest; market: Market; admin: Keypair; id: bigint }): Promise<Sent & { fromPt: bigint; fromYt: bigint }> {
  const sent = await sendAs({
    manifest: p.manifest,
    signer: p.admin,
    contractId: p.market.contracts.recoveryEscrow,
    method: "finalize_record",
    args: [scAddress(p.admin.publicKey()), scU64(p.id)],
  })
  const out = sent.returnValue
  if (!Array.isArray(out) || out.length !== 2 || !out.every((v) => typeof v === "bigint")) throw new Error(`finalize_record returned ${json(out)}`)
  return { ...sent, fromPt: out[0] as bigint, fromYt: out[1] as bigint }
}

/** `get_record(id)`, read from `minLedger` or later. */
export async function readRecord(reader: ContractReader, market: Market, id: bigint, minLedger = 0): Promise<{ record: RecoveryRecord; ledger: number }> {
  const { value, ledger } = await readAt<unknown>(reader, { contractId: market.contracts.recoveryEscrow, functionName: "get_record", args: [{ type: "u64", value: id }] }, minLedger)
  return { record: parseRecoveryRecord(value), ledger }
}

/** `account_records(account)`: the ids of every record written for it, oldest first. */
export async function readAccountRecords(reader: ContractReader, market: Market, account: string, minLedger = 0): Promise<bigint[]> {
  const { value } = await readAt<unknown>(reader, { contractId: market.contracts.recoveryEscrow, functionName: "account_records", args: [{ type: "address", value: account }] }, minLedger)
  if (!Array.isArray(value) || !value.every((id) => typeof id === "bigint")) throw new Error(`account_records returned ${json(value)}`)
  return value as bigint[]
}

/** What any holder (an account or a contract, such as the escrow) has in a market. */
export type Positions = Record<"underlying" | "sy" | "pt" | "yt" | "lp", bigint>

/** `holder`'s underlying (its SAC balance), SY, PT, YT and LP, each read from `minLedger` or later. */
export async function positionsOf(reader: ContractReader, market: Market, holder: string, minLedger = 0): Promise<{ positions: Positions; ledger: number }> {
  const who: ScArg[] = [{ type: "address", value: holder }]
  const read = (contractId: string, functionName: string) => readAt<unknown>(reader, { contractId, functionName, args: who }, minLedger)
  const reads = await Promise.all([
    read(market.underlying.sac, "balance"),
    read(market.contracts.sy, "balance_of"),
    read(market.contracts.pt, "balance"),
    read(market.contracts.yt, "balance"),
    read(market.contracts.pool, "lp_balance"),
  ])
  const [underlying, sy, pt, yt, lp] = reads.map((r, i) => {
    if (typeof r.value !== "bigint") throw new Error(`balance ${i} of ${holder} is not an integer: ${json(r.value)}`)
    return r.value
  })
  return { positions: { underlying, sy, pt, yt, lp }, ledger: Math.min(...reads.map((r) => r.ledger)) }
}
