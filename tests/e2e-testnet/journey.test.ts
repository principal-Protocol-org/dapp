// @vitest-environment node
/**
 * Suite A, the live journey (plan 0007, Task 3; R7-1, R7-3, R7-5): the user journey signed live on
 * Stellar Testnet against the official deployment (`config/manifests/testnet.json`), through the
 * pipeline the app runs (`tests/integration/route-runner.ts`: the trade adapter plans and quotes,
 * `useTradeRoute`'s checks before the start, each step simulated as the user, gated, given floors
 * from its own simulation, reviewed and signed). Fresh keypairs sign in the wallet's place.
 *
 * 1. Two fresh keypairs are onboarded as a user is: Friendbot, the trustline, then the public faucet
 *    (`POST https://testnet.principalmarket.fi/api/faucet`), a faucet minute apart. No secret.
 * 2. The trader's journey, each a single transaction: deposit; mint PT + YT (Split); Buy PT and
 *    Sell PT paid and received in USDY; the flash Buy YT paid in USDY, then Sell YT; LP only paid in
 *    USDY and LP with Keep YT; LP Withdraw to USDY. Every balance moves by exactly the flow's own
 *    result and by nothing else (the stray PT and SY held before stay untouched).
 * 3. Transfers (R7-5): a PT and a YT transfer from the trader to the second account, through the
 *    tokens' SEP-41 `transfer`, exact on both sides.
 * 4. History lists every transaction of the run, once, with its kind, read as the History page
 *    reads it (`use-history.ts`: one `getHealth`, then the walk over the RPC's whole window).
 * 5. Compliance: an account that was not onboarded is refused with the plain reason, before and
 *    after it adds a trustline, and the contracts refuse it too.
 *
 * Testnet is shared and rate-limited: an external failure (Friendbot, the RPC, a stale sequence) is
 * retried once at the step level, and only when nothing of it landed (`tests/live/retry.ts`); no
 * assertion is ever skipped. A Testnet that cannot be reached, an oracle that is not fresh, or a
 * market too close to maturity fails the run with the reason: it never passes empty.
 *
 * The amounts stay small: the official pool holds about 100,000 PT and 95,000 SY, and other people
 * use it. Nothing is asserted on the pool's reserves, which they may move during the run; every
 * exact assertion is on the run's own accounts. The run's record (public keys, hashes, the
 * refusals) is written to `e2e-artifacts/journey.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Keypair } from "@stellar/stellar-sdk"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { simulate } from "@/hooks/use-simulation"
import { fetchAccountState, type AccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import type { ActionInput } from "@/lib/protocol/actions"
import { evaluateAccountCompliance } from "@/lib/protocol/compliance"
import { curveStateFrom } from "@/lib/protocol/curve"
import { fetchAccountHistory, type HistoryKind } from "@/lib/protocol/events"
import { evaluateGates, type Blocker } from "@/lib/protocol/gates"
import { openGuards, type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { validateManifest } from "@/lib/protocol/manifest"
import { fetchMarketState, type MarketState } from "@/lib/protocol/market-state"
import { BPS } from "@/lib/protocol/math"
import { addTrustline, type FaucetStep } from "@/lib/protocol/onboarding"
import { previewDeposit, previewWithdraw } from "@/lib/protocol/previews"
import { createRpcReader } from "@/lib/protocol/reader"
import { assertPreparedMatches, withResourceFeeHeadroom } from "@/lib/protocol/review"
import { planRoute, routeHoldings, type Holdings, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import {
  buildInvocationEnvelope,
  createRpcServer,
  pollTransactionStatus,
  simulateInvocation,
  submitSignedTransaction,
  type ContractInvocation,
  type SimulationOutcome,
} from "@/lib/protocol/stellar"
import type { TradeRequest } from "@/lib/protocol/trade-adapter"
import type { Finding, Manifest, Market } from "@/lib/protocol/types"
import { solveBuyYt } from "@/lib/protocol/yt-solver"
import { keypairSigner, type KeypairSigner } from "../integration/keypair-signer"
import { createRunner, live, runTrade, SLIPPAGE_BPS, type Runner, type Snapshot, type StepRecord, type TradeRun } from "../integration/route-runner"
import { balancesOf, complianceKind, createLog, HISTORY_KIND, ledgerClock, MINUTE, showBalances, U, units, type Balances } from "../live/chain"
import { fundOnce, liveContext, type OnboardedSigner } from "../live/context"
import { retryOnce } from "../live/retry"
import { eventually, json, redact } from "../live/util"

const DAPP = join(__dirname, "..", "..")
const ARTIFACT = join(DAPP, "e2e-artifacts", "journey.json")
const explorer = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`

/** The journey takes minutes; a market closer than this to maturity cannot carry it. */
const MIN_RUNWAY_SECONDS = 6 * 3_600

/** The Router functions of principal 665bb67 the journey signs in one transaction each (R5-1). */
const ONE_STEP_FUNCTIONS = [
  "swap_underlying_for_pt",
  "swap_pt_for_underlying",
  "swap_yt_for_underlying",
  "flash_mint_yt_from_underlying",
  "add_liquidity_single_underlying",
  "add_liquidity_keep_yt",
  "remove_liquidity_to_underlying",
]

/** Every balance a test account holds in this market. */
const TOKENS: (keyof Balances)[] = ["underlying", "sy", "pt", "yt", "lp"]

/** The faucet's payment: 100,000 whole test tokens (`TEST_TOKEN_AMOUNT`). */
const FAUCET_PAYMENT = 100_000n * U

// The amounts: small next to the official pool (about 100,000 PT and 95,000 SY).
const DEPOSIT = 500n * U
const SPLIT = 300n * U
const BUY_PT = 200n * U
const SELL_PT = 100n * U
/** A flash budget: the flash mints about 1 / (1 − PT price) times this in YT. */
const FLASH_BUDGET = 5_000_000n
const LP_ONLY = 200n * U
const KEEP_YT = 300n * U
const TRANSFER = 10n * U

const ctx = liveContext({ network: "testnet" })
const out = createLog("journey")
const log = out.log

/** One transaction of the run, in the order it landed. */
type Landed = { step: string; account: "trader" | "recipient" | "outsider"; action: string; kind: HistoryKind | null; hash: string; ledger?: number }

type Refusal = { state: string; reasons: Blocker[]; simulation: SimulationOutcome | { ok: true } }

/** What `e2e-artifacts/journey.json` records: public data only, through `redact`. */
type JourneyRecord = {
  suite: "journey"
  network: string
  marketId?: string
  sourceCommit?: string
  rpcUrl: string
  faucetOrigin?: string
  startedAt: string
  finishedAt?: string
  durationSeconds?: number
  accounts: Partial<Record<"trader" | "recipient" | "outsider", string>>
  onboarding: Partial<Record<"trader" | "recipient", { trustlineHash: string; faucet: FaucetStep[]; balances: string }>>
  transactions: (Landed & { explorer: string })[]
  history?: { trader: [string, HistoryKind][]; recipient: [string, HistoryKind][] }
  compliance?: { account: string; trustlineHash?: string; refusals: Refusal[]; transferToOutsider?: SimulationOutcome }
  completedTests: string[]
  complete: boolean
}

describe("Suite A: the live journey on the official Testnet deployment (plan 0007)", () => {
  let manifest: Manifest
  let market: Market
  let findings: Finding[]
  let kind: ComplianceKind
  let trader: OnboardedSigner
  let recipient: OnboardedSigner
  let r: Runner
  /** Every confirmed route step of the trader, in the order it landed. */
  const sent: StepRecord[] = []
  /** Every transaction of the run, in the order it landed. */
  const landed: Landed[] = []
  const started = Date.now()
  const record: JourneyRecord = {
    suite: "journey",
    network: ctx.network,
    rpcUrl: ctx.rpcUrl,
    ...(ctx.faucet.mode === "endpoint" ? { faucetOrigin: ctx.faucet.origin } : {}),
    startedAt: new Date(started).toISOString(),
    accounts: {},
    onboarding: {},
    transactions: [],
    completedTests: [],
    complete: false,
  }

  const server = () => createRpcServer(manifest.rpcUrl)
  const reader = () => createRpcReader(manifest)
  const accountState = (account: string): Promise<AccountState> =>
    fetchAccountState(reader(), createHorizon(manifest.horizonUrl), manifest, market.marketId, account, kind)
  const sequenceOf = async (account: string) => (await server().getAccount(account)).sequenceNumber()
  /** The latest ledger any transaction of the run landed in: later reads must be from it or after. */
  const lastLedger = () => Math.max(0, ...landed.map((l) => l.ledger ?? 0))

  /** Balances of `account`, read again while a node answers from before `minLedger`. */
  async function balancesFrom(account: string, minLedger: number): Promise<Balances> {
    const acc = await eventually(
      () => accountState(account),
      (a) => TOKENS.every((k) => a[k].status === "live" && a[k].ledger >= minLedger),
      `the balances of ${account} at ledger ${minLedger} or later`,
      60_000,
    )
    return balancesOf(acc)
  }

  /** The ledger a confirmed transaction landed in. */
  async function ledgerOf(hash: string): Promise<number> {
    const tx = await eventually(
      () => server().getTransaction(hash),
      (t) => t.status !== "NOT_FOUND",
      `transaction ${hash} on the RPC`,
      60_000,
    )
    if (tx.status === "NOT_FOUND") throw new Error(`transaction ${hash} not found`)
    return tx.ledger
  }

  /** The trader's transactions so far are all recorded; the ones the runner signed carry their ledger. */
  function noteSteps(name: string, steps: StepRecord[]) {
    for (const s of steps) landed.push({ step: name, account: "trader", action: s.action, kind: HISTORY_KIND[s.action], hash: s.hash, ...(s.ledger ? { ledger: s.ledger } : {}) })
  }

  /**
   * One signed step of the trader, retried once on an external failure when the trader's sequence
   * number shows nothing of it landed (a second transaction could then never land beside the first).
   */
  async function signedStep<T>(what: string, run: () => Promise<T>): Promise<T> {
    const seq = await sequenceOf(trader.publicKey)
    return retryOnce({ what, run, nothingLanded: async () => (await sequenceOf(trader.publicKey)) === seq, log })
  }

  /** A trade as the tab runs it (`runTrade`), signed once, and recorded. */
  async function trade(req: TradeRequest, expectActions: ActionInput["action"][], expectPlan?: (plans: StepPlan[], s: Snapshot) => void): Promise<TradeRun> {
    const t = await signedStep(`${req.kind} (${expectActions.join(", ")})`, () =>
      runTrade({ manifest, market, runner: r, log, req, expectActions, ...(expectPlan ? { expectPlan } : {}) }),
    )
    noteSteps(req.kind, t.steps)
    return t
  }

  const delta = (t: TradeRun, k: keyof Balances) => t.bal1[k] - t.bal0[k]
  const value = (o: ActionOutput) => {
    if (o.kind !== "amount") throw new Error(`expected an amount, got ${o.kind}`)
    return o.value
  }

  /**
   * The Router sweeps by gain (R5-4): the account holds stray PT and SY before the flow; after it,
   * every balance moved by exactly `moves`, the flow's own result, and by nothing else; and the
   * route's holdings (what the progress panel and the unwind work from) are what the flow received.
   */
  function expectOwnResult(t: TradeRun, moves: Partial<Balances>, label: string): void {
    expect(t.bal0.pt > 0n && t.bal0.sy > 0n, `${label}: the account holds stray PT (${t.bal0.pt}) and SY (${t.bal0.sy}) before`).toBe(true)
    for (const k of TOKENS) expect(delta(t, k), `${label}: ${k} moved`).toBe(moves[k] ?? 0n)
    const received: Holdings = {}
    for (const k of TOKENS) if ((moves[k] ?? 0n) > 0n) received[k] = moves[k]
    expect(routeHoldings(t.request, t.plans, t.outputs, t.plans.length), `${label}: the route's holdings`).toEqual(received)
    log(
      `${label}: tx ${t.steps.map((s) => s.hash).join(", ")}; moved exactly ${TOKENS.filter((k) => moves[k])
        .map((k) => `${k} ${units(moves[k]!)}`)
        .join(", ")}; account now ${showBalances(t.bal1)}`,
    )
  }

  /** A quick action (`ActionPanel`): one step, signed once, recorded, with the balances before and after. */
  async function quickAction(name: string, req: RouteRequest, plans: StepPlan[]) {
    const s0 = await r.snapshot()
    const b0 = balancesOf(s0.acc)
    const { steps } = await signedStep(name, () => r.runRoute(req, plans, { name }))
    noteSteps(name, steps)
    const b1 = balancesOf((await r.snapshot()).acc)
    return { steps, b0, b1 }
  }

  /** A SEP-41 `transfer` the trader signs: built, simulated and assembled, checked, signed, sent, confirmed. */
  async function transfer(token: "pt" | "yt", to: string, amount: bigint): Promise<{ hash: string; ledger: number }> {
    const invocation: ContractInvocation = {
      contractId: market.contracts[token],
      functionName: "transfer",
      args: [
        { type: "address", value: trader.publicKey },
        { type: "address", value: to },
        { type: "i128", value: amount },
      ],
    }
    const node = server()
    const built = buildInvocationEnvelope({
      source: trader.publicKey,
      sequence: await sequenceOf(trader.publicKey),
      networkPassphrase: manifest.networkPassphrase,
      invocation,
    })
    const fromRpc = await node.prepareTransaction(built)
    assertPreparedMatches(built, fromRpc)
    // The headroom a review declares: the trader's PT and YT balances were touched a ledger ago.
    const prepared = withResourceFeeHeadroom(fromRpc)
    assertPreparedMatches(built, prepared)
    const signedXdr = await trader.sign(prepared.toXDR(), manifest.networkPassphrase, trader.publicKey)
    const { hash } = await submitSignedTransaction({ rpcUrl: manifest.rpcUrl, networkPassphrase: manifest.networkPassphrase, signedXdr })
    const polled = await pollTransactionStatus({ rpcUrl: manifest.rpcUrl, hash, attempts: 30, intervalMs: 2_000 })
    expect(polled.status, `${token} transfer ${hash}: ${json(polled)}`).toBe("SUCCESS")
    return { hash, ledger: await ledgerOf(hash) }
  }

  /** What the app shows `account` for `draft`: every gate with its own reads and the simulation as that account. */
  async function gatesFor(account: string, draft: ActionInput): Promise<{ blockers: Blocker[]; simulation: SimulationOutcome }> {
    const [clock, ms, acc] = await Promise.all([ledgerClock(manifest), fetchMarketState(reader(), manifest, market.marketId), accountState(account)])
    const simulation = await simulate(manifest, draft)
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
    return { blockers, simulation }
  }

  beforeAll(async () => {
    // Review Focus 3: a Testnet that cannot be reached fails the run with the reason; it never skips.
    const down = await ctx.unreachableReason()
    if (down) throw new Error(`Testnet cannot be reached: ${down}`)
    manifest = ctx.manifest
    market = manifest.markets[0]
    record.marketId = market.marketId
    record.sourceCommit = manifest.sourceCommit
    findings = validateManifest(manifest)
    expect(findings.filter((f) => f.severity === "error"), "manifest findings").toEqual([])
    for (const fn of ONE_STEP_FUNCTIONS) expect(manifest.routerFunctions ?? [], `the manifest lists ${fn}`).toContain(fn)

    const clock = await ledgerClock(manifest)
    const runway = market.maturity - clock.closeTime
    if (runway < MIN_RUNWAY_SECONDS) throw new Error(`the official market ${market.marketId} matures in ${runway} s; the journey needs an open market`)
    const ms = await fetchMarketState(reader(), manifest, market.marketId)
    // The hosted keeper keeps the oracle fresh (about every 30 minutes, a one-hour window). A stale
    // oracle refuses every trade: the run fails with that reason, it never skips.
    const age = clock.closeTime - Number(live(ms.oracleTimestamp, "oracle timestamp"))
    const window = live(ms.oracleMaxStaleSeconds, "oracle window")
    if (live(ms.oracleFresh, "oracle freshness") !== true) {
      throw new Error(`the official oracle is not available (is_available() is false): last set ${age} s ago, window ${window} s; the hosted keeper has not updated it`)
    }
    expect(live(ms.poolSeeded, "pool seeded"), "the pool is seeded").toBe(true)
    kind = await complianceKind(manifest, market)
    log(
      `market ${market.marketId} (principal ${manifest.sourceCommit.slice(0, 7)}), matures in ${Math.floor(runway / 86_400)} d; oracle ${live(ms.oracleRate, "oracle rate")} set ${age} s ago ` +
        `(window ${window} s); pool PT ${units(live(ms.poolState, "pool").ptReserve)}, SY ${units(live(ms.poolState, "pool").syReserve)}; implied_rate ${live(ms.impliedRate, "implied rate")}; compliance ${kind}`,
    )
  }, 5 * MINUTE)

  // Vitest 5 hands the suite over as the second argument; the first must be a destructuring pattern.
  afterAll(({}, suite) => {
    const finished = Date.now()
    record.finishedAt = new Date(finished).toISOString()
    record.durationSeconds = Math.round((finished - started) / 1_000)
    record.transactions = landed.map((l) => ({ ...l, explorer: explorer(l.hash) }))
    const tests = suite.tasks.filter((t) => t.type === "test")
    record.completedTests = tests.filter((t) => t.result?.state === "pass").map((t) => t.name)
    record.complete = record.completedTests.length === tests.length
    mkdirSync(join(DAPP, "e2e-artifacts"), { recursive: true })
    writeFileSync(ARTIFACT, `${redact(JSON.stringify(record, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2))}\n`)
    log(`record written to e2e-artifacts/journey.json: ${landed.length} transactions, ${record.completedTests.length}/${tests.length} tests passed, ${record.durationSeconds} s`)
    out.summary()
  })

  it("onboards two fresh keypairs through the public faucet: Friendbot, the trustline, then Get test tokens, a faucet minute apart (R7-3)", async () => {
    trader = await ctx.onboard(market, kind)
    recipient = await ctx.onboard(market, kind)
    record.accounts = { trader: trader.publicKey, recipient: recipient.publicKey }
    for (const [name, who] of [
      ["trader", trader],
      ["recipient", recipient],
    ] as const) {
      const acc = await accountState(who.publicKey)
      // Every compliance check the app runs passes, and the faucet paid 100,000 USDY and nothing else.
      expect(evaluateAccountCompliance(acc, kind).map((i) => [i.id, i.status]), `${name} compliance`).toEqual([
        ["account", "ok"],
        ["trustline", "ok"],
        ["authorized", "ok"],
        ["permissioning", "ok"],
        ["perm_pt", "ok"],
        ["perm_yt", "ok"],
      ])
      const b = balancesOf(acc)
      expect(b, `${name} balances`).toEqual({ underlying: FAUCET_PAYMENT, sy: 0n, pt: 0n, yt: 0n, lp: 0n })
      // A fresh account: the faucet performed every step it has.
      expect(who.onboarding?.faucet, `${name} faucet steps`).toEqual(["authorize", "grant_account", "grant_pt", "grant_yt", "pay"])
      record.onboarding[name] = { trustlineHash: who.onboarding!.trustlineHash, faucet: who.onboarding!.faucet, balances: showBalances(b) }
      const cap = acc.depositCap.status === "live" ? units(acc.depositCap.value) : acc.depositCap.error
      log(`${name} ${who.publicKey} onboarded: trustline tx ${who.onboarding!.trustlineHash}, faucet ${who.onboarding!.faucet.join(", ")}; ${showBalances(b)}; deposit cap ${cap}`)
    }
    r = createRunner({ manifest, market, findings, kind, signer: trader, log, record: (s) => sent.push(s), readAfterLanded: true })
  }, 12 * MINUTE)

  it("Deposit: USDY to SY (quick action)", async () => {
    const req = { amount: DEPOSIT } as RouteRequest
    const plans: StepPlan[] = [{ action: "deposit", amount: { from: "value", value: DEPOSIT }, gives: "", takes: "" }]
    const { steps, b0, b1 } = await quickAction("deposit", req, plans)
    expect(b1.underlying - b0.underlying).toBe(-DEPOSIT)
    expect(b1.sy - b0.sy).toBe(value(steps[0].decoded))
    for (const k of ["pt", "yt", "lp"] as const) expect(b1[k] - b0[k], `${k} moved`).toBe(0n)
    log(`deposit: ${units(DEPOSIT)} USDY -> ${units(value(steps[0].decoded))} SY, tx ${steps[0].hash}`)
  })

  it("Mint PT + YT: Split USDY into PT and YT, one each (quick action)", async () => {
    const req: RouteRequest = { kind: "split", marketId: market.marketId, source: trader.publicKey, amount: SPLIT, pay: "underlying", receive: "sy", matured: false }
    const plans = planRoute(req, { routerFunctions: manifest.routerFunctions ?? [] })
    if (!Array.isArray(plans)) throw new Error(plans.disabled)
    expect(plans.map((p) => p.action)).toEqual(["mint"])
    const { steps, b0, b1 } = await quickAction("split", req, plans)
    const [mint] = steps
    if (mint.decoded.kind !== "mint") throw new Error("not a mint output")
    expect(mint.decoded.pt_minted).toBe(mint.decoded.yt_minted)
    expect(b1.underlying - b0.underlying).toBe(-SPLIT)
    expect(b1.pt - b0.pt).toBe(mint.decoded.pt_minted)
    expect(b1.yt - b0.yt).toBe(mint.decoded.yt_minted)
    for (const k of ["sy", "lp"] as const) expect(b1[k] - b0[k], `${k} moved`).toBe(0n)
    log(`split: ${units(SPLIT)} USDY -> PT ${units(mint.decoded.pt_minted)} + YT ${units(mint.decoded.yt_minted)}, tx ${mint.hash}`)
  })

  it("Buy PT with USDY: one transaction (swap_underlying_for_pt); the PT and SY held before are untouched", async () => {
    const t = await trade({ kind: "buy_pt", amount: BUY_PT, pay: "underlying", receive: "underlying" }, ["buy_pt_underlying"])
    const [buy] = t.steps
    expect(buy.amount).toBe(BUY_PT)
    expectOwnResult(t, { underlying: -BUY_PT, pt: value(buy.decoded) }, "buy_pt (USDY)")
    expect(t.quote.exactness).toBe("simulated")
    // Buying PT pushes the fixed rate down (R2-15), on the quote's own reads.
    expect(t.quote.apyAfter! < t.quote.apyBefore!).toBe(true)
  })

  it("Sell PT for USDY: one transaction (swap_pt_for_underlying) withdrawing only the sale's SY", async () => {
    const t = await trade({ kind: "sell_pt", amount: SELL_PT, pay: "underlying", receive: "underlying" }, ["sell_pt_underlying"])
    const [sell] = t.steps
    expectOwnResult(t, { pt: -SELL_PT, underlying: value(sell.decoded) }, "sell_pt (USDY)")
    expect(t.quote.exactness).toBe("simulated")
    expect(t.quote.apyAfter! > t.quote.apyBefore!).toBe(true)
  })

  it("Buy YT with USDY: one flash (flash_mint_yt_from_underlying) spending at most the budget, the rest back as USDY", async () => {
    const req: TradeRequest = { kind: "buy_yt", amount: FLASH_BUDGET, pay: "underlying", receive: "underlying" }
    let sized = { exchangeRate: 0n, budgetSy: 0n, syIn: 0n }
    const t = await trade(req, ["buy_yt_flash_underlying"], (plans, s) => {
      sized = flashSized(s.ms, req)
      // R5-2: the budget is the input, and the sy_in the one sized from the same reads.
      expect(plans[0].amount).toEqual({ from: "input" })
      expect(plans[0].secondaryAmount).toEqual({ from: "value", value: sized.syIn })
      expect(sized.syIn > sized.budgetSy, "the flash mints more than it spends").toBe(true)
    })
    const [buy] = t.steps
    if (buy.decoded.kind !== "flash_yt_underlying") throw new Error("not a flash_yt_underlying output")
    const { yt_out, net_cost, underlying_back } = buy.decoded
    expect(buy.amount).toBe(FLASH_BUDGET)
    expect(buy.secondaryAmount).toBe(sized.syIn)
    // R5-3: the pool pulls max_net_cost up front, capped at the budget's SY; the cost is within it.
    const max = buy.guards.maxNetCost!
    expect(max <= sized.budgetSy, `max_net_cost ${max} vs budget ${sized.budgetSy} SY`).toBe(true)
    expect(net_cost <= max, `net cost ${net_cost} vs max_net_cost ${max}`).toBe(true)
    expect(buy.guards.minOut2).toBe(previewWithdraw(sized.budgetSy - max, sized.exchangeRate))
    // The budget's SY not spent comes back as USDY in the same transaction, and nothing else moves.
    expect(underlying_back).toBe(previewWithdraw(sized.budgetSy - net_cost, sized.exchangeRate))
    expectOwnResult(t, { underlying: underlying_back - FLASH_BUDGET, yt: yt_out }, "buy_yt (USDY flash)")
    expect(t.quote.exactness).toBe("simulated")
    expect(t.quote.flash?.budget).toBe(FLASH_BUDGET)
    expect(t.quote.apyAfter! > t.quote.apyBefore!).toBe(true)
    log(`buy_yt (USDY flash): budget ${units(FLASH_BUDGET)} USDY, sy_in ${units(sized.syIn)}, net cost ${units(net_cost)} SY, ${units(underlying_back)} USDY back, YT ${units(yt_out)}`)
  })

  it("Sell YT for USDY: one transaction (swap_yt_for_underlying) withdrawing only the sale's SY", async () => {
    const yt = balancesOf((await r.snapshot()).acc).yt / 2n
    expect(yt > 0n, "YT from the split and the flash").toBe(true)
    const t = await trade({ kind: "sell_yt", amount: yt, pay: "underlying", receive: "underlying" }, ["sell_yt_underlying"])
    const [sell] = t.steps
    expectOwnResult(t, { yt: -yt, underlying: value(sell.decoded) }, "sell_yt (USDY)")
    expect(t.quote.exactness).toBe("simulated")
  })

  it("LP only paid in USDY: one transaction (add_liquidity_single_underlying); the pool's SY refund stays as SY", async () => {
    const req: TradeRequest = { kind: "lp_only", amount: LP_ONLY, pay: "underlying", receive: "underlying" }
    let syIn = 0n
    const t = await trade(req, ["add_liquidity_underlying"], (plans, s) => {
      syIn = previewDeposit(req.amount, live(s.ms.exchangeRate, "exchange rate"))
      expect(plans[0].secondaryAmount).toEqual({ from: "value", value: syIn })
    })
    const [add] = t.steps
    if (add.decoded.kind !== "add_liquidity") throw new Error("not an add_liquidity output")
    const refund = syIn - add.decoded.sy_used
    expect(refund >= 0n, `sy_used ${add.decoded.sy_used} of sy_in ${syIn}`).toBe(true)
    // R5-5: the PT the zap bought and did not add stays in the pool's reserve, so no PT moves.
    expectOwnResult(t, { underlying: -LP_ONLY, sy: refund, lp: add.decoded.lp }, "lp_only (USDY)")
    expect(t.quote.exactness).toBe("simulated")
  })

  it("LP with Keep YT: one transaction (add_liquidity_keep_yt) minting the SY the dApp sized; LP and YT received", async () => {
    const req: TradeRequest = { kind: "lp_keep_yt", amount: KEEP_YT, pay: "underlying", receive: "underlying" }
    let shares = 0n
    let mint = 0n
    const t = await trade(req, ["add_liquidity_keep_yt"], (plans, s) => {
      shares = previewDeposit(req.amount, live(s.ms.exchangeRate, "exchange rate"))
      const m = plans[0].secondaryAmount
      if (m?.from !== "value") throw new Error(`mint_amount is not a sized value: ${json(m)}`)
      mint = m.value
      expect(mint >= 1n && mint < shares, `mint ${mint} of ${shares} shares`).toBe(true)
    })
    const [keep] = t.steps
    if (keep.decoded.kind !== "keep_yt") throw new Error("not a keep_yt output")
    // What the pool did not take stays in the wallet: PT minted 1:1 with YT, less what was added; the
    // deposit's shares, less the mint and the SY added (R5-7).
    const leftPt = keep.decoded.yt_minted - keep.decoded.pt_used
    const leftSy = shares - mint - keep.decoded.sy_used
    expect(leftPt >= 0n && leftSy >= 0n && leftPt + leftSy <= 10n, `left ${leftPt} PT, ${leftSy} SY`).toBe(true)
    expectOwnResult(t, { underlying: -KEEP_YT, pt: leftPt, sy: leftSy, yt: keep.decoded.yt_minted, lp: keep.decoded.lp }, "lp_keep_yt")
    expect(t.quote.alsoOut?.amount).toBe(keep.decoded.yt_minted)
  })

  it("LP Withdraw to USDY: one transaction (remove_liquidity_to_underlying) selling and unwrapping only what the removal produced", async () => {
    const half = balancesOf((await r.snapshot()).acc).lp / 2n
    expect(half > 0n, "LP from the two adds").toBe(true)
    const t = await trade({ kind: "lp_withdraw", amount: half, pay: "underlying", receive: "underlying" }, ["remove_liquidity_underlying"])
    const [exit] = t.steps
    expect(exit.amount).toBe(half)
    expectOwnResult(t, { lp: -half, underlying: value(exit.decoded) }, "lp_withdraw (USDY)")
    expect(t.quote.exactness).toBe("simulated")
  })

  it("Transfers (R7-5): a PT and a YT transfer from the trader to the second account, exact on both sides", async () => {
    for (const token of ["pt", "yt"] as const) {
      const from0 = await balancesFrom(trader.publicKey, lastLedger())
      const to0 = await balancesFrom(recipient.publicKey, lastLedger())
      expect(from0[token] >= TRANSFER, `the trader holds ${token} ${from0[token]}`).toBe(true)
      const { hash, ledger } = await signedStep(`${token} transfer`, () => transfer(token, recipient.publicKey, TRANSFER))
      landed.push({ step: `${token} transfer`, account: "trader", action: `${token}.transfer`, kind: "transfer", hash, ledger })
      const from1 = await balancesFrom(trader.publicKey, ledger)
      const to1 = await balancesFrom(recipient.publicKey, ledger)
      for (const k of TOKENS) {
        expect(from1[k] - from0[k], `trader ${k} moved`).toBe(k === token ? -TRANSFER : 0n)
        expect(to1[k] - to0[k], `recipient ${k} moved`).toBe(k === token ? TRANSFER : 0n)
      }
      log(`${token} transfer: ${units(TRANSFER)} from ${trader.publicKey} to ${recipient.publicKey}, tx ${hash} (ledger ${ledger})`)
    }
  })

  it("History lists every transaction of the run, once, with its kind, as the History page reads it", async () => {
    expect(landed.length, "transactions to look for").toBeGreaterThan(0)
    // As `use-history.ts`: one getHealth per refresh, its window for every read. Once it reaches the
    // run's last transaction (a node may be a ledger behind).
    const until = lastLedger()
    const health = await eventually(() => server().getHealth(), (h) => h.latestLedger >= until, `the RPC at ledger ${until}`, 60_000)
    const window = { oldestLedger: health.oldestLedger, latestLedger: health.latestLedger }
    const read = (account: string) => fetchAccountHistory({ manifest, marketId: market.marketId, account, server: server(), window })
    const [mine, theirs] = [await read(trader.publicKey), await read(recipient.publicKey)]
    expect(mine.truncated).toBe(false)
    expect(theirs.truncated).toBe(false)
    // Entries are newest first; `landed` is in the order the transactions landed.
    const expected = landed.filter((l) => l.account === "trader").map((l) => [l.hash, l.kind])
    const listed = (h: typeof mine) => [...h.entries].reverse().map((e) => [e.hash, e.kind] as [string, HistoryKind])
    expect(listed(mine), "the trader's history").toEqual(expected)
    expect(listed(theirs), "the recipient's history: the two transfers").toEqual(landed.filter((l) => l.kind === "transfer").map((l) => [l.hash, "transfer"]))
    // R5-9, stated on its own: the flash is a Buy YT, LP only and Keep YT are Add liquidity, the LP exit to USDY a Remove liquidity.
    const kindOf = new Map(mine.entries.map((e) => [e.hash, e.kind]))
    for (const [action, k] of [
      ["buy_yt_flash_underlying", "buy_yt"],
      ["add_liquidity_underlying", "add_liquidity"],
      ["add_liquidity_keep_yt", "add_liquidity"],
      ["remove_liquidity_underlying", "remove_liquidity"],
    ] as const) {
      expect(sent.filter((s) => s.action === action).map((s) => kindOf.get(s.hash)), action).toEqual([k])
    }
    record.history = { trader: listed(mine), recipient: listed(theirs) }
    log(`history: trader ${mine.entries.length} entries (${listed(mine).map(([, k]) => k).join(", ")}); recipient ${theirs.entries.length} (${listed(theirs).map(([, k]) => k).join(", ")})`)
  })

  it("Compliance: an account that was not onboarded is refused with the plain reason, and the contracts refuse it too", async () => {
    const outsider: KeypairSigner = keypairSigner(Keypair.random(), manifest.networkPassphrase)
    const account = outsider.publicKey
    record.accounts.outsider = account
    const compliance: NonNullable<JourneyRecord["compliance"]> = { account, refusals: [] }
    record.compliance = compliance
    const exists = async () => {
      const a = await accountState(account)
      return a.accountExists.status === "live" && a.accountExists.value
    }
    await fundOnce({ manifest, account, exists })
    await eventually(exists, (e) => e, "the outsider's account on Horizon")
    const ledgerNow = Math.floor((await ledgerClock(manifest)).now())
    const draft: ActionInput = {
      action: "deposit",
      marketId: market.marketId,
      source: account,
      amount: 100n * U,
      guards: openGuards("deposit", 100n * U),
      deadline: BigInt(ledgerNow + 300),
    }
    const compliant = (blockers: Blocker[]) => blockers.filter((b) => b.code === "compliance")

    // Funded by Friendbot, nothing else: no trustline, so the issuer cannot authorize it, and Principal does not know it.
    const bare = await gatesFor(account, draft)
    expect(compliant(bare.blockers), "funded only").toEqual([
      { code: "compliance", message: "You have no trustline to the underlying asset. Add one before you can hold it.", fix: "trustline" },
      { code: "compliance", message: "The issuer cannot authorize you until you add a trustline.", fix: "trustline" },
      { code: "compliance", message: "Principal permissioning: your account is not allowed yet. Get test tokens grants it on Testnet.", fix: "onboarding" },
    ])
    compliance.refusals.push({ state: "funded by Friendbot, no trustline", reasons: compliant(bare.blockers), simulation: bare.simulation })

    // With its own trustline but without Get test tokens: the issuer has not authorized it.
    const { hash: trustlineHash } = await retryOnce({
      what: "the outsider's trustline",
      run: () =>
        addTrustline({
          manifest,
          account,
          asset: { code: market.underlying.code, issuer: market.underlying.issuer },
          sign: (xdr) => outsider.sign(xdr, manifest.networkPassphrase, account),
        }),
      nothingLanded: async () => {
        const a = await accountState(account)
        return a.trustline.status === "live" && a.trustline.value === "none"
      },
      log,
    })
    compliance.trustlineHash = trustlineHash
    landed.push({ step: "the outsider's trustline", account: "outsider", action: "changeTrust", kind: null, hash: trustlineHash })
    await eventually(() => accountState(account), (a) => a.trustline.status === "live" && a.trustline.value === "unauthorized", "the outsider's trustline on Horizon")
    const trusted = await gatesFor(account, draft)
    expect(compliant(trusted.blockers), "trustline, not onboarded").toEqual([
      {
        code: "compliance",
        message: "Blocked by the issuer: your trustline exists but is not authorized. On Testnet, Get test tokens asks the issuer to authorize it.",
        fix: "onboarding",
      },
      { code: "compliance", message: "Principal permissioning: your account is not allowed yet. Get test tokens grants it on Testnet.", fix: "onboarding" },
    ])
    // The gates are the app's; the contracts refuse the same deposit on their own.
    expect(trusted.simulation.ok, `the deposit simulated as the outsider: ${json(trusted.simulation)}`).toBe(false)
    expect(trusted.simulation).toMatchObject({ ok: false, kind: "contract_error" })
    compliance.refusals.push({ state: "trustline added, not onboarded (no Get test tokens)", reasons: compliant(trusted.blockers), simulation: trusted.simulation })

    // A PT transfer to it is refused by the contracts too: the recipient is not allowed to hold PT.
    const toOutsider = await simulateInvocation({
      rpcUrl: manifest.rpcUrl,
      networkPassphrase: manifest.networkPassphrase,
      source: trader.publicKey,
      invocation: {
        contractId: market.contracts.pt,
        functionName: "transfer",
        args: [
          { type: "address", value: trader.publicKey },
          { type: "address", value: account },
          { type: "i128", value: U },
        ],
      },
    })
    expect(toOutsider, `a PT transfer to the outsider: ${json(toOutsider)}`).toMatchObject({ ok: false, kind: "contract_error" })
    compliance.transferToOutsider = toOutsider
    const show = (s: SimulationOutcome) => (s.ok ? "ok" : s.kind === "contract_error" ? `contract error #${s.code} from ${s.contractId}` : s.kind)
    log(
      `compliance: ${account} refused before its trustline (${compliant(bare.blockers).length} reasons, simulation ${show(bare.simulation)}) and after it ` +
        `(trustline tx ${trustlineHash}; ${compliant(trusted.blockers).length} reasons, simulation ${show(trusted.simulation)}); a PT transfer to it: ${show(toOutsider)}`,
    )
  }, 6 * MINUTE)
})

/** The flash's sizing (R5-2), from the reads the plan was made with: the budget in SY and the solver's `sy_in`. */
function flashSized(ms: MarketState, req: TradeRequest) {
  const s = curveStateFrom(ms)
  if (!s) throw new Error("no pool state")
  const exchangeRate = live(ms.exchangeRate, "exchange rate")
  const budgetSy = req.pay === "underlying" ? previewDeposit(req.amount, exchangeRate) : req.amount
  const target = (budgetSy * BPS) / (BPS + SLIPPAGE_BPS)
  const solution = solveBuyYt(s, { spendSy: target, oracleRate: live(ms.oracleRate, "oracle"), tokenizationFeeBps: live(ms.fees.tokenizationBps, "fee") })
  if ("error" in solution) throw new Error(solution.error)
  return { exchangeRate, budgetSy, syIn: solution.syIn }
}
