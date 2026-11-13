// @vitest-environment node
/**
 * Suite B, the ephemeral lifecycle (plan 0007, Task 4; R7-2, R7-5, rulings S1 and S2): the flows that
 * need admin powers, signed live on Stellar Testnet against a short-lived market this run deploys
 * with keys it generates, and removes afterwards. Nothing points the app at that market.
 *
 * 1. `beforeAll` deploys it with `scripts/dev-stack/deploy.sh` (EPHEMERAL=1): four run-unique keys
 *    (`e2e-<runId>-<role>`) that the script generates and funds; the contracts built from
 *    `org/principal` at the official manifest's `sourceCommit`; the manifest written to a new file
 *    in a temporary directory. The market matures `MATURITY_SECONDS` after the deploy reads the
 *    ledger time.
 * 2. Two fresh keypairs are onboarded with the run's own issuer (`keys` mode: the faucet's code run
 *    in-process): the trader, and the holder whose PT and YT are redeemed at maturity.
 * 3. Before maturity, through the app's pipeline (`tests/integration/route-runner.ts`): the trader
 *    deposits, splits, buys PT with USDY and adds liquidity paid in USDY; the holder deposits and
 *    splits. The oracle admin ticks the value to 1.05, and the trader claims exactly the pending yield.
 * 4. Compliance recovery (R7-5): the issuer authority (the SAC admin) deauthorizes the trader on the
 *    SAC, the app shows it blocked, and `RecoveryEscrow.seize_all_positions([trader])` moves its SY,
 *    PT, YT and LP to the escrow and writes a record.
 * 5. The oracle admin shortens the freshness window to `STALE_WINDOW_SECONDS`
 *    (`set_safety_params`). The deploy keeps 3,600 s: its own seeding mints about ten minutes after
 *    the genesis value, so a shorter window would refuse it. Then no tick until the market has
 *    matured and the value is stale, plus `MATURITY_MARGIN_SECONDS`; every read and simulation of
 *    the refusals is from the ledger where that was observed or later. The holder's redemption, the
 *    first one, which settles the market at the oracle price, is refused as stale by the app and by
 *    the contracts.
 * 6. One tick. A trade is refused as matured, by the app and by the pool. The holder redeems all its
 *    PT and YT (`redeem_at_maturity`), which settles the market. `finalize_record` settles the seized
 *    PT and YT into the underlying, read back from `get_record`.
 *
 * Testnet is shared and rate-limited: an external failure is retried once at the step level, and
 * only when the signer's sequence number shows nothing of it landed (`tests/live/retry.ts`). A deploy
 * that fails, a Testnet that cannot be reached, or a market left too little time before maturity
 * fails the run with the reason: it never passes empty. `afterAll` removes the run's keys, whatever
 * happened, and writes the record (public keys, contract ids, hashes, refusals, the recovery record)
 * to `e2e-artifacts/lifecycle.json`, through `redact`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { Keypair, type Transaction } from "@stellar/stellar-sdk"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// `keys` mode runs the faucet in-process, and the keeper's growth rule is imported: both are `server-only`.
vi.mock("server-only", () => ({}))

import { derive, ratesFrom } from "@/hooks/use-simulation"
import { fetchAccountState, type AccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { invocationFor, type ActionInput } from "@/lib/protocol/actions"
import { evaluateAccountCompliance } from "@/lib/protocol/compliance"
import { evaluateGates, type Blocker } from "@/lib/protocol/gates"
import { openGuards, type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { parseManifest, validateManifest } from "@/lib/protocol/manifest"
import { fetchMarketState } from "@/lib/protocol/market-state"
import { SCALE } from "@/lib/protocol/math"
import { previewDeposit } from "@/lib/protocol/previews"
import { createRpcReader } from "@/lib/protocol/reader"
import { executeReview, prepareReview } from "@/lib/protocol/review"
import { planRoute, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import { createRpcServer, simulateInvocation, type SimulationOutcome } from "@/lib/protocol/stellar"
import type { TradeRequest } from "@/lib/protocol/trade-adapter"
import type { Finding, Live, Manifest, Market } from "@/lib/protocol/types"
import { pendingYield } from "@/lib/protocol/yield"
import { nextReferenceValue } from "@/lib/server/oracle-keeper"
import { createRunner, DEADLINE_SECONDS, live, runTrade, SLIPPAGE_BPS, type Runner, type StepRecord, type TradeRun } from "../integration/route-runner"
import {
  finalizeRecord,
  oracleSetSafetyParams,
  oracleSetValue,
  positionsOf,
  readAccountRecords,
  readAt,
  readRecord,
  sacSetAuthorized,
  seizeAllPositions,
  type Positions,
  type RecoveryRecord,
  type Sent,
} from "../live/admin"
import { balancesOf, complianceKind, createLog, ledgerClock, MINUTE, showBalances, U, units, type Balances } from "../live/chain"
import { liveContext, type OnboardedSigner } from "../live/context"
import {
  ephemeralDeployEnv,
  isDeployStep,
  keyNamesFor,
  removeRunKeys,
  runDeploy,
  runIdFrom,
  runKeyAddress,
  runKeySecret,
  type KeyNames,
} from "../live/ephemeral"
import { retryOnce } from "../live/retry"
import { eventually, json, redact, sleep } from "../live/util"

const DAPP = join(__dirname, "..", "..")
const ARTIFACT = join(DAPP, "e2e-artifacts", "lifecycle.json")
const explorer = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`

/**
 * S2. The market matures this long after the deploy reads the ledger time, which it does about a
 * minute in, before it deploys the contracts: 5 minutes in run 1, about 10 for the official
 * deployment. The steps before maturity took 2.5 minutes in run 1.
 */
const MATURITY_SECONDS = 1_200
/** The least time to maturity the steps before it need (twice run 1's), checked once the deploy is done. */
const MIN_RUNWAY_SECONDS = 360
/** The deploy's oracle window: the genesis value must still be fresh when its seeding mints. */
const DEPLOY_STALE_SECONDS = 3_600
/** The window the oracle admin sets before the wait: the stale check waits this long after the last tick. */
const STALE_WINDOW_SECONDS = 300
/**
 * How far past maturity (and past the point the oracle goes stale) the refusals are read: about four
 * ledgers, so a node a ledger or two behind is past both too. The reads and the simulation are also
 * floored at the ledger where both were observed (`maturedLedger`).
 */
const MATURITY_MARGIN_SECONDS = 20
/** The oracle's deviation bound, as deployed (deploy.sh): kept when the window changes. */
const MAX_DEVIATION_BPS = 1_000
/** The deploy builds the contracts if they are not cached, then sends about seventy transactions. */
const DEPLOY_TIMEOUT_MS = 30 * MINUTE

// The amounts: the run's own pool holds about 100,000 PT and 95,000 SY.
const TRADER_DEPOSIT = 500n * U
const TRADER_SPLIT = 300n * U
const BUY_PT = 200n * U
const LP_ONLY = 200n * U
const HOLDER_DEPOSIT = 100n * U
const HOLDER_SPLIT = 300n * U
/** The tick before the claim: the value up 5 % (within the oracle's 10 % deviation bound). */
const YIELD_TICK_BPS = 10_500n
/** The trade refused at maturity: Buy PT with SY, as the holder. */
const MATURED_TRADE = 10n * U

const out = createLog("lifecycle")
const log = out.log

type Who = "trader" | "holder"
type Signer = Who | "admin" | "oracle"
/** One transaction of the run, in the order it landed. */
type Landed = { step: string; signer: Signer; action: string; hash: string; ledger: number }
/** A refusal as the app shows it: `ledger`/`ledgerTime` from the clock the gates used; `simulatedLedger` the node's ledger for the simulation. */
type Refusal = { what: string; account: string; ledger: number; ledgerTime: number; simulatedLedger: number; blockers: Blocker[]; simulation: SimulationOutcome }

/** What `e2e-artifacts/lifecycle.json` records: public data only, through `redact`. */
type LifecycleRecord = {
  suite: "lifecycle"
  network: "testnet"
  runId: string
  keyNames: KeyNames
  startedAt: string
  finishedAt?: string
  durationSeconds?: number
  /** Seconds from the start of the run at which each step finished. */
  timings: Record<string, number>
  sourceCommit?: string
  deploy?: {
    seconds: number
    maturitySeconds: number
    oracleMaxStaleSeconds: number
    marketId: string
    maturity: number
    generatedAt: string
    shared: Manifest["shared"]
    contracts: Market["contracts"]
    testAsset: Manifest["testAsset"]
    wasmHashes: Manifest["wasmHashes"]
  }
  roles: Partial<Record<"admin" | "treasury" | "issuer" | "oracle", string>>
  accounts: Partial<Record<Who, string>>
  transactions: (Landed & { explorer: string })[]
  claim?: { expected: bigint; paid: bigint; oracleBefore: bigint; oracleAfter: bigint }
  recovery?: {
    account: string
    seized: Positions
    escrowBefore: Positions
    escrowAfterSeize: Positions
    ids: bigint[]
    recordAfterSeize?: RecoveryRecord
    escrowAfterFinalize?: Positions
    recordAfterFinalize?: RecoveryRecord
    deauthorizedBlockers?: Blocker[]
  }
  staleWindow?: { seconds: number; lastTickTimestamp: number; waitedSeconds: number; observedLedger: number; observedTime: number; marginPastMaturity: number }
  refusals: Refusal[]
  redeem?: { pt: bigint; yt: bigint; underlyingFromPt: bigint; underlyingFromYt: bigint; settledRate: bigint }
  keysRemoved?: string[]
  keysNotRemoved?: string[]
  completedTests: string[]
  complete: boolean
}

describe("Suite B: the ephemeral lifecycle on a throwaway Testnet market (plan 0007)", () => {
  const started = Date.now()
  const runId = runIdFrom()
  const names = keyNamesFor(runId)
  const tmp = mkdtempSync(join(tmpdir(), "principal-e2e-"))
  const manifestOut = join(tmp, "manifest.json")
  const record: LifecycleRecord = {
    suite: "lifecycle",
    network: "testnet",
    runId,
    keyNames: names,
    startedAt: new Date(started).toISOString(),
    timings: {},
    roles: {},
    accounts: {},
    transactions: [],
    refusals: [],
    completedTests: [],
    complete: false,
  }
  const landed: Landed[] = []

  let manifest: Manifest
  let market: Market
  let findings: Finding[]
  let kind: ComplianceKind
  let admin: Keypair
  let oracleAdmin: Keypair
  const signers = {} as Record<Who, OnboardedSigner>
  const runners = {} as Record<Who, Runner>
  /** The ledger time of the last value the oracle accepted. */
  let lastTickTimestamp = 0
  let recordId: bigint | undefined
  /** The ledger at which the market was seen matured and the oracle stale, with the margin: the floor of the refusals' reads. */
  let maturedLedger = 0
  /** Onboards a fresh keypair with the run's own issuer; set once the market is deployed. */
  let onboard: () => Promise<OnboardedSigner> = () => Promise.reject(new Error("the market was not deployed"))

  const reader = () => createRpcReader(manifest)
  const accountOf = (who: Who) => signers[who].publicKey
  const accountState = (account: string): Promise<AccountState> =>
    fetchAccountState(reader(), createHorizon(manifest.horizonUrl), manifest, market.marketId, account, kind)
  const sequenceOf = async (account: string) => (await createRpcServer(manifest.rpcUrl).getAccount(account)).sequenceNumber()
  /** The latest ledger any transaction of the run landed in: later reads must be from it or after. */
  const lastLedger = () => Math.max(0, ...landed.map((l) => l.ledger))
  /** Every read is live and from `minLedger` or later (Testnet's RPC is several nodes, some a ledger behind). */
  const readFrom = (minLedger: number, ...reads: Live<unknown>[]) => reads.every((v) => v.status === "live" && v.ledger >= minLedger)
  const elapsed = () => Math.round((Date.now() - started) / 1_000)
  const mark = (step: string) => {
    record.timings[step] = elapsed()
  }

  function note(step: string, signer: Signer, action: string, sent: { hash: string; ledger: number }) {
    landed.push({ step, signer, action, hash: sent.hash, ledger: sent.ledger })
  }

  /**
   * One signed step, retried once on an external failure when `account`'s sequence number shows
   * nothing of it landed (a second transaction could then never land beside the first).
   */
  async function signedStep<T>(account: string, what: string, run: () => Promise<T>): Promise<T> {
    const seq = await sequenceOf(account)
    return retryOnce({ what, run, nothingLanded: async () => (await sequenceOf(account)) === seq, log })
  }

  /** The runner's steps, recorded with their ledgers. */
  function noteSteps(who: Who, step: string, steps: StepRecord[]) {
    for (const s of steps) {
      if (s.ledger === undefined) throw new Error(`${step}: ${s.hash} has no ledger (readAfterLanded is off)`)
      note(step, who, s.action, { hash: s.hash, ledger: s.ledger })
    }
  }

  /** Balances of `who`, read again while a node answers from before `minLedger`. */
  async function balancesFrom(who: Who, minLedger: number): Promise<Balances> {
    const acc = await eventually(
      () => accountState(accountOf(who)),
      (a) => (["underlying", "sy", "pt", "yt", "lp"] as const).every((k) => a[k].status === "live" && a[k].ledger >= minLedger),
      `the balances of the ${who} at ledger ${minLedger} or later`,
      60_000,
    )
    return balancesOf(acc)
  }

  /** A quick action (`ActionPanel`): one step through the runner, signed once, recorded. */
  async function quickAction(who: Who, name: string, req: RouteRequest, plans: StepPlan[]) {
    const r = runners[who]
    const b0 = await balancesFrom(who, lastLedger())
    const { steps } = await signedStep(accountOf(who), `${who} ${name}`, () => r.runRoute(req, plans, { name: `${who} ${name}` }))
    noteSteps(who, name, steps)
    const b1 = await balancesFrom(who, lastLedger())
    return { steps, b0, b1 }
  }

  /** A trade as the tab runs it (`runTrade`), signed once, recorded. */
  async function trade(who: Who, req: TradeRequest, expectActions: ActionInput["action"][], expectPlan?: Parameters<typeof runTrade>[0]["expectPlan"]): Promise<TradeRun> {
    const t = await signedStep(accountOf(who), `${who} ${req.kind}`, () =>
      runTrade({ manifest, market, runner: runners[who], log, req, expectActions, ...(expectPlan ? { expectPlan } : {}) }),
    )
    noteSteps(who, req.kind, t.steps)
    return t
  }

  /**
   * Claim yield or Redeem at maturity, as their `ActionPanel` signs them: fresh reads, the draft
   * simulated as the user, every gate with that simulation (expected empty), `derive` (neither call
   * takes a floor), `prepareReview`, then `executeReview` (sign, submit, poll, decode). Neither result
   * moves with the pool, so what landed is exactly what was simulated.
   */
  async function floorless(who: Who, action: "claim_yield" | "redeem", amount: bigint, secondaryAmount?: bigint) {
    const r = runners[who]
    const signer = signers[who]
    const minLedger = lastLedger()
    return signedStep(signer.publicKey, `${who} ${action}`, async () => {
      const s = await eventually(
        () => r.snapshot(),
        (snap) => readFrom(minLedger, snap.ms.oracleRate, snap.ms.poolState, snap.acc.pt, snap.acc.yt),
        `the ${who}'s reads at ledger ${minLedger} or later`,
        60_000,
      )
      const draft: ActionInput = {
        action,
        marketId: market.marketId,
        source: signer.publicKey,
        amount,
        ...(secondaryAmount === undefined ? {} : { secondaryAmount }),
        guards: openGuards(action, amount),
        deadline: BigInt(Math.floor(s.ledgerTime) + DEADLINE_SECONDS),
      }
      const { outcome } = await simulateFrom(draft, minLedger)
      expect(evaluateGates(draft, { ...r.base(s), simulation: outcome }), `${action}: gates`).toEqual([])
      const { output: simulated, guards } = derive(draft, outcome, SLIPPAGE_BPS, ratesFrom({ data: s.ms, stale: false }))
      if (!simulated || !guards?.ok) throw new Error(`${action}: no exact quote: ${json({ outcome, guards })}`)
      expect(guards.guards, `${action} takes no floor`).toEqual({})
      const review = await prepareReview({ manifest, input: { ...draft, guards: guards.guards } })
      const result = await executeReview({ review, manifest, sign: signer.sign })
      expect(result.status, `${action}: ${json(result)}`).toBe("SUCCESS")
      expect(result.decodeError).toBeUndefined()
      const decoded = result.output
      if (!decoded) throw new Error(`${action}: no decoded output`)
      expect(decoded, `${action}: landed as simulated`).toEqual(simulated)
      const ledger = await ledgerOf(result.hash)
      note(action, who, action, { hash: result.hash, ledger })
      log(`${who} ${action}: tx ${result.hash} (ledger ${ledger}), ${showOutput(decoded)}`)
      return { hash: result.hash, ledger, decoded }
    })
  }

  /** The ledger a confirmed transaction landed in. */
  async function ledgerOf(hash: string): Promise<number> {
    const tx = await eventually(() => createRpcServer(manifest.rpcUrl).getTransaction(hash), (t) => t.status !== "NOT_FOUND", `transaction ${hash} on the RPC`, 60_000)
    if (tx.status === "NOT_FOUND") throw new Error(`transaction ${hash} not found`)
    return tx.ledger
  }

  /** An admin call signed by one of the run's keys, retried once only if nothing of it landed; recorded. */
  async function adminStep<T extends Sent>(signer: "admin" | "oracle", step: string, action: string, run: () => Promise<T>): Promise<T> {
    const key = signer === "admin" ? admin : oracleAdmin
    const sent = await signedStep(key.publicKey(), step, run)
    note(step, signer, action, sent)
    return sent
  }

  /**
   * The oracle admin pushes a value stamped with the latest ledger time: `next(current)`, or by
   * default the keeper's growth (`nextReferenceValue`, 5 % a year), never below the current value.
   * The oracle must accept it.
   */
  async function tick(step: string, next?: (current: bigint) => bigint): Promise<{ value: bigint; timestamp: number; hash: string }> {
    const oracle = manifest.shared.oracle
    const current = BigInt(String((await reader()({ contractId: oracle, functionName: "get_reference_value" })).value))
    const last = Number((await reader()({ contractId: oracle, functionName: "get_reference_timestamp" })).value)
    let now = (await ledgerClock(manifest)).closeTime
    while (now <= last) {
      await sleep(2_000)
      now = (await ledgerClock(manifest)).closeTime
    }
    const value = next ? next(current) : (nextReferenceValue({ current, lastTimestamp: last, now }) ?? current)
    const sent = await adminStep("oracle", step, "oracle.set_reference_value", () => oracleSetValue({ manifest, oracleAdmin, value, timestamp: now }))
    expect(sent.accepted, `${step}: the oracle accepted ${value} at ${now}`).toBe(true)
    lastTickTimestamp = now
    log(`${step}: oracle ${current} -> ${value} at ledger time ${now}, tx ${sent.hash} (ledger ${sent.ledger})`)
    return { value, timestamp: now, hash: sent.hash }
  }

  /**
   * `draft` simulated as the app simulates it (the hook's `simulate`: `invocationFor`, then
   * `simulateInvocation` as the user), asked again while the node that answers is before `minLedger`:
   * a node a ledger behind would simulate a market not yet matured, or an oracle not yet ticked. The
   * node's ledger comes from the simulation response itself, refused or not.
   */
  async function simulateFrom(draft: ActionInput, minLedger: number): Promise<{ outcome: SimulationOutcome; ledger: number }> {
    return eventually(
      async () => {
        const node = createRpcServer(manifest.rpcUrl)
        let ledger = 0
        const server = {
          getAccount: (account: string) => node.getAccount(account),
          simulateTransaction: async (tx: Transaction) => {
            const response = await node.simulateTransaction(tx)
            ledger = response.latestLedger
            return response
          },
        }
        const outcome = await simulateInvocation({
          rpcUrl: manifest.rpcUrl,
          networkPassphrase: manifest.networkPassphrase,
          source: draft.source,
          invocation: invocationFor(manifest, draft),
          server,
        })
        return { outcome, ledger }
      },
      (r) => r.ledger >= minLedger,
      `the ${draft.action} simulated at ledger ${minLedger} or later`,
      60_000,
    )
  }

  /**
   * What the app shows `account` for `draft`: every gate with fresh reads and the ledger clock, and
   * the simulation as that account, all from `minLedger` or later (the run's last transaction by default).
   */
  async function gatesFor(account: string, draft: ActionInput, minLedger = lastLedger()): Promise<Refusal> {
    const { clock, ms, acc } = await eventually(
      async () => {
        const [clock, ms, acc] = await Promise.all([ledgerClock(manifest), fetchMarketState(reader(), manifest, market.marketId), accountState(account)])
        return { clock, ms, acc }
      },
      (r) => r.clock.sequence >= minLedger && readFrom(minLedger, r.ms.oracleFresh, r.ms.settledRate, r.ms.poolState, r.acc.underlying, r.acc.pt),
      `the reads for ${draft.action} at ledger ${minLedger} or later`,
      60_000,
    )
    const { outcome: simulation, ledger: simulatedLedger } = await simulateFrom(draft, minLedger)
    const blockers = evaluateGates(draft, {
      findings,
      wallet: { status: "connected", publicKey: account, networkPassphrase: manifest.networkPassphrase },
      market: ms,
      account: acc,
      compliance: evaluateAccountCompliance(acc, kind),
      ledgerTime: clock.now(),
      managerId: market.contracts.manager,
      simulation,
    })
    return { what: draft.action, account, ledger: clock.sequence, ledgerTime: Math.floor(clock.now()), simulatedLedger, blockers, simulation }
  }

  const draftFor = async (who: Who, action: ActionInput["action"], amount: bigint, secondaryAmount?: bigint): Promise<ActionInput> => {
    const ms = await fetchMarketState(reader(), manifest, market.marketId)
    return {
      action,
      marketId: market.marketId,
      source: accountOf(who),
      amount,
      ...(secondaryAmount === undefined ? {} : { secondaryAmount }),
      guards: openGuards(action, amount, ratesFrom({ data: ms, stale: false })),
      deadline: BigInt(Math.floor((await ledgerClock(manifest)).now()) + DEADLINE_SECONDS),
    }
  }

  beforeAll(async () => {
    // Review Focus 3: a Testnet that cannot be reached fails the run with the reason; it never skips.
    // The official manifest (`config/manifests/testnet.json`) is only read: its RPC and its `sourceCommit`.
    const official = liveContext({ network: "testnet" })
    const down = await official.unreachableReason()
    if (down) throw new Error(`Testnet cannot be reached: ${down}`)
    // The contracts of the official deployment, never a moving branch head.
    const sourceCommit = official.manifest.sourceCommit
    record.sourceCommit = sourceCommit
    const principalRepo = process.env.PRINCIPAL_REPO ?? "../principal"
    const repoDir = isAbsolute(principalRepo) ? principalRepo : resolve(DAPP, principalRepo)
    if (!existsSync(repoDir)) throw new Error(`the principal repository is not at ${repoDir} (set PRINCIPAL_REPO): the run builds its contracts at ${sourceCommit}`)
    log(`run ${runId}: deploying a throwaway market from principal ${sourceCommit.slice(0, 7)} (maturity in ${MATURITY_SECONDS} s, keys ${Object.values(names).join(", ")})`)

    const deployed = await runDeploy({
      dappDir: DAPP,
      env: ephemeralDeployEnv({
        base: process.env,
        names,
        manifestOut,
        sourceCommit,
        maturitySeconds: MATURITY_SECONDS,
        oracleMaxStaleSeconds: DEPLOY_STALE_SECONDS,
      }),
      onLine: (line) => {
        if (isDeployStep(line)) log(`deploy: ${line}`)
      },
      timeoutMs: DEPLOY_TIMEOUT_MS,
    })
    mark("deploy")
    log(`deployed in ${deployed.seconds} s`)

    manifest = parseManifest(JSON.parse(readFileSync(manifestOut, "utf8")))
    market = manifest.markets[0]
    expect(manifest.network).toBe("testnet")
    expect(manifest.sourceCommit, "the ephemeral market runs the official deployment's contracts").toBe(sourceCommit)
    expect(manifest.markets).toHaveLength(1)
    record.deploy = {
      seconds: deployed.seconds,
      maturitySeconds: MATURITY_SECONDS,
      oracleMaxStaleSeconds: DEPLOY_STALE_SECONDS,
      marketId: market.marketId,
      maturity: market.maturity,
      generatedAt: manifest.generatedAt,
      shared: manifest.shared,
      contracts: market.contracts,
      testAsset: manifest.testAsset,
      wasmHashes: manifest.wasmHashes,
    }
    findings = validateManifest(manifest)
    expect(findings.filter((f) => f.severity === "error"), "manifest findings").toEqual([])
    for (const fn of ["swap_underlying_for_pt", "add_liquidity_single_underlying", "claim_yield", "redeem_at_maturity"]) {
      expect(manifest.routerFunctions ?? [], `the manifest lists ${fn}`).toContain(fn)
    }

    // The run's own keys, read in-process to sign; each checked against the role the market gives it.
    const issuerSecret = await runKeySecret(names.issuer, names)
    admin = Keypair.fromSecret(await runKeySecret(names.admin, names))
    oracleAdmin = Keypair.fromSecret(await runKeySecret(names.oracle, names))
    record.roles = {
      admin: admin.publicKey(),
      treasury: await runKeyAddress(names.treasury, names),
      issuer: Keypair.fromSecret(issuerSecret).publicKey(),
      oracle: oracleAdmin.publicKey(),
    }
    expect(record.roles.issuer, "the issuer key issues the test asset").toBe(market.underlying.issuer)
    const sacAdmin = await reader()({ contractId: market.underlying.sac, functionName: "admin" })
    expect(sacAdmin.value, "the admin key is the SAC admin, the issuer authority of the escrow").toBe(admin.publicKey())
    const oracleAdminOnChain = await reader()({ contractId: manifest.shared.oracle, functionName: "get_admin" })
    expect(oracleAdminOnChain.value, "the oracle key is the oracle admin").toBe(oracleAdmin.publicKey())

    const ctx = liveContext({ network: "testnet", manifestPath: manifestOut, faucet: { mode: "keys", issuerSecret } })
    onboard = () => ctx.onboard(market, kind)

    const clock = await ledgerClock(manifest)
    const runway = market.maturity - clock.closeTime
    if (runway < MIN_RUNWAY_SECONDS) {
      throw new Error(`the deploy took ${deployed.seconds} s and left the market ${runway} s before maturity, less than the ${MIN_RUNWAY_SECONDS} s the steps before it need`)
    }
    const ms = await fetchMarketState(reader(), manifest, market.marketId)
    expect(live(ms.poolSeeded, "pool seeded"), "the pool is seeded").toBe(true)
    expect(live(ms.oracleFresh, "oracle freshness"), "the genesis value is fresh").toBe(true)
    expect(ms.topology).toMatchObject({ status: "live", value: { matches: true } })
    kind = await complianceKind(manifest, market)
    expect(kind).toBe("sac")
    log(
      `market ${market.marketId}, matures in ${runway} s; pool PT ${units(live(ms.poolState, "pool").ptReserve)}, SY ${units(live(ms.poolState, "pool").syReserve)}; ` +
        `oracle ${live(ms.oracleRate, "oracle")} (window ${live(ms.oracleMaxStaleSeconds, "window")} s); escrow ${market.contracts.recoveryEscrow}`,
    )
  }, DEPLOY_TIMEOUT_MS + 5 * MINUTE)

  // Vitest 5 hands the suite over as the second argument; the first must be a destructuring pattern.
  afterAll(async ({}, suite) => {
    try {
      const finished = Date.now()
      record.finishedAt = new Date(finished).toISOString()
      record.durationSeconds = Math.round((finished - started) / 1_000)
      record.transactions = landed.map((l) => ({ ...l, explorer: explorer(l.hash) }))
      const tests = suite.tasks.filter((t) => t.type === "test")
      record.completedTests = tests.filter((t) => t.result?.state === "pass").map((t) => t.name)
      record.complete = record.completedTests.length === tests.length
    } finally {
      // The run's keys go, whatever happened: generated by the deploy, they exist only for this run.
      const { removed, failed } = await removeRunKeys(names)
      record.keysRemoved = removed
      record.keysNotRemoved = failed
      rmSync(tmp, { recursive: true, force: true })
      mkdirSync(join(DAPP, "e2e-artifacts"), { recursive: true })
      writeFileSync(ARTIFACT, `${redact(JSON.stringify(record, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2))}\n`)
      log(
        `keys removed: ${removed.join(", ") || "none"}${failed.length ? `; NOT removed: ${failed.join("; ")}` : ""}. ` +
          `Record written to e2e-artifacts/lifecycle.json: ${landed.length} transactions, ${record.completedTests.length} tests passed, ${record.durationSeconds} s`,
      )
      out.summary()
    }
  }, 3 * MINUTE)

  it("onboards two fresh keypairs with the run's own issuer (keys mode): Friendbot, the trustline, then the faucet", async () => {
    for (const who of ["trader", "holder"] as const) {
      signers[who] = await onboard()
      record.accounts[who] = signers[who].publicKey
      const acc = await accountState(signers[who].publicKey)
      expect(evaluateAccountCompliance(acc, kind).map((i) => [i.id, i.status]), `${who} compliance`).toEqual([
        ["account", "ok"],
        ["trustline", "ok"],
        ["authorized", "ok"],
        ["permissioning", "ok"],
        ["perm_pt", "ok"],
        ["perm_yt", "ok"],
      ])
      expect(balancesOf(acc), `${who} balances`).toEqual({ underlying: 100_000n * U, sy: 0n, pt: 0n, yt: 0n, lp: 0n })
      runners[who] = createRunner({ manifest, market, findings, kind, signer: signers[who], log, readAfterLanded: true })
      log(`${who} ${signers[who].publicKey} onboarded: ${showBalances(balancesOf(acc))}`)
    }
    mark("onboarding")
  }, 8 * MINUTE)

  it("Deposit, then Mint PT + YT (Split), for the trader and the holder", async () => {
    for (const [who, deposit, split] of [
      ["trader", TRADER_DEPOSIT, TRADER_SPLIT],
      ["holder", HOLDER_DEPOSIT, HOLDER_SPLIT],
    ] as const) {
      const dep = await quickAction(who, "deposit", { amount: deposit } as RouteRequest, [{ action: "deposit", amount: { from: "value", value: deposit }, gives: "", takes: "" }])
      const shares = dep.steps[0].decoded
      if (shares.kind !== "amount") throw new Error("deposit: not an amount")
      expect(dep.b1.underlying - dep.b0.underlying).toBe(-deposit)
      expect(dep.b1.sy - dep.b0.sy).toBe(shares.value)
      for (const k of ["pt", "yt", "lp"] as const) expect(dep.b1[k] - dep.b0[k], `${who} deposit: ${k} moved`).toBe(0n)

      const req: RouteRequest = { kind: "split", marketId: market.marketId, source: accountOf(who), amount: split, pay: "underlying", receive: "sy", matured: false }
      const plans = planRoute(req, { routerFunctions: manifest.routerFunctions ?? [] })
      if (!Array.isArray(plans)) throw new Error(plans.disabled)
      expect(plans.map((p) => p.action)).toEqual(["mint"])
      const mint = await quickAction(who, "split", req, plans)
      const minted = mint.steps[0].decoded
      if (minted.kind !== "mint") throw new Error("split: not a mint output")
      expect(minted.pt_minted).toBe(minted.yt_minted)
      expect(mint.b1.underlying - mint.b0.underlying).toBe(-split)
      expect(mint.b1.pt - mint.b0.pt).toBe(minted.pt_minted)
      expect(mint.b1.yt - mint.b0.yt).toBe(minted.yt_minted)
      for (const k of ["sy", "lp"] as const) expect(mint.b1[k] - mint.b0[k], `${who} split: ${k} moved`).toBe(0n)
      log(`${who}: deposit ${units(deposit)} USDY -> ${units(shares.value)} SY (tx ${dep.steps[0].hash}); split ${units(split)} USDY -> PT + YT ${units(minted.pt_minted)} (tx ${mint.steps[0].hash})`)
    }
    mark("deposit and split")
  }, 6 * MINUTE)

  it("Buy PT with USDY: one transaction (swap_underlying_for_pt), exact on the trader's balances", async () => {
    const t = await trade("trader", { kind: "buy_pt", amount: BUY_PT, pay: "underlying", receive: "underlying" }, ["buy_pt_underlying"])
    const [buy] = t.steps
    if (buy.decoded.kind !== "amount") throw new Error("buy_pt: not an amount")
    expect(t.bal1.underlying - t.bal0.underlying).toBe(-BUY_PT)
    expect(t.bal1.pt - t.bal0.pt).toBe(buy.decoded.value)
    for (const k of ["sy", "yt", "lp"] as const) expect(t.bal1[k] - t.bal0[k], `buy_pt: ${k} moved`).toBe(0n)
    expect(t.quote.exactness).toBe("simulated")
    // No check on the quoted APY's move: minutes before maturity the curve's implied rate does not
    // register a trade this small (run 1: 0.014571 before and after). Suite A checks it on a long market.
    log(`buy_pt (USDY): ${units(BUY_PT)} USDY -> PT ${units(buy.decoded.value)}, tx ${buy.hash}; quoted APY ${t.quote.apyBefore} -> ${t.quote.apyAfter}`)
    mark("buy PT")
  }, 4 * MINUTE)

  it("LP only paid in USDY: one transaction (add_liquidity_single_underlying); the pool's SY refund stays as SY", async () => {
    const req: TradeRequest = { kind: "lp_only", amount: LP_ONLY, pay: "underlying", receive: "underlying" }
    let syIn = 0n
    const t = await trade("trader", req, ["add_liquidity_underlying"], (plans, s) => {
      syIn = previewDeposit(req.amount, live(s.ms.exchangeRate, "exchange rate"))
      expect(plans[0].secondaryAmount).toEqual({ from: "value", value: syIn })
    })
    const [add] = t.steps
    if (add.decoded.kind !== "add_liquidity") throw new Error("lp_only: not an add_liquidity output")
    expect(add.decoded.lp > 0n).toBe(true)
    expect(t.bal1.underlying - t.bal0.underlying).toBe(-LP_ONLY)
    expect(t.bal1.lp - t.bal0.lp).toBe(add.decoded.lp)
    expect(t.bal1.sy - t.bal0.sy).toBe(syIn - add.decoded.sy_used)
    for (const k of ["pt", "yt"] as const) expect(t.bal1[k] - t.bal0[k], `lp_only: ${k} moved`).toBe(0n)
    log(`lp_only (USDY): ${units(LP_ONLY)} USDY -> LP ${units(add.decoded.lp)}, SY refund ${units(syIn - add.decoded.sy_used)}, tx ${add.hash}`)
    mark("LP")
  }, 4 * MINUTE)

  it("Oracle tick to 1.05 (the run's oracle key), then Claim yield pays exactly the pending yield", async () => {
    const before = BigInt(String((await reader()({ contractId: manifest.shared.oracle, functionName: "get_reference_value" })).value))
    const ticked = await tick("oracle tick (yield)", (current) => (current * YIELD_TICK_BPS) / 10_000n)
    // The trader's snapshot once it reads the new value: the yield the claim must pay.
    const s = await eventually(
      () => runners.trader.snapshot(),
      (snap) => snap.ms.oracleRate.status === "live" && snap.ms.oracleRate.value === ticked.value,
      "the new oracle value",
      60_000,
    )
    const expected = pendingYield({
      balance: live(s.acc.yt, "yt"),
      lastClaimedIndex: live(s.acc.ytLastClaimedIndex, "last claimed index"),
      pendingClaim: live(s.acc.ytPendingClaim, "pending claim"),
      liveOracleRate: live(s.ms.oracleRate, "oracle rate"),
      ytFrozen: live(s.ms.ytFrozen, "yt frozen"),
      accruedYieldIndex: live(s.ms.ytAccruedIndex, "accrued index"),
      ytFeeBps: live(s.ms.fees.ytBps, "yt fee"),
      exchangeRate: live(s.ms.exchangeRate, "exchange rate"),
    })
    expect(expected.net > 0n, `pending yield ${json(expected)}`).toBe(true)
    const b0 = await balancesFrom("trader", lastLedger())
    const claim = await floorless("trader", "claim_yield", 0n)
    expect(claim.decoded).toEqual({ kind: "amount", value: expected.net })
    const b1 = await balancesFrom("trader", claim.ledger)
    expect(b1.underlying - b0.underlying, "the claim pays USDY").toBe(expected.net)
    for (const k of ["sy", "pt", "yt", "lp"] as const) expect(b1[k] - b0[k], `claim: ${k} moved`).toBe(0n)
    record.claim = { expected: expected.net, paid: expected.net, oracleBefore: before, oracleAfter: ticked.value }
    log(`claim_yield: ${units(expected.net)} USDY (gross ${units(expected.gross)}, YT fee ${units(expected.fee)}), tx ${claim.hash}`)
    mark("tick and claim")
  }, 4 * MINUTE)

  it("Compliance recovery (R7-5): the issuer authority deauthorizes the trader on the SAC, then seize_all_positions moves every position to the escrow", async () => {
    const trader = accountOf("trader")
    const escrow = market.contracts.recoveryEscrow
    const seized = (await positionsOf(reader(), market, trader, lastLedger())).positions
    for (const k of ["sy", "pt", "yt", "lp"] as const) expect(seized[k] > 0n, `the trader holds ${k} before (${seized[k]})`).toBe(true)
    const escrowBefore = (await positionsOf(reader(), market, escrow, lastLedger())).positions
    const countBefore = (await readAt<bigint>(reader(), { contractId: escrow, functionName: "record_count" }, lastLedger())).value

    // 1. The issuer authority (the SAC admin) deauthorizes the trader on the SAC.
    const deauth = await adminStep("admin", "deauthorize the trader", "sac.set_authorized(false)", () =>
      sacSetAuthorized({ manifest, admin, sac: market.underlying.sac, account: trader, authorize: false }),
    )
    const authorized = await readAt<boolean>(reader(), { contractId: market.underlying.sac, functionName: "authorized", args: [{ type: "address", value: trader }] }, deauth.ledger)
    expect(authorized.value, "SAC.authorized(trader)").toBe(false)
    // The app shows it: the trader's trustline is no longer authorized, and a deposit is refused for it.
    await eventually(() => accountState(trader), (a) => a.trustline.status === "live" && a.trustline.value === "unauthorized", "the deauthorized trustline on Horizon", 60_000)
    const refused = await gatesFor(trader, await draftFor("trader", "deposit", U))
    const compliance = refused.blockers.filter((b) => b.code === "compliance")
    expect(compliance).toEqual([
      {
        code: "compliance",
        message: "Blocked by the issuer: your trustline exists but is not authorized. On Testnet, Get test tokens asks the issuer to authorize it.",
        fix: "onboarding",
      },
    ])
    expect(refused.simulation, `a deposit simulated as the deauthorized trader: ${json(refused.simulation)}`).toMatchObject({ ok: false, kind: "contract_error" })
    log(`deauthorized ${trader}: tx ${deauth.hash} (ledger ${deauth.ledger}); the app refuses its deposit: "${compliance[0].message}"`)

    // 2. seize_all_positions([trader]), signed by the issuer authority.
    const seize = await adminStep("admin", "seize all positions", "escrow.seize_all_positions", () => seizeAllPositions({ manifest, market, admin, accounts: [trader] }))
    expect(seize.ids, "one record, the next id").toEqual([countBefore])
    const [id] = seize.ids
    recordId = id

    // 3. The trader holds no position any more; the escrow holds its PT and YT (and the PT of its LP),
    // its SY and the LP's SY leg unwrapped into the underlying. Its USDY stays on its frozen trustline.
    const after = (await positionsOf(reader(), market, trader, seize.ledger)).positions
    expect(after).toEqual({ underlying: seized.underlying, sy: 0n, pt: 0n, yt: 0n, lp: 0n })
    const { record: rec } = await readRecord(reader(), market, id, seize.ledger)
    expect(rec).toMatchObject({
      id,
      account: trader,
      ledger: seize.ledger,
      sy_shares: seized.sy,
      lp_amount: seized.lp,
      pt_amount: seized.pt,
      yt_amount: seized.yt,
      finalized: false,
      underlying_from_pt: 0n,
      underlying_from_yt: 0n,
    })
    expect(rec.underlying_from_sy > 0n && rec.lp_pt >= 0n && rec.underlying_from_lp > 0n, `record ${json(rec)}`).toBe(true)
    const escrowAfter = (await positionsOf(reader(), market, escrow, seize.ledger)).positions
    expect(escrowAfter).toEqual({
      underlying: escrowBefore.underlying + rec.underlying_from_sy + rec.underlying_from_lp,
      sy: escrowBefore.sy,
      pt: escrowBefore.pt + seized.pt + rec.lp_pt,
      yt: escrowBefore.yt + seized.yt,
      lp: escrowBefore.lp,
    })
    expect(await readAccountRecords(reader(), market, trader, seize.ledger)).toEqual([id])
    record.recovery = { account: trader, seized, escrowBefore, escrowAfterSeize: escrowAfter, ids: seize.ids, recordAfterSeize: rec, deauthorizedBlockers: compliance }
    log(
      `seize_all_positions([${trader}]): tx ${seize.hash} (ledger ${seize.ledger}), record ${id}: SY ${units(seized.sy)} -> USDY ${units(rec.underlying_from_sy)}; ` +
        `LP ${units(seized.lp)} -> PT ${units(rec.lp_pt)} held + USDY ${units(rec.underlying_from_lp)}; PT ${units(seized.pt)} and YT ${units(seized.yt)} held ` +
        `(yield at seizure ${units(rec.yt_yield_at_seize)}); escrow now PT ${units(escrowAfter.pt)}, YT ${units(escrowAfter.yt)}, USDY ${units(escrowAfter.underlying)}`,
    )
    mark("recovery")
  }, 4 * MINUTE)

  it("After maturity, with no tick for longer than the oracle's window: the first redemption, which settles the market, is refused as stale", async () => {
    // The oracle admin shortens the window (the deploy keeps 3,600 s for its own seeding).
    const window = await adminStep("oracle", "oracle window", "oracle.set_safety_params", () =>
      oracleSetSafetyParams({ manifest, oracleAdmin, maxStaleSeconds: STALE_WINDOW_SECONDS, maxDeviationBps: MAX_DEVIATION_BPS }),
    )
    log(`oracle window set to ${STALE_WINDOW_SECONDS} s: tx ${window.hash}`)
    const waitFrom = Date.now()
    const due = Math.max(market.maturity, lastTickTimestamp + STALE_WINDOW_SECONDS + 1) + MATURITY_MARGIN_SECONDS
    let clock = await ledgerClock(manifest)
    log(
      `waiting ${Math.max(0, Math.ceil(due - clock.now()))} s: maturity at ${market.maturity}, the last tick (${lastTickTimestamp}) stale after ` +
        `${lastTickTimestamp + STALE_WINDOW_SECONDS}, then ${MATURITY_MARGIN_SECONDS} s more`,
    )
    while (clock.closeTime < due) {
      await sleep(Math.min(30_000, Math.max(5_000, (due - clock.now()) * 1_000)))
      clock = await ledgerClock(manifest)
    }
    // Every read and simulation of the refusals is from this ledger or later: a lagging node is read again.
    maturedLedger = Math.max(lastLedger(), clock.sequence)
    record.staleWindow = {
      seconds: STALE_WINDOW_SECONDS,
      lastTickTimestamp,
      waitedSeconds: Math.round((Date.now() - waitFrom) / 1_000),
      observedLedger: clock.sequence,
      observedTime: clock.closeTime,
      marginPastMaturity: clock.closeTime - market.maturity,
    }

    const ms = await eventually(
      () => fetchMarketState(reader(), manifest, market.marketId),
      (m) => readFrom(maturedLedger, m.oracleFresh) && m.oracleFresh.status === "live" && m.oracleFresh.value === false,
      `the oracle read as stale at ledger ${maturedLedger} or later`,
      60_000,
    )
    expect(live(ms.oracleMaxStaleSeconds, "window")).toBe(BigInt(STALE_WINDOW_SECONDS))
    expect(live(ms.settledRate, "settled rate"), "nobody has settled the market").toBeNull()
    expect(live(ms.ytFrozen, "yt frozen"), "the YT index is not frozen").toBe(false)

    const holder = await balancesFrom("holder", lastLedger())
    expect(holder.pt > 0n && holder.yt > 0n).toBe(true)
    const refusal = await gatesFor(accountOf("holder"), await draftFor("holder", "redeem", holder.pt, holder.yt), maturedLedger)
    expect(refusal.ledgerTime - market.maturity >= MATURITY_MARGIN_SECONDS, `read ${refusal.ledgerTime - market.maturity} s past maturity`).toBe(true)
    expect(refusal.blockers).toEqual([
      {
        code: "oracle",
        message:
          "The oracle price is stale: it has not been updated in the last 5 minutes. The first redemption settles the market at the current oracle price, so that price must be fresh. Wait for the next oracle update, then try again.",
      },
      {
        code: "quote",
        message: "The simulation was refused with contract error #7, so there is no exact quote and this would fail on-chain. Check the amount and any reason listed above, then try again.",
      },
    ])
    // PrincipalManager.OracleStale (#7), raised by the manager under the Router's redeem_at_maturity.
    expect(refusal.simulation).toMatchObject({ ok: false, kind: "contract_error", contractId: market.contracts.manager, code: 7 })
    record.refusals.push({ ...refusal, what: "redeem_at_maturity with a stale oracle (the first redemption settles the market)" })
    log(
      `stale: the holder's redemption is refused at ledger ${refusal.ledger} (time ${refusal.ledgerTime}, ${refusal.ledgerTime - market.maturity} s past maturity, ` +
        `last tick ${lastTickTimestamp}; simulated at ledger ${refusal.simulatedLedger}): ${refusal.blockers.map((b) => b.code).join(", ")}; contract error #7 from the manager`,
    )
    mark("stale refusal")
  }, 30 * MINUTE)

  it("After a tick, a trade is refused as matured, by the app and by the pool", async () => {
    if (maturedLedger === 0) throw new Error("maturity was not observed: the stale check did not run")
    await tick("oracle tick (maturity)")
    // From the tick's ledger (after the one where maturity was observed, with its margin) or later.
    const floor = Math.max(lastLedger(), maturedLedger)
    await eventually(
      () => fetchMarketState(reader(), manifest, market.marketId),
      (m) => readFrom(floor, m.oracleFresh) && m.oracleFresh.status === "live" && m.oracleFresh.value === true,
      `the oracle read as fresh at ledger ${floor} or later`,
      60_000,
    )
    const refusal = await gatesFor(accountOf("holder"), await draftFor("holder", "buy_pt", MATURED_TRADE), floor)
    expect(refusal.ledgerTime - market.maturity >= MATURITY_MARGIN_SECONDS, `read ${refusal.ledgerTime - market.maturity} s past maturity`).toBe(true)
    expect(refusal.blockers).toEqual([
      {
        code: "maturity",
        message:
          "Trading closed at maturity: this market has matured, so PT and YT can no longer be bought or sold in the pool. You can still redeem, claim yield, remove liquidity and withdraw SY.",
      },
      {
        code: "quote",
        message: "The simulation was refused with contract error #6, so there is no exact quote and this would fail on-chain. Check the amount and any reason listed above, then try again.",
      },
    ])
    // MarketPool.Expired (#6): `assert_active` refuses a swap at or after maturity.
    expect(refusal.simulation).toMatchObject({ ok: false, kind: "contract_error", contractId: market.contracts.pool, code: 6 })
    record.refusals.push({ ...refusal, what: "buy_pt after maturity (the oracle fresh)" })
    log(
      `matured: a Buy PT is refused at ledger ${refusal.ledger} (time ${refusal.ledgerTime}, ${refusal.ledgerTime - market.maturity} s past maturity ${market.maturity}; ` +
        `simulated at ledger ${refusal.simulatedLedger}); contract error #6 from the pool`,
    )
    mark("matured refusal")
  }, 4 * MINUTE)

  it("redeem_at_maturity: the holder redeems all its PT and YT, settling the market; exact on its balances", async () => {
    const s = await eventually(
      () => runners.holder.snapshot(),
      (snap) => snap.ms.oracleFresh.status === "live" && snap.ms.oracleFresh.value === true,
      "a fresh oracle in the holder's reads",
      60_000,
    )
    const b0 = await balancesFrom("holder", lastLedger())
    const rate = live(s.ms.oracleRate, "oracle rate")
    // The YT leg pays the yield the holder's YT earned (the 1.05 tick and since), after the YT fee.
    const ytLeg = pendingYield({
      balance: b0.yt,
      lastClaimedIndex: live(s.acc.ytLastClaimedIndex, "last claimed index"),
      pendingClaim: live(s.acc.ytPendingClaim, "pending claim"),
      liveOracleRate: rate,
      ytFrozen: live(s.ms.ytFrozen, "yt frozen"),
      accruedYieldIndex: live(s.ms.ytAccruedIndex, "accrued index"),
      ytFeeBps: live(s.ms.fees.ytBps, "yt fee"),
      exchangeRate: live(s.ms.exchangeRate, "exchange rate"),
    })
    expect(ytLeg.net > 0n, "the holder's YT earned yield").toBe(true)
    const redeem = await floorless("holder", "redeem", b0.pt, b0.yt)
    if (redeem.decoded.kind !== "redeem") throw new Error("redeem: not a redeem output")
    const { underlying_from_pt: fromPt, underlying_from_yt: fromYt } = redeem.decoded
    expect(fromYt).toBe(ytLeg.net)
    // PT at the settlement rate: pt × SCALE / rate in underlying (one raw unit for the SY round trip).
    const ptLeg = (b0.pt * SCALE) / rate
    expect(fromPt <= ptLeg && ptLeg - fromPt <= 1n, `PT leg ${fromPt} vs ${ptLeg}`).toBe(true)
    const b1 = await balancesFrom("holder", redeem.ledger)
    expect(b1).toEqual({ ...b0, underlying: b0.underlying + fromPt + fromYt, pt: 0n, yt: 0n })
    const ms = await eventually(
      () => fetchMarketState(reader(), manifest, market.marketId),
      (m) => m.settledRate.status === "live" && m.settledRate.value !== null,
      "the settled market",
      60_000,
    )
    const settled = live(ms.settledRate, "settled rate") as bigint
    expect(settled, "settled at the oracle value of the tick").toBe(rate)
    record.redeem = { pt: b0.pt, yt: b0.yt, underlyingFromPt: fromPt, underlyingFromYt: fromYt, settledRate: settled }
    log(`redeem_at_maturity: PT ${units(b0.pt)} -> USDY ${units(fromPt)}, YT ${units(b0.yt)} -> USDY ${units(fromYt)}; settled at ${settled}; tx ${redeem.hash}`)
    mark("redeem")
  }, 4 * MINUTE)

  it("finalize_record settles the seized PT and YT into the underlying; the record reads back finalized", async () => {
    if (recordId === undefined || !record.recovery?.recordAfterSeize) throw new Error("no recovery record: the seizure did not run")
    const seizedRec = record.recovery.recordAfterSeize
    const escrow = market.contracts.recoveryEscrow
    const escrowBefore = (await positionsOf(reader(), market, escrow, lastLedger())).positions
    const id = recordId
    const fin = await adminStep("admin", "finalize the record", "escrow.finalize_record", () => finalizeRecord({ manifest, market, admin, id }))
    const { record: rec } = await readRecord(reader(), market, id, fin.ledger)
    expect(rec).toEqual({ ...seizedRec, finalized: true, underlying_from_pt: fin.fromPt, underlying_from_yt: fin.fromYt })
    const settled = record.redeem?.settledRate
    if (settled === undefined) throw new Error("the market was not settled by the redemption")
    const ptTotal = seizedRec.pt_amount + seizedRec.lp_pt
    const ptLeg = (ptTotal * SCALE) / settled
    expect(fin.fromPt <= ptLeg && ptLeg - fin.fromPt <= 1n, `PT leg ${fin.fromPt} vs ${ptLeg}`).toBe(true)
    expect(fin.fromYt >= 0n).toBe(true)
    const escrowAfter = (await positionsOf(reader(), market, escrow, fin.ledger)).positions
    expect(escrowAfter).toEqual({
      ...escrowBefore,
      underlying: escrowBefore.underlying + fin.fromPt + fin.fromYt,
      pt: escrowBefore.pt - ptTotal,
      yt: escrowBefore.yt - seizedRec.yt_amount,
    })
    record.recovery.recordAfterFinalize = rec
    record.recovery.escrowAfterFinalize = escrowAfter
    log(
      `finalize_record(${id}): tx ${fin.hash} (ledger ${fin.ledger}); PT ${units(ptTotal)} -> USDY ${units(fin.fromPt)}, YT ${units(seizedRec.yt_amount)} -> USDY ${units(fin.fromYt)}; ` +
        `escrow now USDY ${units(escrowAfter.underlying)}, PT ${units(escrowAfter.pt)}, YT ${units(escrowAfter.yt)}`,
    )
    mark("finalize")
  }, 4 * MINUTE)
})

const showOutput = (o: ActionOutput) =>
  Object.entries(o)
    .filter(([k]) => k !== "kind")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ")
