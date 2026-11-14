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
 *   role, and holds no admin right: it may run on any network. It simulates the call and submits only
 *   what is worth a transaction (`tickFeed`).
 */
import { Keypair, StrKey, rpc, scValToNative, type Transaction, type xdr } from "@stellar/stellar-sdk"
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
} from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"

/** Yearly growth of the test reference value, in percent. */
export const ORACLE_APY_PERCENT = 5
const SECONDS_PER_YEAR = 31_536_000
const TX_TIMEOUT_SECONDS = 60

/** The keeper cannot run: no key, a key that is not the oracle admin, or a network it must not feed. */
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
  const { rpcUrl, networkPassphrase } = manifest
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
  const { rpcUrl, networkPassphrase } = manifest
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
   * `ref_rej` event's; null when no event said (`reason` is then `unknown`).
   */
  | { status: "rejected"; value: string | null; timestamp: number | null; hash?: string; reason: string }
  /** Feed: the oracle took its feed's value (`ref_set`), in transaction `hash`. Null value: the landed call disagreed with its simulation. */
  | { status: "synced"; value: string | null; timestamp: number | null; hash: string }
  /** Feed: a routine rejection (`stale_ts`, `no_data`), never sent. `no_data` has no value or timestamp. */
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

// ---------------------------------------------------------------- feed mode (spec 0004 D-21)

/**
 * The reasons `sync_from_feed` can reject with (principal 24d980d `oracle_adapter/src/lib.rs:460-552`),
 * in D-21's three classes, from their one source (`lib/protocol/dashboard/rejections.ts`):
 * - significant: an attempted disallowed value change; one transaction per new (reason, value) puts
 *   it on-chain with a hash;
 * - routine: no new data; never worth a transaction;
 * - broken feed: the feed's own data is unusable; no transaction, and the alert check raises `feed_broken`.
 */
export { BROKEN, ROUTINE, SIGNIFICANT }

const isIn = (list: readonly string[], reason: string) => list.includes(reason)

/** A simulation of `sync_from_feed`: its return value (native) and its events, as RPC reports them. */
export type FeedSimulation = { retval: unknown; events: readonly xdr.DiagnosticEvent[] }

/** What the feed keeper needs from the network: one view of the oracle, a simulation, and one signed call. */
export type FeedChain = {
  read(fn: "feed_source"): Promise<unknown>
  /** Simulates `invocation` with `source` as the transaction's source. A simulation error throws its text. */
  simulate(source: string, invocation: ContractInvocation): Promise<FeedSimulation>
  /** Sends and waits; `events` are the landed transaction's contract events, when RPC returned them. */
  send(signer: Keypair, invocation: ContractInvocation): Promise<Landed>
}

/** The feed chain of `oracle` on the manifest's RPC. */
export function createFeedChain(manifest: Manifest, oracle: string, deps: { server?: OracleRpcServer } = {}): FeedChain {
  const { rpcUrl, networkPassphrase } = manifest
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
    send: (signer, invocation) => sendInvocation(manifest, server, signer, invocation),
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
const NO_FEED = "the oracle has no feed source (set_feed_source was never called)."
const FEED_ERROR_15 = "the feed answered an error (#15) to sync_from_feed: the oracle names a feed, so this is not its FeedNotConfigured."

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
/** The `ref_rej` among `events` as a reason and its (value, timestamp); `no_data` carries the contract's placeholders (0, 0), not a price. */
function rejectionOf(events: DecodedEvent[]): Rejection | null {
  const event = events.find((e) => e.topic === "ref_rej")
  const reason = event?.fields.reason
  if (typeof reason !== "string") return null
  return { reason, point: reason === "no_data" ? NO_POINT : pointOf(event) }
}

/**
 * One feed-mode run (D-21). It checks the oracle has a feed (`feed_source()`; a missing view or
 * `None` is a config error), simulates `sync_from_feed` as the keeper, then:
 * - `true`: submits, and reports `synced` with the `ref_set` value;
 * - `false`: reads the reason from the simulation's `ref_rej` event:
 *   - routine (`stale_ts`, `no_data`): `skipped`, nothing sent;
 *   - significant (`oob`, `decrease`, `deviate`, `fb_value`): submitted when its (reason, value) is
 *     not `lastSubmittedRejection` (the last one this keeper put on-chain), so each distinct rejection
 *     has a transaction; a repeat is `rejected` with no hash;
 *   - broken feed (`bad_price`, `rescale`, `future_ts`), or a reason this app does not know: `rejected`, nothing sent;
 *   - no `ref_rej` event: `rejected` with reason `unknown`, nothing sent.
 * The call that lands has the last word: its return value decides synced or rejected (it can differ
 * from the simulation when the feed moved in between), and its own `ref_set` or `ref_rej` event, when
 * RPC returns the landed events, gives the recorded (reason, value); else the simulated ones stand.
 * An error 15 after `feed_source()` named a feed is the feed's (`FeedNotConfigured` needs no feed), and
 * is worded so. No admin check and no network refusal: the key holds no role.
 */
export async function tickFeed(deps: {
  manifest: Manifest
  secret: string | undefined
  /** The oracle to sync (`ORACLE_KEEPER_ORACLE_ID`); the manifest's by default. */
  oracle?: string
  chain?: FeedChain
  /** The last significant rejection this keeper submitted for the oracle; null (or absent): none known, so any is new. */
  lastSubmittedRejection?: { reason: string; value: string } | null
}): Promise<OracleTick> {
  const keeper = keeperKey(deps.secret, "ORACLE_KEEPER_SECRET")
  const oracle = deps.oracle ?? deps.manifest.shared.oracle
  const chain = deps.chain ?? createFeedChain(deps.manifest, oracle)
  const run = { mode: "feed" as const, signer: keeper.publicKey() }

  let source: unknown
  try {
    source = await chain.read("feed_source")
  } catch (error) {
    if (error instanceof Error && MISSING_FUNCTION.test(error.message)) throw new OracleKeeperConfigError(NO_FEED_VIEW)
    throw error
  }
  if (source === null || source === undefined) throw new OracleKeeperConfigError(NO_FEED)

  const invocation: ContractInvocation = { contractId: oracle, functionName: "sync_from_feed", args: [] }
  let simulation: FeedSimulation
  try {
    simulation = await chain.simulate(keeper.publicKey(), invocation)
  } catch (error) {
    if (error instanceof Error && ERROR_15.test(error.message)) throw new OracleKeeperConfigError(FEED_ERROR_15)
    throw error
  }
  const events = oracleEvents(simulation.events.map((d) => d.event), oracle)

  /** Sends the call; the landed events, when there are any, override the simulated `ref_set` or rejection. */
  const submit = async (simulated: { set?: DecodedEvent; rejection?: Rejection }): Promise<OracleTick> => {
    const { hash, returnValue, events: landedEvents } = await chain.send(keeper, invocation)
    const landed = oracleEvents(landedEvents ?? [], oracle)
    if (returnValue === true) return { ...run, status: "synced", ...pointOf(landed.find((e) => e.topic === "ref_set") ?? simulated.set), hash }
    const rejection = rejectionOf(landed) ?? simulated.rejection
    if (!rejection) return { ...run, status: "rejected", ...NO_POINT, hash, reason: "unknown" }
    return { ...run, status: "rejected", ...rejection.point, hash, reason: rejection.reason }
  }

  if (simulation.retval === true) return submit({ set: events.find((e) => e.topic === "ref_set") })
  if (simulation.retval !== false) throw new Error("sync_from_feed simulated a return value that is neither true nor false")

  const rejection = rejectionOf(events)
  if (!rejection) return { ...run, status: "rejected", ...NO_POINT, reason: "unknown" }
  const { reason, point } = rejection
  if (isIn(ROUTINE, reason)) return { ...run, status: "skipped", ...point, reason }
  if (!isIn(SIGNIFICANT, reason)) return { ...run, status: "rejected", ...point, reason }
  const last = deps.lastSubmittedRejection
  if (last && last.reason === reason && last.value === point.value) return { ...run, status: "rejected", ...point, reason }
  return submit({ rejection })
}
