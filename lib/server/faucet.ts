import "server-only"

/**
 * The Testnet faucet behind `POST /api/faucet` (spec §9): the app's only server code, and the only
 * code holding keys. For one account it performs only the missing steps, in order:
 *
 * 1. `authorize` — SAC `set_authorized(account, true)`, signed by the issuer (the SAC admin);
 * 2. `grant_account` — Permissioning `grant_account(admin, account)`;
 * 3. `grant_pt` / `grant_yt` — Permissioning `grant_asset(admin, account, pt|yt)`, for every market;
 * 4. `pay` — a classic payment of `FAUCET_AMOUNT` test tokens from the issuer, only below
 *    `FAUCET_TOP_UP_BELOW`.
 *
 * Grants and authorization are read first and skipped when present. Runs are queued whole, one at a
 * time per instance (first come, first finished), and a transaction is sent again once on a stale
 * sequence number. Abuse limits, all per instance: one request per address and per IP per minute;
 * 120 requests that reach the chain per minute; 4 runs that send transactions per minute; and no
 * run is queued that would finish past the time budget (`busy`). There is no proof that the caller
 * controls the address: on Testnet, granting any account is harmless (spec §9).
 */
import { Account, Asset, Keypair, Operation, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk"
import { bytesToHex } from "@/lib/protocol/bytes"
import { formatAmount } from "@/lib/protocol/format"
import { PASSPHRASES } from "@/lib/protocol/manifest"
import {
  TEST_TOKEN_AMOUNT,
  TEST_TOKEN_TOP_UP_BELOW,
  onboardingAvailable,
  sharedTestAsset,
  wholeTokens,
  type FaucetStep,
} from "@/lib/protocol/onboarding"
import { toBool } from "@/lib/protocol/reader"
import { assertPreparedMatches } from "@/lib/protocol/review"
import {
  buildInvocationEnvelope,
  createRpcServer,
  describeTransactionResult,
  pollTransactionStatus,
  simulateContractRead,
  type ContractInvocation,
  type ScArg,
} from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"

/** Whole test tokens paid per top-up. */
export const FAUCET_AMOUNT = TEST_TOKEN_AMOUNT
/** Whole test tokens below which the faucet pays. */
export const FAUCET_TOP_UP_BELOW = TEST_TOKEN_TOP_UP_BELOW
/** One accepted request per address and per IP in this window. */
export const FAUCET_RATE_LIMIT_MS = 60_000
/** At most this many runs that send transactions per instance per rolling minute (R42, lowered by R43). */
export const FAUCET_RUNS_PER_MINUTE = 4
/** At most this many requests that read from the chain per instance per rolling minute (R42c). */
export const FAUCET_READS_PER_MINUTE = 120
/** Estimated time of one run (up to five transactions, each confirmed), for admission (R43). */
export const FAUCET_RUN_ESTIMATE_MS = 30_000
/** A run is queued only if it should finish within this time, under the route's `maxDuration` (R43). */
export const FAUCET_QUEUE_BUDGET_MS = 90_000

export type TestAsset = Market["underlying"]

export type FaucetAccount =
  | { exists: false }
  | { exists: true; trustline: { authorized: boolean; balance: bigint } | null }

/**
 * The chain as the faucet sees it. Writes resolve once the transaction succeeded on-chain and
 * throw `BadSequenceError` when the network refused a stale sequence number (sent again once).
 */
export interface FaucetChain {
  readAccount(account: string, asset: TestAsset): Promise<FaucetAccount>
  isAllowed(account: string): Promise<boolean>
  isAllowedForAsset(account: string, asset: string): Promise<boolean>
  /** SAC `set_authorized(account, true)`, signed by the issuer. */
  setAuthorized(account: string, asset: TestAsset): Promise<void>
  /** Permissioning `grant_account(admin, account)`, signed by the Permissioning admin. */
  grantAccount(account: string): Promise<void>
  /** Permissioning `grant_asset(admin, account, asset)`, signed by the Permissioning admin. */
  grantAsset(account: string, asset: string): Promise<void>
  /** Classic payment of `amount` raw units of the test asset, from the issuer. */
  pay(account: string, asset: TestAsset, amount: bigint): Promise<void>
}

/** The network refused a transaction for its sequence number (`txBadSeq`). */
export class BadSequenceError extends Error {
  readonly code = "tx_bad_seq"
  constructor() {
    super("the network refused the transaction's sequence number")
    this.name = "BadSequenceError"
  }
}

/** The server is missing a key, or holds one that does not match the manifest. Never carries a key. */
export class FaucetConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FaucetConfigError"
  }
}

/** A faucet transaction was refused, failed, or was not confirmed. */
export class FaucetTxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FaucetTxError"
  }
}

/** A write failed: which step stopped the run. Steps before it are on-chain and are skipped next time. */
export class FaucetStepError extends Error {
  readonly step: FaucetStep
  constructor(step: FaucetStep, cause: unknown) {
    super(`faucet step ${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = "FaucetStepError"
    this.step = step
  }
}

export type FaucetOutcome =
  | { performed: FaucetStep[] }
  | { error: "network" | "rate_limited" | "no_trustline" | "busy" | "not_configured" }

// ---------------------------------------------------------------- per-instance state

/** Last accepted request time, by `addr:<account>` and `ip:<ip>`. Best effort: one instance only. */
const lastAccepted = new Map<string, number>()
/** Times of the requests that read from the chain in the rolling window (R42c). */
let readTimes: number[] = []
/** Times of the runs that sent transactions in the rolling window (R42, R43). */
let runTimes: number[] = []
/** Runs queued or running, for admission (R43). */
let pendingRuns = 0
/** Tail of the run queue: each run starts once the previous one settled. */
let queueTail: Promise<unknown> = Promise.resolve()

export function resetFaucetStateForTests(): void {
  lastAccepted.clear()
  readTimes = []
  runTimes = []
  pendingRuns = 0
  queueTail = Promise.resolve()
}

const expired = (at: number, now: number) => now - at >= FAUCET_RATE_LIMIT_MS || at > now

const keysOf = (account: string, ip: string) => [`addr:${account}`, `ip:${ip}`]

/**
 * Takes the slot for both keys, or refuses (a refused request does not restart the window).
 * Checked first, before any read: one request per address and per IP per minute.
 */
function takeKeySlots(account: string, ip: string, now: number): boolean {
  for (const [key, at] of lastAccepted) if (expired(at, now)) lastAccepted.delete(key)
  const keys = keysOf(account, ip)
  if (keys.some((key) => lastAccepted.has(key))) return false
  for (const key of keys) lastAccepted.set(key, now)
  return true
}

/** A request refused or failed before any transaction does not lock its address and IP out (R42c). */
function releaseKeySlots(account: string, ip: string): void {
  for (const key of keysOf(account, ip)) lastAccepted.delete(key)
}

/**
 * Takes a slot of a rolling per-instance budget, or refuses. Check and take happen with no await
 * in between, so concurrent requests cannot both take the last slot.
 */
function takeSlot(times: number[], limit: number, now: number): number[] | null {
  const live = times.filter((at) => !expired(at, now))
  if (live.length >= limit) return null
  live.push(now)
  return live
}

/**
 * Admits a run to the queue only if, behind the runs already queued or running, it should still
 * finish within the time budget (R43); otherwise the caller answers `busy` at once, rather than
 * hold a request that would time out while its transactions keep going.
 */
function admits(): boolean {
  return (pendingRuns + 1) * FAUCET_RUN_ESTIMATE_MS <= FAUCET_QUEUE_BUDGET_MS
}

/** Queues one whole run: its transactions are sent back to back, before the next run's (R43). */
function enqueueRun<T>(run: () => Promise<T>): Promise<T> {
  pendingRuns += 1
  const result = queueTail.then(run, run)
  queueTail = result.catch(() => undefined)
  return result.finally(() => {
    pendingRuns -= 1
  })
}

/** Sends one transaction; a stale sequence number gets exactly one more attempt. */
async function send(step: FaucetStep, write: () => Promise<void>): Promise<void> {
  try {
    try {
      await write()
    } catch (error) {
      if (!(error instanceof BadSequenceError)) throw error
      await write()
    }
  } catch (error) {
    throw new FaucetStepError(step, error)
  }
}

// ---------------------------------------------------------------- the run

export async function runFaucet(p: {
  account: string
  manifest: Manifest
  ip: string
  now: number
  chain?: FaucetChain
}): Promise<FaucetOutcome> {
  const { account, manifest } = p
  if (!onboardingAvailable(manifest) || manifest.networkPassphrase !== PASSPHRASES[manifest.network]) {
    return { error: "network" }
  }
  // The route validates the body; this is the last line before anything is signed.
  if (!StrKey.isValidEd25519PublicKey(account)) throw new Error("runFaucet needs a G… account address")
  // Onboarding trusts, authorizes and pays one asset: every market must share it (R44).
  const asset = sharedTestAsset(manifest)
  if (!asset) return { error: "not_configured" }
  const chain = p.chain ?? createStellarFaucetChain(manifest)

  const { ip, now } = p
  if (!takeKeySlots(account, ip, now)) return { error: "rate_limited" }
  // A cheap budget on the requests that reach the chain, checked before any RPC read (R42c).
  const reads = takeSlot(readTimes, FAUCET_READS_PER_MINUTE, now)
  if (!reads) {
    releaseKeySlots(account, ip)
    return { error: "rate_limited" }
  }
  readTimes = reads

  const assetGrants = [
    ...new Map(
      manifest.markets.flatMap((m) => [
        [m.contracts.pt, "grant_pt"],
        [m.contracts.yt, "grant_yt"],
      ] as const),
    ),
  ]
  let state: FaucetAccount
  let allowed: boolean
  let assetsAllowed: boolean[]
  try {
    ;[state, allowed, assetsAllowed] = await Promise.all([
      chain.readAccount(account, asset),
      chain.isAllowed(account),
      Promise.all(assetGrants.map(([contract]) => chain.isAllowedForAsset(account, contract))),
    ])
  } catch (error) {
    releaseKeySlots(account, ip)
    throw error
  }
  if (!state.exists || !state.trustline) return { error: "no_trustline" }

  // Only the missing steps, in order. Authorization first: an AUTH_REQUIRED asset cannot be paid
  // to an unauthorized trustline.
  const plan: { step: FaucetStep; write: () => Promise<void> }[] = []
  if (!state.trustline.authorized) plan.push({ step: "authorize", write: () => chain.setAuthorized(account, asset) })
  if (!allowed) plan.push({ step: "grant_account", write: () => chain.grantAccount(account) })
  for (const [i, [contract, step]] of assetGrants.entries()) {
    if (!assetsAllowed[i]) plan.push({ step, write: () => chain.grantAsset(account, contract) })
  }
  if (state.trustline.balance < wholeTokens(FAUCET_TOP_UP_BELOW, asset.decimals)) {
    plan.push({ step: "pay", write: () => chain.pay(account, asset, wholeTokens(FAUCET_AMOUNT, asset.decimals)) })
  }
  if (plan.length === 0) return { performed: [] }

  // Admission, the run cap and queueing happen with no await in between (R42b, R43).
  if (!admits()) {
    releaseKeySlots(account, ip)
    return { error: "busy" }
  }
  const runs = takeSlot(runTimes, FAUCET_RUNS_PER_MINUTE, now)
  if (!runs) {
    releaseKeySlots(account, ip)
    return { error: "rate_limited" }
  }
  runTimes = runs

  return enqueueRun(async () => {
    const performed: FaucetStep[] = []
    for (const { step, write } of plan) {
      await send(step, write)
      performed.push(step)
    }
    return { performed }
  })
}

// ---------------------------------------------------------------- the real chain

/** The RPC calls the real chain makes; `rpc.Server` satisfies it, tests inject a fake. */
export type FaucetRpcServer = {
  getAccount(address: string): Promise<{ sequenceNumber(): string }>
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<{ entries: { val: { type: string; value: unknown } }[] }>
  simulateTransaction: NonNullable<Parameters<typeof simulateContractRead>[0]["server"]>["simulateTransaction"]
  prepareTransaction(transaction: Transaction): Promise<Transaction>
  sendTransaction(transaction: Transaction): Promise<{
    status: string
    hash?: string
    errorResult?: xdr.TransactionResult
    errorResultXdr?: string
  }>
  getTransaction(hash: string): Promise<{ status: string; returnValue?: xdr.ScVal }>
}

/** Validity window of the faucet's own transactions. */
const TX_TIMEOUT_SECONDS = 120
/** Inclusion fee bid for the classic payment, in stroops (0.001 XLM): charged only as far as needed. */
const CLASSIC_FEE = "10000"
/** `TrustLineFlags.AUTHORIZED_FLAG`. */
const AUTHORIZED_FLAG = 1

function keypairFrom(value: string | undefined, name: string): Keypair {
  if (!value || value.trim() === "") throw new FaucetConfigError(`${name} is not set on this server.`)
  try {
    return Keypair.fromSecret(value.trim())
  } catch {
    // The value itself is never repeated.
    throw new FaucetConfigError(`${name} is not a valid Stellar secret key.`)
  }
}

function rejection(sent: { errorResult?: xdr.TransactionResult; errorResultXdr?: string }): xdr.TransactionResult | undefined {
  try {
    if (sent.errorResult) return sent.errorResult
    if (sent.errorResultXdr) return xdr.TransactionResult.fromXdr(sent.errorResultXdr, "base64")
  } catch {
    // Undecodable: reported without a reason.
  }
  return undefined
}

/**
 * The faucet chain on the manifest's RPC, with the keys from the environment: `FAUCET_ISSUER_SECRET`
 * (required: the test asset issuer, which is also its SAC admin) and
 * `FAUCET_PERMISSIONING_ADMIN_SECRET` (optional; defaults to the issuer). Throws
 * `FaucetConfigError` when a key is missing, malformed, or not the manifest's issuer.
 */
export function createStellarFaucetChain(
  manifest: Manifest,
  opts: { env?: Record<string, string | undefined>; server?: FaucetRpcServer } = {},
): FaucetChain {
  const env = opts.env ?? process.env
  const issuer = keypairFrom(env.FAUCET_ISSUER_SECRET, "FAUCET_ISSUER_SECRET")
  const admin = env.FAUCET_PERMISSIONING_ADMIN_SECRET?.trim()
    ? keypairFrom(env.FAUCET_PERMISSIONING_ADMIN_SECRET, "FAUCET_PERMISSIONING_ADMIN_SECRET")
    : issuer
  const asset = sharedTestAsset(manifest)
  if (!asset) throw new FaucetConfigError("The manifest's markets do not share one test asset; onboarding supports a single one.")
  if (issuer.publicKey() !== asset.issuer) {
    throw new FaucetConfigError("FAUCET_ISSUER_SECRET is not the key of the test asset issuer named in the manifest.")
  }
  // A classic asset always has 7 decimals; raw amounts are stroops of it.
  if (asset.decimals !== 7) {
    throw new FaucetConfigError(`The test asset must be a classic asset with 7 decimals; the manifest says ${asset.decimals}.`)
  }

  const server: FaucetRpcServer = opts.server ?? createRpcServer(manifest.rpcUrl)
  const { networkPassphrase, rpcUrl } = manifest
  const permissioning = manifest.shared.permissioning
  const address = (value: string): ScArg => ({ type: "address", value })

  async function read(invocation: ContractInvocation): Promise<boolean> {
    const result = await simulateContractRead<unknown>({ rpcUrl, networkPassphrase, invocation, server })
    return toBool(result.value)
  }

  /** Submits a signed transaction and waits for SUCCESS, polling by its locally computed hash. */
  async function submit(tx: Transaction): Promise<void> {
    const hash = bytesToHex(tx.hash())
    const sent = await server.sendTransaction(tx)
    if (sent.status === "ERROR") {
      const result = rejection(sent)
      if (result?.result.type === "txBadSeq") throw new BadSequenceError()
      throw new FaucetTxError(`the network rejected it${result ? ` because ${describeTransactionResult(result)}` : ""}`)
    }
    if (sent.status === "TRY_AGAIN_LATER") throw new FaucetTxError("the network is busy and did not accept it")
    const polled = await pollTransactionStatus({ rpcUrl, hash, server, attempts: 30, intervalMs: 1_000 })
    if (polled.status === "FAILED") throw new FaucetTxError(`it failed on-chain (${hash})`)
    if (polled.status !== "SUCCESS") throw new FaucetTxError(`it was not confirmed in time (${hash})`)
  }

  /** A Soroban call from `signer`: built here, prepared by RPC, checked (R29), signed, sent. */
  async function invoke(signer: Keypair, invocation: ContractInvocation): Promise<void> {
    const sequence = (await server.getAccount(signer.publicKey())).sequenceNumber()
    const built = buildInvocationEnvelope({
      source: signer.publicKey(),
      sequence,
      networkPassphrase,
      invocation,
      timeoutSeconds: TX_TIMEOUT_SECONDS,
    })
    const prepared = await server.prepareTransaction(built)
    // RPC may add footprint, resources and fee; it may not change the call or authorize anything else.
    assertPreparedMatches(built, prepared)
    prepared.sign(signer)
    await submit(prepared)
  }

  async function classic(signer: Keypair, operation: xdr.Operation): Promise<void> {
    const sequence = (await server.getAccount(signer.publicKey())).sequenceNumber()
    const tx = new TransactionBuilder(new Account(signer.publicKey(), sequence), { fee: CLASSIC_FEE, networkPassphrase })
      .addOperation(operation)
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build()
    tx.sign(signer)
    await submit(tx)
  }

  return {
    async readAccount(account, testAssetArg) {
      const key = Keypair.fromPublicKey(account)
      const accountKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: key.xdrPublicKey() }))
      const trustlineKey = xdr.LedgerKey.trustline(
        new xdr.LedgerKeyTrustLine({
          accountId: key.xdrAccountId(),
          asset: new Asset(testAssetArg.code, testAssetArg.issuer).toTrustLineXdrObject(),
        }),
      )
      // Read from the RPC the dialog confirmed the user's changeTrust on, so a fresh trustline is seen.
      const { entries } = await server.getLedgerEntries(accountKey, trustlineKey)
      if (!entries.some((e) => e.val.type === "account")) return { exists: false }
      const trustline = entries.find((e) => e.val.type === "trustline")?.val.value as
        | { balance: bigint; flags: number }
        | undefined
      if (!trustline) return { exists: true, trustline: null }
      return {
        exists: true,
        trustline: { authorized: (trustline.flags & AUTHORIZED_FLAG) !== 0, balance: BigInt(trustline.balance) },
      }
    },
    isAllowed: (account) => read({ contractId: permissioning, functionName: "is_allowed", args: [address(account)] }),
    isAllowedForAsset: (account, contract) =>
      read({ contractId: permissioning, functionName: "is_allowed_for_asset", args: [address(account), address(contract)] }),
    setAuthorized: (account, testAssetArg) =>
      invoke(issuer, {
        contractId: testAssetArg.sac,
        functionName: "set_authorized",
        args: [address(account), { type: "bool", value: true }],
      }),
    grantAccount: (account) =>
      invoke(admin, {
        contractId: permissioning,
        functionName: "grant_account",
        args: [address(admin.publicKey()), address(account)],
      }),
    grantAsset: (account, contract) =>
      invoke(admin, {
        contractId: permissioning,
        functionName: "grant_asset",
        args: [address(admin.publicKey()), address(account), address(contract)],
      }),
    pay: (account, testAssetArg, amount) =>
      classic(
        issuer,
        Operation.payment({
          destination: account,
          asset: new Asset(testAssetArg.code, testAssetArg.issuer),
          // Classic amounts are decimal strings with 7 digits: exact, never rounded.
          amount: formatAmount(amount, 7, 7),
        }),
      ),
  }
}
