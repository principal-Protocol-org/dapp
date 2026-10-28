// @vitest-environment node
/**
 * The protocol layer end to end against real contracts on the local network (Task 23).
 *
 * Every step goes through the production functions the app uses: reads (`fetchMarketState`,
 * `fetchAccountState`, `evaluateAccountCompliance`), gates (`evaluateGates`, expected empty), the
 * exact simulation with open guards (`simulateInvocation`, `parseOutput`), slippage floors
 * (`guardsFrom`, 50 bps), `prepareReview` and `executeReview` (sign, submit, poll, decode), the
 * onboarding helpers and the server faucet with its real chain. A keypair stands in for Freighter.
 *
 * Skipped unless `config/manifests/local.json` is a `local` manifest and its RPC answers
 * (`scripts/dev-stack/up.sh`). The deployed market must mature within the run; when it does not
 * fit, the suite deploys a fresh one (`scripts/dev-stack/deploy.sh`, which rewrites local.json).
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { Keypair, Transaction, rpc, scValToNative } from "@stellar/stellar-sdk"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// `server-only` throws outside a react-server bundle; the faucet is imported here as the route does.
vi.mock("server-only", () => ({}))

import { fetchAccountState, type AccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { ACTION_META, invocationFor, type ActionId, type ActionInput, type GuardValues } from "@/lib/protocol/actions"
import { evaluateAccountCompliance, fetchMarketCompliance, type ComplianceItem } from "@/lib/protocol/compliance"
import { fetchAccountHistory, type HistoryKind } from "@/lib/protocol/events"
import { evaluateGates, type GateContext } from "@/lib/protocol/gates"
import { guardsFrom, openGuards, parseOutput, type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { parseManifest, validateManifest } from "@/lib/protocol/manifest"
import { fetchMarketState, type MarketState } from "@/lib/protocol/market-state"
import { BPS, ceilDiv } from "@/lib/protocol/math"
import { addTrustline, fetchMarketPermissions, onboardingSteps } from "@/lib/protocol/onboarding"
import { createRpcReader, isContractError } from "@/lib/protocol/reader"
import { assertPreparedMatches, executeReview, prepareReview } from "@/lib/protocol/review"
import {
  AMOUNTS_MOVED_REASON,
  buildInvocationEnvelope,
  createRpcServer,
  failedTransactionReason,
  getLedgerClock,
  pollTransactionStatus,
  simulateInvocation,
  submitSignedTransaction,
  type ContractInvocation,
  type SimulationOutcome,
} from "@/lib/protocol/stellar"
import type { Finding, Manifest, Market } from "@/lib/protocol/types"
import { pendingYield } from "@/lib/protocol/yield"
import { createStellarFaucetChain, resetFaucetStateForTests, runFaucet } from "@/lib/server/faucet"
import { fundedKeypairSigner, type KeypairSigner } from "./keypair-signer"

const run = promisify(execFile)

const DAPP = join(__dirname, "..", "..")
const MANIFEST_PATH = join(DAPP, "config", "manifests", "local.json")
const DEV_STACK = join(DAPP, "scripts", "dev-stack")

/** Shared-context defaults: 50 bps slippage, 300 s deadline. */
const SLIPPAGE_BPS = 50n
const DEADLINE_SECONDS = 300
/** One whole token at 7 decimals. */
const U = 10_000_000n

/**
 * Seconds from the start of the run to maturity the pre-maturity steps need (onboarding, 11
 * transactions and the pinned zap, two oracle ticks, a pause and an unpause: about 1.5 minutes
 * measured), and the most this run waits for maturity.
 * Outside that window a fresh market is deployed, maturing `DEPLOY_MATURITY_SECONDS` after the
 * deploy reads the ledger time (the deploy itself takes about two minutes of that).
 */
const MIN_RUNWAY_SECONDS = 240
const MAX_RUNWAY_SECONDS = 900
const DEPLOY_MATURITY_SECONDS = 600

const MINUTE = 60_000

function readManifest(): Manifest {
  return parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")))
}

/** Why the suite cannot run here, or null: a local manifest and a healthy RPC are required. */
async function skipReason(): Promise<string | null> {
  if (!existsSync(MANIFEST_PATH)) return "config/manifests/local.json does not exist"
  let manifest: Manifest
  try {
    manifest = readManifest()
  } catch (error) {
    return `config/manifests/local.json is not a valid manifest (${error instanceof Error ? error.message : String(error)})`
  }
  if (manifest.network !== "local") return `config/manifests/local.json is for "${manifest.network}", not "local"`
  try {
    const health = await createRpcServer(manifest.rpcUrl).getHealth()
    if (health.status !== "healthy") return `the local RPC reports "${health.status}"`
  } catch (error) {
    return `the local RPC does not answer (${error instanceof Error ? error.message : String(error)})`
  }
  return null
}

const skip = await skipReason()
if (skip) console.info(`[integration] skipped: ${skip}. Start it with scripts/dev-stack/up.sh.`)

/** The faucet key the dev stack wrote; read here, never printed. */
function faucetIssuerSecret(): string {
  const prefix = "FAUCET_ISSUER_SECRET="
  const line = readFileSync(join(DAPP, ".env.local"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(prefix))
  if (!line) throw new Error(".env.local has no FAUCET_ISSUER_SECRET; run scripts/dev-stack/deploy.sh")
  return line.slice(prefix.length).trim()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `read` until `done` holds (Horizon trails RPC by a ledger or two). */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(1_000)
  }
}

const abs = (v: bigint) => (v < 0n ? -v : v)
/** JSON that survives bigints (results and outcomes carry them). */
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))

/** Everything the run observed, printed again at the end so the report has it in one place. */
const observed: string[] = []
function log(line: string): void {
  observed.push(line)
  console.info(`[integration] ${line}`)
}
const show = (out: ActionOutput) =>
  Object.entries(out)
    .filter(([k]) => k !== "kind")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ")

/** The numeric fields of an output, by name. */
function fieldsOf(out: ActionOutput): Record<string, bigint> {
  const fields: Record<string, bigint> = {}
  for (const [k, v] of Object.entries(out)) if (typeof v === "bigint") fields[k] = v
  return fields
}

/** (a) T7: the raw `scValToNative` shapes `parseOutput` relies on — structs are objects, tuples arrays. */
function expectRawShape(action: ActionId, retval: unknown): void {
  const bigints = (value: unknown, n: number) => {
    expect(Array.isArray(value), `${action} returns a tuple (array)`).toBe(true)
    const items = value as unknown[]
    expect(items).toHaveLength(n)
    for (const item of items) expect(typeof item).toBe("bigint")
  }
  const struct = (value: unknown, keys: string[]) => {
    expect(typeof value === "object" && value !== null && !Array.isArray(value), `${action} returns a struct (object)`).toBe(true)
    const record = value as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual([...keys].sort())
    for (const key of keys) expect(typeof record[key], `${action}.${key}`).toBe("bigint")
  }
  switch (action) {
    case "mint":
      return struct(retval, ["pt_minted", "yt_minted", "fee_shares"])
    case "redeem":
      return struct(retval, ["underlying_from_pt", "underlying_from_yt"])
    case "buy_yt":
    case "remove_liquidity":
      return bigints(retval, 2)
    case "add_liquidity":
    case "add_liquidity_sy":
      return bigints(retval, 3)
    default:
      expect(typeof retval, `${action} returns an integer`).toBe("bigint")
  }
}

/** The decoded result honours the signed floors (the contract enforces them; checked here too). */
function expectFloors(input: ActionInput, out: ActionOutput, g: GuardValues): void {
  switch (out.kind) {
    case "amount":
      if (g.minOut !== undefined) expect(out.value >= g.minOut).toBe(true)
      return
    case "mint":
      expect(out.pt_minted >= g.minOut!).toBe(true)
      return
    case "add_liquidity":
      expect(out.lp >= g.minOut!).toBe(true)
      return
    case "remove_liquidity":
      expect(out.pt >= g.minOut!).toBe(true)
      expect(out.sy >= g.minOut2!).toBe(true)
      return
    case "buy_yt":
      expect(out.yt_out >= g.minOut!).toBe(true)
      expect(input.amount - out.sy_back <= g.maxNetCost!).toBe(true)
      return
    case "redeem":
      return
  }
}

/** History kind each action's transaction is listed as (T19). */
const HISTORY_KIND: Record<ActionId, HistoryKind> = {
  deposit: "deposit",
  withdraw: "withdraw",
  mint: "mint",
  buy_pt: "buy_pt",
  sell_pt: "sell_pt",
  buy_yt: "buy_yt",
  sell_yt: "sell_yt",
  add_liquidity: "add_liquidity",
  add_liquidity_sy: "add_liquidity",
  remove_liquidity: "remove_liquidity",
  recombine: "recombine",
  claim_yield: "claim",
  redeem: "redeem",
}

/** A user's approval time in Freighter, between preparation and submission (well inside the 60 s review window). */
const SIGNING_DELAY_MS = 5_000

/**
 * The account's nested `SY.transfer(from, pool, amount)` in the signed authorization of an
 * `add_liquidity_single_sy` (Router → MarketPool → SY), as simulation recorded it.
 */
function signedNestedTransfer(unsignedXdr: string, networkPassphrase: string): { from: string; amount: bigint } {
  const tx = new Transaction(unsignedXdr, networkPassphrase)
  const [operation] = tx.operations
  if (operation?.type !== "invokeHostFunction") throw new Error("not a contract call")
  const transfer = operation.auth?.[0]?.rootInvocation.subInvocations[0]?.subInvocations[0]?.function
  if (transfer?.type !== "sorobanAuthorizedFunctionTypeContractFn" || transfer.contractFn.functionName.toString() !== "transfer") {
    throw new Error("the authorization has no nested transfer")
  }
  const [from, , amount] = transfer.contractFn.args.map((a) => scValToNative(a) as unknown)
  if (typeof from !== "string" || typeof amount !== "bigint") throw new Error("unexpected transfer arguments")
  return { from, amount }
}

type ScErrorLike = { type: string; code?: { name?: string } }

/** Why a transaction failed on-chain: its result code, the auth refusal, the transfer amount it ran with. */
async function failureOf(rpcUrl: string, hash: string) {
  const tx = await createRpcServer(rpcUrl).getTransaction(hash)
  if (tx.status !== rpc.Api.GetTransactionStatus.FAILED) throw new Error(`transaction ${hash} is ${tx.status}, not FAILED`)
  const outcome = tx.resultXdr.result
  const op = outcome.type === "txFailed" ? outcome.results[0] : undefined
  const result = op?.type === "opInner" && op.tr.type === "invokeHostFunction" ? op.tr.invokeHostFunctionResult.type : outcome.type
  let authInvalidAction = false
  let executedTransfer: bigint | undefined
  for (const { event } of tx.diagnosticEventsXdr ?? []) {
    const [topic, detail, fn] = event.body.value.topics
    if (topic?.type !== "scvSymbol") continue
    if (topic.value === "error" && detail?.type === "scvError") {
      const error = detail.error as unknown as ScErrorLike
      if (error.type === "sceAuth" && error.code?.name === "scecInvalidAction") authInvalidAction = true
    }
    if (topic.value === "fn_call" && fn?.type === "scvSymbol" && fn.value === "transfer") {
      const args = scValToNative(event.body.value.data) as unknown
      if (Array.isArray(args) && typeof args[2] === "bigint") executedTransfer = args[2]
    }
  }
  return { result, authInvalidAction, executedTransfer }
}

type Snapshot = { ms: MarketState; acc: AccountState; compliance: ComplianceItem[]; ledgerTime: number }
type Sent = { action: ActionId; hash: string; simulated: ActionOutput; decoded: ActionOutput }

describe.skipIf(skip !== null)("protocol layer on the local network", () => {
  let manifest: Manifest
  let market: Market
  let findings: Finding[]
  let kind: ComplianceKind
  let signer: KeypairSigner
  let account: string
  let issuerSecret: string
  let managerPaused = false
  /** Ledger before the first protocol transaction: the start of the history check's window. */
  let firstLedger = 0
  const sent: Sent[] = []
  /** Hashes of transactions that failed on-chain (the pinned pool limitation). */
  const failed: string[] = []

  const reader = () => createRpcReader(manifest)
  const horizon = () => createHorizon(manifest.horizonUrl)
  const server = () => createRpcServer(manifest.rpcUrl)

  async function ledgerClock() {
    const clock = await getLedgerClock(server())
    return { ...clock, now: () => clock.closeTime + (Date.now() - clock.readAtMs) / 1000 }
  }

  async function oracleTick(rate?: bigint): Promise<string> {
    const { stdout } = await run(join(DEV_STACK, "oracle-tick.sh"), rate === undefined ? [] : [rate.toString()], { cwd: DAPP })
    const line = stdout.trim()
    log(line)
    return line
  }

  async function snapshot(): Promise<Snapshot> {
    const [clock, ms, acc] = await Promise.all([
      ledgerClock(),
      fetchMarketState(reader(), manifest, market.marketId),
      fetchAccountState(reader(), horizon(), manifest, market.marketId, account, kind),
    ])
    return { ms, acc, compliance: evaluateAccountCompliance(acc, kind), ledgerTime: clock.now() }
  }

  function gateContext(s: Snapshot, simulation: SimulationOutcome): GateContext {
    return {
      findings,
      wallet: { status: "connected", publicKey: account, networkPassphrase: manifest.networkPassphrase },
      market: s.ms,
      account: s.acc,
      compliance: s.compliance,
      ledgerTime: s.ledgerTime,
      simulation,
      managerId: market.contracts.manager,
    }
  }

  /** The simulation input, as the action panel builds it: open guards, deadline from ledger time. */
  function simInputFor(action: ActionId, amount: bigint, secondaryAmount: bigint | undefined, s: Snapshot): ActionInput {
    return {
      action,
      marketId: market.marketId,
      source: account,
      amount,
      ...(secondaryAmount === undefined ? {} : { secondaryAmount }),
      guards: openGuards(action, amount),
      deadline: BigInt(Math.floor(s.ledgerTime) + DEADLINE_SECONDS),
    }
  }

  function simulate(input: ActionInput): Promise<SimulationOutcome> {
    return simulateInvocation({
      rpcUrl: manifest.rpcUrl,
      networkPassphrase: manifest.networkPassphrase,
      source: input.source,
      invocation: invocationFor(manifest, input),
    })
  }

  /**
   * An action up to the signature, as the action panel takes it: gates empty, exact simulation with
   * open guards, floors at 50 bps from the simulated output, then the prepared review.
   */
  async function reviewStep(action: ActionId, amount: bigint, secondaryAmount?: bigint) {
    const before = await snapshot()
    const simInput = simInputFor(action, amount, secondaryAmount, before)
    const simulation = await simulate(simInput)
    const blockers = evaluateGates({ ...simInput, guards: {}, deadline: 0n }, gateContext(before, simulation))
    expect(blockers, `${action}: gates`).toEqual([])
    if (!simulation.ok) throw new Error(`${action}: simulation failed: ${json(simulation)}`)

    expectRawShape(action, simulation.retval)
    const simulated = parseOutput(action, simulation.retval)
    const guards = guardsFrom(action, simInput, simulated, SLIPPAGE_BPS)
    expect(guards.ok, `${action}: guardsFrom ${json(guards)}`).toBe(true)
    if (!guards.ok) throw new Error(guards.reason)

    const input: ActionInput = { ...simInput, guards: guards.guards, deadline: BigInt(Math.floor((await ledgerClock()).now()) + DEADLINE_SECONDS) }
    const review = await prepareReview({ manifest, input })
    return { before, input, simulated, guards: guards.guards, review }
  }

  /**
   * One action through every production step: `reviewStep`, then sign, submit, poll and decode;
   * SUCCESS, and the decoded output within 50 bps (rounded up) of the simulated one.
   */
  async function runStep(action: ActionId, amount: bigint, secondaryAmount?: bigint): Promise<Sent> {
    const { input, simulated, guards, review } = await reviewStep(action, amount, secondaryAmount)
    const result = await executeReview({ review, manifest, sign: signer.sign })
    expect(result.status, `${action}: ${json(result)}`).toBe("SUCCESS")
    expect(result.decodeError).toBeUndefined()
    const decoded = result.output
    if (!decoded) throw new Error(`${action}: no decoded output`)
    expect(decoded.kind).toBe(simulated.kind)

    const sim = fieldsOf(simulated)
    const dec = fieldsOf(decoded)
    expect(Object.keys(dec).sort()).toEqual(Object.keys(sim).sort())
    for (const [field, s] of Object.entries(sim)) {
      const tolerance = ceilDiv(abs(s) * SLIPPAGE_BPS, BPS)
      expect(abs(dec[field] - s) <= tolerance, `${action}.${field}: decoded ${dec[field]} vs simulated ${s} (±${tolerance})`).toBe(true)
    }
    expectFloors(input, decoded, guards)

    const step = { action, hash: result.hash, simulated, decoded }
    sent.push(step)
    log(`${action}: tx ${result.hash.slice(0, 12)} simulated ${show(simulated)} | decoded ${show(decoded)}`)
    return step
  }

  /** An admin call (the dev stack's pp-admin is the issuer and every contract's admin), checked like the faucet's. */
  async function adminInvoke(invocation: ContractInvocation): Promise<void> {
    const admin = Keypair.fromSecret(issuerSecret)
    const node = server()
    const source = admin.publicKey()
    const built = buildInvocationEnvelope({
      source,
      sequence: (await node.getAccount(source)).sequenceNumber(),
      networkPassphrase: manifest.networkPassphrase,
      invocation,
    })
    const prepared = await node.prepareTransaction(built)
    assertPreparedMatches(built, prepared)
    prepared.sign(admin)
    const { hash } = await submitSignedTransaction({
      rpcUrl: manifest.rpcUrl,
      networkPassphrase: manifest.networkPassphrase,
      signedXdr: prepared.toXdr(),
    })
    const polled = await pollTransactionStatus({ rpcUrl: manifest.rpcUrl, hash, attempts: 30, intervalMs: 1_000 })
    expect(polled.status, `${invocation.functionName}`).toBe("SUCCESS")
  }

  const setManagerPaused = async (paused: boolean) => {
    await adminInvoke({
      contractId: market.contracts.manager,
      functionName: "set_paused",
      args: [
        { type: "address", value: Keypair.fromSecret(issuerSecret).publicKey() },
        { type: "bool", value: paused },
      ],
    })
    managerPaused = paused
  }

  beforeAll(async () => {
    manifest = readManifest()
    const runway = manifest.markets[0].maturity - (await getLedgerClock(createRpcServer(manifest.rpcUrl))).closeTime
    if (runway < MIN_RUNWAY_SECONDS || runway > MAX_RUNWAY_SECONDS) {
      log(`market matures in ${runway} s; deploying a fresh one (MATURITY_SECONDS=${DEPLOY_MATURITY_SECONDS})`)
      const started = Date.now()
      try {
        await run(join(DEV_STACK, "deploy.sh"), [], {
          cwd: DAPP,
          env: { ...process.env, MATURITY_SECONDS: String(DEPLOY_MATURITY_SECONDS) },
          maxBuffer: 64 * 1024 * 1024,
        })
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string }
        throw new Error(`deploy.sh failed:\n${String(e.stdout ?? "").slice(-2000)}\n${String(e.stderr ?? "").slice(-2000)}`)
      }
      log(`deployed in ${Math.round((Date.now() - started) / 1000)} s`)
      manifest = readManifest()
    }
    market = manifest.markets[0]
    issuerSecret = faucetIssuerSecret()
    findings = validateManifest(manifest)
    // A fresh oracle value: the market may have been deployed more than an hour ago.
    await oracleTick()
  }, 8 * MINUTE)

  afterAll(async () => {
    // Never leave the developer's network paused, whatever failed.
    if (managerPaused) await setManagerPaused(false)
    console.info(`[integration] summary\n${observed.join("\n")}`)
  }, MINUTE)

  it("reads the market and its compliance model live", async () => {
    expect(findings.filter((f) => f.severity === "error")).toEqual([])
    const ms = await fetchMarketState(reader(), manifest, market.marketId)
    expect(ms.topology).toMatchObject({ status: "live", value: { matches: true, mismatches: [] } })
    expect(ms.poolSeeded).toMatchObject({ status: "live", value: true })
    expect(ms.oracleFresh).toMatchObject({ status: "live", value: true })
    expect(ms.settledRate).toMatchObject({ status: "live", value: null })
    // Every read the dApp makes answers on the real contracts.
    const unavailable = Object.entries({ ...ms, ...ms.fees, ...ms.cb })
      .filter(([, v]) => typeof v === "object" && v !== null && "status" in v && v.status === "unavailable")
      .map(([k, v]) => `${k}: ${(v as { error: string }).error}`)
    expect(unavailable).toEqual([])

    const model = await fetchMarketCompliance(horizon(), reader(), market)
    expect(model).toMatchObject({
      status: "live",
      value: { kind: "sac", authRequired: true, authRevocable: true, clawbackEnabled: true, administrator: market.underlying.issuer },
    })
    if (model.status !== "live") throw new Error(model.error)
    kind = model.value.kind
  })

  it("onboards a fresh keypair: Friendbot, trustline, faucet", async () => {
    signer = await fundedKeypairSigner(manifest)
    account = signer.publicKey
    const read = () => fetchAccountState(reader(), horizon(), manifest, market.marketId, account, kind)

    // Funded, no trustline yet.
    const funded = await eventually(read, (a) => a.accountExists.status === "live" && a.accountExists.value, "the funded account on Horizon")
    expect(funded.trustline).toMatchObject({ status: "live", value: "none" })
    expect(onboardingSteps(funded).map((s) => [s.id, s.done])).toEqual([["fund", true], ["trustline", false], ["grant", false]])

    // (b) T8: SAC.authorized for an account without a trustline traps; the contracts read that as
    // "not authorized" (compliance::is_authorized matches only Ok(Ok(true))), and so does the dApp.
    const trap = await reader()({
      contractId: market.underlying.sac,
      functionName: "authorized",
      args: [{ type: "address", value: account }],
    }).then(
      (r) => `answered ${String(r.value)}`,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    log(`SAC.authorized without a trustline: ${trap.split("\n")[0].slice(0, 300)}`)
    expect(isContractError(trap), trap).toBe(true)
    expect(funded.sacAuthorized).toEqual({ status: "live", value: false, ledger: 0 })
    const noTrust = evaluateAccountCompliance(funded, kind)
    expect(noTrust.find((i) => i.id === "trustline")).toMatchObject({ status: "missing", fix: "trustline" })
    expect(noTrust.find((i) => i.id === "authorized")).toMatchObject({ status: "missing", fix: "trustline" })

    // The user's changeTrust, signed by the keypair as Freighter would.
    await addTrustline({
      manifest,
      account,
      asset: { code: market.underlying.code, issuer: market.underlying.issuer },
      sign: (xdr) => signer.sign(xdr, manifest.networkPassphrase, account),
    })
    const trusted = await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value !== "none", "the trustline on Horizon")
    expect(trusted.trustline).toMatchObject({ status: "live", value: "unauthorized" })
    // With a trustline, an unauthorized account is a plain `false` from the SAC, not a trap.
    expect(trusted.sacAuthorized).toMatchObject({ status: "live", value: false })
    expect(evaluateAccountCompliance(trusted, kind).find((i) => i.id === "authorized")).toMatchObject({ status: "blocked", fix: "onboarding" })

    // The server faucet on the real chain: authorize, grant account, PT, YT, pay.
    resetFaucetStateForTests()
    const chain = createStellarFaucetChain(manifest, { env: { FAUCET_ISSUER_SECRET: issuerSecret } })
    const outcome = await runFaucet({ account, manifest, ip: "127.0.0.1", now: Date.now(), chain })
    expect(outcome).toEqual({ performed: ["authorize", "grant_account", "grant_pt", "grant_yt", "pay"] })
    // Read back through the real chain: nothing is left to do.
    resetFaucetStateForTests()
    expect(await runFaucet({ account, manifest, ip: "127.0.0.2", now: Date.now(), chain })).toEqual({ performed: [] })

    const onboarded = await eventually(
      read,
      (a) => a.trustline.status === "live" && a.trustline.value === "authorized",
      "the authorized trustline on Horizon",
    )
    expect(onboarded.underlying).toMatchObject({ status: "live", value: 10_000n * U })
    expect(evaluateAccountCompliance(onboarded, kind).map((i) => [i.id, i.status])).toEqual([
      ["account", "ok"],
      ["trustline", "ok"],
      ["authorized", "ok"],
      ["permissioning", "ok"],
      ["perm_pt", "ok"],
      ["perm_yt", "ok"],
    ])
    const markets = await fetchMarketPermissions(reader(), manifest, account)
    expect(onboardingSteps(onboarded, { markets }).every((s) => s.done)).toBe(true)
  }, 3 * MINUTE)

  it("deposit, then mint", async () => {
    firstLedger = (await ledgerClock()).sequence
    const deposit = await runStep("deposit", 4_000n * U)
    expect(deposit.decoded).toMatchObject({ kind: "amount" })
    const mint = await runStep("mint", 3_000n * U)
    // The tokenization fee (5 bps, rounded up) is withheld from the SY before PT and YT are sized.
    expect(mint.decoded).toMatchObject({ kind: "mint" })
    if (mint.decoded.kind !== "mint") return
    expect(mint.decoded.pt_minted).toBe(mint.decoded.yt_minted)
    expect(mint.decoded.fee_shares).toBe((3_000n * U * 5n + BPS - 1n) / BPS)
  }, 2 * MINUTE)

  it("trades: buy_pt, sell_pt, buy_yt, sell_yt", async () => {
    await runStep("buy_pt", 500n * U)
    await runStep("sell_pt", 200n * U)
    await runStep("buy_yt", 200n * U)
    await runStep("sell_yt", 100n * U)
  }, 3 * MINUTE)

  it("liquidity: add_liquidity, remove_liquidity (half)", async () => {
    await runStep("add_liquidity", 300n * U, 400n * U)
    const lp = (await snapshot()).acc.lp
    if (lp.status !== "live") throw new Error(lp.error)
    expect(lp.value > 0n).toBe(true)
    await runStep("remove_liquidity", lp.value / 2n)
  }, 3 * MINUTE)

  /**
   * R47 and its canary. `MarketPool.add_liquidity_single_sy` computes the SY it pulls
   * (`split + sy_used`) when the transaction runs, from a curve whose exponent and swap fee depend on
   * the ledger time (`state()`), then calls `SY.transfer(from, pool, amount)`, which needs `from`'s
   * authorization for exactly that amount. The signed authorization pins the amount of the
   * simulation; inclusion is always at a later ledger, so the amounts differ and the host refuses the
   * transfer (`Error(Auth, InvalidAction)`). The dApp therefore does not offer it: the gates and
   * `prepareReview` refuse it. The canary then sends the same transaction past them, on purpose, so
   * this test fails loudly the day the pool takes a fixed amount.
   */
  it("add_liquidity_sy is refused (R47); sent past the gates, the pool's nested SY transfer still outruns the signed authorization", async () => {
    const before = await snapshot()
    const simInput = simInputFor("add_liquidity_sy", 1_000n * U, undefined, before)
    const simulation = await simulate(simInput)
    // Every other gate passes: the only refusal is that the action is not offered.
    const blockers = evaluateGates({ ...simInput, guards: {}, deadline: 0n }, gateContext(before, simulation))
    expect(blockers).toEqual([{ code: "disabled", message: ACTION_META.add_liquidity_sy.disabled!.reason }])
    if (!simulation.ok) throw new Error(`add_liquidity_sy: simulation failed: ${json(simulation)}`)
    expectRawShape("add_liquidity_sy", simulation.retval)
    const guards = guardsFrom("add_liquidity_sy", simInput, parseOutput("add_liquidity_sy", simulation.retval), SLIPPAGE_BPS)
    if (!guards.ok) throw new Error(guards.reason)
    const input: ActionInput = { ...simInput, guards: guards.guards, deadline: BigInt(Math.floor((await ledgerClock()).now()) + DEADLINE_SECONDS) }
    await expect(prepareReview({ manifest, input })).rejects.toThrow("Add liquidity (SY only) is not offered")

    // The canary bypasses the gate and prepareReview on purpose: built, RPC-prepared and checked
    // (R29) like a review, then signed and sent, to show the pool limitation still holds.
    const node = server()
    const built = buildInvocationEnvelope({
      source: account,
      sequence: (await node.getAccount(account)).sequenceNumber(),
      networkPassphrase: manifest.networkPassphrase,
      invocation: invocationFor(manifest, input),
      timeoutSeconds: DEADLINE_SECONDS,
    })
    const prepared = await node.prepareTransaction(built)
    assertPreparedMatches(built, prepared)
    const unsignedXdr = prepared.toXdr()
    const signed = signedNestedTransfer(unsignedXdr, manifest.networkPassphrase)
    expect(signed.from).toBe(account)
    // A user takes a few seconds to approve in Freighter; the pool's curve moves every ledger meanwhile.
    await sleep(SIGNING_DELAY_MS)
    const signedXdr = await signer.sign(unsignedXdr, manifest.networkPassphrase, account)
    const { hash } = await submitSignedTransaction({ rpcUrl: manifest.rpcUrl, networkPassphrase: manifest.networkPassphrase, signedXdr })
    const polled = await pollTransactionStatus({ rpcUrl: manifest.rpcUrl, hash, attempts: 30, intervalMs: 1_000 })
    if (polled.status === "SUCCESS") {
      throw new Error(
        "add_liquidity_sy succeeded: the pool limitation no longer reproduces. If the contract was fixed, promote add_liquidity_sy into the main flow and remove `disabled` from its ACTION_META.",
      )
    }
    // NOT_FOUND (a poll timeout) is a flake, not a fix: only SUCCESS above means the limitation is gone.
    expect(polled.status).toBe("FAILED")
    // R49, live: the cause the app shows for this failure, read from the real result and diagnostics.
    expect(failedTransactionReason(polled.failure)).toBe(AMOUNTS_MOVED_REASON)
    const failure = await failureOf(manifest.rpcUrl, hash)
    expect(failure.result).toBe("invokeHostFunctionTrapped")
    expect(failure.authInvalidAction).toBe(true)
    expect(failure.executedTransfer).toBeDefined()
    expect(failure.executedTransfer).not.toBe(signed.amount)
    failed.push(hash)
    log(
      `add_liquidity_sy: gates [disabled], prepareReview refused; canary tx ${hash.slice(0, 12)} FAILED (${failure.result}, ` +
        `Error(Auth, InvalidAction)): signed SY.transfer amount ${signed.amount}, executed ${failure.executedTransfer}; reason "${failedTransactionReason(polled.failure)}"`,
    )
  }, 2 * MINUTE)

  it("oracle tick to 1.05, then claim_yield pays exactly the pending yield", async () => {
    await oracleTick(10_500_000n)

    // (c) T10/R25: a paused PrincipalManager is recognised from the simulation's diagnostic events.
    const managerId = market.contracts.manager
    await setManagerPaused(true)
    try {
      const s = await snapshot()
      const input = simInputFor("claim_yield", 0n, undefined, s)
      const paused = await simulate(input)
      // The invoked contract is the Router: the manager can only be named from the diagnostic events.
      expect(managerId).not.toBe(market.contracts.router)
      expect(paused).toMatchObject({ ok: false, kind: "contract_error", contractId: managerId, code: 9 })
      const blockers = evaluateGates({ ...input, guards: {}, deadline: 0n }, gateContext(s, paused))
      expect(blockers.map((b) => b.code)).toEqual(["pause"])
      expect(blockers[0].message).toContain("PrincipalManager is paused")
      log(`paused claim_yield simulation: contract_error #9 raised by ${managerId.slice(0, 8)}… (the manager)`)
    } finally {
      await setManagerPaused(false)
    }

    const before = await snapshot()
    const live = <T,>(v: { status: string; value?: T; error?: string }, what: string): T => {
      if (v.status !== "live") throw new Error(`${what}: ${v.error}`)
      return v.value as T
    }
    const expected = pendingYield({
      balance: live(before.acc.yt, "yt"),
      lastClaimedIndex: live(before.acc.ytLastClaimedIndex, "last claimed index"),
      pendingClaim: live(before.acc.ytPendingClaim, "pending claim"),
      liveOracleRate: live(before.ms.oracleRate, "oracle rate"),
      ytFrozen: live(before.ms.ytFrozen, "yt frozen"),
      accruedYieldIndex: live(before.ms.ytAccruedIndex, "accrued index"),
      ytFeeBps: live(before.ms.fees.ytBps, "yt fee"),
      exchangeRate: live(before.ms.exchangeRate, "exchange rate"),
    })
    expect(expected.net > 0n).toBe(true)
    const claim = await runStep("claim_yield", 0n)
    expect(claim.decoded).toEqual({ kind: "amount", value: expected.net })
  }, 3 * MINUTE)

  it("recombine", async () => {
    await runStep("recombine", 500n * U)
  }, 2 * MINUTE)

  it(
    "redeems PT and YT once the market has matured",
    async () => {
      const maturity = market.maturity
      let clock = await ledgerClock()
      log(`waiting ${Math.max(0, Math.ceil(maturity - clock.now()))} s for maturity`)
      while (clock.closeTime < maturity) {
        await sleep(5_000)
        clock = await ledgerClock()
      }
      // Unsettled and unfrozen: the first redemption settles at the oracle price, which must be fresh (R40).
      await oracleTick()
      const s = await snapshot()
      const pt = s.acc.pt.status === "live" ? s.acc.pt.value : 0n
      const yt = s.acc.yt.status === "live" ? s.acc.yt.value : 0n
      expect(pt > 0n && yt > 0n).toBe(true)
      const redeem = await runStep("redeem", pt, yt)
      expect(redeem.decoded).toMatchObject({ kind: "redeem" })
      const after = await snapshot()
      expect(after.acc.pt).toMatchObject({ status: "live", value: 0n })
      expect(after.acc.yt).toMatchObject({ status: "live", value: 0n })
      expect(after.ms.settledRate.status === "live" && after.ms.settledRate.value !== null).toBe(true)
    },
    18 * MINUTE,
  )

  it("history lists every transaction the test sent, once, with its kind (T19)", async () => {
    const expected = sent.map((s) => [s.hash, HISTORY_KIND[s.action]])
    expect(expected).toHaveLength(11)
    expect(failed).toHaveLength(1)

    const full = await fetchAccountHistory({ manifest, marketId: market.marketId, account })
    expect(full.truncated).toBe(false)
    // Entries are newest first; `sent` is in the order the transactions were sent.
    expect([...full.entries].reverse().map((e) => [e.hash, e.kind])).toEqual(expected)
    expect(full.oracleUpdates.some((u) => u.value === 10_500_000n)).toBe(true)
    // A trapped transaction emits no contract events: the failed zap is not listed.
    expect(full.entries.some((e) => failed.includes(e.hash))).toBe(false)

    // Many small windows: the endLedger walk must find the same entries, none twice, none missing.
    const health = await server().getHealth()
    const windowed = await fetchAccountHistory({
      manifest,
      marketId: market.marketId,
      account,
      window: { oldestLedger: Math.max(health.oldestLedger, firstLedger - 3), latestLedger: health.latestLedger },
      windowLedgers: 37,
    })
    expect(windowed.truncated).toBe(false)
    expect(windowed.entries).toEqual(full.entries)
    log(
      `history: ${full.entries.length} entries (${[...full.entries].reverse().map((e) => e.kind).join(", ")}), ` +
        `${windowed.window.latestLedger - windowed.window.oldestLedger} ledgers in windows of 37`,
    )
  }, 2 * MINUTE)
})
