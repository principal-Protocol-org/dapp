import "server-only"

/**
 * The oracle keeper behind `/api/cron/oracle`. It runs in one of two modes (`ORACLE_KEEPER_MODE`):
 *
 * - **push** (default), for the app's own test deployments (testnet, local): the OracleAdapter's value
 *   is fresh for `max_stale_seconds` (read from the contract) and only its admin may push one, so a
 *   schedule calls this every 30 minutes with `ORACLE_ADMIN_SECRET`, a key that is the oracle's admin
 *   and nothing else (the protocol admin key never reaches the server). It pushes the value grown at
 *   `ORACLE_APY_PERCENT` a year for the time elapsed, stamped with the ledger time, as
 *   `scripts/dev-stack/oracle-tick.sh` does by hand. It never runs on mainnet.
 * - **feed** (spec 0004 D-21): the oracle reads its own SEP-40 feed (`sync_from_feed`, permissionless,
 *   principal 24d980d), so the keeper signs with `ORACLE_KEEPER_SECRET`, a funded key with no protocol
 *   role (it refuses the oracle admin's key), and holds no admin right: it may run on any network. One
 *   run covers every oracle of the manifest from that one account (spec 0005 M-13, `tickFeedAll`): it
 *   simulates each oracle's call and submits only what is worth a transaction.
 */
import { Keypair, StrKey, rpc, scValToNative, xdr, type Transaction } from "@stellar/stellar-sdk"
import { bytesToHex } from "@/lib/protocol/bytes"
import { BROKEN, ROUTINE, SIGNIFICANT } from "@/lib/protocol/dashboard/rejections"
import { decodeEvent, type DecodedEvent } from "@/lib/protocol/events"
import { assertPreparedMatches } from "@/lib/protocol/review"
import {
  buildInvocationEnvelope,
  createRpcServer,
  getLedgerClock,
  pollTransactionStatus,
  simulateContractRead,
  submitSignedTransaction,
  type ContractInvocation,
  type PolledTransactionResult,
} from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"
import type { KeeperFailure } from "./oracle-ticks"
import { serverRpcUrlOf } from "./rpc-urls"

/** Yearly growth of the test reference value, in percent. */
export const ORACLE_APY_PERCENT = 5
const SECONDS_PER_YEAR = 31_536_000
const TX_TIMEOUT_SECONDS = 60

/** The keeper cannot run: no key, a push key that is not the oracle admin, a feed key that is, or a network it must not feed. */
export class OracleKeeperConfigError extends Error {}

/** What a sent transaction that never confirmed reports as its code. */
export const NOT_CONFIRMED = "not confirmed"

/**
 * The keeper sent its update, and it did not land: it failed on-chain, or it was not confirmed in
 * time. `hash` is the transaction's (public); `code` is its result code (e.g.
 * `invokeHostFunctionTrapped`, `txBadSeq`), `FAILED` when RPC gave no result, or `not confirmed`.
 * The message carries the same two, never a key.
 */
export class OracleSubmitError extends Error {
  constructor(
    readonly hash: string,
    readonly code: string,
  ) {
    super(code === NOT_CONFIRMED ? `the oracle update was not confirmed in time (${hash})` : `the oracle update failed on-chain (${hash}, ${code})`)
    this.name = "OracleSubmitError"
  }
}

/** A FAILED transaction's result code: the host function's for a contract call, else the transaction's; `FAILED` when RPC gave none. */
function failureCode(result: xdr.TransactionResult | undefined): string {
  if (!result) return "FAILED"
  try {
    const outcome = result.result
    if (outcome.type === "txFailed") {
      const [operation] = outcome.results
      if (operation?.type === "opInner" && operation.tr.type === "invokeHostFunction") return operation.tr.invokeHostFunctionResult.type
      if (operation) return operation.type === "opInner" ? operation.tr.type : operation.type
    }
    return outcome.type
  } catch {
    // An undecodable result: the status alone.
    return "FAILED"
  }
}

/**
 * The value to push at ledger time `now`: `current × (1 + apy)^(elapsed / year)`, floored and never
 * below `current` (the contract refuses a decrease). Null when `now` is not after `lastTimestamp`:
 * the contract refuses a timestamp that does not move forward.
 */
export function nextReferenceValue(params: {
  current: bigint
  lastTimestamp: number
  now: number
  apyPercent?: number
}): bigint | null {
  const { current, lastTimestamp, now } = params
  if (now <= lastTimestamp) return null
  const factor = Math.pow(1 + (params.apyPercent ?? ORACLE_APY_PERCENT) / 100, (now - lastTimestamp) / SECONDS_PER_YEAR)
  const grown = (current * BigInt(Math.floor(factor * 1e12))) / 1_000_000_000_000n
  return grown > current ? grown : current
}

type OracleRead = "get_admin" | "get_reference_value" | "get_reference_timestamp" | "get_primary_source" | "last_rejection"

/** What the keeper needs from the network: reads of the oracle, the ledger clock, and one signed call. */
export type OracleChain = {
  read(fn: OracleRead): Promise<unknown>
  /** The latest ledger's close time, unix seconds. */
  ledgerTime(): Promise<number>
  /** Sends `invocation` signed by `signer` and waits for success; returns the hash and the call's return value. */
  send(signer: Keypair, invocation: ContractInvocation): Promise<{ hash: string; returnValue: unknown }>
}

/** The RPC calls the real chain makes; `rpc.Server` satisfies it, tests inject a fake. */
export type OracleRpcServer = {
  simulateTransaction: NonNullable<Parameters<typeof simulateContractRead>[0]["server"]>["simulateTransaction"]
  getLatestLedger(): Promise<{ sequence: number; closeTime: string | number }>
  getAccount(address: string): Promise<{ sequenceNumber(): string }>
  prepareTransaction(transaction: Transaction): Promise<Transaction>
  sendTransaction(transaction: Transaction): Promise<{
    status: string
    hash?: string
    errorResult?: xdr.TransactionResult
    errorResultXdr?: string
  }>
  getTransaction(hash: string): Promise<{ status: string; returnValue?: xdr.ScVal; events?: { contractEventsXdr?: xdr.ContractEvent[][] } }>
}

/** The oracle chain on the manifest's RPC. */
export function createOracleChain(manifest: Manifest, deps: { server?: OracleRpcServer } = {}): OracleChain {
  const { networkPassphrase } = manifest
  const rpcUrl = serverRpcUrlOf(manifest)
  const server: OracleRpcServer = deps.server ?? createRpcServer(rpcUrl)
  const oracle = manifest.shared.oracle
  return {
    async read(fn) {
      const result = await simulateContractRead({ rpcUrl, networkPassphrase, server, invocation: { contractId: oracle, functionName: fn, args: [] } })
      return result.value
    },
    async ledgerTime() {
      return (await getLedgerClock(server)).closeTime
    },
    send: (signer, invocation) => sendInvocation(manifest, server, signer, invocation),
  }
}

/** A sent call that landed: its hash, its return value, and the contract events it emitted when RPC returned them. */
export type Landed = { hash: string; returnValue: unknown; events?: readonly xdr.ContractEvent[] }

/**
 * Sends `invocation` signed by `signer` and waits for success; returns the hash, the call's return
 * value and its contract events. A transaction that does not land throws `OracleSubmitError` with its hash.
 */
async function sendInvocation(manifest: Manifest, server: OracleRpcServer, signer: Keypair, invocation: ContractInvocation): Promise<Landed> {
  const { networkPassphrase } = manifest
  const rpcUrl = serverRpcUrlOf(manifest)
  const sequence = (await server.getAccount(signer.publicKey())).sequenceNumber()
  const built = buildInvocationEnvelope({ source: signer.publicKey(), sequence, networkPassphrase, invocation, timeoutSeconds: TX_TIMEOUT_SECONDS })
  const prepared = await server.prepareTransaction(built)
  // RPC may add footprint, resources and fee; it may not change the call or authorize anything else (R29).
  assertPreparedMatches(built, prepared)
  prepared.sign(signer)
  const { hash } = await submitSignedTransaction({ rpcUrl, networkPassphrase, signedXdr: prepared.toEnvelope().toXDR("base64"), server })
  const polled = await pollTransactionStatus({ rpcUrl, hash, server, attempts: 30, intervalMs: 1_000 })
  if (polled.status === "FAILED") throw new OracleSubmitError(hash, failureCode(polled.failure?.result))
  if (polled.status !== "SUCCESS") throw new OracleSubmitError(hash, NOT_CONFIRMED)
  return polled.contractEvents ? { hash, returnValue: polled.returnValue, events: polled.contractEvents } : { hash, returnValue: polled.returnValue }
}

/** How the keeper feeds the oracle: it pushes a computed value (`set_reference_value`), or, from spec 0004 D-21, has the oracle read its feed. */
export type KeeperMode = "push" | "feed"

/**
 * One keeper run's outcome. Every outcome names its `mode` and its `signer` (the keeper key's public
 * key, never the secret), which the run's `oracle_ticks` row records (spec 0004 D-19).
 */
export type OracleTick = { mode: KeeperMode; signer: string } & (
  /** Push: the ledger clock has not moved since the last value; nothing was sent. */
  | { status: "unchanged"; value: string; timestamp: number }
  /** Push: the value landed. */
  | { status: "updated"; value: string; timestamp: number; hash: string }
  /**
   * The oracle refused the value (R4-8): `set_reference_value` or `sync_from_feed` returned false.
   * Push always sent it (`hash`). Feed mode sends only a new significant rejection; a repeat, a broken
   * feed or an unknown reason has no `hash` (not submitted). `value` and `timestamp` are the oracle's
   * `ref_rej` event's; null when no event said (`reason` is then `unknown`), or when the reason
   * carries the contract's (0, 0) placeholders, not a price (`feed_err`, `no_data`: `NO_PRICE_REASONS`).
   */
  | { status: "rejected"; value: string | null; timestamp: number | null; hash?: string; reason: string }
  /** Feed: the oracle took its feed's value (`ref_set`), in transaction `hash`. Null value: the landed call disagreed with its simulation. */
  | { status: "synced"; value: string | null; timestamp: number | null; hash: string }
  /** Feed: a routine rejection (`stale_ts`, `no_data`, `throttle`), never sent. `no_data` has no value or timestamp. */
  | { status: "skipped"; value: string | null; timestamp: number | null; reason: string }
)

/** The public key of the keeper's key, for a run's tick record; null when the key is unset or not a Stellar secret. */
export function keeperSigner(secret: string | undefined): string | null {
  const trimmed = secret?.trim()
  if (!trimmed) return null
  try {
    return Keypair.fromSecret(trimmed).publicKey()
  } catch {
    return null
  }
}

/** The keeper's key from the variable `name`; a config error naming the variable (never its value) when unset or invalid. */
function keeperKey(secret: string | undefined, name: string): Keypair {
  const trimmed = secret?.trim()
  if (!trimmed) throw new OracleKeeperConfigError(`${name} is not set.`)
  try {
    return Keypair.fromSecret(trimmed)
  } catch {
    throw new OracleKeeperConfigError(`${name} is not a valid Stellar secret key.`)
  }
}

/** The source id (R4-8) from `get_primary_source()`: `Option<BytesN<32>>` decoded as bytes, or null. */
function sourceHex(value: unknown): string | null {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex")
  if (typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  return null
}

/** Why the oracle refused: `last_rejection().reason`, or "unknown" when it cannot be read. */
async function rejectionReason(chain: OracleChain): Promise<string> {
  try {
    const rejection = (await chain.read("last_rejection")) as { reason?: unknown } | null
    return typeof rejection?.reason === "string" ? rejection.reason : "unknown"
  } catch {
    return "unknown"
  }
}

/** One keeper run: checks the key is the oracle admin, then pushes the next value unless the clock has not moved. */
export async function tickOracle(deps: { manifest: Manifest; secret: string | undefined; chain?: OracleChain }): Promise<OracleTick> {
  const { manifest } = deps
  if (manifest.network === "mainnet") throw new OracleKeeperConfigError("the oracle keeper runs only on testnet and local networks.")
  const keeper = keeperKey(deps.secret, "ORACLE_ADMIN_SECRET")
  const chain = deps.chain ?? createOracleChain(manifest)
  const run = { mode: "push" as const, signer: keeper.publicKey() }

  const admin = await chain.read("get_admin")
  if (admin !== keeper.publicKey()) throw new OracleKeeperConfigError("ORACLE_ADMIN_SECRET is not the key of the oracle admin.")

  const current = BigInt(String(await chain.read("get_reference_value")))
  const lastTimestamp = Number(await chain.read("get_reference_timestamp"))
  const now = await chain.ledgerTime()
  const next = nextReferenceValue({ current, lastTimestamp, now })
  if (next === null) return { ...run, status: "unchanged", value: current.toString(), timestamp: lastTimestamp }

  const source = sourceHex(await chain.read("get_primary_source"))
  if (!source) throw new OracleKeeperConfigError("the oracle has no primary source (set_sources was never called, or it is a v1 oracle).")

  const { hash, returnValue } = await chain.send(keeper, {
    contractId: manifest.shared.oracle,
    functionName: "set_reference_value",
    args: [
      { type: "address", value: keeper.publicKey() },
      { type: "bytes", value: source },
      { type: "i128", value: next.toString() },
      { type: "u64", value: String(now) },
    ],
  })
  // A rejection is a successful transaction that returned false: never report it as an update (R4-8).
  if (returnValue !== true) return { ...run, status: "rejected", value: next.toString(), timestamp: now, hash, reason: await rejectionReason(chain) }
  return { ...run, status: "updated", value: next.toString(), timestamp: now, hash }
}

// ---------------------------------------------------------------- feed mode (spec 0004 D-21, spec 0005 M-13)

/**
 * The reasons `sync_from_feed` can reject with (principal 24d980d `oracle_adapter/src/lib.rs:460-552`),
 * in D-21's three classes, from their one source (`lib/protocol/dashboard/rejections.ts`):
 * - significant: an attempted disallowed value change; with `recordRejections` (M-14), one
 *   transaction per new (reason, value) puts it on-chain with a hash;
 * - routine: no new data; never worth a transaction;
 * - broken feed: the feed's own data is unusable; no transaction, and the alert check raises `feed_broken`.
 */
export { BROKEN, ROUTINE, SIGNIFICANT }

/**
 * The keeper's own reason for an oracle with no feed source (`feed_source()` is `None`): nothing to
 * sync, so the run is `skipped` and sends nothing (M-13). Not a contract rejection: it is in none of
 * the three classes.
 */
export const NO_FEED_REASON = "no_feed"

/** What a run reports for an oracle whose transaction its deadline left unsent. */
export const NOT_SENT = "not sent"

const isIn = (list: readonly string[], reason: string) => list.includes(reason)

/** A simulation of `sync_from_feed`: its return value (native) and its events, as RPC reports them. */
export type FeedSimulation = { retval: unknown; events: readonly xdr.DiagnosticEvent[] }

/** What the feed keeper reads of one oracle: two views and a simulation. Sending goes through the run's one `KeeperAccount`. */
export type FeedChain = {
  read(fn: "feed_source" | "get_admin"): Promise<unknown>
  /** Simulates `invocation` with `source` as the transaction's source. A simulation error throws its text. */
  simulate(source: string, invocation: ContractInvocation): Promise<FeedSimulation>
}

/** The feed chain of `oracle` on the manifest's RPC. */
export function createFeedChain(manifest: Manifest, oracle: string, deps: { server?: OracleRpcServer } = {}): FeedChain {
  const { networkPassphrase } = manifest
  const rpcUrl = serverRpcUrlOf(manifest)
  const server: OracleRpcServer = deps.server ?? createRpcServer(rpcUrl)
  return {
    async read(fn) {
      return (await simulateContractRead({ rpcUrl, networkPassphrase, server, invocation: { contractId: oracle, functionName: fn, args: [] } })).value
    },
    async simulate(source, invocation) {
      const simulation = await server.simulateTransaction(buildInvocationEnvelope({ source, sequence: "0", networkPassphrase, invocation }))
      if (rpc.Api.isSimulationRestore(simulation)) throw new Error("the oracle needs archived ledger entries restored before it can sync")
      if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error)
      if (!simulation.result) throw new Error("the simulation returned no result")
      return { retval: scValToNative(simulation.result.retval), events: simulation.events ?? [] }
    },
  }
}

/** A built `sync_from_feed` as RPC prepared it (footprint, resources, fee), with what that preparing simulation said. */
export type PreparedSync = { transaction: Transaction } & FeedSimulation

/**
 * The keeper account's side of a feed run: its sequence number (read once per run), RPC's
 * preparation, the send, and one look at a sent hash. `createKeeperAccount` backs it with RPC.
 */
export type KeeperAccount = {
  /** The account's current sequence number. */
  sequence(address: string): Promise<string>
  /**
   * RPC's preparation of a built transaction, and the verdict of the simulation it rests on: the
   * keeper sends only while that fresh verdict still matches its decision. A simulation error throws its text.
   */
  prepare(transaction: Transaction): Promise<PreparedSync>
  /** Sends a signed transaction; the network's status (`PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER`, `ERROR`) and, for a refusal, its result. */
  send(transaction: Transaction): Promise<{ status: string; errorResult?: xdr.TransactionResult }>
  /** One look at a sent hash: `NOT_FOUND` until it is in a ledger, then `SUCCESS` (return value, contract events) or `FAILED` (result). */
  lookup(hash: string): Promise<PolledTransactionResult>
}

/** The keeper account on the manifest's RPC. */
export function createKeeperAccount(manifest: Manifest, deps: { server?: OracleRpcServer } = {}): KeeperAccount {
  const rpcUrl = serverRpcUrlOf(manifest)
  const server: OracleRpcServer = deps.server ?? createRpcServer(rpcUrl)
  return {
    sequence: async (address) => (await server.getAccount(address)).sequenceNumber(),
    // What `prepareTransaction` does (simulate, then assemble), keeping the simulation's return value and events.
    async prepare(transaction) {
      const simulation = await server.simulateTransaction(transaction)
      if (rpc.Api.isSimulationRestore(simulation)) throw new Error("the oracle needs archived ledger entries restored before it can sync")
      if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error)
      if (!simulation.result) throw new Error("the simulation returned no result")
      return {
        transaction: rpc.assembleTransaction(transaction, simulation).build(),
        retval: scValToNative(simulation.result.retval),
        events: simulation.events ?? [],
      }
    },
    async send(transaction) {
      const answer = await server.sendTransaction(transaction)
      // SDK 17 parses the refusal into `errorResult`; a raw answer carries `errorResultXdr`.
      let errorResult = answer.errorResult
      if (!errorResult && answer.errorResultXdr) {
        try {
          errorResult = xdr.TransactionResult.fromXdr(answer.errorResultXdr, "base64")
        } catch {
          // An undecodable result: the status alone.
        }
      }
      return errorResult ? { status: answer.status, errorResult } : { status: answer.status }
    },
    lookup: (hash) => pollTransactionStatus({ rpcUrl, hash, server, attempts: 1 }),
  }
}

/** A simulation of a function the contract does not export (a 665bb67 oracle has no `feed_source`). */
const MISSING_FUNCTION = /Error\(WasmVm, MissingValue\)/
/**
 * Contract error 15. The oracle's own 15 is `FeedNotConfigured` (24d980d), raised only when
 * `feed_source()` is `None`; the keeper reads that view first, so a 15 after it named a feed is
 * another contract's: the feed answered an error.
 */
const ERROR_15 = /Error\(Contract, #15\)/
const NO_FEED_VIEW = "the oracle has no feed_source function: its code predates sync_from_feed (principal 665bb67 or older)."
const FEED_ERROR_15 = "the feed answered an error (#15) to sync_from_feed: the oracle names a feed, so this is not its FeedNotConfigured."
/** Spec 0004 D-21: no oracle admin key lives on the server. The feed keeper's key must hold no protocol role. */
export const KEEPER_IS_ADMIN = "ORACLE_KEEPER_SECRET is the oracle admin's key: feed mode needs a key with no protocol role."

/** The oracle's own contract events, decoded (`ref_set`, `ref_rej`); anything else, or of another contract, is left out. */
function oracleEvents(events: readonly xdr.ContractEvent[], oracle: string): DecodedEvent[] {
  const decoded: DecodedEvent[] = []
  for (const event of events) {
    try {
      if (event.type.name !== "contract" || event.contractId === null) continue
      if (StrKey.encodeContract(Buffer.from(event.contractId.toBytes())) !== oracle) continue
      const [topic] = event.body.value.topics
      if (topic?.type !== "scvSymbol") continue
      const one = decodeEvent("oracle", String(topic.value), scValToNative(event.body.value.data))
      if (one) decoded.push(one)
    } catch {
      // An event of unexpected shape is not one of the oracle's.
    }
  }
  return decoded
}

type Point = { value: string | null; timestamp: number | null }
const NO_POINT: Point = { value: null, timestamp: null }
/** An event's (value, timestamp) as a tick reports them. */
function pointOf(event: DecodedEvent | undefined): Point {
  const { value, timestamp } = event?.fields ?? {}
  return { value: typeof value === "bigint" ? value.toString() : null, timestamp: typeof timestamp === "bigint" ? Number(timestamp) : null }
}

type Rejection = { reason: string; point: Point }
/** Reasons whose `ref_rej` carries the contract's placeholders (0, 0), not a price: the feed gave none (3af9388 `sync_from_feed`). */
export const NO_PRICE_REASONS: ReadonlySet<string> = new Set(["no_data", "feed_err"])
/** The `ref_rej` among `events` as a reason and its (value, timestamp); `no_data` and `feed_err` have no point. */
function rejectionOf(events: DecodedEvent[]): Rejection | null {
  const event = events.find((e) => e.topic === "ref_rej")
  const reason = event?.fields.reason
  if (typeof reason !== "string") return null
  return { reason, point: NO_PRICE_REASONS.has(reason) ? NO_POINT : pointOf(event) }
}

/** One oracle's outcome in a feed run, as its `oracle_ticks` row records it. */
export type FeedOutcome = OracleTick | KeeperFailure
type Run = { mode: "feed"; signer: string }
/** What the simulation said a sent call would do: the `ref_set` it emitted, or the rejection being put on-chain. */
type Simulated = { set?: DecodedEvent; rejection?: Rejection }
/** Phase 1's verdict for one oracle: its outcome already, or a `sync_from_feed` to send. */
type Decision = { outcome: FeedOutcome } | { submit: Simulated }
/**
 * What one simulation of `sync_from_feed` says by D-21's rules, before the keeper's memory is asked:
 * `true` (a sync to send), a significant rejection (sent only on request, once per (reason, value);
 * `notSent` is its outcome otherwise), or an outcome with nothing to send.
 */
type Verdict = { sync: Simulated } | { significant: Rejection; notSent: FeedOutcome } | { outcome: FeedOutcome }

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown")

/** An error as one oracle's outcome: a config error in the app's own words, anything else by its name only (RPC text may carry a provider URL). */
function failureOf(run: Run, error: unknown): KeeperFailure {
  if (error instanceof OracleKeeperConfigError) return { ...run, status: "not_configured", message: error.message }
  return { ...run, status: "failed", name: errorName(error) }
}

const syncCall = (oracle: string): ContractInvocation => ({ contractId: oracle, functionName: "sync_from_feed", args: [] })

/**
 * A simulation's verdict: `true` is a sync; `false` is read from the oracle's `ref_rej` event: routine
 * → `skipped`; broken feed or a reason this app does not know → `rejected`; significant → see
 * `Verdict`; no `ref_rej` → `rejected` (`unknown`). Anything else throws.
 */
function verdictOf(run: Run, oracle: string, simulation: FeedSimulation): Verdict {
  const events = oracleEvents(simulation.events.map((d) => d.event), oracle)
  if (simulation.retval === true) return { sync: { set: events.find((e) => e.topic === "ref_set") } }
  if (simulation.retval !== false) throw new Error("sync_from_feed simulated a return value that is neither true nor false")
  const rejection = rejectionOf(events)
  if (!rejection) return { outcome: { ...run, status: "rejected", ...NO_POINT, reason: "unknown" } }
  const { reason, point } = rejection
  if (isIn(ROUTINE, reason)) return { outcome: { ...run, status: "skipped", ...point, reason } }
  const notSent: FeedOutcome = { ...run, status: "rejected", ...point, reason }
  if (!isIn(SIGNIFICANT, reason)) return { outcome: notSent }
  return { significant: rejection, notSent }
}

/**
 * Phase 1 for one oracle: its feed, its admin, one simulation of `sync_from_feed` as the keeper,
 * then the verdict (D-21, M-13, M-14):
 * - `feed_source()` missing (a 665bb67 oracle) or the keeper's key is the oracle's admin: not_configured;
 * - `feed_source()` `None`: `skipped` (`no_feed`), nothing sent;
 * - `true`: send;
 * - `false`, by the simulated `ref_rej`: routine → `skipped`; broken feed or unknown → `rejected`,
 *   nothing sent; significant → `rejected`, nothing sent, unless `recordRejections` and its
 *   (reason, value) is not the last one this keeper put on-chain: then send;
 * - no `ref_rej`: `rejected` (`unknown`), nothing sent.
 * The admin check comes before the feed check: an admin key is refused whatever the oracle needs.
 */
async function decide(
  oracle: string,
  chain: FeedChain,
  keeper: Keypair,
  run: Run,
  opts: { recordRejections: boolean; lastSubmittedRejection(oracle: string): Promise<{ reason: string; value: string } | null> },
): Promise<Decision> {
  let source: unknown
  try {
    source = await chain.read("feed_source")
  } catch (error) {
    if (error instanceof Error && MISSING_FUNCTION.test(error.message)) throw new OracleKeeperConfigError(NO_FEED_VIEW)
    throw error
  }
  // Copying ORACLE_ADMIN_SECRET into ORACLE_KEEPER_SECRET is an easy mistake: refuse it before signing anything.
  if ((await chain.read("get_admin")) === keeper.publicKey()) throw new OracleKeeperConfigError(KEEPER_IS_ADMIN)
  if (source === null || source === undefined) return { outcome: { ...run, status: "skipped", ...NO_POINT, reason: NO_FEED_REASON } }

  let simulation: FeedSimulation
  try {
    simulation = await chain.simulate(keeper.publicKey(), syncCall(oracle))
  } catch (error) {
    if (error instanceof Error && ERROR_15.test(error.message)) throw new OracleKeeperConfigError(FEED_ERROR_15)
    throw error
  }
  const verdict = verdictOf(run, oracle, simulation)
  if ("sync" in verdict) return { submit: verdict.sync }
  if ("outcome" in verdict) return verdict
  if (!opts.recordRejections) return { outcome: verdict.notSent }
  const { reason, point } = verdict.significant
  const last = await opts.lastSubmittedRejection(oracle)
  if (last && last.reason === reason && last.value === point.value) return { outcome: verdict.notSent }
  return { submit: { rejection: verdict.significant } }
}

/**
 * Phase 2's check, right before signing: the preparing simulation's verdict against phase 1's
 * decision, which may be several ledgers old (the feed moved, someone else synced). The call is sent
 * while that fresh verdict is `true` (a sync, which is what `decide` sends on `true`), or, for a
 * rejection being put on-chain, the same significant (reason, value). Anything else sends nothing
 * and is recorded from the fresh simulation by `decide`'s rules: routine → `skipped`, broken feed →
 * `rejected`, and a significant rejection that is not the one decided → `rejected` with no hash (the
 * next run decides it, with its memory).
 */
function recheck(run: Run, oracle: string, decided: Simulated, fresh: FeedSimulation): { send: Simulated } | { outcome: FeedOutcome } {
  const verdict = verdictOf(run, oracle, fresh)
  if ("sync" in verdict) return { send: verdict.sync }
  if ("outcome" in verdict) return verdict
  const { reason, point } = verdict.significant
  const same = decided.rejection !== undefined && decided.rejection.reason === reason && decided.rejection.point.value === point.value
  return same ? { send: { rejection: verdict.significant } } : { outcome: verdict.notSent }
}

/**
 * A sent call's outcome from its transaction in a ledger. The call that landed has the last word:
 * its return value decides synced or rejected (it can differ from the simulation when the feed moved
 * in between), and its own `ref_set` or `ref_rej` event, when RPC returns the landed events, gives
 * the recorded (reason, value); else the simulated ones stand.
 */
function landedOutcome(run: Run, oracle: string, simulated: Simulated, polled: PolledTransactionResult): FeedOutcome {
  const { hash } = polled
  if (polled.status === "FAILED") return { ...run, status: "failed", name: failureCode(polled.failure?.result), hash }
  if (polled.status !== "SUCCESS") return { ...run, status: "failed", name: polled.status, hash }
  const landed = oracleEvents(polled.contractEvents ?? [], oracle)
  if (polled.returnValue === true) return { ...run, status: "synced", ...pointOf(landed.find((e) => e.topic === "ref_set") ?? simulated.set), hash }
  const rejection = rejectionOf(landed) ?? simulated.rejection
  if (!rejection) return { ...run, status: "rejected", ...NO_POINT, hash, reason: "unknown" }
  return { ...run, status: "rejected", ...rejection.point, hash, reason: rejection.reason }
}

/** Between two looks at a sent hash. */
const POLL_INTERVAL_MS = 1_000
/**
 * How long a send that threw (an HTTP error: did it reach the network?) is waited for before the
 * next transaction takes its sequence number: about two Mainnet ledgers. It is still looked for at
 * the end of the run.
 */
const UNSURE_SEND_WAIT_MS = 10_000
/**
 * Phase 1's share of the run: an oracle not decided this long after the run starts (or by the
 * deadline, whichever is first) is `not decided`, so a hanging read leaves the others time to send
 * (about one Mainnet ledger per transaction).
 */
const DECIDE_BUDGET_MS = 15_000

/** What a run reports for an oracle whose reads and simulation did not finish in phase 1's share of the run. */
export const NOT_DECIDED = "not decided"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const PAST = Symbol("past the deadline")
/**
 * `work`, or `PAST` when `until` (ms) comes first. A rejection before then rejects. A call that loses
 * the race is left to finish on its own; its answer is ignored.
 */
async function by<T>(work: Promise<T>, until: number): Promise<T | typeof PAST> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const past = new Promise<typeof PAST>((resolve) => {
    timer = setTimeout(() => resolve(PAST), Math.max(0, until - Date.now()))
  })
  try {
    return await Promise.race([work, past])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Looks `hashes` up together, about once a second, until each is in a ledger or `until` (ms) passes.
 * No look starts at or after `until`, and each is cut there. A look that throws counts as not found.
 */
async function inLedgers(account: KeeperAccount, hashes: readonly string[], until: number): Promise<Map<string, PolledTransactionResult>> {
  const found = new Map<string, PolledTransactionResult>()
  for (;;) {
    const open = hashes.filter((hash) => !found.has(hash))
    if (open.length === 0 || Date.now() >= until) return found
    const looks = await Promise.all(open.map((hash) => by(account.lookup(hash), until).catch(() => null)))
    looks.forEach((look, i) => {
      if (look && look !== PAST && look.status !== "NOT_FOUND") found.set(open[i], look)
    })
    const left = until - Date.now()
    if (found.size === hashes.length || left <= 0) return found
    await sleep(Math.min(POLL_INTERVAL_MS, left))
  }
}

/** A transaction handed to the network and not yet seen in a ledger. */
type InFlight = {
  index: number
  hash: string
  /** The network took it (PENDING, DUPLICATE); false when the send threw or outlasted the deadline, so whether it got there is unknown. */
  taken: boolean
  /** Its outcome if it is never seen in a ledger: `not confirmed`, or the thrown send's error name. */
  unseen: string
}

/**
 * One feed-mode run over `oracles` (spec 0005 M-13), from one keeper account, inside `deadlineMs`:
 *
 * 1. In parallel, each oracle is decided (`decide`: its reads and one simulation, nothing signed),
 *    by phase 1's cutoff (`DECIDE_BUDGET_MS` after the start, or the deadline): one not decided by
 *    then is `failed: not decided`.
 * 2. One after another, each `sync_from_feed` to send is built on the next sequence number (the
 *    account is read once, before the first, and the number advanced here), prepared by RPC (a fresh
 *    simulation), checked (`assertPreparedMatches`: the same call, source and sequence number; and
 *    `recheck`: the fresh verdict still calls for this send, else nothing is sent and the number is
 *    kept), signed, hashed (so a send that throws keeps its hash), and sent. The network keeps one
 *    transaction per account in its queue, so each waits until the previous one is in a ledger.
 *    A number is used only by a transaction the network took (or one found in a ledger after its
 *    send threw); a refusal (`txBadSeq` when another run used the account, `TRY_AGAIN_LATER`) is
 *    that oracle's `failed` and the next transaction takes the same number. No re-read and no
 *    retry: the next scheduled run starts from the account again.
 * 3. Every hash still unseen (taken, or from a send that threw) is looked up together until each is
 *    in a ledger or the deadline passes (`not confirmed`, or the thrown send's error name, with the
 *    hash). An oracle the deadline leaves unsent is `not sent`.
 *
 * Every network call (each oracle's decision, the sequence read, each preparation, send and look) is
 * raced against the time left: the run resolves, with exactly one outcome per oracle in the order
 * given, by `deadlineMs` plus the event loop's delay in firing a timer (milliseconds), whatever the
 * network does. A send cut by the deadline is handled as a send that threw. A transaction that lands
 * after the run (late on the network, or cut by the deadline) is recorded as it stood then (`failed`
 * with its hash); its effect is on-chain and indexed, the next run simulates from the oracle's new
 * state, and a rejection that landed late is not in the keeper's memory (no `rejected` row with its
 * hash), so with `recordRejections` the next run may submit it once more.
 *
 * An error on one oracle is its own outcome (`failureOf`) and never stops the others. Without a
 * usable key, every oracle is `not_configured` and nothing is read. No network refusal: the key holds
 * no role (push mode keeps its refusal of mainnet). `sync_from_feed` needs no auth, so the admin's
 * key would work, but it would put that key in a server variable, which D-21 rules out: each
 * oracle's admin is checked.
 */
export async function tickFeedAll(deps: {
  manifest: Manifest
  secret: string | undefined
  /** The oracles to sync, distinct, in the order the answer keeps (`manifestOracles`, or the local override). */
  oracles: readonly string[]
  /** Whether a new significant rejection is put on-chain (M-14, `ORACLE_KEEPER_RECORD_REJECTIONS`). */
  recordRejections: boolean
  /** No network call runs past this time (ms): no transaction is sent, and no hash looked for, after it. */
  deadlineMs: number
  /** The last significant rejection this keeper submitted for an oracle (its `oracle_ticks` memory); read only when one is to be submitted. */
  lastSubmittedRejection(oracle: string): Promise<{ reason: string; value: string } | null>
  chainFor?: (oracle: string) => FeedChain
  account?: KeeperAccount
}): Promise<{ oracle: string; outcome: FeedOutcome }[]> {
  const { manifest, oracles, deadlineMs } = deps
  let keeper: Keypair
  try {
    keeper = keeperKey(deps.secret, "ORACLE_KEEPER_SECRET")
  } catch (error) {
    const message = error instanceof Error ? error.message : "ORACLE_KEEPER_SECRET is not usable."
    return oracles.map((oracle) => ({ oracle, outcome: { status: "not_configured", mode: "feed", signer: null, message } }))
  }
  const run: Run = { mode: "feed", signer: keeper.publicKey() }
  const notSent: FeedOutcome = { ...run, status: "failed", name: NOT_SENT }
  let server: OracleRpcServer | undefined
  const rpcServer = () => (server ??= createRpcServer(serverRpcUrlOf(manifest)))
  const chainFor = deps.chainFor ?? ((oracle: string) => createFeedChain(manifest, oracle, { server: rpcServer() }))
  const account = deps.account ?? createKeeperAccount(manifest, { server: rpcServer() })

  // Phase 1: every oracle at once, by its cutoff.
  const decideBy = Math.min(deadlineMs, Date.now() + DECIDE_BUDGET_MS)
  const decisions = await Promise.all(
    oracles.map(async (oracle): Promise<Decision> => {
      try {
        const decision = await by(decide(oracle, chainFor(oracle), keeper, run, deps), decideBy)
        return decision === PAST ? { outcome: { ...run, status: "failed", name: NOT_DECIDED } } : decision
      } catch (error) {
        return { outcome: failureOf(run, error) }
      }
    }),
  )
  const outcomes: (FeedOutcome | undefined)[] = decisions.map((d) => ("outcome" in d ? d.outcome : undefined))
  /** What each sent call's fresh simulation said it would do: the fallback for its landed events. */
  const simulatedFor = new Map<number, Simulated>()
  const landed = new Map<number, PolledTransactionResult>()
  const inFlight: InFlight[] = []
  /** Sends that threw and were not seen in their window: their number went to the next transaction; phase 3 still looks for them. */
  const unsure: InFlight[] = []

  // Phase 2: one transaction after another.
  let sequence: bigint | null = null
  let accountError: string | null = null
  for (const [index, decision] of decisions.entries()) {
    if (!("submit" in decision)) continue
    if (Date.now() >= deadlineMs) {
      // Past the deadline nothing more is sent; phase 3 settles what is still in flight.
      outcomes[index] = notSent
      continue
    }
    const previous = inFlight.at(-1)
    if (previous) {
      // One transaction per account in the network's queue: the previous one must be in a ledger first.
      const until = previous.taken ? deadlineMs : Math.min(deadlineMs, Date.now() + UNSURE_SEND_WAIT_MS)
      const seen = (await inLedgers(account, [previous.hash], until)).get(previous.hash)
      if (seen) {
        inFlight.pop()
        landed.set(previous.index, seen)
        // A thrown send whose transaction is in a ledger did use its number.
        if (!previous.taken && sequence !== null) sequence += 1n
      } else if (!previous.taken) {
        // Not seen in its window: as far as the ledger shows, it did not reach the network, so its
        // number is the next one's. If it lands after all, the next one is refused (one effect per number).
        inFlight.pop()
        unsure.push(previous)
      }
      // Taken and still unseen at the deadline: phase 3 settles it.
    }
    if (Date.now() >= deadlineMs) {
      outcomes[index] = notSent
      continue
    }
    if (sequence === null && accountError === null) {
      try {
        const read = await by(account.sequence(keeper.publicKey()), deadlineMs)
        if (read === PAST) {
          outcomes[index] = notSent
          continue
        }
        sequence = BigInt(read)
      } catch (error) {
        accountError = errorName(error)
      }
    }
    if (sequence === null) {
      outcomes[index] = { ...run, status: "failed", name: accountError ?? "unknown" }
      continue
    }

    let signed: Transaction
    let hash: string
    try {
      const built = buildInvocationEnvelope({
        source: keeper.publicKey(),
        sequence: sequence.toString(),
        networkPassphrase: manifest.networkPassphrase,
        invocation: syncCall(oracles[index]),
        timeoutSeconds: TX_TIMEOUT_SECONDS,
      })
      const prepared = await by(account.prepare(built), deadlineMs)
      if (prepared === PAST) {
        // Nothing reached the network: the number is unused.
        outcomes[index] = notSent
        continue
      }
      // RPC may add footprint, resources and fee; it may not change the call, the source or the sequence number (R29).
      assertPreparedMatches(built, prepared.transaction)
      const check = recheck(run, oracles[index], decision.submit, prepared)
      if ("outcome" in check) {
        // The fresh simulation no longer calls for this send: nothing is sent, the number is the next one's.
        outcomes[index] = check.outcome
        continue
      }
      simulatedFor.set(index, check.send)
      prepared.transaction.sign(keeper)
      signed = prepared.transaction
      hash = bytesToHex(prepared.transaction.hash())
    } catch (error) {
      // Nothing reached the network: the number is the next transaction's.
      outcomes[index] = failureOf(run, error)
      continue
    }
    if (Date.now() >= deadlineMs) {
      // The preparation ran up to the deadline: nothing is sent that the run could not confirm.
      outcomes[index] = notSent
      continue
    }
    let answer: Awaited<ReturnType<KeeperAccount["send"]>>
    try {
      const sent = await by(account.send(signed), deadlineMs)
      if (sent === PAST) {
        // Cut by the deadline: as a send that threw, it keeps its hash, and the run sends nothing more.
        inFlight.push({ index, hash, taken: false, unseen: NOT_CONFIRMED })
        continue
      }
      answer = sent
    } catch (error) {
      inFlight.push({ index, hash, taken: false, unseen: errorName(error) })
      continue
    }
    if (answer.status === "PENDING" || answer.status === "DUPLICATE") {
      sequence += 1n
      inFlight.push({ index, hash, taken: true, unseen: NOT_CONFIRMED })
    } else {
      // Refused: `txBadSeq` (another run used the account), `TRY_AGAIN_LATER` (its transaction is still queued), a fee, ….
      const name = answer.status === "ERROR" ? (answer.errorResult ? failureCode(answer.errorResult) : "ERROR") : answer.status
      outcomes[index] = { ...run, status: "failed", name, hash }
    }
  }

  // Phase 3: whatever is still unseen, together, until the deadline.
  const open = [...unsure, ...inFlight]
  const seen = await inLedgers(account, open.map((f) => f.hash), deadlineMs)
  for (const f of open) {
    const look = seen.get(f.hash)
    if (look) landed.set(f.index, look)
    else outcomes[f.index] = { ...run, status: "failed", name: f.unseen, hash: f.hash }
  }
  for (const [index, look] of landed) {
    const decision = decisions[index]
    if ("submit" in decision) outcomes[index] = landedOutcome(run, oracles[index], simulatedFor.get(index) ?? decision.submit, look)
  }
  return oracles.map((oracle, index) => ({ oracle, outcome: outcomes[index] ?? { ...run, status: "failed", name: "unknown" } }))
}
