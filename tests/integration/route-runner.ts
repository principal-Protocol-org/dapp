/**
 * The app's route pipeline without React, for the live suites: what `useTradeRoute` checks before a
 * route starts (`routePreStartBlockers`, the hook's own function, fed this runner's simulation of
 * step 1), then what `useRoute` does for each step (`prepareStep`, then `sign`), with a keypair in
 * place of Freighter.
 *
 * Per step, as `useRoute.prepareStep` does it: fresh reads, `resolveStep` from the outputs the
 * confirmed steps really produced, a draft with open guards and a deadline from the ledger clock,
 * `simulate` (the hook's own, as the user), the gates with that simulation (expected empty),
 * `derive` (the floors at the slippage setting, from that simulation and the live SY exchange rate,
 * as the hook passes it: the USDY flash's budget is capped in SY, R5-3), `prepareReview`; then, as
 * `sign` does it, `executeReview` (R31 checks, sign, submit, poll, decode). The open guards take the
 * same rate (R5-3: the USDY flash is simulated with its whole budget in SY as `max_net_cost`).
 */
import { expect } from "vitest"
import { derive, ratesFrom, simulate } from "@/hooks/use-simulation"
import { fetchAccountState, type AccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { ACTION_META, type ActionInput, type GuardValues } from "@/lib/protocol/actions"
import { evaluateAccountCompliance, type ComplianceItem } from "@/lib/protocol/compliance"
import { impliedRate, type CurveState } from "@/lib/protocol/curve"
import { evaluateGates, type Blocker, type GateContext } from "@/lib/protocol/gates"
import { openGuards, type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { fetchMarketState, type MarketState, type PoolStateView } from "@/lib/protocol/market-state"
import { BPS, ceilDiv } from "@/lib/protocol/math"
import { createRpcReader } from "@/lib/protocol/reader"
import { executeReview, prepareReview, type Review } from "@/lib/protocol/review"
import { preStartDraft, routePreStartBlockers } from "@/lib/protocol/route-gates"
import { resolveStep, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import { createRpcServer, type SimulationOutcome } from "@/lib/protocol/stellar"
import { currentContractsAdapter, toRouteRequest, type PlanContext, type TradeQuote, type TradeRequest } from "@/lib/protocol/trade-adapter"
import type { Finding, Live, Manifest, Market } from "@/lib/protocol/types"
import { balancesOf, ledgerClock, showBalances, units, type Balances } from "../live/chain"
import { json, sleep } from "../live/util"
import type { KeypairSigner } from "./keypair-signer"

/** The app's defaults (`hooks/use-settings.ts`): 50 bps slippage, a 300 s deadline. */
export const SLIPPAGE_BPS = 50n
export const DEADLINE_SECONDS = 300

export type Snapshot = { ms: MarketState; acc: AccountState; compliance: ComplianceItem[]; ledgerTime: number }

/** The account's balances a snapshot reads again when the RPC fails one (`snapshot`). */
const BALANCES = ["underlying", "sy", "pt", "yt", "lp"] as const
const SNAPSHOT_ATTEMPTS = 4
/** With `readAfterLanded`, how often a snapshot behind the last confirmed step is read again (1 s apart). */
const LANDED_ATTEMPTS = 20

/** One confirmed step: what it was signed with and what it returned. */
export type StepRecord = {
  index: number
  action: ActionInput["action"]
  amount: bigint
  secondaryAmount?: bigint
  /** The floors the step was signed with, from its own simulation. */
  guards: GuardValues
  simulated: ActionOutput
  decoded: ActionOutput
  hash: string
  /** The ledger it landed in (`readAfterLanded` only, set once it is looked up). */
  ledger?: number
}

const abs = (v: bigint) => (v < 0n ? -v : v)

/**
 * The floors an action is signed with, and a result against them (0001): every slippage-sensitive
 * call has a floor above zero; Buy YT's `max_net_cost` sits above zero and below what the buy
 * spends; the flash's net cost is within its `max_net_cost` (R5-3); the result honors each floor.
 * The route runner checks a step's simulated output before it is signed and its decoded output once
 * it lands; the lifecycle suite checks every decoded output. The flash's cap at the budget, and the
 * USDY flash's `min_underlying_back` (the one floor that may be 0, R5-3), need the exchange rate: the
 * routes suite checks them.
 */
export function expectFloors(input: ActionInput, out: ActionOutput, g: GuardValues, label: string = input.action): void {
  const positive = (floor: bigint | undefined, what: string): bigint => {
    expect(floor !== undefined && floor > 0n, `${label}: ${what} ${String(floor)} must be a floor above zero`).toBe(true)
    return floor as bigint
  }
  const atLeast = (got: bigint, floor: bigint, what: string) => expect(got >= floor, `${label}: ${what} ${got} below its floor ${floor}`).toBe(true)
  switch (out.kind) {
    case "amount":
      // claim_yield returns an amount and takes no floor.
      if (!ACTION_META[input.action].slippageSensitive) return
      atLeast(out.value, positive(g.minOut, "minOut"), "output")
      return
    case "mint":
      atLeast(out.pt_minted, positive(g.minOut, "minOut"), "pt_minted")
      return
    case "add_liquidity":
    case "keep_yt":
      // Keep YT signs min_lp_out only: the YT it mints has no floor.
      atLeast(out.lp, positive(g.minOut, "min_lp_out"), "lp")
      return
    case "remove_liquidity":
      atLeast(out.pt, positive(g.minOut, "min_pt_out"), "pt")
      atLeast(out.sy, positive(g.minOut2, "min_sy_out"), "sy")
      return
    case "buy_yt": {
      atLeast(out.yt_out, positive(g.minOut, "min_yt_out"), "yt_out")
      const max = positive(g.maxNetCost, "max_net_cost")
      expect(max < input.amount, `${label}: max_net_cost ${max} vs sy_in ${input.amount}`).toBe(true)
      expect(input.amount - out.sy_back <= max, `${label}: net cost ${input.amount - out.sy_back} vs max_net_cost ${max}`).toBe(true)
      return
    }
    case "flash_yt":
    case "flash_yt_underlying": {
      atLeast(out.yt_out, positive(g.minOut, "min_yt_out"), "yt_out")
      const max = positive(g.maxNetCost, "max_net_cost")
      expect(out.net_cost <= max, `${label}: net cost ${out.net_cost} vs max_net_cost ${max}`).toBe(true)
      return
    }
    case "redeem":
      // redeem_at_maturity takes no floor: the settlement rate is frozen.
      return
  }
}

export const showOutput = (out: ActionOutput) =>
  Object.entries(out)
    .filter(([k]) => k !== "kind")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ")

export function createRunner(p: {
  manifest: Manifest
  market: Market
  findings: Finding[]
  kind: ComplianceKind
  signer: KeypairSigner
  log: (line: string) => void
  /** Called with every confirmed step, in the order they landed (the history check's list). */
  record?: (step: StepRecord) => void
  /**
   * For an RPC served by several nodes (Testnet): a read right after a confirmed step may come from
   * a node a ledger behind the one that confirmed it. When set, each confirmed step's ledger is
   * looked up, and a snapshot is read again until its balances and pool state are from that ledger
   * or later. Off by default: the local stack is one node, and its suites run as they always have.
   */
  readAfterLanded?: boolean
}) {
  const { manifest, market, findings, kind, signer, log } = p
  const account = signer.publicKey
  const reader = () => createRpcReader(manifest)
  const horizon = () => createHorizon(manifest.horizonUrl)
  /** The ledger of the latest confirmed step (`readAfterLanded` only; 0 otherwise). */
  let landed = 0

  /** The ledger a confirmed transaction landed in, read again while the node asked does not know it yet. */
  async function landedLedger(hash: string): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      const tx = await createRpcServer(manifest.rpcUrl).getTransaction(hash)
      if (tx.status !== "NOT_FOUND") return tx.ledger
      if (attempt === LANDED_ATTEMPTS) throw new Error(`transaction ${hash} confirmed, then not found by the RPC ${attempt} times`)
      await sleep(1_000)
    }
  }

  /**
   * Fresh reads, as the panels refresh them. The local RPC now and then fails a read's preflight
   * ("setting ContractComputeV0 is not present in the snapshot") while it ingests a ledger; the app
   * shows that read as unavailable and reads it again on its next refresh. So does this: a balance
   * that comes back unavailable is read again (logged), a few times, before the snapshot is used.
   */
  async function snapshot(): Promise<Snapshot> {
    for (let attempt = 1; ; attempt++) {
      const [clock, ms, acc] = await Promise.all([
        ledgerClock(manifest),
        fetchMarketState(reader(), manifest, market.marketId),
        fetchAccountState(reader(), horizon(), manifest, market.marketId, account, kind),
      ])
      const unread = BALANCES.flatMap((k) => (acc[k].status === "unavailable" ? [`${k}: ${acc[k].error}`] : []))
      // Reads from before the last confirmed step (never with `readAfterLanded` off: `landed` stays 0).
      const reads = [...BALANCES.map((k) => [k, acc[k]] as const), ["pool state", ms.poolState] as const]
      const behind = reads.flatMap(([k, v]) => (v.status === "live" && v.ledger < landed ? [`${k} at ledger ${v.ledger}`] : []))
      if (behind.length > 0) {
        if (attempt >= LANDED_ATTEMPTS) throw new Error(`snapshot: reads still behind ledger ${landed} after ${attempt} attempts: ${behind.join(", ")}`)
        log(`snapshot attempt ${attempt}: read again, the RPC answered from before ledger ${landed} (${behind.join(", ")})`)
        await sleep(1_000)
        continue
      }
      if (unread.length === 0 || attempt >= SNAPSHOT_ATTEMPTS) {
        return { ms, acc, compliance: evaluateAccountCompliance(acc, kind), ledgerTime: clock.now() }
      }
      log(`snapshot attempt ${attempt}: read again, the RPC did not answer ${unread.join("; ")}`)
      await sleep(1_000)
    }
  }

  /** The SY exchange rate the open guards and the floors may need (R5-3), from reads that are fresh: `useRoute`'s `ratesFrom`. */
  const rates = (s: Snapshot) => ratesFrom({ data: s.ms, stale: false })

  /** `useGateContext`'s `base`: every gate input but the simulation. */
  function base(s: Snapshot): Omit<GateContext, "simulation"> {
    return {
      findings,
      wallet: { status: "connected", publicKey: account, networkPassphrase: manifest.networkPassphrase },
      market: s.ms,
      account: s.acc,
      compliance: s.compliance,
      ledgerTime: s.ledgerTime,
      managerId: market.contracts.manager,
    }
  }

  /**
   * `useTradeRoute`'s refusals before the start, for `plans` (expected empty): step 1 is simulated as
   * the user, as the hook's `useSimulation` does it (open guards, a deadline from the ledger clock),
   * and `routePreStartBlockers` does the rest, exactly as the hook calls it.
   */
  async function preStart(req: RouteRequest, plans: StepPlan[]): Promise<{ blockers: Blocker[]; firstOutput?: ActionOutput }> {
    const s = await snapshot()
    const first = preStartDraft(plans[0], req).input
    // The USDY flash's open max_net_cost is its budget in SY, which needs the exchange rate (R5-3).
    const simInput: ActionInput = { ...first, guards: openGuards(first.action, first.amount, rates(s)), deadline: BigInt(Math.floor(s.ledgerTime) + DEADLINE_SECONDS) }
    const outcome = await simulate(manifest, simInput)
    const { output, guards } = derive(simInput, outcome, SLIPPAGE_BPS, rates(s))
    const blockers = routePreStartBlockers({
      plans,
      request: req,
      base: base(s),
      simOutcome: outcome,
      ...(output ? { simOutput: output } : {}),
      ...(guards ? { simGuards: guards } : {}),
    })
    return { blockers, ...(output ? { firstOutput: output } : {}) }
  }

  /** Step `i` of a route, prepared and signed as `useRoute` does it; `name` labels the log lines. */
  async function runStep(req: RouteRequest, plans: StepPlan[], outputs: ActionOutput[], i: number, name: string = req.kind): Promise<StepRecord> {
    const plan = plans[i]
    const label = `${name} step ${i + 1}/${plans.length} (${plan.action})`
    const s = await snapshot()
    const amounts = resolveStep(plan, req, outputs)
    const ledgerAt = Math.floor(s.ledgerTime)
    const draft: ActionInput = {
      action: plan.action,
      marketId: market.marketId,
      source: account,
      amount: amounts.amount,
      ...(amounts.secondaryAmount !== undefined ? { secondaryAmount: amounts.secondaryAmount } : {}),
      ...(amounts.desired ? { desired: amounts.desired } : {}),
      guards: openGuards(plan.action, amounts.amount, rates(s)),
      deadline: BigInt(ledgerAt + DEADLINE_SECONDS),
    }
    const outcome: SimulationOutcome = await simulate(manifest, draft)
    const blockers = evaluateGates(draft, { ...base(s), simulation: outcome })
    expect(blockers, `${label}: gates`).toEqual([])
    const { output: simulated, guards } = derive(draft, outcome, SLIPPAGE_BPS, rates(s))
    if (!simulated || !guards?.ok) throw new Error(`${label}: no exact quote: ${json({ outcome, guards })}`)
    // A floor above zero on every slippage-sensitive call, from this step's own simulation, checked
    // before the step is signed.
    const g = guards.guards
    expect(ACTION_META[plan.action].slippageSensitive, `${label} is slippage-sensitive`).toBe(true)
    expectFloors({ ...draft, guards: g }, simulated, g, `${label} (simulated)`)

    const review: Review = await prepareReview({ manifest, input: { ...draft, guards: g } })
    expect(review.input.guards).toEqual(g)
    const result = await executeReview({ review, manifest, sign: signer.sign })
    expect(result.status, `${label}: ${json(result)}`).toBe("SUCCESS")
    expect(result.decodeError).toBeUndefined()
    const decoded = result.output
    if (!decoded) throw new Error(`${label}: no decoded output`)
    expect(decoded.kind).toBe(simulated.kind)
    // The landed result honours the floors it was signed with (the contract enforces them; checked here too).
    expectFloors({ ...draft, guards: g }, decoded, g, label)
    // The landed result is within the slippage setting of this step's simulation, field by field.
    for (const [field, sim] of Object.entries(simulated)) {
      if (typeof sim !== "bigint") continue
      const dec = (decoded as Record<string, unknown>)[field] as bigint
      const tolerance = ceilDiv(abs(sim) * SLIPPAGE_BPS, BPS)
      expect(abs(dec - sim) <= tolerance, `${label}.${field}: decoded ${dec} vs simulated ${sim} (±${tolerance})`).toBe(true)
    }
    const floors = Object.entries(g)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ")
    log(`${label}: amount ${amounts.amount}${amounts.secondaryAmount !== undefined ? ` + ${amounts.secondaryAmount}` : ""}, signed with ${floors}; tx ${result.hash.slice(0, 12)} simulated ${showOutput(simulated)} | decoded ${showOutput(decoded)}`)
    const record: StepRecord = { index: i, action: plan.action, ...amounts, guards: g, simulated, decoded, hash: result.hash }
    p.record?.(record)
    if (p.readAfterLanded) {
      record.ledger = await landedLedger(result.hash)
      landed = Math.max(landed, record.ledger)
    }
    return record
  }

  /**
   * A route from its first open step to its end (or through step `until`, 1-based): each step only
   * once the one before it is confirmed, from its real output.
   */
  async function runRoute(req: RouteRequest, plans: StepPlan[], opts: { outputs?: ActionOutput[]; from?: number; until?: number; name?: string } = {}) {
    const outputs = [...(opts.outputs ?? [])]
    const steps: StepRecord[] = []
    const last = (opts.until ?? plans.length) - 1
    for (let i = opts.from ?? 0; i <= last; i++) {
      const step = await runStep(req, plans, outputs, i, opts.name)
      outputs[i] = step.decoded
      steps.push(step)
    }
    return { outputs, steps }
  }

  /**
   * One action as an `ActionPanel` (a Quick action) runs it: the same simulation, gates, floors and
   * review as a route step, for a fixed amount.
   */
  async function runAction(action: ActionInput["action"], amount: bigint, name = `quick action ${action}`): Promise<StepRecord> {
    const plan: StepPlan = { action, amount: { from: "value", value: amount }, gives: "", takes: "" }
    // Only `amount` of a request is ever read, and only for an `input` amount: this plan has none.
    const req = { amount } as RouteRequest
    return runStep(req, [plan], [], 0, name)
  }

  return { account, snapshot, base, preStart, runStep, runRoute, runAction }
}

export type Runner = ReturnType<typeof createRunner>

/** A live read's value, or a throw naming what could not be read. */
export function live<T>(v: Live<T>, what: string): T {
  if (v.status !== "live") throw new Error(`${what}: ${v.error}`)
  return v.value
}

export const showPool = (p: PoolStateView) => `PT ${units(p.ptReserve)}, SY ${units(p.syReserve)}, LP ${units(p.totalLp)}, τ ${p.secondsToMaturity} s`

/** The fixed APR at `SCALE` of `after`'s reserves on `before`'s clock, exponent and oracle rate: the trade's own move. */
export function rateMove(before: PoolStateView, after: PoolStateView): { before: bigint; after: bigint } {
  const at: CurveState = { ...before }
  return { before: impliedRate(at), after: impliedRate({ ...at, ptReserve: after.ptReserve, syReserve: after.syReserve, totalLp: after.totalLp }) }
}

/**
 * `useTradeRoute`'s plan context: the manifest alone decides a one-step route (R5-4), and the plan
 * sizes with the slippage the quote uses (R5-2).
 */
export function planContext(manifest: Manifest, market: Market, runner: Runner, s: Snapshot): PlanContext {
  return {
    marketId: market.marketId,
    source: runner.account,
    matured: false,
    routerFunctions: manifest.routerFunctions ?? [],
    slippageBps: SLIPPAGE_BPS,
    ms: s.ms,
  }
}

export type TradeRun = {
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
 * `useTradeRoute` does, then every step in order by `runner`. Returns what it moved.
 */
export async function runTrade(p: {
  manifest: Manifest
  market: Market
  runner: Runner
  log: (line: string) => void
  req: TradeRequest
  expectActions: ActionInput["action"][]
  expectPlan?: (plans: StepPlan[], s: Snapshot) => void
}): Promise<TradeRun> {
  const { manifest, market, runner, log, req } = p
  const s0 = await runner.snapshot()
  const ctx = planContext(manifest, market, runner, s0)
  const planned = currentContractsAdapter.plan(req, ctx)
  if (!Array.isArray(planned)) throw new Error(`${req.kind}: not offered: ${planned.disabled}`)
  expect(planned.map((step) => step.action), `${req.kind} route`).toEqual(p.expectActions)
  p.expectPlan?.(planned, s0)
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
  return run
}
