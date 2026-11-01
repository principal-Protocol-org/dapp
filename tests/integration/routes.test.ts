// @vitest-environment node
/**
 * Every route of spec 0002 §4 end to end on the local USDY market (Task 24, ruling R2-68), through
 * the pipeline the app runs: the trade adapter plans the route (`currentContractsAdapter.plan`, which
 * sizes Buy YT and Keep YT from the market's reads) and quotes it, `useTradeRoute`'s checks before
 * the start pass, then each step is resolved from the real outputs of the steps before it,
 * simulated as the user, gated, given floors from its own simulation, reviewed and signed
 * (`route-runner.ts`). A fresh keypair, onboarded through the real faucet, signs in Freighter's place.
 *
 * - Buy and Sell PT, each paid or received in USDY and in SY; the implied rate falls on a buy and
 *   rises on a sale (R2-15), checked on the pool's reserves at one point in time.
 * - Buy YT in SY and in USDY: the buy is signed with the solver's `sy_in`, its net cost stays within
 *   the spend at the slippage setting (R2-58), and the rate rises. Sell YT, to USDY.
 * - LP: Keep YT, then Withdraw to USDY and to SY. LP only (Keep YT off) stays refused (R47).
 * - Quick actions: deposit, split, recombine (to SY, as the dialog does, and to USDY, as the route).
 * - Interruption: a Buy PT stopped after its deposit is turned back into USDY by the unwind plan
 *   (`unwindFrom`, as `useRoute.unwind` builds it).
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// The faucet (local-stack's onboarding) is `server-only`; that guard throws outside a react-server bundle.
vi.mock("server-only", () => ({}))

import { fetchAccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { ACTION_META, ADD_LIQUIDITY_SY_DISABLED_PAYING_SY, type ActionInput } from "@/lib/protocol/actions"
import { impliedRate, curveStateFrom, type CurveState } from "@/lib/protocol/curve"
import { evaluateGates } from "@/lib/protocol/gates"
import { openGuards, type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { validateManifest } from "@/lib/protocol/manifest"
import { fetchMarketState, type MarketState, type PoolStateView } from "@/lib/protocol/market-state"
import { BPS, ceilDiv } from "@/lib/protocol/math"
import { previewDeposit } from "@/lib/protocol/previews"
import { createRpcReader, readLive, toBigint } from "@/lib/protocol/reader"
import { prepareReview } from "@/lib/protocol/review"
import { describeHoldings, planRoute, routeHoldings, unwindFrom, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import { currentContractsAdapter, toRouteRequest, type PlanContext, type TradeQuote, type TradeRequest } from "@/lib/protocol/trade-adapter"
import type { Finding, Live, Manifest, Market } from "@/lib/protocol/types"
import { solveBuyYt } from "@/lib/protocol/yt-solver"
import {
  balancesOf,
  complianceKind,
  createLog,
  json,
  ledgerClock,
  MINUTE,
  onboardFreshAccount,
  oracleTick,
  readManifest,
  runwaySeconds,
  showBalances,
  skipReason,
  U,
  units,
  type Balances,
} from "./local-stack"
import { createRunner, SLIPPAGE_BPS, type Runner, type StepRecord } from "./route-runner"

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

describe.skipIf(skip !== null)("every route on the local USDY market (Task 24)", () => {
  let manifest: Manifest
  let market: Market
  let findings: Finding[]
  let kind: ComplianceKind
  let treasury: string
  let r: Runner
  let start: ChainState
  let startBalances: Balances

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

  const planCtx = (ms: MarketState): PlanContext => ({
    marketId: market.marketId,
    source: r.account,
    matured: false,
    routerFunctions: manifest.routerFunctions ?? [],
    ms,
  })

  type TradeRun = {
    request: RouteRequest
    plans: StepPlan[]
    quote: TradeQuote
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
   * `useTradeRoute` does, then every step in order. Returns what it moved.
   */
  async function trade(req: TradeRequest, expectActions: ActionInput["action"][], expectPlan?: (plans: StepPlan[], ms: MarketState) => void): Promise<TradeRun> {
    const s0 = await r.snapshot()
    const ctx = planCtx(s0.ms)
    const planned = currentContractsAdapter.plan(req, ctx)
    if (!Array.isArray(planned)) throw new Error(`${req.kind}: not offered: ${planned.disabled}`)
    expect(planned.map((p) => p.action), `${req.kind} route`).toEqual(expectActions)
    expectPlan?.(planned, s0.ms)
    const request = toRouteRequest(req, ctx)
    const pre = await r.preStart(request, planned)
    expect(pre.blockers, `${req.kind}: refusals before the start`).toEqual([])
    const lp = s0.acc.lp.status === "live" ? { heldLp: s0.acc.lp.value } : {}
    const firstStep = pre.firstOutput ? { firstStep: { action: planned[0].action, output: pre.firstOutput } } : {}
    const quoted = currentContractsAdapter.quote(req, { ms: s0.ms, slippageBps: SLIPPAGE_BPS, plans: planned, ...lp, ...firstStep })
    if (quoted.status !== "live") throw new Error(`${req.kind}: quote unavailable: ${quoted.error}`)
    const quote = quoted.value
    const pool0 = live(s0.ms.poolState, "pool state")
    const { outputs, steps } = await r.runRoute(request, planned)
    const s1 = await r.snapshot()
    const pool1 = live(s1.ms.poolState, "pool state")
    const run: TradeRun = {
      request,
      plans: planned,
      quote,
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
    return run
  }

  const delta = (t: TradeRun, k: keyof Balances) => t.bal1[k] - t.bal0[k]
  const value = (o: ActionOutput) => {
    if (o.kind !== "amount") throw new Error(`expected an amount, got ${o.kind}`)
    return o.value
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

    kind = await complianceKind(manifest, market)
    start = await chainState()
    log(`before: ${showState(start)}`)
    const signer = await onboardFreshAccount(manifest, market, kind)
    r = createRunner({ manifest, market, findings, kind, signer, log })
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
    }
    out.summary()
  }, 2 * MINUTE)

  it("LP only (Keep YT off) stays refused (R47): no route, no quote, no review", async () => {
    const s = await r.snapshot()
    const ctx = planCtx(s.ms)
    const reason = ACTION_META.add_liquidity_sy.disabled?.reason
    expect(reason).toBeDefined()
    const usdy: TradeRequest = { kind: "lp_only", amount: 100n * U, pay: "underlying", receive: "underlying" }
    const sy: TradeRequest = { ...usdy, pay: "sy" }
    expect(currentContractsAdapter.plan(usdy, ctx)).toEqual({ disabled: reason })
    expect(currentContractsAdapter.plan(sy, ctx)).toEqual({ disabled: ADD_LIQUIDITY_SY_DISABLED_PAYING_SY })
    expect(currentContractsAdapter.quote(usdy, { ms: s.ms, slippageBps: SLIPPAGE_BPS, plans: [] })).toEqual({ status: "unavailable", error: reason })
    // Sent past the planner, the gates and the review refuse the pool's zap as well.
    const input: ActionInput = {
      action: "add_liquidity_sy",
      marketId: market.marketId,
      source: r.account,
      amount: 100n * U,
      guards: { minOut: 1n },
      deadline: BigInt(Math.floor(s.ledgerTime) + 300),
    }
    expect(evaluateGates({ ...input, guards: openGuards("add_liquidity_sy", input.amount) }, r.base(s)).map((b) => b.code)).toContain("disabled")
    await expect(prepareReview({ manifest, input })).rejects.toThrow("Add liquidity (SY only) is not offered")
    log("lp_only: plan disabled (R47 reason, USDY and SY payers), quote unavailable, gates [disabled], prepareReview refused; nothing signed")
  }, MINUTE)

  it("Buy PT with USDY: deposit, then buy; the implied rate falls", async () => {
    const t = await trade({ kind: "buy_pt", amount: 300n * U, pay: "underlying", receive: "underlying" }, ["deposit", "buy_pt"])
    const [dep, buy] = t.steps
    expect(dep.amount).toBe(300n * U)
    // The buy spends exactly what the deposit produced.
    expect(buy.amount).toBe(value(dep.decoded))
    expect(delta(t, "underlying")).toBe(-300n * U)
    expect(delta(t, "sy")).toBe(0n)
    expect(delta(t, "pt")).toBe(value(buy.decoded))
    expect(t.pool1.ptReserve < t.pool0.ptReserve && t.pool1.syReserve > t.pool0.syReserve).toBe(true)
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    expect(t.quote.apyAfter! < t.quote.apyBefore!).toBe(true)
  }, 3 * MINUTE)

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

  it("Sell PT for USDY: sell, then withdraw the SY; the implied rate rises", async () => {
    const t = await trade({ kind: "sell_pt", amount: 100n * U, pay: "underlying", receive: "underlying" }, ["sell_pt", "withdraw"])
    const [sell, withdraw] = t.steps
    expect(withdraw.amount).toBe(value(sell.decoded))
    expect(delta(t, "pt")).toBe(-100n * U)
    expect(delta(t, "sy")).toBe(0n)
    expect(delta(t, "underlying")).toBe(value(withdraw.decoded))
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
  }, 3 * MINUTE)

  it("Quick action deposit: USDY to SY, the capital Buy YT in SY moves", async () => {
    const before = balancesOf((await r.snapshot()).acc)
    const dep = await r.runAction("deposit", 2_500n * U)
    const after = balancesOf((await r.snapshot()).acc)
    expect(after.underlying - before.underlying).toBe(-2_500n * U)
    expect(after.sy - before.sy).toBe(value(dep.decoded))
  }, 2 * MINUTE)

  /** Buy YT's solver answer for `spend`, from the reads the plan was made with. */
  function solved(ms: MarketState, req: TradeRequest) {
    const s = curveStateFrom(ms)
    if (!s) throw new Error("no pool state")
    const exchangeRate = live(ms.exchangeRate, "exchange rate")
    const spendSy = req.pay === "underlying" ? previewDeposit(req.amount, exchangeRate) : req.amount
    const solution = solveBuyYt(s, { spendSy, oracleRate: live(ms.oracleRate, "oracle"), tokenizationFeeBps: live(ms.fees.tokenizationBps, "fee") })
    if ("error" in solution) throw new Error(solution.error)
    return { spendSy, ...solution }
  }

  it("Buy YT with SY: one buy signed with the solver's sy_in; net cost within the spend at slippage; the rate rises", async () => {
    const req: TradeRequest = { kind: "buy_yt", amount: 5_000_000n, pay: "sy", receive: "underlying" }
    let syIn = 0n
    let spendSy = 0n
    const t = await trade(req, ["buy_yt"], (plans, ms) => {
      const sol = solved(ms, req)
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

  it("Buy YT with USDY: deposit, buy with the solver's sy_in, withdraw the refund; spend within slippage; the rate rises", async () => {
    const req: TradeRequest = { kind: "buy_yt", amount: 5_000_000n, pay: "underlying", receive: "underlying" }
    let syIn = 0n
    const t = await trade(req, ["deposit", "buy_yt", "withdraw"], (plans, ms) => {
      syIn = solved(ms, req).syIn
      expect(plans[1].amount).toEqual({ from: "value", value: syIn })
      expect(plans[2].amount).toEqual({ from: "step", index: 1, field: "sy_back" })
    })
    const [dep, buy, withdraw] = t.steps
    if (buy.decoded.kind !== "buy_yt") throw new Error("not a buy_yt output")
    // The deposit covers sy_in (the step's `requires`), and the buy moves exactly sy_in.
    expect(value(dep.decoded) >= syIn).toBe(true)
    expect(buy.amount).toBe(syIn)
    expect(withdraw.amount).toBe(buy.decoded.sy_back)
    const net = syIn - buy.decoded.sy_back
    expect(net <= buy.guards.maxNetCost!).toBe(true)
    // What left the wallet in USDY: the deposit, less the refund withdrawn. A raw unit of rounding
    // per conversion (deposit rounded up, withdraw down) on top of the spend at slippage.
    const spent = -delta(t, "underlying")
    expect(spent).toBe(dep.amount - value(withdraw.decoded))
    // Within what the quote disclosed ("spends at most", in the token paid: USDY).
    expect(spent <= t.quote.maxCost!, `spent ${spent} vs disclosed ${t.quote.maxCost}`).toBe(true)
    expect(spent <= ceilDiv(req.amount * (BPS + SLIPPAGE_BPS), BPS) + 2n, `spent ${spent} vs spend ${req.amount}`).toBe(true)
    // Any SY the deposit gave beyond sy_in stays in the wallet (dust).
    expect(delta(t, "sy")).toBe(value(dep.decoded) - syIn)
    expect(delta(t, "yt")).toBe(buy.decoded.yt_out)
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    log(
      `buy_yt (USDY): spend ${units(req.amount)} USDY, deposit ${units(dep.amount)} USDY -> ${units(value(dep.decoded))} SY, sy_in ${units(syIn)}, ` +
        `sy_back ${units(buy.decoded.sy_back)} withdrawn to ${units(value(withdraw.decoded))} USDY; spent ${units(spent)} USDY ` +
        `(quote "spends at most" ${units(t.quote.maxCost!)}), YT ${units(buy.decoded.yt_out)}`,
    )
  }, 4 * MINUTE)

  it("Sell YT for USDY: sell every YT held, then withdraw; the pool buys its PT back, so the rate falls", async () => {
    const yt = balancesOf((await r.snapshot()).acc).yt
    expect(yt > 0n).toBe(true)
    const t = await trade({ kind: "sell_yt", amount: yt, pay: "underlying", receive: "underlying" }, ["sell_yt", "withdraw"])
    const [sell, withdraw] = t.steps
    expect(withdraw.amount).toBe(value(sell.decoded))
    expect(delta(t, "yt")).toBe(-yt)
    expect(delta(t, "underlying")).toBe(value(withdraw.decoded))
    expect(t.pool1.ptReserve).toBe(t.pool0.ptReserve - yt)
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
  }, 3 * MINUTE)

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

  it("LP Keep YT: mint, deposit, add both at the pool's ratio; LP and YT received, no swap", async () => {
    const req: TradeRequest = { kind: "lp_keep_yt", amount: 300n * U, pay: "underlying", receive: "underlying" }
    const t = await trade(req, ["mint", "deposit", "add_liquidity"])
    const [mint, dep, add] = t.steps
    if (mint.decoded.kind !== "mint" || add.decoded.kind !== "add_liquidity") throw new Error("unexpected outputs")
    expect(mint.amount + dep.amount).toBe(req.amount)
    expect(add.amount).toBe(mint.decoded.pt_minted)
    expect(add.secondaryAmount).toBe(value(dep.decoded))
    expect(delta(t, "underlying")).toBe(-req.amount)
    expect(delta(t, "lp")).toBe(add.decoded.lp)
    expect(delta(t, "yt")).toBe(mint.decoded.yt_minted)
    // What the pool did not take stays in the wallet: a raw unit or two at most.
    const leftPt = mint.decoded.pt_minted - add.decoded.pt_used
    const leftSy = value(dep.decoded) - add.decoded.sy_used
    expect(leftPt >= 0n && leftSy >= 0n && leftPt + leftSy <= 10n, `left ${leftPt} PT, ${leftSy} SY`).toBe(true)
    expect(t.quote.priceImpactPpm).toBe(0n)
    log(`lp_keep_yt: split ${units(mint.amount)} USDY minted / ${units(dep.amount)} USDY deposited; LP ${units(add.decoded.lp)}, YT kept ${units(mint.decoded.yt_minted)}; left ${leftPt} PT + ${leftSy} SY raw`)
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

  it("An interrupted Buy PT (deposit done, buy not signed) is turned back into USDY by the unwind plan", async () => {
    const s0 = await r.snapshot()
    const b0 = balancesOf(s0.acc)
    const req: TradeRequest = { kind: "buy_pt", amount: 100n * U, pay: "underlying", receive: "underlying" }
    const ctx = planCtx(s0.ms)
    const plans = currentContractsAdapter.plan(req, ctx)
    if (!Array.isArray(plans)) throw new Error(plans.disabled)
    const request = toRouteRequest(req, ctx)
    expect(plans.map((p) => p.action)).toEqual(["deposit", "buy_pt"])
    // Step 1 lands; the route stops before step 2 (a closed tab, an expired review, a refusal).
    const { outputs } = await r.runRoute(request, plans, { until: 1 })
    const sy = value(outputs[0])
    const holdings = routeHoldings(request, plans, outputs, 1)
    expect(holdings).toEqual({ sy })
    log(`interrupted buy_pt after step 1: "${describeHoldings(holdings!, market.underlying)}"`)
    const u = unwindFrom(holdings)
    if (!u.available) throw new Error(u.reason)
    expect(u.amount).toBe(sy)
    // As useRoute.unwind: the confirmed steps stay, the rest is replaced by the single call back.
    const unwound = [...plans.slice(0, 1), u.plan]
    expect(unwound.map((p) => p.action)).toEqual(["deposit", "withdraw"])
    const { steps } = await r.runRoute(request, unwound, { outputs, from: 1, name: "buy_pt unwind" })
    const back = value(steps[0].decoded)
    const b1 = balancesOf((await r.snapshot()).acc)
    expect(b1.sy).toBe(b0.sy)
    expect(b1.pt).toBe(b0.pt)
    expect(b1.underlying - b0.underlying).toBe(back - 100n * U)
    // Deposit and withdraw at the same SY rate lose at most a raw unit or two to rounding.
    expect(100n * U - back <= 2n, `${units(100n * U)} USDY in, ${units(back)} USDY back`).toBe(true)
    log(`unwind: withdraw ${units(sy)} SY -> ${units(back)} USDY (paid ${units(100n * U)} USDY); ${json({ holdingsAfter: routeHoldings(request, unwound, [...outputs, steps[0].decoded], 2) })}`)
  }, 3 * MINUTE)
})
