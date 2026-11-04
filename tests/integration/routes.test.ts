// @vitest-environment node
/**
 * Every route of spec 0002 §4 end to end on the local USDY market (Task 24, ruling R2-68; plan 0004
 * Task 8), through the pipeline the app runs: the trade adapter plans the route
 * (`currentContractsAdapter.plan`, with the account's live SY balance as `useTradeRoute` passes it)
 * and quotes it, `useTradeRoute`'s checks before the start pass, then each step is resolved from the
 * real outputs of the steps before it, simulated as the user, gated, given floors from its own
 * simulation, reviewed and signed (`route-runner.ts`). A fresh keypair, onboarded through the real
 * faucet, signs in Freighter's place.
 *
 * The manifest lists the five one-transaction Router functions (principal 97ac23e), so:
 * - One step each, on a wallet with no SY: Buy PT paid in USDY (`swap_underlying_for_pt`), Sell PT
 *   and Sell YT to USDY (`swap_pt_for_underlying`, `swap_yt_for_underlying`), Buy YT paid in USDY
 *   (`swap_underlying_for_yt`, still moving the solver's deposit, R4-5, its bound in SY, R4-6), and
 *   Keep YT (`add_liquidity_keep_yt`, minting the SY the dApp sized, R4-4).
 * - R4-3: with 1 raw SY in the wallet, the three that end with `withdraw_all` are planned the old
 *   way, say why, and complete; with the balance unknown, the one step is planned and the
 *   `sy_balance` gate refuses it, as the Router itself does (error 9).
 * - LP only (Keep YT off) for both payers (R4-7: 3cb1942 takes `sy_in` up front and refunds the
 *   rest; R47 is lifted): SY payer one step, signed after a user's approval time; USDY payer, deposit
 *   then add.
 * - In SY: Buy and Sell PT, Buy YT signed with the solver's `sy_in` (R2-58). The implied rate falls on
 *   a buy and rises on a sale (R2-15), checked on the pool's reserves at one point in time.
 * - Quick actions: deposit, split, recombine (to SY, as the dialog does, and to USDY, as the route).
 * - LP Withdraw to USDY and to SY.
 * - Interruption: an LP only paid in USDY stopped after its deposit is turned back into USDY by the
 *   unwind plan (`unwindFrom`, as `useRoute.unwind` builds it).
 * - History: every transaction the suite signed is listed once, with its kind; the one-transaction
 *   trades as R4-10 classifies them.
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

import { derive, simulate } from "@/hooks/use-simulation"
import { fetchAccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import type { ActionInput } from "@/lib/protocol/actions"
import { impliedRate, curveStateFrom, type CurveState } from "@/lib/protocol/curve"
import { fetchAccountHistory } from "@/lib/protocol/events"
import { openGuards, type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { validateManifest } from "@/lib/protocol/manifest"
import { fetchMarketState, type MarketState, type PoolStateView } from "@/lib/protocol/market-state"
import { BPS, SCALE, ceilDiv } from "@/lib/protocol/math"
import { previewDeposit } from "@/lib/protocol/previews"
import { createRpcReader, readLive, toBigint } from "@/lib/protocol/reader"
import { describeHoldings, planRoute, routeHoldings, unwindFrom, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
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
import { createRunner, DEADLINE_SECONDS, SLIPPAGE_BPS, showOutput, type Runner, type Snapshot, type StepRecord } from "./route-runner"

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
   * `useTradeRoute`'s plan context: the account's SY balance goes in when it is read (R4-3).
   * `knownSy: false` plans as the tab does while that read is not live.
   */
  const planCtx = (s: Snapshot, opts: { knownSy?: boolean } = {}): PlanContext => ({
    marketId: market.marketId,
    source: r.account,
    matured: false,
    routerFunctions: manifest.routerFunctions ?? [],
    ms: s.ms,
    ...(opts.knownSy !== false && s.acc.sy.status === "live" ? { syBalance: s.acc.sy.value } : {}),
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
    if (planned.length === 1 && (planned[0].action.endsWith("_underlying") || planned[0].action === "add_liquidity_keep_yt")) {
      oneStep.push({ what: `${req.kind} (${planned[0].action})`, step: steps[0] })
    }
    return run
  }

  const delta = (t: TradeRun, k: keyof Balances) => t.bal1[k] - t.bal0[k]
  const value = (o: ActionOutput) => {
    if (o.kind !== "amount") throw new Error(`expected an amount, got ${o.kind}`)
    return o.value
  }
  const sy = async () => balancesOf((await r.snapshot()).acc).sy

  /**
   * Leaves exactly `target` raw SY in the wallet, with Quick actions as a user would: a withdraw of
   * the rest. A withdraw needs a floor above zero (0001), so it moves at least 2 raw SY: below that,
   * a deposit comes first.
   */
  async function holdSy(target: bigint, why: string): Promise<void> {
    let held = await sy()
    if (held === target) return
    if (held - target < 2n) {
      await r.runAction("deposit", 10n * U, `${why}: quick action deposit`)
      held = await sy()
    }
    await r.runAction("withdraw", held - target, `${why}: quick action withdraw`)
    expect(await sy(), `${why}: SY held`).toBe(target)
    log(`${why}: SY held is now ${target} raw`)
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
    for (const fn of ["swap_underlying_for_pt", "swap_pt_for_underlying", "swap_underlying_for_yt", "swap_yt_for_underlying", "add_liquidity_keep_yt"]) {
      if (!(manifest.routerFunctions ?? []).includes(fn)) throw new Error(`NEEDS_CONTEXT: local.json does not list ${fn}; deploy the market from principal 97ac23e`)
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

  // --- One transaction each, on a wallet with no SY (R4-3) ---

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

  it("Sell PT for USDY: one transaction (swap_pt_for_underlying) on a wallet with no SY; the implied rate rises", async () => {
    await holdSy(0n, "sell_pt one step")
    const t = await trade({ kind: "sell_pt", amount: 100n * U, pay: "underlying", receive: "underlying" }, ["sell_pt_underlying"])
    const [sell] = t.steps
    expect(t.bal0.sy).toBe(0n)
    expect(delta(t, "pt")).toBe(-100n * U)
    // withdraw_all unwraps exactly the sale's SY: nothing is left.
    expect(delta(t, "sy")).toBe(0n)
    expect(delta(t, "underlying")).toBe(value(sell.decoded))
    expect(t.quote.exactness).toBe("simulated")
    expect(t.pool1.ptReserve).toBe(t.pool0.ptReserve + 100n * U)
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
  }, 3 * MINUTE)

  /** Buy YT's solver answer for `spend`, from the reads the plan was made with. */
  function solved(ms: MarketState, req: TradeRequest) {
    const s = curveStateFrom(ms)
    if (!s) throw new Error("no pool state")
    const exchangeRate = live(ms.exchangeRate, "exchange rate")
    const spendSy = req.pay === "underlying" ? previewDeposit(req.amount, exchangeRate) : req.amount
    const solution = solveBuyYt(s, { spendSy, oracleRate: live(ms.oracleRate, "oracle"), tokenizationFeeBps: live(ms.fees.tokenizationBps, "fee") })
    if ("error" in solution) throw new Error(solution.error)
    return { spendSy, exchangeRate, ...solution }
  }

  it("Buy YT with USDY: one transaction (swap_underlying_for_yt) moving the solver's deposit (R4-5), its bound in SY (R4-6); the rate rises", async () => {
    await holdSy(0n, "buy_yt one step")
    const req: TradeRequest = { kind: "buy_yt", amount: 5_000_000n, pay: "underlying", receive: "underlying" }
    let syIn = 0n
    let deposit = 0n
    let xr = 0n
    const t = await trade(req, ["buy_yt_underlying"], (plans, s) => {
      const sol = solved(s.ms, req)
      syIn = sol.syIn
      xr = sol.exchangeRate
      // The deposit that yields at least the solver's sy_in (the adapter's sizing).
      deposit = ceilDiv(sol.syIn * xr, SCALE)
      expect(plans[0].amount).toEqual({ from: "value", value: deposit })
    })
    const [buy] = t.steps
    if (buy.decoded.kind !== "buy_yt_underlying") throw new Error("not a buy_yt_underlying output")
    expect(t.bal0.sy).toBe(0n)
    expect(buy.amount).toBe(deposit)
    expect(previewDeposit(deposit, xr) >= syIn).toBe(true)
    // R4-5: the capital moved is still disclosed: the whole deposit leaves, underlying_back returns in step 1.
    expect(deposit > req.amount).toBe(true)
    expect(t.quote.capital).toMatchObject({ moved: deposit, backStep: 1 })
    // R4-6: signed in SY, from the deposit's SY and the least SY that pays underlying_back.
    expect(buy.guards.syIn).toBe(previewDeposit(deposit, xr))
    const netSy = buy.guards.syIn! - ceilDiv(buy.decoded.underlying_back * SCALE, xr)
    expect(netSy <= buy.guards.maxNetCost!, `net ${netSy} SY vs signed max ${buy.guards.maxNetCost}`).toBe(true)
    // What left the wallet in USDY: the deposit less what came back, within what the quote disclosed
    // and within the spend at slippage (a raw unit of rounding per conversion).
    const spent = -delta(t, "underlying")
    expect(spent).toBe(deposit - buy.decoded.underlying_back)
    expect(spent <= t.quote.maxCost!, `spent ${spent} vs disclosed ${t.quote.maxCost}`).toBe(true)
    expect(spent <= ceilDiv(req.amount * (BPS + SLIPPAGE_BPS), BPS) + 2n, `spent ${spent} vs spend ${req.amount}`).toBe(true)
    expect(delta(t, "sy")).toBe(0n)
    expect(delta(t, "yt")).toBe(buy.decoded.yt_out)
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    log(
      `buy_yt (one step): spend ${units(req.amount)} USDY, deposit ${units(deposit)} USDY (${units(buy.guards.syIn!)} SY), underlying_back ${units(buy.decoded.underlying_back)}; ` +
        `spent ${units(spent)} USDY (quote "spends at most" ${units(t.quote.maxCost!)}), net ${units(netSy)} SY (signed max ${units(buy.guards.maxNetCost!)} SY), YT ${units(buy.decoded.yt_out)}`,
    )
  }, 3 * MINUTE)

  it("Sell YT for USDY: one transaction (swap_yt_for_underlying) on a wallet with no SY; the pool buys its PT back, so the rate falls", async () => {
    await holdSy(0n, "sell_yt one step")
    const yt = balancesOf((await r.snapshot()).acc).yt / 2n
    expect(yt > 0n).toBe(true)
    const t = await trade({ kind: "sell_yt", amount: yt, pay: "underlying", receive: "underlying" }, ["sell_yt_underlying"])
    const [sell] = t.steps
    expect(t.bal0.sy).toBe(0n)
    expect(delta(t, "yt")).toBe(-yt)
    expect(delta(t, "sy")).toBe(0n)
    expect(delta(t, "underlying")).toBe(value(sell.decoded))
    expect(t.quote.exactness).toBe("simulated")
    expect(t.pool1.ptReserve).toBe(t.pool0.ptReserve - yt)
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
  }, 3 * MINUTE)

  it("LP Keep YT: one transaction (add_liquidity_keep_yt) minting the SY the dApp sized (R4-4); LP and YT received, no swap", async () => {
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
    expect(delta(t, "underlying")).toBe(-req.amount)
    expect(delta(t, "lp")).toBe(keep.decoded.lp)
    expect(delta(t, "yt")).toBe(keep.decoded.yt_minted)
    // What the pool did not take stays in the wallet: PT minted 1:1 with YT, less what was added;
    // the deposit's shares, less the mint and the SY added.
    const leftPt = keep.decoded.yt_minted - keep.decoded.pt_used
    const leftSy = shares - mint - keep.decoded.sy_used
    expect(delta(t, "pt")).toBe(leftPt)
    expect(delta(t, "sy")).toBe(leftSy)
    expect(leftPt >= 0n && leftSy >= 0n && leftPt + leftSy <= 10n, `left ${leftPt} PT, ${leftSy} SY`).toBe(true)
    // Final review 1: the split leaves no SY, so the next one-signature sale is not sent multi-step.
    expect(leftSy, "SY left by the one-step Keep YT").toBe(0n)
    expect(t.quote.leftover?.filter((l) => l.token === "sy")).toEqual([])
    expect(t.quote.priceImpactPpm).toBe(0n)
    expect(t.quote.alsoOut?.amount).toBe(keep.decoded.yt_minted)
    log(`lp_keep_yt (one step): ${units(req.amount)} USDY -> ${units(shares)} SY, ${units(mint)} SY minted; LP ${units(keep.decoded.lp)}, YT kept ${units(keep.decoded.yt_minted)}; left ${leftPt} PT + ${leftSy} SY raw`)
  }, 3 * MINUTE)

  // --- In SY ---

  it("Quick action deposit: USDY to SY, the capital the SY trades below move", async () => {
    const before = balancesOf((await r.snapshot()).acc)
    const dep = await r.runAction("deposit", 2_500n * U)
    const after = balancesOf((await r.snapshot()).acc)
    expect(after.underlying - before.underlying).toBe(-2_500n * U)
    expect(after.sy - before.sy).toBe(value(dep.decoded))
  }, 2 * MINUTE)

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

  it("Buy YT with SY: one buy signed with the solver's sy_in; net cost within the spend at slippage; the rate rises", async () => {
    const req: TradeRequest = { kind: "buy_yt", amount: 5_000_000n, pay: "sy", receive: "underlying" }
    let syIn = 0n
    let spendSy = 0n
    const t = await trade(req, ["buy_yt"], (plans, s) => {
      const sol = solved(s.ms, req)
      syIn = sol.syIn
      spendSy = sol.spendSy
      expect(plans[0].amount).toEqual({ from: "value", value: sol.syIn })
    })
    const [buy] = t.steps
    if (buy.decoded.kind !== "buy_yt") throw new Error("not a buy_yt output")
    // The buy moves the solver's sy_in (asserted equal to the plan's above), more than the spend
    // (R2-59: disclosed as capital).
    expect(buy.amount).toBe(syIn)
    expect(syIn > spendSy).toBe(true)
    expect(t.quote.capital?.moved).toBe(syIn)
    const net = syIn - buy.decoded.sy_back
    // R2-58: the signed bound holds, the net cost is within what the quote disclosed ("spends at
    // most", in SY here), and within the spend plus the slippage setting.
    expect(net <= buy.guards.maxNetCost!, `net ${net} vs signed max ${buy.guards.maxNetCost}`).toBe(true)
    expect(net <= t.quote.maxCost!, `net ${net} vs disclosed ${t.quote.maxCost}`).toBe(true)
    expect(net <= ceilDiv(spendSy * (BPS + SLIPPAGE_BPS), BPS), `net ${net} vs spend ${spendSy}`).toBe(true)
    expect(delta(t, "sy")).toBe(-net)
    expect(delta(t, "yt")).toBe(buy.decoded.yt_out)
    expect(t.pool1.ptReserve > t.pool0.ptReserve).toBe(true)
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    expect(t.quote.apyAfter! > t.quote.apyBefore!).toBe(true)
    log(
      `buy_yt (SY): spend ${units(spendSy)} SY, solver sy_in ${units(syIn)} (${Number(syIn / spendSy)}x), sy_back ${units(buy.decoded.sy_back)}, ` +
        `net cost ${units(net)} SY (signed max ${units(buy.guards.maxNetCost!)}; quote "spends at most" ${units(t.quote.maxCost!)}), YT ${units(buy.decoded.yt_out)}`,
    )
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
    expect(delta(t, "sy")).toBe(-add.decoded.sy_used)
    expect(add.decoded.sy_used <= req.amount).toBe(true)
    expect(delta(t, "lp")).toBe(add.decoded.lp)
    // The PT the zap bought and the add did not use is refunded too (not in the return value).
    const ptRefund = delta(t, "pt")
    expect(ptRefund >= 0n).toBe(true)
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
        `kept ${units(add.decoded.sy_used)} SY, refunded ${units(req.amount - add.decoded.sy_used)} SY + ${units(ptRefund)} PT; ` +
        `quote fee ${units(t.quote.fee)} SY, impact ${t.quote.priceImpactPpm} ppm, refunds ${json(t.quote.leftover)}`,
    )
  }, 3 * MINUTE)

  it("LP only paid in USDY: deposit, then add_liquidity_single_sy of what the deposit produced", async () => {
    const req: TradeRequest = { kind: "lp_only", amount: 200n * U, pay: "underlying", receive: "underlying" }
    const t = await trade(req, ["deposit", "add_liquidity_sy"])
    const [dep, add] = t.steps
    if (add.decoded.kind !== "add_liquidity") throw new Error("not an add_liquidity output")
    expect(dep.amount).toBe(req.amount)
    expect(add.amount).toBe(value(dep.decoded))
    expect(delta(t, "underlying")).toBe(-req.amount)
    expect(delta(t, "lp")).toBe(add.decoded.lp)
    expect(delta(t, "sy")).toBe(value(dep.decoded) - add.decoded.sy_used)
    expect(delta(t, "pt") >= 0n).toBe(true)
    // The quote priced the deposit's simulated SY on the curve port: the LP landed within the
    // slippage setting of it (the curve moves with the ledger time in between).
    const tolerance = ceilDiv(add.decoded.lp * SLIPPAGE_BPS, BPS)
    expect(t.quote.exactness).toBe("indicative")
    expect(t.quote.out - add.decoded.lp <= tolerance && add.decoded.lp - t.quote.out <= tolerance, `quote ${t.quote.out} vs LP ${add.decoded.lp}`).toBe(true)
    expect(t.quote.feeToken).toBe("underlying")
    expect(t.quote.apyAfter! < t.quote.apyBefore!).toBe(true)
    log(
      `lp_only (USDY): ${units(req.amount)} USDY -> ${units(value(dep.decoded))} SY; LP ${units(add.decoded.lp)} (quote ${units(t.quote.out)}), ` +
        `refunded ${units(delta(t, "sy"))} SY + ${units(delta(t, "pt"))} PT (quote ${json(t.quote.leftover)})`,
    )
  }, 3 * MINUTE)

  // --- R4-3: 1 raw SY in the wallet ---

  /** A sale or Buy YT that would sweep SY, as the tabs offer them in USDY. */
  const SWEEPING: { req: () => Promise<TradeRequest>; one: ActionInput["action"]; multi: ActionInput["action"][] }[] = [
    { req: async () => ({ kind: "sell_pt", amount: 50n * U, pay: "underlying", receive: "underlying" }), one: "sell_pt_underlying", multi: ["sell_pt", "withdraw"] },
    {
      req: async () => ({ kind: "sell_yt", amount: balancesOf((await r.snapshot()).acc).yt / 2n, pay: "underlying", receive: "underlying" }),
      one: "sell_yt_underlying",
      multi: ["sell_yt", "withdraw"],
    },
    { req: async () => ({ kind: "buy_yt", amount: 5_000_000n, pay: "underlying", receive: "underlying" }), one: "buy_yt_underlying", multi: ["deposit", "buy_yt", "withdraw"] },
  ]

  it("1 raw SY held, balance not read: the one step is planned and the sy_balance gate refuses it, as the Router does (error 9)", async () => {
    await holdSy(1n, "sweep backstop")
    const s = await r.snapshot()
    // A withdraw of that 1 raw SY gets no floor above zero at the slippage setting: logged for the report.
    const dust: ActionInput = { action: "withdraw", marketId: market.marketId, source: r.account, amount: 1n, guards: openGuards("withdraw", 1n), deadline: BigInt(Math.floor(s.ledgerTime) + DEADLINE_SECONDS) }
    const dustGuards = derive(dust, await simulate(manifest, dust), SLIPPAGE_BPS).guards
    log(`withdraw of 1 raw SY at ${SLIPPAGE_BPS} bps: ${json(dustGuards)}`)
    for (const { req: make, one } of SWEEPING) {
      const req = await make()
      const ctx = planCtx(s, { knownSy: false })
      const plans = currentContractsAdapter.plan(req, ctx)
      if (!Array.isArray(plans)) throw new Error(`${req.kind}: not offered: ${plans.disabled}`)
      expect(plans.map((p) => p.action), `${req.kind}, SY not read`).toEqual([one])
      const pre = await r.preStart(toRouteRequest(req, ctx), plans)
      expect(pre.blockers.map((b) => b.code), `${req.kind}: refusals`).toContain("sy_balance")
      // The contract's own refusal, simulated as the user: PreexistingSyBalance, raised by the Router.
      const draft: ActionInput = {
        action: one,
        marketId: market.marketId,
        source: r.account,
        amount: req.kind === "buy_yt" ? (plans[0].amount as { value: bigint }).value : req.amount,
        guards: openGuards(one, req.amount),
        deadline: BigInt(Math.floor(s.ledgerTime) + DEADLINE_SECONDS),
      }
      const sim = await simulate(manifest, draft)
      expect(sim).toMatchObject({ ok: false, kind: "contract_error", contractId: market.contracts.router, code: 9 })
      log(`${one} with 1 raw SY: gates ${json(pre.blockers.map((b) => b.code))} ("${pre.blockers.find((b) => b.code === "sy_balance")?.message}"); simulation Router error #9`)
    }
  }, 3 * MINUTE)

  for (const { req: make, one, multi } of SWEEPING) {
    it(`1 raw SY held: ${one} falls back to ${multi.join(", ")}, says why (R4-3), and completes`, async () => {
      await holdSy(1n, `${one} fallback`)
      const req = await make()
      expect(req.amount > 0n).toBe(true)
      const t = await trade(req, multi, (plans) => {
        expect(plans[0].fallback).toBe(
          `You hold 0.0000001 SY, so this takes ${multi.length} signatures: the one-signature trade would withdraw all your SY. An amount this small cannot be withdrawn, so this trade keeps its multi-step route.`,
        )
        expect(plans.slice(1).every((p) => p.fallback === undefined)).toBe(true)
      })
      expect(t.bal0.sy).toBe(1n)
      const last = t.steps.at(-1)!
      expect(last.action).toBe("withdraw")
      if (req.kind === "buy_yt") {
        const [dep, buy, withdraw] = t.steps
        if (buy.decoded.kind !== "buy_yt") throw new Error("not a buy_yt output")
        expect(withdraw.amount).toBe(buy.decoded.sy_back)
        expect(delta(t, "yt")).toBe(buy.decoded.yt_out)
        // The 1 raw SY is untouched; the deposit's SY beyond sy_in stays beside it.
        expect(delta(t, "sy")).toBe(value(dep.decoded) - buy.amount)
      } else {
        const [sell, withdraw] = t.steps
        // The withdraw takes exactly what the sale gave: the 1 raw SY stays.
        expect(withdraw.amount).toBe(value(sell.decoded))
        expect(delta(t, "sy")).toBe(0n)
        expect(delta(t, req.kind === "sell_pt" ? "pt" : "yt")).toBe(-req.amount)
        expect(delta(t, "underlying")).toBe(value(withdraw.decoded))
      }
      log(`${req.kind} with 1 raw SY: ${t.steps.map((s) => `${s.action} tx ${s.hash.slice(0, 12)} ${showOutput(s.decoded)}`).join("; ")}`)
    }, 4 * MINUTE)
  }

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

  it("LP Withdraw to USDY: remove, sell the PT, withdraw the SY removed and the sale's SY together", async () => {
    const lp = balancesOf((await r.snapshot()).acc).lp
    const half = lp / 2n
    const t = await trade({ kind: "lp_withdraw", amount: half, pay: "underlying", receive: "underlying" }, ["remove_liquidity", "sell_pt", "withdraw"])
    const [remove, sell, withdraw] = t.steps
    if (remove.decoded.kind !== "remove_liquidity") throw new Error("not a remove_liquidity output")
    expect(sell.amount).toBe(remove.decoded.pt)
    expect(withdraw.amount).toBe(remove.decoded.sy + value(sell.decoded))
    expect(delta(t, "lp")).toBe(-half)
    expect(delta(t, "pt")).toBe(0n)
    expect(delta(t, "sy")).toBe(0n)
    expect(delta(t, "underlying")).toBe(value(withdraw.decoded))
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
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

  it("An interrupted LP only paid in USDY (deposit done, add not signed) is turned back into USDY by the unwind plan", async () => {
    const s0 = await r.snapshot()
    const b0 = balancesOf(s0.acc)
    const req: TradeRequest = { kind: "lp_only", amount: 100n * U, pay: "underlying", receive: "underlying" }
    const ctx = planCtx(s0)
    const plans = currentContractsAdapter.plan(req, ctx)
    if (!Array.isArray(plans)) throw new Error(plans.disabled)
    const request = toRouteRequest(req, ctx)
    expect(plans.map((p) => p.action)).toEqual(["deposit", "add_liquidity_sy"])
    // Step 1 lands; the route stops before step 2 (a closed tab, an expired review, a refusal).
    const { outputs } = await r.runRoute(request, plans, { until: 1 })
    const deposited = value(outputs[0])
    const holdings = routeHoldings(request, plans, outputs, 1)
    expect(holdings).toEqual({ sy: deposited })
    log(`interrupted lp_only after step 1: "${describeHoldings(holdings!, market.underlying)}"`)
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

  // --- History (R4-10) ---

  it("history lists every transaction the suite signed, once, with its kind; the one-transaction trades as R4-10 says", async () => {
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
    log(`history: ${full.entries.length} entries for ${sent.length} transactions (${[...full.entries].reverse().map((e) => e.kind).join(", ")})`)
  }, 2 * MINUTE)
})
