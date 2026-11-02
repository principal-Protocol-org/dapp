import "server-only"

/**
 * The oracle keeper behind `/api/cron/oracle`, for the app's own test deployments (testnet, local).
 * The OracleAdapter's value is fresh for 3600 s and only its admin may push one, so a schedule calls
 * this every 30 minutes with `ORACLE_ADMIN_SECRET`, a key that is the oracle's admin and nothing else
 * (the protocol admin key never reaches the server). It pushes the value grown at
 * `ORACLE_APY_PERCENT` a year for the time elapsed, stamped with the ledger time, as
 * `scripts/dev-stack/oracle-tick.sh` does by hand. It never runs on mainnet.
 */
import { Keypair, type Transaction, type xdr } from "@stellar/stellar-sdk"
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

type OracleRead = "get_admin" | "get_reference_value" | "get_reference_timestamp"

/** What the keeper needs from the network: reads of the oracle, the ledger clock, and one signed call. */
export type OracleChain = {
  read(fn: OracleRead): Promise<unknown>
  /** The latest ledger's close time, unix seconds. */
  ledgerTime(): Promise<number>
  /** Sends `invocation` signed by `signer` and waits for success; returns the transaction hash. */
  send(signer: Keypair, invocation: ContractInvocation): Promise<string>
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
  getTransaction(hash: string): Promise<{ status: string; returnValue?: xdr.ScVal }>
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
    async send(signer, invocation) {
      const sequence = (await server.getAccount(signer.publicKey())).sequenceNumber()
      const built = buildInvocationEnvelope({ source: signer.publicKey(), sequence, networkPassphrase, invocation, timeoutSeconds: TX_TIMEOUT_SECONDS })
      const prepared = await server.prepareTransaction(built)
      // RPC may add footprint, resources and fee; it may not change the call or authorize anything else (R29).
      assertPreparedMatches(built, prepared)
      prepared.sign(signer)
      const { hash } = await submitSignedTransaction({ rpcUrl, networkPassphrase, signedXdr: prepared.toEnvelope().toXDR("base64"), server })
      const polled = await pollTransactionStatus({ rpcUrl, hash, server, attempts: 30, intervalMs: 1_000 })
      if (polled.status === "FAILED") throw new Error(`the oracle update failed on-chain (${hash})`)
      if (polled.status !== "SUCCESS") throw new Error(`the oracle update was not confirmed in time (${hash})`)
      return hash
    },
  }
}

export type OracleTick =
  | { status: "unchanged"; value: string; timestamp: number }
  | { status: "updated"; value: string; timestamp: number; hash: string }

/** One keeper run: checks the key is the oracle admin, then pushes the next value unless the clock has not moved. */
export async function tickOracle(deps: { manifest: Manifest; secret: string | undefined; chain?: OracleChain }): Promise<OracleTick> {
  const { manifest } = deps
  if (manifest.network === "mainnet") throw new OracleKeeperConfigError("the oracle keeper runs only on testnet and local networks.")
  const secret = deps.secret?.trim()
  if (!secret) throw new OracleKeeperConfigError("ORACLE_ADMIN_SECRET is not set.")
  let keeper: Keypair
  try {
    keeper = Keypair.fromSecret(secret)
  } catch {
    throw new OracleKeeperConfigError("ORACLE_ADMIN_SECRET is not a valid Stellar secret key.")
  }
  const chain = deps.chain ?? createOracleChain(manifest)

  const admin = await chain.read("get_admin")
  if (admin !== keeper.publicKey()) throw new OracleKeeperConfigError("ORACLE_ADMIN_SECRET is not the key of the oracle admin.")

  const current = BigInt(String(await chain.read("get_reference_value")))
  const lastTimestamp = Number(await chain.read("get_reference_timestamp"))
  const now = await chain.ledgerTime()
  const next = nextReferenceValue({ current, lastTimestamp, now })
  if (next === null) return { status: "unchanged", value: current.toString(), timestamp: lastTimestamp }

  const hash = await chain.send(keeper, {
    contractId: manifest.shared.oracle,
    functionName: "set_reference_value",
    args: [
      { type: "address", value: keeper.publicKey() },
      { type: "i128", value: next.toString() },
      { type: "u64", value: String(now) },
    ],
  })
  return { status: "updated", value: next.toString(), timestamp: now, hash }
}
