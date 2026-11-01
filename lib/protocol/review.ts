/**
 * The prepared review and its execution: the last code path before the user's signature.
 *
 * `prepareReview` builds the exact transaction, has RPC prepare it (`server.prepareTransaction`:
 * simulation, footprint, auth) and describes it in plain words. `prepareManagerReview` does the
 * same for a manager call (0002 §5), which a builder of `manager-calls.ts` made. `executeReview`
 * signs either: it refuses a review older than 60 s, re-derives the call from what the review was
 * prepared from (`origin`), has the wallet sign it, checks the wallet signed exactly that
 * transaction, then submits, polls and decodes the result. `prepareRestore` builds the
 * `restoreFootprint` transaction an archived-entry simulation asks for; `executeRestore` signs it
 * under the same rules.
 *
 * RPC is untrusted (R29): whatever it prepares or simulates is checked against what was built
 * locally before it is shown for signing — same call, same time bounds, no foreign authorization
 * (for a manager call: only the signer's own, for exactly the call and nothing beneath it), a fee
 * that is explained and below `MAX_TX_FEE_STROOPS`, and a restore footprint limited to the market's
 * own contracts and the Wasm code its manifest pins (R29b).
 *
 * Ported from `dapp-old/src/lib/transactions.ts` (the prepared review only: the preview and local
 * XDR modes are dropped), `buildPreparedInvokeTransaction` from `dapp-old/src/lib/stellar.ts` (R14)
 * and the `signAndSubmit` flow of `dapp-old/src/App.tsx`.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk"
import { ACTION_META, invocationFor, type ActionId, type ActionInput, type GuardValues } from "./actions"
import { bytesToHex } from "./bytes"
import { formatAmount, shorten } from "./format"
import { parseOutput, type ActionOutput } from "./guards"
import { hashLike } from "./hash"
import { MANAGER_CALL_AUTH, managerCallTree, rebuildManagerCall, type ManagerCall } from "./manager-calls"
import { getMarket } from "./manifest"
import {
  assertSignedTransactionMatchesReview,
  buildInvocationEnvelope,
  createRpcServer,
  failedTransactionReason,
  pollTransactionStatus,
  SubmissionRejectedError,
  simulateInvocation,
  submitSignedTransaction,
  transactionEnvelopeHash,
  type ContractInvocation,
} from "./stellar"
import type { Manifest, Market } from "./types"

/** A prepared review expires 60 s after preparation (shared context). */
export const REVIEW_TTL_MS = 60_000

/**
 * R31: what `prepareReview`, `prepareManagerReview` and `prepareRestore` issued, keyed by the very
 * object they returned. `executeReview` and `executeRestore` refuse any other object, and read the
 * preparation time, the XDR hash and (for a review) the origin object from here, never from the
 * object they are handed.
 */
type Issued = { preparedAtMs: number; unsignedXdrHash: string; origin?: ReviewOrigin }
const issued = new WeakMap<object, Issued>()

/** The most this app ever asks the user to sign as a network fee: 10 XLM, in stroops (R29). */
export const MAX_TX_FEE_STROOPS = 100_000_000n

/** Transaction validity window (time bounds), as dapp-old used for its 300 s deadline default. */
export const TX_TIMEOUT_SECONDS = 300

/** Every Principal token, and XLM, have 7 decimals. */
const TOKEN_DECIMALS = 7
const XLM_DECIMALS = 7

/** What a review was prepared from: a user action (0001) or a manager call (0002 §5). */
export type ReviewOrigin = { type: "action"; input: ActionInput } | { type: "manager"; call: ManagerCall }

/** The prepared transaction and its plain-words description, the same for every review. */
type PreparedTransaction = {
  invocation: ContractInvocation
  unsignedXdr: string
  unsignedXdrHash: string
  /** Total fee of the prepared transaction, in stroops: the most the network can charge. */
  fee: string
  preparedAtMs: number
  expiresAtMs: number
  summary: {
    give: string[]
    getAtLeast: string[]
    fees: string[]
    /** The contract call's deadline (unix seconds, from ledger time), for the actions that take one. */
    deadline?: number
    /**
     * The transaction's own time bound (`maxTime`, unix seconds): set 300 s after preparation by the
     * device clock. The network refuses the transaction after it, whatever the deadline (M3).
     */
    validUntil: number
  }
  callTree: string[]
}

/** A prepared review of a user action. `input` is `origin.input`, the very same object (R31 checks it). */
export type Review = PreparedTransaction & { origin: { type: "action"; input: ActionInput }; input: ActionInput }

/**
 * A prepared review of a manager call (0002 §5). It moves no amount from the signer, so it has no
 * floor and `give` / `getAtLeast` are empty; every other rule of an action holds (R29, R31, expiry).
 */
export type ManagerReview = PreparedTransaction & { origin: { type: "manager"; call: ManagerCall } }

/** Any review `executeReview` signs. */
export type AnyReview = Review | ManagerReview

export type TxStatus = "SUCCESS" | "FAILED" | "NOT_FOUND"

export type TxResult = {
  hash: string
  status: TxStatus
  /** FAILED: why, in plain words (R49). Always set for a FAILED transaction. */
  reason?: string
  output?: ActionOutput
  /** The transaction succeeded but its return value could not be read; hash and status stand. */
  decodeError?: string
  /** The transaction was submitted but its status could not be read; it may still land. */
  pollError?: string
}

type SimulateServer = NonNullable<Parameters<typeof simulateInvocation>[0]["server"]>
type SubmitServer = NonNullable<Parameters<typeof submitSignedTransaction>[0]["server"]>
type PollServer = NonNullable<Parameters<typeof pollTransactionStatus>[0]["server"]>

/** The RPC calls this module makes; `createRpcServer` satisfies it, tests inject a fake. */
export type ReviewRpcServer = SimulateServer &
  SubmitServer &
  PollServer & {
    prepareTransaction(transaction: Transaction): Promise<Transaction>
  }

/** A prepared `restoreFootprint` transaction: shown with its fee, and expiring like a review. */
export type RestoreReview = {
  source: string
  unsignedXdr: string
  unsignedXdrHash: string
  /** Total fee of the restore transaction, in stroops. */
  fee: string
  preparedAtMs: number
  expiresAtMs: number
}

/** `WalletAdapter.sign` (Task 11): signs the XDR and returns the signed XDR. */
export type SignTransaction = (unsignedXdr: string, networkPassphrase: string, expectedSigner: string) => Promise<string>

const CALL_TREES: Record<ActionId, string[]> = {
  deposit: ["SYWrapper.deposit"],
  withdraw: ["Router.unwrap", "SYWrapper.withdraw"],
  mint: ["Router.wrap_and_mint", "SYWrapper.deposit", "PrincipalManager.mint"],
  buy_pt: ["Router.swap_sy_for_pt", "MarketPool.swap_sy_for_pt"],
  sell_pt: ["Router.swap_pt_for_sy", "MarketPool.swap_pt_for_sy"],
  buy_yt: ["Router.swap_sy_for_yt", "PrincipalManager.mint", "MarketPool.swap_pt_for_sy"],
  sell_yt: ["Router.swap_yt_for_sy", "MarketPool.swap_yt_for_sy"],
  add_liquidity: ["Router.add_liquidity", "MarketPool.add_liquidity"],
  add_liquidity_sy: ["Router.add_liquidity_single_sy", "MarketPool.add_liquidity_single_sy"],
  remove_liquidity: ["Router.remove_liquidity", "MarketPool.remove_liquidity"],
  recombine: ["Router.recombine", "PrincipalManager.recombine"],
  claim_yield: ["Router.claim_yield", "PrincipalManager.claim_yield"],
  redeem: ["Router.redeem_at_maturity", "PrincipalManager.redeem"],
}

/** The guard fields each slippage-sensitive call signs (R4 mapping). */
function signedFloors(action: ActionId): (keyof GuardValues)[] {
  if (!ACTION_META[action].slippageSensitive) return []
  if (action === "remove_liquidity") return ["minOut", "minOut2"]
  if (action === "buy_yt") return ["minOut", "maxNetCost"]
  return ["minOut"]
}

/**
 * R5: no slippage-sensitive call is prepared with a zero, negative or missing floor (for buy_yt,
 * `max_net_cost` too). The last gate before signing, whatever the caller passed.
 */
function assertNoZeroFloor(input: ActionInput): void {
  const floors = signedFloors(input.action)
  if (floors.length === 0) return
  const zero =
    floors.some((field) => input.guards[field] === undefined) ||
    Object.values(input.guards).some((value) => value !== undefined && value <= 0n)
  if (zero) {
    throw new Error(
      `zero floor: ${ACTION_META[input.action].label} would be signed without a minimum above 0, so it is not prepared. Wait for the exact quote, then review again.`,
    )
  }
}

/**
 * R47: an action this release does not offer is never prepared or signed, whatever the caller
 * passed; the gates refuse it too (`disabled`).
 */
function assertOffered(input: ActionInput): void {
  const disabled = ACTION_META[input.action].disabled
  if (disabled) throw new Error(`${ACTION_META[input.action].label} is not offered, so it is not prepared. ${disabled.reason}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function invokedContractArgs(transaction: Transaction): xdr.InvokeContractArgs | undefined {
  const [operation] = transaction.operations
  if (operation?.type !== "invokeHostFunction" || operation.func.type !== "hostFunctionTypeInvokeContract") return undefined
  return operation.func.invokeContract
}

function xlm(stroops: bigint): string {
  return `${formatAmount(stroops, XLM_DECIMALS, XLM_DECIMALS)} XLM`
}

/** The resource fee the transaction's Soroban data declares (0 without Soroban data). */
function sorobanResourceFee(transaction: Transaction): bigint {
  const envelope = transaction.toEnvelope()
  if (envelope.type !== "envelopeTypeTx") return 0n
  const ext = envelope.value.tx.ext
  return ext.type === "sorobanData" ? ext.sorobanData.resourceFee : 0n
}

/** R29: refuse a fee above the hard cap. */
function assertFeeCapped(fee: bigint, what: string): void {
  if (fee > MAX_TX_FEE_STROOPS) {
    throw new Error(
      `${what} asks for a network fee of ${xlm(fee)}, above the ${xlm(MAX_TX_FEE_STROOPS)} this app signs. Refusing it; try again later or use another RPC.`,
    )
  }
}

/**
 * What a prepared transaction may authorize (R29). `rooted`, for an action: every entry is for
 * exactly this call, with the call's own nested transfers beneath it. `caller`, for a manager call
 * its signer authorizes: exactly one entry, the source account's own, for exactly this call and
 * nothing beneath it. `none`, for a permissionless manager call: no entry at all.
 */
export type AuthRule = "rooted" | "caller" | "none"

type AuthFault = { kind: "foreign" } | { kind: "missing" } | { kind: "other_signer"; account: string }

/**
 * RPC is untrusted (R29). It may add footprint, resources, auth and the resource fee; it must not
 * change who calls what, at which sequence and in which time window, add an authorization `auth`
 * does not allow, or charge a fee it does not explain. Also applied by the server faucet to the
 * transactions it signs with its own keys (`lib/server/faucet.ts`).
 */
export function assertPreparedMatches(built: Transaction, prepared: Transaction, auth: AuthRule = "rooted"): void {
  const expected = invokedContractArgs(built)
  const call = invokedContractArgs(prepared)
  const same =
    expected !== undefined &&
    call !== undefined &&
    prepared.operations.length === 1 &&
    call.toXdr("base64") === expected.toXdr("base64") &&
    prepared.source === built.source &&
    prepared.sequence === built.sequence &&
    prepared.networkPassphrase === built.networkPassphrase
  if (!same) {
    throw new Error(
      "RPC returned a prepared transaction that is not the transaction that was requested. Refusing to review it; try again or use another RPC.",
    )
  }

  const window = (tx: Transaction) => (tx.timeBounds ? `${tx.timeBounds.minTime}-${tx.timeBounds.maxTime}` : "none")
  if (window(prepared) !== window(built)) {
    throw new Error(
      "RPC changed the time bounds of the transaction it prepared. Refusing to review it; try again or use another RPC.",
    )
  }

  const fee = BigInt(prepared.fee)
  assertFeeCapped(fee, "The prepared transaction")
  const explained = BigInt(built.fee) + sorobanResourceFee(prepared)
  if (fee > explained) {
    throw new Error(
      `The prepared fee (${xlm(fee)}) is more than the base fee plus the resource fee it declares (${xlm(explained)}). Refusing it; try again or use another RPC.`,
    )
  }

  const fault = authFault(prepared, expected.toXdr("base64"), auth)
  if (fault) throw authRefusal(fault)
}

function authRefusal(fault: AuthFault): Error {
  switch (fault.kind) {
    case "foreign":
      return new Error("RPC added an authorization for something other than this call. Refusing to review it; try again or use another RPC.")
    case "missing":
      return new Error("RPC left out the authorization this call needs. Refusing to review it; try again or use another RPC.")
    case "other_signer":
      return new Error(
        `This call needs an authorization from another account (${shorten(fault.account)}), which this app does not ask for. Connect that account's wallet, then try again.`,
      )
  }
}

/** The function is exactly this call: same contract, function and arguments. */
function isCall(fn: xdr.SorobanAuthorizedFunction, callXdr: string): boolean {
  return fn.type === "sorobanAuthorizedFunctionTypeContractFn" && fn.contractFn.toXdr("base64") === callXdr
}

/** Why the transaction's authorizations break `rule` for the call `callXdr`; undefined when they keep it. */
function authFault(transaction: Transaction, callXdr: string, rule: AuthRule): AuthFault | undefined {
  const [operation] = transaction.operations
  const auth = operation?.type === "invokeHostFunction" ? (operation.auth ?? []) : []
  if (rule === "rooted") return auth.every((entry) => isCall(entry.rootInvocation.function, callXdr)) ? undefined : { kind: "foreign" }
  if (rule === "none") return auth.length === 0 ? undefined : { kind: "foreign" }
  if (auth.length === 0) return { kind: "missing" }
  const [entry] = auth
  if (auth.length > 1 || !isCall(entry.rootInvocation.function, callXdr) || entry.rootInvocation.subInvocations.length > 0) {
    return { kind: "foreign" }
  }
  const { credentials } = entry
  if (credentials.type === "sorobanCredentialsSourceAccount") return undefined
  // Another account's authorization (address credentials): a signature this app never asks for.
  if (credentials.type === "sorobanCredentialsAddress") {
    return { kind: "other_signer", account: Address.fromScAddress(credentials.address.address).toString() }
  }
  return { kind: "foreign" }
}

function decodeTransaction(unsignedXdr: string, networkPassphrase: string): Transaction | undefined {
  try {
    return new Transaction(unsignedXdr, networkPassphrase)
  } catch {
    return undefined
  }
}

/** The `InvokeContractArgs` XDR of `invocation`, as the transaction carries it; undefined if it cannot be built. */
function callXdrOf(manifest: Manifest, source: string, invocation: ContractInvocation): string | undefined {
  try {
    const envelope = buildInvocationEnvelope({ source, sequence: "0", networkPassphrase: manifest.networkPassphrase, invocation })
    return invokedContractArgs(envelope)?.toXdr("base64")
  } catch {
    return undefined
  }
}

/** The issuance record of an object `prepare*` returned; refuses anything else (R31). */
function issuance(subject: object, preparedAtMs: number, what: "review" | "restore"): Issued {
  const record = issued.get(subject)
  if (!record) throw new Error(`This ${what} was not prepared by this app. Prepare it again before signing.`)
  if (record.preparedAtMs !== preparedAtMs) throw changedSince(what, "its preparation time")
  return record
}

function changedSince(what: "review" | "restore", detail: string): Error {
  return new Error(`This ${what} was changed after it was prepared (${detail}). Prepare it again before signing.`)
}

/** The caller's clock cannot hold time back: the later of `nowMs` and the system clock. */
function currentTime(nowMs: number | undefined): number {
  return Math.max(nowMs ?? Number.NEGATIVE_INFINITY, Date.now())
}

/** The call a review must make, re-derived from its origin, and who signs and authorizes it. */
type ReviewedCall = { source: string; invocation: ContractInvocation; auth: AuthRule; action?: ActionId }

/**
 * R31: the call `review` was prepared for, derived again from its origin. An action: still offered
 * (R47), no zero floor (R5), the call `input` maps to. A manager call: the call its builder makes
 * again for this manifest (`rebuildManagerCall`), which refuses any other contract, function,
 * argument, signer or label.
 */
function reviewedCall(review: AnyReview, manifest: Manifest): ReviewedCall {
  const { origin } = review
  if (origin.type === "action") {
    if (!("input" in review) || review.input !== origin.input) throw changedSince("review", "the action it describes")
    const input = origin.input
    assertOffered(input)
    assertNoZeroFloor(input)
    return { source: input.source, invocation: invocationFor(manifest, input), auth: "rooted", action: input.action }
  }
  let call: ManagerCall
  try {
    call = rebuildManagerCall(manifest, origin.call)
  } catch {
    throw changedSince("review", "the call it describes")
  }
  return { source: call.source, invocation: call.invocation, auth: MANAGER_CALL_AUTH[call.kind] }
}

/**
 * R31: re-checks, right before signing, that the review still describes exactly the transaction
 * `prepareReview` or `prepareManagerReview` issued: the origin it was issued with, the call
 * re-derived from it (`reviewedCall`), an XDR that makes exactly that call, from its source, with
 * no authorization the call's rule does not allow, at the reviewed fee (within the cap), and a hash
 * that is both the reviewed one and the issued one. Returns the re-derived call.
 */
function assertReviewIntact(review: AnyReview, manifest: Manifest, record: Issued): ReviewedCall {
  if (record.origin === undefined || review.origin !== record.origin) throw changedSince("review", "what it was prepared from")
  const call = reviewedCall(review, manifest)
  const expected = callXdrOf(manifest, call.source, call.invocation)
  if (expected === undefined || callXdrOf(manifest, call.source, review.invocation) !== expected) {
    throw changedSince("review", "the call it describes")
  }
  const tx = decodeTransaction(review.unsignedXdr, manifest.networkPassphrase)
  if (!tx || tx.operations.length !== 1 || invokedContractArgs(tx)?.toXdr("base64") !== expected) {
    throw changedSince("review", "its transaction does not make the reviewed call")
  }
  if (tx.source !== call.source) throw changedSince("review", "its transaction has another source account")
  assertFeeCapped(BigInt(tx.fee), "The transaction to sign")
  if (tx.fee !== review.fee) throw changedSince("review", "its fee")
  const fault = authFault(tx, expected, call.auth)
  if (fault) {
    throw changedSince(
      "review",
      fault.kind === "missing" ? "its transaction lacks the authorization the call needs" : "its transaction authorizes another call",
    )
  }
  const hash = hashLike(review.unsignedXdr)
  if (hash !== review.unsignedXdrHash || hash !== record.unsignedXdrHash) {
    throw changedSince("review", "its transaction is not the one that was prepared")
  }
  return call
}

/** R31: the restore is still exactly the single `restoreFootprint` transaction `prepareRestore` issued. */
function assertRestoreIntact(restore: RestoreReview, manifest: Manifest, record: Issued): void {
  const tx = decodeTransaction(restore.unsignedXdr, manifest.networkPassphrase)
  if (!tx || tx.operations.length !== 1 || tx.operations[0].type !== "restoreFootprint") {
    throw changedSince("restore", "its transaction is not a single restoreFootprint")
  }
  if (tx.source !== restore.source) throw changedSince("restore", "its transaction has another source account")
  assertFeeCapped(BigInt(tx.fee), "The restore")
  if (tx.fee !== restore.fee) throw changedSince("restore", "its fee")
  const hash = hashLike(restore.unsignedXdr)
  if (hash !== restore.unsignedXdrHash || hash !== record.unsignedXdrHash) {
    throw changedSince("restore", "its transaction is not the one that was prepared")
  }
}

/** The exact fee field being signed; the network may charge less, never more. */
function networkFee(fee: string): string {
  return `Network fee: up to ${xlm(BigInt(fee))}`
}

function summarize(market: Market, input: ActionInput, fee: string, validUntil: number): Review["summary"] {
  const underlying = market.underlying.code
  const decimalsOf = (token: string) => (token === underlying ? market.underlying.decimals : TOKEN_DECIMALS)
  // Every digit: the review shows exactly the amounts being signed, never a rounded floor.
  const amount = (value: bigint, token: string) => `${formatAmount(value, decimalsOf(token), decimalsOf(token))} ${token}`
  const { amount: a, secondaryAmount: b = 0n, guards: g } = input
  const floor = (value: bigint | undefined, token: string) => amount(value ?? 0n, token)

  const swapFee = "Swap fee: charged by the pool in SY, already counted in the amounts above."
  const tokenizationFee = "Tokenization fee: withheld from the SY before PT and YT are minted, already counted in the amounts above."
  const ytFee = "YT fee: deducted from the yield before it is paid."

  let give: string[]
  let getAtLeast: string[]
  let protocolFees: string[] = []
  switch (input.action) {
    case "deposit":
      give = [amount(a, underlying)]
      getAtLeast = [floor(g.minOut, "SY")]
      break
    case "withdraw":
      give = [amount(a, "SY")]
      getAtLeast = [floor(g.minOut, underlying)]
      break
    case "mint":
      give = [amount(a, underlying)]
      // Only min_pt_out is signed; the contract mints YT 1:1 with PT.
      getAtLeast = [`${floor(g.minOut, "PT")}, and the same amount of YT`]
      protocolFees = [tokenizationFee]
      break
    case "buy_pt":
      give = [amount(a, "SY")]
      getAtLeast = [floor(g.minOut, "PT")]
      protocolFees = [swapFee]
      break
    case "sell_pt":
      give = [amount(a, "PT")]
      getAtLeast = [floor(g.minOut, "SY")]
      protocolFees = [swapFee]
      break
    case "buy_yt": {
      // max_net_cost bounds what is given, not what is received: the PT sale must return at
      // least sy_in − max_net_cost SY (Router.swap_sy_for_yt), or the call reverts.
      const maxNetCost = g.maxNetCost ?? 0n
      give = [
        maxNetCost >= a
          ? `${amount(a, "SY")}, all of which may be spent: no SY is guaranteed back`
          : `${amount(a, "SY")}, of which at most ${amount(maxNetCost, "SY")} is spent: the rest comes back to you`,
      ]
      getAtLeast = [floor(g.minOut, "YT")]
      protocolFees = [tokenizationFee, swapFee]
      break
    }
    case "sell_yt":
      give = [amount(a, "YT")]
      getAtLeast = [floor(g.minOut, "SY")]
      protocolFees = [swapFee]
      break
    case "add_liquidity":
      // Only pt_used / sy_used, the amounts in the pool's ratio, are taken (MarketPool.add_liquidity).
      give = [`up to ${amount(a, "PT")}`, `up to ${amount(b, "SY")}`]
      getAtLeast = [floor(g.minOut, "LP")]
      break
    case "add_liquidity_sy":
      give = [amount(a, "SY")]
      getAtLeast = [floor(g.minOut, "LP")]
      protocolFees = [swapFee]
      break
    case "remove_liquidity":
      give = [amount(a, "LP")]
      getAtLeast = [floor(g.minOut, "PT"), floor(g.minOut2, "SY")]
      break
    case "recombine":
      give = [amount(a, "PT"), amount(a, "YT")]
      getAtLeast = [floor(g.minOut, "SY")]
      break
    case "claim_yield":
      give = []
      getAtLeast = [`Your pending yield, paid in ${underlying}. This call sets no minimum.`]
      protocolFees = [ytFee]
      break
    case "redeem":
      // Either side may be 0: only the legs redeemed are listed.
      give = [...(a > 0n ? [amount(a, "PT")] : []), ...(b > 0n ? [amount(b, "YT")] : [])]
      getAtLeast = [
        // Unsettled, this redemption may be the one that settles the market (R40): no rate is fixed yet.
        ...(a > 0n
          ? [
              `${underlying} for your PT, at the settlement rate. If the market has not settled yet, this redemption may be the one that settles it, at the rate in force when it lands.`,
            ]
          : []),
        ...(b > 0n ? [`${underlying} for your YT: the yield it has left, net of the YT fee.`] : []),
        "This call sets no minimum.",
      ]
      protocolFees = b > 0n ? [ytFee] : []
      break
  }

  const fees = [networkFee(fee), ...protocolFees]
  return ACTION_META[input.action].hasDeadline
    ? { give, getAtLeast, fees, deadline: Number(input.deadline), validUntil }
    : { give, getAtLeast, fees, validUntil }
}

/** The time bound this app set on the transaction it built (R29 keeps RPC from changing it). */
function maxTimeOf(transaction: Transaction): number {
  const maxTime = Number(transaction.timeBounds?.maxTime)
  if (!Number.isFinite(maxTime) || maxTime <= 0) throw new Error("The transaction was built without a time bound. Nothing was signed.")
  return maxTime
}

/**
 * Builds the exact transaction for `input`, has RPC prepare it and describes it for review.
 * Refuses an action that is not offered (R47) and a zero floor (R5) before any RPC call.
 */
export async function prepareReview(p: { manifest: Manifest; input: ActionInput; rpc?: ReviewRpcServer }): Promise<Review> {
  const { manifest, input } = p
  const market = getMarket(manifest, input.marketId)
  if (!market) throw new Error(`Unknown market "${input.marketId}".`)
  assertOffered(input)
  assertNoZeroFloor(input)
  const invocation = invocationFor(manifest, input)

  const server = p.rpc ?? createRpcServer(manifest.rpcUrl)
  const { built, prepared } = await buildAndPrepare(server, manifest, input.source, invocation)
  assertPreparedMatches(built, prepared)

  const unsignedXdr = prepared.toXDR()
  const preparedAtMs = Date.now()
  const origin: Review["origin"] = { type: "action", input }
  const review: Review = {
    origin,
    input,
    invocation,
    unsignedXdr,
    unsignedXdrHash: hashLike(unsignedXdr),
    fee: prepared.fee,
    preparedAtMs,
    expiresAtMs: preparedAtMs + REVIEW_TTL_MS,
    summary: summarize(market, input, prepared.fee, maxTimeOf(built)),
    callTree: CALL_TREES[input.action],
  }
  issued.set(review, { preparedAtMs, unsignedXdrHash: review.unsignedXdrHash, origin })
  return review
}

/**
 * Builds the exact transaction for a manager call (0002 §5), has RPC prepare it and describes it
 * for review, under an action's rules. The call is first re-derived by its builder, before any RPC
 * call: one no builder of `manager-calls.ts` makes for this manifest is refused. The simulation must
 * succeed, and RPC may not change the call, its source, sequence or time bounds, charge a fee it
 * does not explain or one above the cap, or authorize anything but what the call's rule allows
 * (`MANAGER_CALL_AUTH`: the signer's own authorization of exactly this call, or none) (R29). A
 * manager call moves no amount from the signer, so it has no floor.
 */
export async function prepareManagerReview(p: { manifest: Manifest; call: ManagerCall; rpc?: ReviewRpcServer }): Promise<ManagerReview> {
  const { manifest } = p
  const call = rebuildManagerCall(manifest, p.call)

  const server = p.rpc ?? createRpcServer(manifest.rpcUrl)
  const { built, prepared } = await buildAndPrepare(server, manifest, call.source, call.invocation)
  assertPreparedMatches(built, prepared, MANAGER_CALL_AUTH[call.kind])

  const unsignedXdr = prepared.toXDR()
  const preparedAtMs = Date.now()
  const origin: ManagerReview["origin"] = { type: "manager", call }
  const review: ManagerReview = {
    origin,
    // A copy of its own: R31 compares it with the call re-derived from `origin`.
    invocation: rebuildManagerCall(manifest, call).invocation,
    unsignedXdr,
    unsignedXdrHash: hashLike(unsignedXdr),
    fee: prepared.fee,
    preparedAtMs,
    expiresAtMs: preparedAtMs + REVIEW_TTL_MS,
    summary: { give: [], getAtLeast: [], fees: [networkFee(prepared.fee)], validUntil: maxTimeOf(built) },
    callTree: managerCallTree(manifest, call),
  }
  issued.set(review, { preparedAtMs, unsignedXdrHash: review.unsignedXdrHash, origin })
  return review
}

/**
 * Builds `invocation` as `source` at its next sequence, with this app's time bounds, and has RPC
 * prepare it: simulation, footprint, auth and resource fee. Ported from dapp-old
 * buildPreparedInvokeTransaction (R14). A failed simulation refuses in plain words.
 */
async function buildAndPrepare(
  server: ReviewRpcServer,
  manifest: Manifest,
  source: string,
  invocation: ContractInvocation,
): Promise<{ built: Transaction; prepared: Transaction }> {
  const account = await server.getAccount(source)
  const built = buildInvocationEnvelope({
    source,
    sequence: account.sequenceNumber(),
    networkPassphrase: manifest.networkPassphrase,
    invocation,
    timeoutSeconds: TX_TIMEOUT_SECONDS,
  })
  try {
    return { built, prepared: await server.prepareTransaction(built) }
  } catch (error) {
    throw new Error(
      `The transaction could not be prepared (${errorText(error)}). Nothing was signed; check the reasons shown and try again.`,
    )
  }
}

/** True once 60 s have passed since preparation. A clock that went backwards, or NaN, also expires it. */
export function isExpired(review: Pick<Review, "preparedAtMs">, nowMs: number): boolean {
  if (!Number.isFinite(nowMs) || nowMs < review.preparedAtMs) return true
  return nowMs - review.preparedAtMs >= REVIEW_TTL_MS
}

type SubmittedTransaction = {
  hash: string
  status: TxStatus
  reason?: string
  returnValue?: unknown
  decodeError?: string
  pollError?: string
}

/**
 * Signs `unsignedXdr` with the wallet, refuses anything but exactly that transaction signed by
 * `source`, submits it and polls for the result. Used by `executeReview` and `executeRestore`, which
 * apply the 60 s rule first.
 *
 * The hash is computed locally from the signed envelope before submitting, and that hash is the one
 * polled and reported (R30): it is never lost, and never taken from RPC. Only a refusal (status
 * ERROR, or TRY_AGAIN_LATER) throws, since the transaction was then not accepted. A failed or
 * ambiguous send is polled, because the transaction may have landed.
 */
async function signAndSubmit(p: {
  unsignedXdr: string
  manifest: Manifest
  source: string
  sign: SignTransaction
  rpc?: ReviewRpcServer
  /** Runs once the wallet has signed, before anything is submitted: it may refuse (R31: expiry). */
  afterSign: () => void
}): Promise<SubmittedTransaction> {
  const { manifest } = p
  const server = p.rpc ?? createRpcServer(manifest.rpcUrl)
  const signedXdr = await p.sign(p.unsignedXdr, manifest.networkPassphrase, p.source)
  p.afterSign()
  assertSignedTransactionMatchesReview({
    unsignedXdr: p.unsignedXdr,
    signedXdr,
    networkPassphrase: manifest.networkPassphrase,
    expectedSigner: p.source,
  })
  const hash = transactionEnvelopeHash(signedXdr, manifest.networkPassphrase)

  let sendError: string | undefined
  try {
    const submitted = await submitSignedTransaction({
      rpcUrl: manifest.rpcUrl,
      networkPassphrase: manifest.networkPassphrase,
      signedXdr,
      server,
    })
    if (submitted.status === "TRY_AGAIN_LATER") {
      throw new SubmissionRejectedError(
        "The network is busy and did not accept the transaction. Nothing was submitted; review it again in a moment.",
        hash,
      )
    }
  } catch (error) {
    if (error instanceof SubmissionRejectedError) throw error
    sendError = errorText(error)
  }

  // PENDING (queued), DUPLICATE (already queued), and a failed or ambiguous send are all polled.
  const lookItUp = "Look it up by its hash before trying again."
  let polled: Awaited<ReturnType<typeof pollTransactionStatus>>
  try {
    polled = await pollTransactionStatus({ rpcUrl: manifest.rpcUrl, hash, server })
  } catch (error) {
    const sent = sendError ? `Sending the transaction failed (${sendError}), and` : "The transaction was submitted, but"
    return { hash, status: "NOT_FOUND", pollError: `${sent} its status could not be read (${errorText(error)}). ${lookItUp}` }
  }
  if (polled.status === "SUCCESS") {
    return polled.decodeError
      ? { hash, status: "SUCCESS", decodeError: polled.decodeError }
      : { hash, status: "SUCCESS", returnValue: polled.returnValue }
  }
  if (polled.status === "FAILED") return { hash, status: "FAILED", reason: failedTransactionReason(polled.failure) }
  return sendError
    ? {
        hash,
        status: "NOT_FOUND",
        pollError: `Sending the transaction failed (${sendError}), and the network does not show it yet. ${lookItUp}`,
      }
    : { hash, status: "NOT_FOUND" }
}

/** A FAILED or NOT_FOUND outcome, with its cause (R49) or poll error when there is one. */
function unsuccessful(sent: SubmittedTransaction): TxResult {
  const { hash, status, reason, pollError } = sent
  return { hash, status, ...(reason === undefined ? {} : { reason }), ...(pollError === undefined ? {} : { pollError }) }
}

/**
 * Executes a prepared review, of an action or of a manager call: refuses it once expired, then
 * signs, checks, submits, polls and decodes. After SUCCESS a return value that cannot be read gives
 * `output: undefined` and a `decodeError`, never a throw: the hash and status of an on-chain
 * transaction are not lost. A manager call has no action output: its SUCCESS carries none, and its
 * effect is read back from the chain.
 *
 * R31: only a review `prepareReview` or `prepareManagerReview` returned is executed, its expiry
 * counts from the issued time, it is re-checked in full before signing (`assertReviewIntact`, which
 * re-derives the call from its origin), and expiry is checked again once the wallet has signed,
 * before submitting. The wallet must sign as the call's source.
 */
export async function executeReview(p: {
  review: AnyReview
  manifest: Manifest
  sign: SignTransaction
  rpc?: ReviewRpcServer
  nowMs?: number
}): Promise<TxResult> {
  const { review } = p
  const record = issuance(review, review.preparedAtMs, "review")
  const fresh = () => {
    if (isExpired(record, currentTime(p.nowMs))) {
      throw new Error(
        "This review is over a minute old. Prepare it again to re-check the live conditions before signing.",
      )
    }
  }
  fresh()
  const call = assertReviewIntact(review, p.manifest, record)

  const sent = await signAndSubmit({
    unsignedXdr: review.unsignedXdr,
    manifest: p.manifest,
    source: call.source,
    sign: p.sign,
    rpc: p.rpc,
    afterSign: fresh,
  })
  if (sent.status !== "SUCCESS") return unsuccessful(sent)
  if (call.action === undefined) return { hash: sent.hash, status: "SUCCESS" }

  const unreadable = (reason: string): TxResult => ({
    hash: sent.hash,
    status: "SUCCESS",
    output: undefined,
    decodeError: `The transaction succeeded, but its result could not be read (${reason}).`,
  })
  if (sent.decodeError) return unreadable(sent.decodeError)
  if (sent.returnValue === undefined) return unreadable("it returned no value")
  try {
    return { hash: sent.hash, status: "SUCCESS", output: parseOutput(call.action, sent.returnValue) }
  } catch (error) {
    return unreadable(errorText(error))
  }
}

/**
 * What a restore may touch: the contracts of every market `invocation` belongs to, plus the shared
 * ones, and the Wasm hashes (lower-case hex) those markets' manifests pin, if any (R29b).
 */
function restoreScope(manifest: Manifest, invocation: ContractInvocation): { contracts: Set<string>; wasmHashes?: Set<string> } {
  const markets = manifest.markets.filter((m) => Object.values(m.contracts).includes(invocation.contractId))
  if (markets.length === 0) {
    throw new Error("This call is not to a contract of this network's markets, so no restore is offered.")
  }
  const contracts = new Set([
    ...markets.flatMap((m) => [...Object.values(m.contracts), m.underlying.sac]),
    manifest.shared.riskControl,
    manifest.shared.permissioning,
  ])
  const pinned = markets.flatMap((m) => (m.wasmHashes ? Object.values(m.wasmHashes) : []))
  return pinned.length > 0 ? { contracts, wasmHashes: new Set(pinned.map((h) => h.toLowerCase())) } : { contracts }
}

/**
 * R29/R29b: a restore footprint is read-write only, and every key belongs to the market: contract
 * data (instances included) of its manifest contracts, or Wasm code whose hash the manifest pins.
 * Hashes are compared as exact bytes (hex of the key's bytes); RPC is never asked which code is ours.
 */
function assertRestorable(footprint: SorobanDataBuilder, scope: { contracts: Set<string>; wasmHashes?: Set<string> }): void {
  const refuse = (cause: string, fix = "try again or use another RPC"): never => {
    throw new Error(`${cause} Refusing to restore it; ${fix}.`)
  }
  if (footprint.getReadOnly().length > 0) refuse("The restore asked for includes read-only entries.")
  const keys = footprint.getReadWrite()
  if (keys.length === 0) refuse("The restore asked for names no ledger entry.")

  for (const key of keys) {
    if (key.type === "contractData") {
      const contract = Address.fromScAddress(key.contractData.contract).toString()
      if (!scope.contracts.has(contract)) refuse(`The restore asked for includes data of a contract outside this market (${contract}).`)
    } else if (key.type === "contractCode") {
      if (!scope.wasmHashes) {
        throw new Error("Restore needs contract code the manifest does not pin; ask the operator.")
      }
      const hash = bytesToHex(key.contractCode.hash.toBytes())
      if (!scope.wasmHashes.has(hash)) {
        refuse(`The restore asked for includes contract code the manifest does not pin (${hash}).`, "ask the operator, or use another RPC")
      }
    } else {
      refuse(`The restore asked for includes a ${key.type} entry, which is not contract data.`)
    }
  }
}

/**
 * Builds the restore transaction an archived-entry simulation asks for: the action is simulated as
 * `source`, and the simulation's `restorePreamble` (footprint and fee) becomes one
 * `restoreFootprint` operation, at the account's fresh sequence. The footprint and fee are checked
 * (R29) and the fee is returned so it is shown before signing; it expires like a review.
 */
export async function prepareRestore(p: {
  manifest: Manifest
  source: string
  invocation: ContractInvocation
  rpc?: ReviewRpcServer
}): Promise<RestoreReview> {
  const { manifest, source } = p
  const scope = restoreScope(manifest, p.invocation)
  const server = p.rpc ?? createRpcServer(manifest.rpcUrl)
  const sequence = (await server.getAccount(source)).sequenceNumber()
  const simulation = await server.simulateTransaction(
    buildInvocationEnvelope({ source, sequence, networkPassphrase: manifest.networkPassphrase, invocation: p.invocation }),
  )
  if (!rpc.Api.isSimulationRestore(simulation)) {
    throw new Error("No contract data needs restoring for this transaction, so there is nothing to restore. Prepare the action again.")
  }

  const { transactionData, minResourceFee } = simulation.restorePreamble
  const resourceFee = /^\d+$/.test(minResourceFee) ? BigInt(minResourceFee) : undefined
  if (resourceFee === undefined) throw new Error("RPC returned no valid restore fee. Refusing to restore; try again.")
  assertFeeCapped(BigInt(BASE_FEE) + resourceFee, "The restore")
  // A copy: the checked footprint is the one that is signed.
  const sorobanData = new SorobanDataBuilder(transactionData.build()).setResourceFee(resourceFee.toString())
  assertRestorable(sorobanData, scope)

  // build() adds the resource fee to `fee`, so `fee` is the inclusion fee alone.
  const restore = new TransactionBuilder(new Account(source, sequence), {
    fee: BASE_FEE,
    networkPassphrase: manifest.networkPassphrase,
  })
    .setSorobanData(sorobanData.build())
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build()
  const unsignedXdr = restore.toXDR()
  const preparedAtMs = Date.now()
  const prepared: RestoreReview = {
    source,
    unsignedXdr,
    unsignedXdrHash: hashLike(unsignedXdr),
    fee: restore.fee,
    preparedAtMs,
    expiresAtMs: preparedAtMs + REVIEW_TTL_MS,
  }
  issued.set(prepared, { preparedAtMs, unsignedXdrHash: prepared.unsignedXdrHash })
  return prepared
}

/**
 * Signs and submits a prepared restore under the same rules as a review (R31): only a restore
 * `prepareRestore` returned, 60 s from the issued time (checked again after signing), and still
 * exactly the single `restoreFootprint` transaction it issued, from `source`, at its fee.
 */
export async function executeRestore(p: {
  restore: RestoreReview
  manifest: Manifest
  sign: SignTransaction
  rpc?: ReviewRpcServer
  nowMs?: number
}): Promise<TxResult> {
  const { restore } = p
  const record = issuance(restore, restore.preparedAtMs, "restore")
  const fresh = () => {
    if (isExpired(record, currentTime(p.nowMs))) {
      throw new Error("This restore was prepared over a minute ago. Prepare it again before signing.")
    }
  }
  fresh()
  assertRestoreIntact(restore, p.manifest, record)

  const sent = await signAndSubmit({
    unsignedXdr: restore.unsignedXdr,
    manifest: p.manifest,
    source: restore.source,
    sign: p.sign,
    rpc: p.rpc,
    afterSign: fresh,
  })
  return sent.status === "SUCCESS" ? { hash: sent.hash, status: sent.status } : unsuccessful(sent)
}
