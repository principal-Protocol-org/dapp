// @vitest-environment node
/**
 * Every route of spec 0002 §4 end to end on the local USDY market (Task 24, ruling R2-68; plan 0004
 * Task 8; plan 0005 Task 5), through the pipeline the app runs: the trade adapter plans the route
 * (`currentContractsAdapter.plan`, with the slippage tolerance as `useTradeRoute` passes it)
 * and quotes it, `useTradeRoute`'s checks before the start pass, then each step is resolved from the
 * real outputs of the steps before it, simulated as the user, gated, given floors from its own
 * simulation, reviewed and signed (`route-runner.ts`). A fresh keypair, onboarded through the real
 * faucet, signs in Freighter's place.
 *
 * The manifest lists the Router functions of principal 665bb67 (R5-1), so:
 * - One step each: Buy PT paid in USDY (`swap_underlying_for_pt`), Sell PT and Sell YT to USDY
 *   (`swap_pt_for_underlying`, `swap_yt_for_underlying`), Keep YT (`add_liquidity_keep_yt`, minting
 *   the SY the dApp sized, R4-4, with the desired PT and SY, R5-7), LP only paid in USDY
 *   (`add_liquidity_single_underlying`, signing the `sy_in` its deposit gives, R5-5) and LP Withdraw
 *   to USDY (`remove_liquidity_to_underlying`, R5-6).
 * - Buy YT is the flash swap for either payer (R5-2): `flash_mint_yt` and
 *   `flash_mint_yt_from_underlying`, the amount typed being the budget, signed with R5-3's bound. A
 *   budget of exactly the simulated cost completes with nothing back.
 * - The Router sweeps by gain (R5-4): from the deposit on, the account holds stray PT and SY before
 *   every one-step flow, and a direct balance read after it shows them untouched, plus only the
 *   flow's own result; the route's holdings count that result alone (Review Focus 1 and 3).
 * - LP only paid in SY (R4-7: the pool takes `sy_in` up front and refunds the rest; R47 is lifted):
 *   one step, signed after a user's approval time; the PT the zap does not add stays in the pool (R5-5).
 * - In SY: Buy and Sell PT. The implied rate falls on a buy and rises on a sale (R2-15), checked on
 *   the pool's reserves at one point in time.
 * - Quick actions: deposit, split, recombine (to SY, as the dialog does, and to USDY, as the route).
 * - LP Withdraw to SY.
 * - Interruption: on a manifest that does not list `add_liquidity_single_underlying`, an LP only paid
 *   in USDY stopped after its deposit is turned back into USDY by the unwind plan (`unwindFrom`, as
 *   `useRoute.unwind` builds it), which leaves the SY held before alone.
 * - History: every transaction the suite signed is listed once, with its kind; the one-transaction
 *   trades as R4-10 and R5-9 classify them.
 *
 * Matured routes (redeem, the matured LP withdraw) cannot run here: this market matures in hours.
 * The unit tests cover them (routes, trade adapter).
 *
 * The market is the developer's (R2-68): nothing is redeployed and local.json is not rewritten. Trades
 * are small; the oracle is ticked only when stale or about to be. Before and after the run the pool,
 * the fees, the oracle and the treasury are logged, so every state change can be reported.
 * Skipped unless `config/manifests/local.json` is a local manifest whose RPC answers.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Address, Transaction, scValToNative, type xdr } from "@stellar/stellar-sdk"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// The faucet (local-stack's onboarding) is `server-only`; that guard throws outside a react-server bundle.
vi.mock("server-only", () => ({}))

import { fetchAccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import type { ActionInput } from "@/lib/protocol/actions"
import { impliedRate, curveStateFrom, type CurveState } from "@/lib/protocol/curve"
import { fetchAccountHistory } from "@/lib/protocol/events"
import { type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { validateManifest } from "@/lib/protocol/manifest"
import { fetchMarketState, type MarketState, type PoolStateView } from "@/lib/protocol/market-state"
import { BPS, ceilDiv, SCALE } from "@/lib/protocol/math"
import { previewDeposit, previewWithdraw } from "@/lib/protocol/previews"
import { createRpcReader, readLive, toBigint } from "@/lib/protocol/reader"
import { describeHoldings, planRoute, routeHoldings, unwindFrom, type Holdings, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import { currentContractsAdapter, toRouteRequest, type PlanContext, type TradeQuote, type TradeRequest } from "@/lib/protocol/trade-adapter"
import type { Finding, Live, Manifest, Market } from "@/lib/protocol/types"
import { solveBuyYt } from "@/lib/protocol/yt-solver"
import type { KeypairSigner } from "./keypair-signer"
import {
  balancesOf,
  complianceKind,
  createLog,
  HISTORY_KIND,
  json,
  ledgerClock,
  MINUTE,
  onboardFreshAccount,
  oracleTick,
  readManifest,
  runwaySeconds,
  showBalances,
  skipReason,
  sleep,
  U,
  units,
  type Balances,
} from "./local-stack"
import { createRunner, SLIPPAGE_BPS, type Runner, type Snapshot, type StepRecord } from "./route-runner"

/** The run takes minutes; below this much life left the suite skips (R2-68: it never redeploys). */
const MIN_RUNWAY_SECONDS = 1_800

/** Why the deployed market is too close to maturity for this suite, or null. */
async function runwayReason(): Promise<string | null> {
  const runway = await runwaySeconds(readManifest())
  if (runway >= MIN_RUNWAY_SECONDS) return null
  const when = runway > 0 ? `matures in ${Math.floor(runway / 60)} min` : "has matured"
  return `the local market ${when}; redeploy a fresh market to run the routes suite (it needs ${MIN_RUNWAY_SECONDS / 60} min)`
}

const down = await skipReason()
const skip = down ?? (await runwayReason())
if (down) console.info(`[routes] skipped: ${down}. Start it with scripts/dev-stack/up.sh.`)
else if (skip) console.info(`[routes] skipped: ${skip}.`)

const out = createLog("routes")
const log = out.log
/** The oracle is stale after 3,600 s; it is ticked when older than this, so it stays fresh for the run. */
const TICK_AFTER_SECONDS = 1_800
/** A user's approval time in Freighter, between preparation and submission (well inside the review window). */
const SIGNING_DELAY_MS = 5_000

/** The Router functions of principal 665bb67 this suite signs in one transaction each (R5-1). */
const ONE_STEP_FUNCTIONS = [
  "swap_underlying_for_pt",
  "swap_pt_for_underlying",
  "swap_yt_for_underlying",
  "add_liquidity_keep_yt",
  "flash_mint_yt",
  "flash_mint_yt_from_underlying",
  "add_liquidity_single_underlying",
  "remove_liquidity_to_underlying",
]

/** The actions that sign those functions: a route of one of them is a one-transaction trade (R4-10, R5-9). */
const ONE_CALL: ActionInput["action"][] = [
  "buy_pt_underlying",
  "sell_pt_underlying",
  "sell_yt_underlying",
  "add_liquidity_keep_yt",
  "buy_yt_flash",
  "buy_yt_flash_underlying",
  "add_liquidity_underlying",
  "remove_liquidity_underlying",
]

/** Every balance a test account holds in this market. */
const TOKENS: (keyof Balances)[] = ["underlying", "sy", "pt", "yt", "lp"]

function live<T>(v: Live<T>, what: string): T {
  if (v.status !== "live") throw new Error(`${what}: ${v.error}`)
  return v.value
}

const parsePair = (raw: unknown): [bigint, bigint] => {
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error("accrued_fees did not return a pair")
  return [toBigint(raw[0]), toBigint(raw[1])]
}

const showPool = (p: PoolStateView) => `PT ${units(p.ptReserve)}, SY ${units(p.syReserve)}, LP ${units(p.totalLp)}, τ ${p.secondsToMaturity} s`

/** The fixed APR at `SCALE` of `after`'s reserves on `before`'s clock, exponent and oracle rate: the trade's own move. */
function rateMove(before: PoolStateView, after: PoolStateView): { before: bigint; after: bigint } {
  const at: CurveState = { ...before }
  return { before: impliedRate(at), after: impliedRate({ ...at, ptReserve: after.ptReserve, syReserve: after.syReserve, totalLp: after.totalLp }) }
}

/**
 * Every `SY.transfer` the signed authorization lets `account` make, as simulation recorded it
 * (Router → MarketPool → SY for `add_liquidity_single_sy`): R47 was the pool computing that amount
 * again at inclusion, so the signed one no longer matched.
 */
function signedSyTransfers(unsignedXdr: string, networkPassphrase: string, sy: string, account: string): bigint[] {
  const tx = new Transaction(unsignedXdr, networkPassphrase)
  const [operation] = tx.operations
  if (operation?.type !== "invokeHostFunction") throw new Error("not a contract call")
  const found: bigint[] = []
  const walk = (inv: xdr.SorobanAuthorizedInvocation) => {
    const fn = inv.function
    if (fn.type === "sorobanAuthorizedFunctionTypeContractFn" && fn.contractFn.functionName.toString() === "transfer") {
      const [from, , amount] = fn.contractFn.args.map((a) => scValToNative(a) as unknown)
      const contract = Address.fromScAddress(fn.contractFn.contractAddress).toString()
      if (contract === sy && from === account && typeof amount === "bigint") found.push(amount)
    }
    inv.subInvocations.forEach(walk)
  }
  for (const entry of operation.auth ?? []) walk(entry.rootInvocation)
  return found
}

type ChainState = {
  ledger: number
  pool: PoolStateView
  impliedRate: bigint
  ptPrice: bigint
  oracle: bigint
  oracleTs: bigint
  totalPt: bigint
  totalYt: bigint
  poolFees: [bigint, bigint]
  managerFees: [bigint, bigint]
  treasury: Balances
}

describe.skipIf(skip !== null)("every route on the local USDY market (Task 24; 0004 Task 8)", () => {
  let manifest: Manifest
  let market: Market
  let findings: Finding[]
  let kind: ComplianceKind
  let treasury: string
  let signer: KeypairSigner
  let r: Runner
  let start: ChainState
  let startBalances: Balances
  /** Every confirmed step, in the order it landed: the history check's list. */
  const sent: StepRecord[] = []
  /** The one-transaction trades, for the report. */
  const oneStep: { what: string; step: StepRecord }[] = []

  const reader = () => createRpcReader(manifest)

  async function chainState(): Promise<ChainState> {
    const [ms, poolFees, managerFees, acc] = await Promise.all([
      fetchMarketState(reader(), manifest, market.marketId),
      readLive(reader(), { contractId: market.contracts.pool, functionName: "accrued_fees" }, parsePair),
      readLive(reader(), { contractId: market.contracts.manager, functionName: "accrued_fees" }, parsePair),
      fetchAccountState(reader(), createHorizon(manifest.horizonUrl), manifest, market.marketId, treasury, kind),
    ])
    const pool = live(ms.poolState, "pool state")
    return {
      ledger: ms.poolState.status === "live" ? ms.poolState.ledger : 0,
      pool,
      impliedRate: live(ms.impliedRate, "implied rate"),
      ptPrice: live(ms.ptPrice, "PT price"),
      oracle: live(ms.oracleRate, "oracle rate"),
      oracleTs: live(ms.oracleTimestamp, "oracle timestamp"),
      totalPt: live(ms.totalPt, "PT supply"),
      totalYt: live(ms.totalYt, "YT supply"),
      poolFees: live(poolFees, "pool fees"),
      managerFees: live(managerFees, "manager fees"),
      treasury: balancesOf(acc),
    }
  }

  const showState = (s: ChainState) =>
    `ledger ${s.ledger}: pool ${showPool(s.pool)}; implied_rate ${s.impliedRate} (APR ${(Number(s.impliedRate) / 1e5).toFixed(4)} %), pt_price ${s.ptPrice}; ` +
    `oracle ${s.oracle} @ ${s.oracleTs}; supply PT ${units(s.totalPt)}, YT ${units(s.totalYt)}; ` +
    `fees pool ${s.poolFees.join("/")} manager ${s.managerFees.join("/")} (protocol/creator, SY raw); treasury ${showBalances(s.treasury)}`

  /**
   * `useTradeRoute`'s plan context: the manifest alone decides a one-step route (R5-4), and the plan
   * sizes with the slippage the quote uses (R5-2).
   */
  const planCtx = (s: Snapshot): PlanContext => ({
    marketId: market.marketId,
    source: r.account,
    matured: false,
    routerFunctions: manifest.routerFunctions ?? [],
    slippageBps: SLIPPAGE_BPS,
    ms: s.ms,
  })

  type TradeRun = {
    request: RouteRequest
    plans: StepPlan[]
    quote: TradeQuote
    /** Step 1 as `useTradeRoute` simulated it before the start: what the quote's exact figures come from. */
    firstOutput?: ActionOutput
    steps: StepRecord[]
    outputs: ActionOutput[]
    pool0: PoolStateView
    pool1: PoolStateView
    bal0: Balances
    bal1: Balances
    rate: { before: bigint; after: bigint }
    onChain: { before: bigint; after: bigint }
  }

  /**
   * A trade as the tab runs it: planned and quoted by the adapter, checked before the start as
   * `useTradeRoute` does, then every step in order (by `runner`, `r` unless said). Returns what it moved.
   */
  async function trade(
    req: TradeRequest,
    expectActions: ActionInput["action"][],
    expectPlan?: (plans: StepPlan[], s: Snapshot) => void,
    runner: Runner = r,
  ): Promise<TradeRun> {
    const s0 = await runner.snapshot()
    const ctx = planCtx(s0)
    const planned = currentContractsAdapter.plan(req, ctx)
    if (!Array.isArray(planned)) throw new Error(`${req.kind}: not offered: ${planned.disabled}`)
    expect(planned.map((p) => p.action), `${req.kind} route`).toEqual(expectActions)
    expectPlan?.(planned, s0)
    const request = toRouteRequest(req, ctx)
    const pre = await runner.preStart(request, planned)
    expect(pre.blockers, `${req.kind}: refusals before the start`).toEqual([])
    const lp = s0.acc.lp.status === "live" ? { heldLp: s0.acc.lp.value } : {}
    const firstStep = pre.firstOutput ? { firstStep: { action: planned[0].action, output: pre.firstOutput } } : {}
    const quoted = currentContractsAdapter.quote(req, { ms: s0.ms, slippageBps: SLIPPAGE_BPS, plans: planned, ...lp, ...firstStep })
    if (quoted.status !== "live") throw new Error(`${req.kind}: quote unavailable: ${quoted.error}`)
    const quote = quoted.value
    const pool0 = live(s0.ms.poolState, "pool state")
    const { outputs, steps } = await runner.runRoute(request, planned)
    const s1 = await runner.snapshot()
    const pool1 = live(s1.ms.poolState, "pool state")
    const run: TradeRun = {
      request,
      plans: planned,
      quote,
      ...(pre.firstOutput ? { firstOutput: pre.firstOutput } : {}),
      steps,
      outputs,
      pool0,
      pool1,
      bal0: balancesOf(s0.acc),
      bal1: balancesOf(s1.acc),
      rate: rateMove(pool0, pool1),
      onChain: { before: live(s0.ms.impliedRate, "implied rate"), after: live(s1.ms.impliedRate, "implied rate") },
    }
    log(
      `${req.kind} ${units(req.amount)} (pay ${req.pay}, receive ${req.receive}): quote out ${units(quote.out)} ${quote.outToken} (${quote.exactness}), ` +
        `APY ${quote.apyBefore?.toFixed(6)} -> ${quote.apyAfter?.toFixed(6)}; pool ${showPool(pool0)} -> ${showPool(pool1)}; ` +
        `implied APR (same clock) ${run.rate.before} -> ${run.rate.after}, on-chain implied_rate ${run.onChain.before} -> ${run.onChain.after}; ` +
        `account ${showBalances(run.bal1)}`,
    )
    if (planned.length === 1 && ONE_CALL.includes(planned[0].action)) {
      oneStep.push({ what: `${req.kind} (${planned[0].action})`, step: steps[0] })
    }
    return run
  }

  const delta = (t: TradeRun, k: keyof Balances) => t.bal1[k] - t.bal0[k]
  const value = (o: ActionOutput) => {
    if (o.kind !== "amount") throw new Error(`expected an amount, got ${o.kind}`)
    return o.value
  }

  /**
   * Review Focus 1 and 3 (R5-4: the Router sweeps by gain). Before the flow the account holds stray PT
   * and SY; after it, a direct balance read shows every balance moved by exactly `moves`, the flow's own
   * result, and by nothing else (a token not named did not move); and the route's holdings
   * (`routeHoldings`, what the progress panel and the unwind work from) are what the flow received,
   * never the balances held before.
   */
  function expectOwnResult(t: TradeRun, moves: Partial<Balances>, label: string): void {
    expect(t.bal0.pt > 0n && t.bal0.sy > 0n, `${label}: the account holds stray PT (${t.bal0.pt}) and SY (${t.bal0.sy}) before`).toBe(true)
    for (const k of TOKENS) expect(delta(t, k), `${label}: ${k} moved`).toBe(moves[k] ?? 0n)
    const received: Holdings = {}
    for (const k of TOKENS) if ((moves[k] ?? 0n) > 0n) received[k] = moves[k]
    expect(routeHoldings(t.request, t.plans, t.outputs, t.plans.length), `${label}: the route's holdings`).toEqual(received)
    log(`${label}: held before ${showBalances(t.bal0)}; moved only ${TOKENS.filter((k) => moves[k]).map((k) => `${k} ${units(moves[k]!)}`).join(", ")}`)
  }

  /** `|got − want|` within the slippage setting of `want`: a figure quoted before the start against what landed. */
  const nearQuote = (got: bigint, want: bigint, what: string) => {
    const tolerance = ceilDiv((want < 0n ? -want : want) * SLIPPAGE_BPS, BPS)
    const diff = got - want
    expect(diff <= tolerance && -diff <= tolerance, `${what}: landed ${got} vs quoted ${want} (±${tolerance})`).toBe(true)
  }

  beforeAll(async () => {
    manifest = readManifest()
    market = manifest.markets[0]
    findings = validateManifest(manifest)
    expect(findings.filter((f) => f.severity === "error")).toEqual([])
    treasury = (await promisify(execFile)("stellar", ["keys", "address", "principal-localdev-treasury"])).stdout.trim()

    // R2-68: the developer's market is used as it is, never redeployed (too close to maturity, the
    // suite skips above). An oracle that cannot be ticked or an empty pool stops the run.
    const clock = await ledgerClock(manifest)
    const ms0 = await fetchMarketState(reader(), manifest, market.marketId)
    const age = clock.closeTime - Number(live(ms0.oracleTimestamp, "oracle timestamp"))
    if (age > TICK_AFTER_SECONDS) log(`oracle last set ${age} s ago: ${await oracleTick()}`)
    else log(`oracle last set ${age} s ago: not ticked`)
    const ms = await fetchMarketState(reader(), manifest, market.marketId)
    if (live(ms.oracleFresh, "oracle freshness") !== true) throw new Error("NEEDS_CONTEXT: the oracle is still stale after a tick")
    if (live(ms.poolSeeded, "pool seeded") !== true) throw new Error("NEEDS_CONTEXT: the pool is empty")
    for (const fn of ONE_STEP_FUNCTIONS) {
      if (!(manifest.routerFunctions ?? []).includes(fn)) throw new Error(`NEEDS_CONTEXT: local.json does not list ${fn}; deploy the market from principal 665bb67`)
    }

    kind = await complianceKind(manifest, market)
    start = await chainState()
    log(`before: ${showState(start)}`)
    signer = await onboardFreshAccount(manifest, market, kind)
    r = createRunner({ manifest, market, findings, kind, signer, log, record: (s) => sent.push(s) })
    startBalances = balancesOf((await r.snapshot()).acc)
    log(`test account ${r.account} onboarded (Friendbot, trustline, faucet): ${showBalances(startBalances)}`)
  }, 5 * MINUTE)

  afterAll(async () => {
    if (start && r) {
      const end = await chainState()
      const acc = balancesOf((await r.snapshot()).acc)
      log(`after: ${showState(end)}`)
      log(`test account ${r.account}: ${showBalances(startBalances)} -> ${showBalances(acc)}`)
      log(
        `pool change: PT ${units(end.pool.ptReserve - start.pool.ptReserve)}, SY ${units(end.pool.syReserve - start.pool.syReserve)}, ` +
          `LP ${units(end.pool.totalLp - start.pool.totalLp)}; implied_rate ${start.impliedRate} -> ${end.impliedRate}; ` +
          `treasury ${(Object.keys(end.treasury) as (keyof Balances)[]).map((k) => `${k} ${units(end.treasury[k] - start.treasury[k])}`).join(", ")}`,
      )
      for (const o of oneStep) log(`one transaction: ${o.what}: tx ${o.step.hash}`)
    }
    out.summary()
  }, 2 * MINUTE)

  // --- Setup: stray PT and SY, then one transaction each ---

  it("Buy PT with USDY: one transaction (swap_underlying_for_pt); the implied rate falls", async () => {
    const t = await trade({ kind: "buy_pt", amount: 300n * U, pay: "underlying", receive: "underlying" }, ["buy_pt_underlying"])
    const [buy] = t.steps
    expect(buy.amount).toBe(300n * U)
    expect(delta(t, "underlying")).toBe(-300n * U)
    // The deposit's SY is all spent inside the same transaction.
    expect(delta(t, "sy")).toBe(0n)
    expect(delta(t, "pt")).toBe(value(buy.decoded))
    expect(t.quote.exactness).toBe("simulated")
    expect(t.pool1.ptReserve < t.pool0.ptReserve && t.pool1.syReserve > t.pool0.syReserve).toBe(true)
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    expect(t.quote.apyAfter! < t.quote.apyBefore!).toBe(true)
  }, 3 * MINUTE)

  it("Quick action deposit: USDY to SY; from here on the account holds stray PT and SY", async () => {
    const before = balancesOf((await r.snapshot()).acc)
    const dep = await r.runAction("deposit", 2_500n * U)
    const after = balancesOf((await r.snapshot()).acc)
    expect(after.underlying - before.underlying).toBe(-2_500n * U)
    expect(after.sy - before.sy).toBe(value(dep.decoded))
    expect(after.pt > 0n && after.sy > 0n).toBe(true)
  }, 2 * MINUTE)

  /**
   * The flash's sizing (R5-2), from the reads the plan was made with: the budget in SY, and the
   * solver's `sy_in` for a net cost of at most `budgetSy · BPS / (BPS + slippage)`.
   */
  function flashSized(ms: MarketState, req: TradeRequest) {
    const s = curveStateFrom(ms)
    if (!s) throw new Error("no pool state")
    const exchangeRate = live(ms.exchangeRate, "exchange rate")
    const budgetSy = req.pay === "underlying" ? previewDeposit(req.amount, exchangeRate) : req.amount
    const target = (budgetSy * BPS) / (BPS + SLIPPAGE_BPS)
    const solution = solveBuyYt(s, { spendSy: target, oracleRate: live(ms.oracleRate, "oracle"), tokenizationFeeBps: live(ms.fees.tokenizationBps, "fee") })
    if ("error" in solution) throw new Error(solution.error)
    return { exchangeRate, budgetSy, target, syIn: solution.syIn }
  }

  /** The flash route's plan: the budget is the input and the `sy_in` the one sized from the same reads (R5-2). */
  function expectFlashPlan(plans: StepPlan[], s: Snapshot, req: TradeRequest) {
    const sized = flashSized(s.ms, req)
    expect(plans[0].amount).toEqual({ from: "input" })
    expect(plans[0].secondaryAmount).toEqual({ from: "value", value: sized.syIn })
    // The flash mints far more than it spends: the pool's own SY funds the mint.
    expect(sized.syIn > sized.budgetSy).toBe(true)
    return sized
  }

  it("Buy YT with USDY: one flash (flash_mint_yt_from_underlying) spending at most the budget, the rest back as USDY; the PT and SY held before are untouched; the rate rises", async () => {
    const req: TradeRequest = { kind: "buy_yt", amount: 5_000_000n, pay: "underlying", receive: "underlying" }
    let sized = { exchangeRate: 0n, budgetSy: 0n, target: 0n, syIn: 0n }
    const t = await trade(req, ["buy_yt_flash_underlying"], (plans, s) => {
      sized = expectFlashPlan(plans, s, req)
    })
    const [buy] = t.steps
    if (buy.decoded.kind !== "flash_yt_underlying") throw new Error("not a flash_yt_underlying output")
    const { yt_out, net_cost, underlying_back } = buy.decoded
    const xr = sized.exchangeRate
    expect(buy.amount).toBe(req.amount)
    expect(buy.secondaryAmount).toBe(sized.syIn)
    // R5-3: the pool pulls max_net_cost up front, capped at the budget's SY; the cost is within it.
    const max = buy.guards.maxNetCost!
    expect(max <= sized.budgetSy, `max_net_cost ${max} vs budget ${sized.budgetSy} SY`).toBe(true)
    expect(net_cost <= max, `net cost ${net_cost} vs max_net_cost ${max}`).toBe(true)
    // min_underlying_back follows from the signed bound (the one floor that may be 0, R5-3).
    expect(buy.guards.minOut2).toBe(previewWithdraw(sized.budgetSy - max, xr))
    expect(underlying_back >= buy.guards.minOut2!).toBe(true)
    // The budget's SY not spent comes back as USDY in the same transaction, and nothing else is unwrapped.
    expect(underlying_back).toBe(previewWithdraw(sized.budgetSy - net_cost, xr))
    // Review Focus 1: not a unit of the SY (or PT) held before is spent.
    expectOwnResult(t, { underlying: underlying_back - req.amount, yt: yt_out }, "buy_yt (USDY flash)")
    expect(t.quote.exactness).toBe("simulated")
    expect(t.quote.capital, "a flash discloses no capital").toBeUndefined()
    expect(t.quote.maxCost).toBe(req.amount)
    expect(t.quote.flash?.budget).toBe(req.amount)
    nearQuote(underlying_back, t.quote.flash!.expectedBack, "USDY back")
    nearQuote(yt_out, t.quote.out, "YT")
    expect(t.pool1.ptReserve).toBe(t.pool0.ptReserve + yt_out)
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    expect(t.quote.apyAfter! > t.quote.apyBefore!).toBe(true)
    log(
      `buy_yt (USDY flash): budget ${units(req.amount)} USDY (${units(sized.budgetSy)} SY), sy_in ${units(sized.syIn)}, signed max_net_cost ${units(max)} and ` +
        `min_underlying_back ${units(buy.guards.minOut2!)}; net cost ${units(net_cost)} SY, ${units(underlying_back)} USDY back (quote ${units(t.quote.flash!.expectedBack)}), YT ${units(yt_out)}`,
    )
  }, 3 * MINUTE)

  it("Buy YT with SY: one flash (flash_mint_yt) spending exactly its net cost, within the budget, and not a unit of the SY beyond it; the rate rises", async () => {
    const req: TradeRequest = { kind: "buy_yt", amount: 5_000_000n, pay: "sy", receive: "underlying" }
    let sized = { exchangeRate: 0n, budgetSy: 0n, target: 0n, syIn: 0n }
    const t = await trade(req, ["buy_yt_flash"], (plans, s) => {
      sized = expectFlashPlan(plans, s, req)
    })
    const [buy] = t.steps
    if (buy.decoded.kind !== "flash_yt") throw new Error("not a flash_yt output")
    const { yt_out, net_cost } = buy.decoded
    expect(buy.amount).toBe(req.amount)
    expect(buy.secondaryAmount).toBe(sized.syIn)
    // The wallet holds more SY than the budget: the pool pulls max_net_cost (at most the budget, R5-3)
    // and refunds what the flash did not cost, so the SY beyond the budget is never in play.
    expect(t.bal0.sy > req.amount, `SY held ${t.bal0.sy} vs budget ${req.amount}`).toBe(true)
    const max = buy.guards.maxNetCost!
    expect(max <= req.amount, `max_net_cost ${max} vs budget ${req.amount}`).toBe(true)
    expect(net_cost <= max, `net cost ${net_cost} vs max_net_cost ${max}`).toBe(true)
    // R5-2: the cost with the slippage margin fits the budget.
    expect(ceilDiv(net_cost * (BPS + SLIPPAGE_BPS), BPS) <= req.amount, `net cost ${net_cost} with the margin vs budget ${req.amount}`).toBe(true)
    // Review Focus 1: exactly the net cost leaves the wallet.
    expectOwnResult(t, { sy: -net_cost, yt: yt_out }, "buy_yt (SY flash)")
    expect(t.quote.exactness).toBe("simulated")
    expect(t.quote.capital, "a flash discloses no capital").toBeUndefined()
    expect(t.quote.maxCost).toBe(req.amount)
    nearQuote(net_cost, t.quote.flash!.expectedCost, "SY cost")
    expect(t.pool1.ptReserve).toBe(t.pool0.ptReserve + yt_out)
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    expect(t.quote.apyAfter! > t.quote.apyBefore!).toBe(true)
    log(
      `buy_yt (SY flash): budget ${units(req.amount)} SY, target cost ${units(sized.target)}, sy_in ${units(sized.syIn)} (${Number(sized.syIn / req.amount)}x), ` +
        `signed max_net_cost ${units(max)}; net cost ${units(net_cost)} SY (quote ${units(t.quote.flash!.expectedCost)}), YT ${units(yt_out)}`,
    )
  }, 3 * MINUTE)

  it("A flash budget of exactly the simulated cost completes with nothing back, for either payer (R5-3: max_net_cost is the whole budget)", async () => {
    // The app always sizes the cost below the budget (R5-2), so this budget is set by hand: the net
    // cost of a fixed sy_in, simulated as the user. The cost falls a little with time (the PT nears
    // par), so a large flash would get a few raw units back by inclusion; this one (0.1 SY) is small
    // enough that it does not move in the seconds between the simulation and the ledger.
    const syIn = U / 10n
    for (const pay of ["underlying", "sy"] as const) {
      const action = pay === "sy" ? "buy_yt_flash" : "buy_yt_flash_underlying"
      const name = `buy_yt exact budget (${pay})`
      const plans: StepPlan[] = [{ action, amount: { from: "input" }, secondaryAmount: { from: "value", value: syIn }, gives: pay === "sy" ? "SY" : "USDY", takes: "YT" }]
      const request = (amount: bigint): RouteRequest => ({ kind: "buy_yt", marketId: market.marketId, source: r.account, amount, pay, receive: "underlying", matured: false })
      // A budget of sy_in itself always covers the cost while the PT is below par.
      const probe = await r.preStart(request(syIn), plans)
      expect(probe.blockers, `${name}: refusals before the start`).toEqual([])
      const first = probe.firstOutput
      if (first?.kind !== "flash_yt" && first?.kind !== "flash_yt_underlying") throw new Error(`${name}: no simulated flash: ${json(first)}`)
      const cost = first.net_cost
      const s0 = await r.snapshot()
      const xr = live(s0.ms.exchangeRate, "exchange rate")
      const budget = pay === "sy" ? cost : ceilDiv(cost * xr, SCALE)
      if (pay === "underlying") expect(previewDeposit(budget, xr), `${name}: a USDY budget whose deposit is exactly the cost`).toBe(cost)
      const b0 = balancesOf(s0.acc)
      expect(b0.pt > 0n && b0.sy > cost, `${name}: stray PT and SY held before`).toBe(true)
      const { steps } = await r.runRoute(request(budget), plans, { name })
      const [buy] = steps
      const b1 = balancesOf((await r.snapshot()).acc)
      if (buy.decoded.kind !== "flash_yt" && buy.decoded.kind !== "flash_yt_underlying") throw new Error(`${name}: not a flash output`)
      // The margin would pass the budget, so the cap binds: the whole budget is the bound (R5-3).
      expect(buy.guards.maxNetCost).toBe(cost)
      // The cost did not move between the simulation and the ledger: the budget is spent to the unit.
      expect(buy.decoded.net_cost, `${name}: net cost vs the budget's SY`).toBe(cost)
      const moved: Balances = { underlying: 0n, sy: 0n, pt: 0n, yt: buy.decoded.yt_out, lp: 0n }
      if (buy.decoded.kind === "flash_yt_underlying") {
        // The one zero floor allowed, and the contract's withdraw of a zero gain (9509529).
        expect(buy.guards.minOut2).toBe(0n)
        expect(buy.decoded.underlying_back, `${name}: USDY back`).toBe(0n)
        moved.underlying = -budget
      } else {
        moved.sy = -cost
      }
      for (const k of TOKENS) expect(b1[k] - b0[k], `${name}: ${k} moved`).toBe(moved[k])
      log(
        `${name}: sy_in ${units(syIn)}, simulated cost ${cost} raw SY, budget ${budget} raw ${pay === "sy" ? "SY" : "USDY"}; signed max_net_cost ${String(buy.guards.maxNetCost)}` +
          `${pay === "underlying" ? `, min_underlying_back ${String(buy.guards.minOut2)}` : ""}; tx ${buy.hash.slice(0, 12)} net cost ${buy.decoded.net_cost}, ` +
          `${buy.decoded.kind === "flash_yt_underlying" ? `USDY back ${buy.decoded.underlying_back}` : "SY refunded 0"}, YT ${units(buy.decoded.yt_out)}`,
      )
    }
  }, 4 * MINUTE)

  it("Sell PT for USDY: one transaction (swap_pt_for_underlying) withdrawing only the sale's SY; the SY held before is untouched; the implied rate rises", async () => {
    const t = await trade({ kind: "sell_pt", amount: 100n * U, pay: "underlying", receive: "underlying" }, ["sell_pt_underlying"])
    const [sell] = t.steps
    expectOwnResult(t, { pt: -100n * U, underlying: value(sell.decoded) }, "sell_pt (USDY)")
    expect(t.quote.exactness).toBe("simulated")
    expect(t.pool1.ptReserve).toBe(t.pool0.ptReserve + 100n * U)
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
  }, 3 * MINUTE)

  it("Sell YT for USDY: one transaction (swap_yt_for_underlying) withdrawing only the sale's SY; the PT and SY held before are untouched; the pool buys its PT back, so the rate falls", async () => {
    const yt = balancesOf((await r.snapshot()).acc).yt / 2n
    expect(yt > 0n, "YT from the flash buys above").toBe(true)
    const t = await trade({ kind: "sell_yt", amount: yt, pay: "underlying", receive: "underlying" }, ["sell_yt_underlying"])
    const [sell] = t.steps
    expectOwnResult(t, { yt: -yt, underlying: value(sell.decoded) }, "sell_yt (USDY)")
    expect(t.quote.exactness).toBe("simulated")
    expect(t.pool1.ptReserve).toBe(t.pool0.ptReserve - yt)
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
  }, 3 * MINUTE)

  it("LP Keep YT: one transaction (add_liquidity_keep_yt) minting the SY the dApp sized (R4-4); LP and YT received, no swap; the PT and SY held before are untouched", async () => {
    const req: TradeRequest = { kind: "lp_keep_yt", amount: 300n * U, pay: "underlying", receive: "underlying" }
    let shares = 0n
    let mint = 0n
    const t = await trade(req, ["add_liquidity_keep_yt"], (plans, s) => {
      shares = previewDeposit(req.amount, live(s.ms.exchangeRate, "exchange rate"))
      const m = plans[0].secondaryAmount
      if (m?.from !== "value") throw new Error(`mint_amount is not a sized value: ${json(m)}`)
      mint = m.value
      expect(plans[0].amount).toEqual({ from: "input" })
      // Review Focus 5: the Router adds shares − mint SY, so the mint stays below the deposit's shares.
      expect(mint >= 1n && mint < shares, `mint ${mint} of ${shares} shares`).toBe(true)
    })
    const [keep] = t.steps
    if (keep.decoded.kind !== "keep_yt") throw new Error("not a keep_yt output")
    expect(keep.amount).toBe(req.amount)
    expect(keep.secondaryAmount).toBe(mint)
    // What the pool did not take stays in the wallet: PT minted 1:1 with YT, less what was added;
    // the deposit's shares, less the mint and the SY added (R5-7).
    const leftPt = keep.decoded.yt_minted - keep.decoded.pt_used
    const leftSy = shares - mint - keep.decoded.sy_used
    expect(leftPt >= 0n && leftSy >= 0n && leftPt + leftSy <= 10n, `left ${leftPt} PT, ${leftSy} SY`).toBe(true)
    expectOwnResult(t, { underlying: -req.amount, pt: leftPt, sy: leftSy, yt: keep.decoded.yt_minted, lp: keep.decoded.lp }, "lp_keep_yt")
    // R4-4's sizing uses up the SY side when it can: what the pool does not take is PT, if anything.
    expect(leftSy, "SY left by the one-step Keep YT").toBe(0n)
    expect(t.quote.leftover?.filter((l) => l.token === "sy")).toEqual([])
    expect(t.quote.priceImpactPpm).toBe(0n)
    expect(t.quote.alsoOut?.amount).toBe(keep.decoded.yt_minted)
    log(`lp_keep_yt (one step): ${units(req.amount)} USDY -> ${units(shares)} SY, ${units(mint)} SY minted; LP ${units(keep.decoded.lp)}, YT kept ${units(keep.decoded.yt_minted)}; left ${leftPt} PT + ${leftSy} SY raw`)
  }, 3 * MINUTE)

  it("LP only paid in USDY: one transaction (add_liquidity_single_underlying) signing the sy_in its deposit gives (R5-5); the pool's SY refund stays as SY, the PT and SY held before are untouched", async () => {
    const req: TradeRequest = { kind: "lp_only", amount: 200n * U, pay: "underlying", receive: "underlying" }
    let syIn = 0n
    const t = await trade(req, ["add_liquidity_underlying"], (plans, s) => {
      syIn = previewDeposit(req.amount, live(s.ms.exchangeRate, "exchange rate"))
      expect(plans[0].amount).toEqual({ from: "input" })
      expect(plans[0].secondaryAmount).toEqual({ from: "value", value: syIn })
    })
    const [add] = t.steps
    if (add.decoded.kind !== "add_liquidity") throw new Error("not an add_liquidity output")
    expect(add.amount).toBe(req.amount)
    expect(add.secondaryAmount).toBe(syIn)
    // sy_used is what the pool kept (the zap's swap and the SY added); the rest of sy_in came back.
    const refund = syIn - add.decoded.sy_used
    expect(refund >= 0n, `sy_used ${add.decoded.sy_used} of sy_in ${syIn}`).toBe(true)
    // R5-5: the PT the zap bought and did not add stays in the pool's reserve, so no PT moves.
    expectOwnResult(t, { underlying: -req.amount, sy: refund, lp: add.decoded.lp }, "lp_only (USDY)")
    // The figures R2-64 owes, exact from the simulation before the start.
    if (t.firstOutput?.kind !== "add_liquidity") throw new Error("no simulated add before the start")
    expect(t.quote.exactness).toBe("simulated")
    expect(t.quote.out).toBe(t.firstOutput.lp)
    const quotedRefund = syIn - t.firstOutput.sy_used
    expect(t.quote.leftover).toEqual(quotedRefund > 0n ? [{ amount: quotedRefund, token: "sy" }] : [])
    expect(t.quote.feeToken).toBe("underlying")
    expect(t.quote.apyAfter! < t.quote.apyBefore!).toBe(true)
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    log(
      `lp_only (USDY, one step): ${units(req.amount)} USDY -> sy_in ${units(syIn)} signed; LP ${units(add.decoded.lp)} (quote ${units(t.quote.out)}), ` +
        `kept ${units(add.decoded.sy_used)} SY, refunded ${units(refund)} SY (quote ${json(t.quote.leftover)})`,
    )
  }, 3 * MINUTE)

  // --- In SY ---

  it("Sell PT for SY: one swap; the implied rate rises", async () => {
    const t = await trade({ kind: "sell_pt", amount: 150n * U, pay: "underlying", receive: "sy" }, ["sell_pt"])
    expect(delta(t, "pt")).toBe(-150n * U)
    expect(delta(t, "sy")).toBe(value(t.steps[0].decoded))
    expect(t.pool1.ptReserve).toBe(t.pool0.ptReserve + 150n * U)
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    expect(t.quote.apyAfter! > t.quote.apyBefore!).toBe(true)
  }, 3 * MINUTE)

  it("Buy PT with SY: one swap; the implied rate falls", async () => {
    const t = await trade({ kind: "buy_pt", amount: 100n * U, pay: "sy", receive: "underlying" }, ["buy_pt"])
    expect(delta(t, "sy")).toBe(-100n * U)
    expect(delta(t, "pt")).toBe(value(t.steps[0].decoded))
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
  }, 3 * MINUTE)

  // --- LP only (Keep YT off), R4-7 ---

  it("LP only paid in SY: one add_liquidity_single_sy, signed after a user's approval time; the authorization pins sy_in and the pool refunds the rest", async () => {
    // R47 was the pool computing what it pulls again at inclusion, a few ledgers after the
    // simulation the authorization was recorded from. A signer that takes a user's time to approve,
    // and reads the SY transfer it authorizes.
    const authorized: bigint[][] = []
    const slow: KeypairSigner = {
      publicKey: signer.publicKey,
      async sign(unsignedXdr, passphrase, expected) {
        authorized.push(signedSyTransfers(unsignedXdr, passphrase, market.contracts.sy, signer.publicKey))
        await sleep(SIGNING_DELAY_MS)
        return signer.sign(unsignedXdr, passphrase, expected)
      },
    }
    const slowRunner = createRunner({ manifest, market, findings, kind, signer: slow, log, record: (s) => sent.push(s) })
    const req: TradeRequest = { kind: "lp_only", amount: 100n * U, pay: "sy", receive: "underlying" }
    const t = await trade(req, ["add_liquidity_sy"], undefined, slowRunner)
    const [add] = t.steps
    if (add.decoded.kind !== "add_liquidity") throw new Error("not an add_liquidity output")
    expect(add.amount).toBe(req.amount)
    // The one SY transfer the account authorized is sy_in itself, a fixed amount.
    expect(authorized).toEqual([[req.amount]])
    // sy_used is what the pool kept (split + sy_used); the rest came back in the same transaction.
    expect(add.decoded.sy_used <= req.amount).toBe(true)
    // R5-5: the PT the zap bought and the add did not use stays in the pool's reserve: no PT moves.
    expectOwnResult(t, { sy: -add.decoded.sy_used, lp: add.decoded.lp }, "lp_only (SY)")
    // The figures R2-64 owes: exact LP (the add is the first step, simulated before the start; the
    // step's own simulation, a ledger or two later, may differ by the curve's move), fee, impact, APY, share.
    expect(t.quote.exactness).toBe("simulated")
    expect(t.quote.out).toBe(t.firstOutput?.kind === "add_liquidity" ? t.firstOutput.lp : -1n)
    expect(t.quote.fee > 0n && (t.quote.priceImpactPpm ?? 0n) > 0n).toBe(true)
    expect(t.quote.apyAfter! < t.quote.apyBefore!).toBe(true)
    expect(t.quote.poolShare !== undefined && t.quote.poolShare.after > t.quote.poolShare.before).toBe(true)
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    log(
      `lp_only (SY, one step, signed ${SIGNING_DELAY_MS / 1000} s after its simulation): authorized SY.transfer ${units(authorized[0][0])}; LP ${units(add.decoded.lp)}, ` +
        `kept ${units(add.decoded.sy_used)} SY, refunded ${units(req.amount - add.decoded.sy_used)} SY; ` +
        `quote fee ${units(t.quote.fee)} SY, impact ${t.quote.priceImpactPpm} ppm, refunds ${json(t.quote.leftover)}`,
    )
  }, 3 * MINUTE)

  // --- Quick actions, LP withdraw, interruption ---

  it("Quick actions: split USDY into PT + YT, recombine to SY (the dialog) and to USDY (the route)", async () => {
    const routeFor = (kind: "split" | "recombine", amount: bigint, receive: "sy" | "underlying"): { req: RouteRequest; plans: StepPlan[] } => {
      const req: RouteRequest = { kind, marketId: market.marketId, source: r.account, amount, pay: "underlying", receive, matured: false }
      const plans = planRoute(req, { routerFunctions: manifest.routerFunctions ?? [] })
      if (!Array.isArray(plans)) throw new Error(plans.disabled)
      return { req, plans }
    }
    const b0 = balancesOf((await r.snapshot()).acc)
    const split = routeFor("split", 100n * U, "sy")
    expect(split.plans.map((p) => p.action)).toEqual(["mint"])
    const [mint] = (await r.runRoute(split.req, split.plans, { name: "split" })).steps
    if (mint.decoded.kind !== "mint") throw new Error("not a mint output")
    expect(mint.decoded.pt_minted).toBe(mint.decoded.yt_minted)
    const b1 = balancesOf((await r.snapshot()).acc)
    expect(b1.underlying - b0.underlying).toBe(-100n * U)
    expect(b1.pt - b0.pt).toBe(mint.decoded.pt_minted)
    expect(b1.yt - b0.yt).toBe(mint.decoded.yt_minted)

    const toSy = routeFor("recombine", 50n * U, "sy")
    expect(toSy.plans.map((p) => p.action)).toEqual(["recombine"])
    const [rec] = (await r.runRoute(toSy.req, toSy.plans, { name: "recombine (quick action, to SY)" })).steps
    const b2 = balancesOf((await r.snapshot()).acc)
    expect(b2.pt - b1.pt).toBe(-50n * U)
    expect(b2.yt - b1.yt).toBe(-50n * U)
    expect(b2.sy - b1.sy).toBe(value(rec.decoded))

    const toUsdy = routeFor("recombine", 40n * U, "underlying")
    expect(toUsdy.plans.map((p) => p.action)).toEqual(["recombine", "withdraw"])
    const steps = (await r.runRoute(toUsdy.req, toUsdy.plans, { name: "recombine (to USDY)" })).steps
    const b3 = balancesOf((await r.snapshot()).acc)
    expect(steps[1].amount).toBe(value(steps[0].decoded))
    expect(b3.sy - b2.sy).toBe(0n)
    expect(b3.underlying - b2.underlying).toBe(value(steps[1].decoded))
  }, 4 * MINUTE)

  it("LP Withdraw to USDY: one transaction (remove_liquidity_to_underlying, R5-6) selling and unwrapping only what the removal produced; the PT and SY held before are untouched; the rate rises", async () => {
    const lp = balancesOf((await r.snapshot()).acc).lp
    const half = lp / 2n
    const t = await trade({ kind: "lp_withdraw", amount: half, pay: "underlying", receive: "underlying" }, ["remove_liquidity_underlying"])
    const [exit] = t.steps
    expect(exit.amount).toBe(half)
    // Review Focus 3: the stray PT is not sold and the stray SY not unwrapped.
    expectOwnResult(t, { lp: -half, underlying: value(exit.decoded) }, "lp_withdraw (USDY)")
    // The one call's simulation before the start is the USDY the quote states.
    expect(t.quote.exactness).toBe("simulated")
    expect(t.quote.out).toBe(t.firstOutput ? value(t.firstOutput) : -1n)
    nearQuote(value(exit.decoded), t.quote.out, "USDY out")
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    log(`lp_withdraw (USDY, one step): ${units(half)} LP -> ${units(value(exit.decoded))} USDY (quote ${units(t.quote.out)}, signed floor ${units(exit.guards.minOut!)})`)
  }, 4 * MINUTE)

  it("LP Withdraw to SY: remove, then sell the PT", async () => {
    const lp = balancesOf((await r.snapshot()).acc).lp
    const t = await trade({ kind: "lp_withdraw", amount: lp, pay: "underlying", receive: "sy" }, ["remove_liquidity", "sell_pt"])
    const [remove, sell] = t.steps
    if (remove.decoded.kind !== "remove_liquidity") throw new Error("not a remove_liquidity output")
    expect(sell.amount).toBe(remove.decoded.pt)
    expect(t.bal1.lp).toBe(0n)
    expect(delta(t, "pt")).toBe(0n)
    expect(delta(t, "sy")).toBe(remove.decoded.sy + value(sell.decoded))
  }, 4 * MINUTE)

  it("An interrupted LP only paid in USDY on a manifest without add_liquidity_single_underlying (deposit done, add not signed) is turned back into USDY by the unwind plan; the SY held before stays", async () => {
    const s0 = await r.snapshot()
    const b0 = balancesOf(s0.acc)
    expect(b0.sy > 0n, "stray SY held before").toBe(true)
    const req: TradeRequest = { kind: "lp_only", amount: 100n * U, pay: "underlying", receive: "underlying" }
    // Without the one-step function the route is a deposit, then the add (R5-5 offers the one call only when listed).
    const ctx: PlanContext = { ...planCtx(s0), routerFunctions: (manifest.routerFunctions ?? []).filter((fn) => fn !== "add_liquidity_single_underlying") }
    const plans = currentContractsAdapter.plan(req, ctx)
    if (!Array.isArray(plans)) throw new Error(plans.disabled)
    const request = toRouteRequest(req, ctx)
    expect(plans.map((p) => p.action)).toEqual(["deposit", "add_liquidity_sy"])
    // Step 1 lands; the route stops before step 2 (a closed tab, an expired review, a refusal).
    const { outputs } = await r.runRoute(request, plans, { until: 1 })
    const deposited = value(outputs[0])
    const holdings = routeHoldings(request, plans, outputs, 1)
    // The route's holdings are what its deposit gave, not the SY the wallet already held.
    expect(holdings).toEqual({ sy: deposited })
    log(`interrupted lp_only after step 1: "${describeHoldings(holdings!, market.underlying)}" (the wallet holds ${units(b0.sy + deposited)} SY)`)
    const u = unwindFrom(holdings)
    if (!u.available) throw new Error(u.reason)
    expect(u.amount).toBe(deposited)
    // As useRoute.unwind: the confirmed steps stay, the rest is replaced by the single call back.
    const unwound = [...plans.slice(0, 1), u.plan]
    expect(unwound.map((p) => p.action)).toEqual(["deposit", "withdraw"])
    const { steps } = await r.runRoute(request, unwound, { outputs, from: 1, name: "lp_only unwind" })
    const back = value(steps[0].decoded)
    const b1 = balancesOf((await r.snapshot()).acc)
    expect(b1.sy).toBe(b0.sy)
    expect(b1.pt).toBe(b0.pt)
    expect(b1.lp).toBe(b0.lp)
    expect(b1.underlying - b0.underlying).toBe(back - 100n * U)
    // Deposit and withdraw at the same SY rate lose at most a raw unit or two to rounding.
    expect(100n * U - back <= 2n, `${units(100n * U)} USDY in, ${units(back)} USDY back`).toBe(true)
    log(`unwind: withdraw ${units(deposited)} SY -> ${units(back)} USDY (paid ${units(100n * U)} USDY); ${json({ holdingsAfter: routeHoldings(request, unwound, [...outputs, steps[0].decoded], 2) })}`)
  }, 3 * MINUTE)

  // --- History (R4-10, R5-9) ---

  it("history lists every transaction the suite signed, once, with its kind; the one-transaction trades as R4-10 and R5-9 say", async () => {
    expect(sent.length > 0).toBe(true)
    const expected = sent.map((s) => [s.hash, HISTORY_KIND[s.action]])
    const full = await fetchAccountHistory({ manifest, marketId: market.marketId, account: r.account })
    expect(full.truncated).toBe(false)
    // Entries are newest first; `sent` is in the order the transactions landed.
    expect([...full.entries].reverse().map((e) => [e.hash, e.kind])).toEqual(expected)
    const byHash = new Map(full.entries.map((e) => [e.hash, e]))
    for (const o of oneStep) {
      const entry = byHash.get(o.step.hash)
      expect(entry?.kind, o.what).toBe(HISTORY_KIND[o.step.action])
      log(`history: ${o.what} tx ${o.step.hash.slice(0, 12)} listed as ${entry?.kind}: ${json(entry?.lines)}`)
    }
    // R5-9, stated on its own: the flash is a Buy YT, LP only from USDY an Add liquidity, the LP exit to
    // USDY a Remove liquidity.
    const r59: [ActionInput["action"], string][] = [
      ["buy_yt_flash", "buy_yt"],
      ["buy_yt_flash_underlying", "buy_yt"],
      ["add_liquidity_underlying", "add_liquidity"],
      ["remove_liquidity_underlying", "remove_liquidity"],
    ]
    for (const [action, kind] of r59) {
      const listed = sent.filter((s) => s.action === action).map((s) => byHash.get(s.hash)?.kind)
      expect(listed.length > 0, `${action} was signed`).toBe(true)
      expect(listed, `${action} in the history`).toEqual(listed.map(() => kind))
    }
    log(`history: ${full.entries.length} entries for ${sent.length} transactions (${[...full.entries].reverse().map((e) => e.kind).join(", ")})`)
  }, 2 * MINUTE)
})
