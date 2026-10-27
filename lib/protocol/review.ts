/**
 * The prepared review and its execution: the last code path before the user's signature.
 *
 * `prepareReview` builds the exact transaction, has RPC prepare it (`server.prepareTransaction`:
 * simulation, footprint, auth) and describes it in plain words. `executeReview` refuses a review
 * older than 60 s, has the wallet sign it, checks the wallet signed exactly that transaction, then
 * submits, polls and decodes the result. `prepareRestore` builds the `restoreFootprint`
 * transaction an archived-entry simulation asks for.
 *
 * Ported from `dapp-old/src/lib/transactions.ts` (the prepared review only: the preview and local
 * XDR modes are dropped), `buildPreparedInvokeTransaction` from `dapp-old/src/lib/stellar.ts` (R14)
 * and the `signAndSubmit` flow of `dapp-old/src/App.tsx`.
 */
import {
  Account,
  BASE_FEE,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk"
import { ACTION_META, invocationFor, type ActionId, type ActionInput, type GuardValues } from "./actions"
import { formatAmount } from "./format"
import { parseOutput, type ActionOutput } from "./guards"
import { hashLike } from "./hash"
import { getMarket } from "./manifest"
import {
  assertSignedTransactionMatchesReview,
  buildInvocationEnvelope,
  createRpcServer,
  pollTransactionStatus,
  simulateInvocation,
  submitSignedTransaction,
  type ContractInvocation,
} from "./stellar"
import type { Manifest, Market } from "./types"

/** A prepared review expires 60 s after preparation (shared context). */
export const REVIEW_TTL_MS = 60_000

/** Transaction validity window (time bounds), as dapp-old used for its 300 s deadline default. */
const TX_TIMEOUT_SECONDS = 300

/** Every Principal token, and XLM, have 7 decimals. */
const TOKEN_DECIMALS = 7
const XLM_DECIMALS = 7

export type Review = {
  input: ActionInput
  invocation: ContractInvocation
  unsignedXdr: string
  unsignedXdrHash: string
  /** Total fee of the prepared transaction, in stroops: the most the network can charge. */
  fee: string
  preparedAtMs: number
  expiresAtMs: number
  summary: { give: string[]; getAtLeast: string[]; fees: string[]; deadline?: number }
  callTree: string[]
}

export type TxStatus = "SUCCESS" | "FAILED" | "NOT_FOUND"

export type TxResult = {
  hash: string
  status: TxStatus
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
  PollServer & { prepareTransaction(transaction: Transaction): Promise<Transaction> }

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hostFunctionXdr(transaction: Transaction): string | undefined {
  const [operation] = transaction.operations
  return operation?.type === "invokeHostFunction" ? operation.func.toXdr("base64") : undefined
}

/** RPC adds footprint, auth and fees; it must not change who calls what, or at which sequence. */
function assertPreparedMatches(built: Transaction, prepared: Transaction): void {
  const expected = hostFunctionXdr(built)
  const same =
    expected !== undefined &&
    prepared.operations.length === 1 &&
    hostFunctionXdr(prepared) === expected &&
    prepared.source === built.source &&
    prepared.sequence === built.sequence &&
    prepared.networkPassphrase === built.networkPassphrase
  if (!same) {
    throw new Error(
      "RPC returned a prepared transaction that is not the transaction that was requested. Refusing to review it; try again or use another RPC.",
    )
  }
}

function summarize(market: Market, input: ActionInput, fee: string): Review["summary"] {
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
      give = [amount(a, "PT"), amount(b, "SY")]
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
      give = b > 0n ? [amount(a, "PT"), amount(b, "YT")] : [amount(a, "PT")]
      getAtLeast = [`${underlying} at the settlement rate. The rate is fixed at settlement, so this call sets no minimum.`]
      protocolFees = b > 0n ? [ytFee] : []
      break
  }

  const fees = [`Network fee: up to ${formatAmount(BigInt(fee), XLM_DECIMALS, XLM_DECIMALS)} XLM`, ...protocolFees]
  return ACTION_META[input.action].hasDeadline
    ? { give, getAtLeast, fees, deadline: Number(input.deadline) }
    : { give, getAtLeast, fees }
}

/**
 * Builds the exact transaction for `input`, has RPC prepare it and describes it for review.
 * Refuses a zero floor (R5) before any RPC call.
 */
export async function prepareReview(p: { manifest: Manifest; input: ActionInput; rpc?: ReviewRpcServer }): Promise<Review> {
  const { manifest, input } = p
  const market = getMarket(manifest, input.marketId)
  if (!market) throw new Error(`Unknown market "${input.marketId}".`)
  assertNoZeroFloor(input)
  const invocation = invocationFor(manifest, input)

  // Ported from dapp-old buildPreparedInvokeTransaction (R14).
  const server = p.rpc ?? createRpcServer(manifest.rpcUrl)
  const account = await server.getAccount(input.source)
  const built = buildInvocationEnvelope({
    source: input.source,
    sequence: account.sequenceNumber(),
    networkPassphrase: manifest.networkPassphrase,
    invocation,
    timeoutSeconds: TX_TIMEOUT_SECONDS,
  })
  let prepared: Transaction
  try {
    prepared = await server.prepareTransaction(built)
  } catch (error) {
    throw new Error(
      `The transaction could not be prepared (${errorText(error)}). Nothing was signed; check the reasons shown and try again.`,
    )
  }
  assertPreparedMatches(built, prepared)

  const unsignedXdr = prepared.toXDR()
  const preparedAtMs = Date.now()
  return {
    input,
    invocation,
    unsignedXdr,
    unsignedXdrHash: hashLike(unsignedXdr),
    fee: prepared.fee,
    preparedAtMs,
    expiresAtMs: preparedAtMs + REVIEW_TTL_MS,
    summary: summarize(market, input, prepared.fee),
    callTree: CALL_TREES[input.action],
  }
}

/** True once 60 s have passed since preparation. A clock that went backwards, or NaN, also expires it. */
export function isExpired(review: Pick<Review, "preparedAtMs">, nowMs: number): boolean {
  if (!Number.isFinite(nowMs) || nowMs < review.preparedAtMs) return true
  return nowMs - review.preparedAtMs >= REVIEW_TTL_MS
}

export type SubmittedTransaction = {
  hash: string
  status: TxStatus
  returnValue?: unknown
  decodeError?: string
  pollError?: string
}

/**
 * Signs `unsignedXdr` with the wallet, refuses anything but exactly that transaction signed by
 * `source`, submits it and polls for the result. Used by `executeReview`, and for a restore.
 * Once RPC has returned a hash it is never lost: a failure to read the result is reported, not thrown.
 */
export async function signAndSubmit(p: {
  unsignedXdr: string
  manifest: Manifest
  source: string
  sign: SignTransaction
  rpc?: ReviewRpcServer
}): Promise<SubmittedTransaction> {
  const { manifest } = p
  const server = p.rpc ?? createRpcServer(manifest.rpcUrl)
  const signedXdr = await p.sign(p.unsignedXdr, manifest.networkPassphrase, p.source)
  assertSignedTransactionMatchesReview({
    unsignedXdr: p.unsignedXdr,
    signedXdr,
    networkPassphrase: manifest.networkPassphrase,
    expectedSigner: p.source,
  })

  const submitted = await submitSignedTransaction({
    rpcUrl: manifest.rpcUrl,
    networkPassphrase: manifest.networkPassphrase,
    signedXdr,
    server,
  })
  if (submitted.status === "TRY_AGAIN_LATER") {
    throw new Error(
      "The network is busy and did not accept the transaction. Nothing was submitted; review it again in a moment.",
    )
  }

  // PENDING (queued) and DUPLICATE (already queued) are both polled.
  let polled: Awaited<ReturnType<typeof pollTransactionStatus>>
  try {
    polled = await pollTransactionStatus({ rpcUrl: manifest.rpcUrl, hash: submitted.hash, server })
  } catch (error) {
    return {
      hash: submitted.hash,
      status: "NOT_FOUND",
      pollError: `The transaction was submitted, but its status could not be read (${errorText(error)}). Look it up by its hash before trying again.`,
    }
  }
  if (polled.status === "SUCCESS") {
    return polled.decodeError
      ? { hash: submitted.hash, status: "SUCCESS", decodeError: polled.decodeError }
      : { hash: submitted.hash, status: "SUCCESS", returnValue: polled.returnValue }
  }
  return { hash: submitted.hash, status: polled.status === "FAILED" ? "FAILED" : "NOT_FOUND" }
}

/**
 * Executes a prepared review: refuses it once expired, then signs, checks, submits, polls and
 * decodes. After SUCCESS a return value that cannot be read gives `output: undefined` and a
 * `decodeError`, never a throw: the hash and status of an on-chain transaction are not lost.
 */
export async function executeReview(p: {
  review: Review
  manifest: Manifest
  sign: SignTransaction
  rpc?: ReviewRpcServer
  nowMs?: number
}): Promise<TxResult> {
  const { review } = p
  if (isExpired(review, p.nowMs ?? Date.now())) {
    throw new Error(
      "This review is over a minute old. Prepare it again to re-check the live conditions before signing.",
    )
  }

  const sent = await signAndSubmit({
    unsignedXdr: review.unsignedXdr,
    manifest: p.manifest,
    source: review.input.source,
    sign: p.sign,
    rpc: p.rpc,
  })
  if (sent.status !== "SUCCESS") {
    return sent.pollError ? { hash: sent.hash, status: sent.status, pollError: sent.pollError } : { hash: sent.hash, status: sent.status }
  }

  const unreadable = (reason: string): TxResult => ({
    hash: sent.hash,
    status: "SUCCESS",
    output: undefined,
    decodeError: `The transaction succeeded, but its result could not be read (${reason}).`,
  })
  if (sent.decodeError) return unreadable(sent.decodeError)
  if (sent.returnValue === undefined) return unreadable("it returned no value")
  try {
    return { hash: sent.hash, status: "SUCCESS", output: parseOutput(review.input.action, sent.returnValue) }
  } catch (error) {
    return unreadable(errorText(error))
  }
}

/**
 * Builds the restore transaction an archived-entry simulation asks for: the action is simulated as
 * `source`, and the simulation's `restorePreamble` (footprint and fee) becomes one
 * `restoreFootprint` operation, at the account's fresh sequence.
 */
export async function prepareRestore(p: {
  manifest: Manifest
  source: string
  invocation: ContractInvocation
  rpc?: ReviewRpcServer
}): Promise<{ unsignedXdr: string; unsignedXdrHash: string }> {
  const { manifest, source } = p
  const server = p.rpc ?? createRpcServer(manifest.rpcUrl)
  const sequence = (await server.getAccount(source)).sequenceNumber()
  const simulation = await server.simulateTransaction(
    buildInvocationEnvelope({ source, sequence, networkPassphrase: manifest.networkPassphrase, invocation: p.invocation }),
  )
  if (!rpc.Api.isSimulationRestore(simulation)) {
    throw new Error("No contract data needs restoring for this transaction, so there is nothing to restore. Prepare the action again.")
  }

  const { transactionData, minResourceFee } = simulation.restorePreamble
  // build() adds the resource fee to `fee`, so `fee` is the inclusion fee alone.
  const sorobanData = new SorobanDataBuilder(transactionData.build()).setResourceFee(minResourceFee).build()
  const restore = new TransactionBuilder(new Account(source, sequence), {
    fee: BASE_FEE,
    networkPassphrase: manifest.networkPassphrase,
  })
    .setSorobanData(sorobanData)
    .addOperation(Operation.restoreFootprint({}))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build()
  const unsignedXdr = restore.toXDR()
  return { unsignedXdr, unsignedXdrHash: hashLike(unsignedXdr) }
}
