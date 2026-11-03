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
 * as the hook passes it: one-step Buy YT's bound is in SY, R4-6), `prepareReview`; then, as
 * `sign` does it, `executeReview` (R31 checks, sign, submit, poll, decode).
 */
import { expect } from "vitest"
import { derive, ratesFrom, simulate } from "@/hooks/use-simulation"
import { fetchAccountState, type AccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { ACTION_META, type ActionInput, type GuardValues } from "@/lib/protocol/actions"
import { evaluateAccountCompliance, type ComplianceItem } from "@/lib/protocol/compliance"
import { evaluateGates, type Blocker, type GateContext } from "@/lib/protocol/gates"
import { openGuards, type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { fetchMarketState, type MarketState } from "@/lib/protocol/market-state"
import { BPS, ceilDiv } from "@/lib/protocol/math"
import { createRpcReader } from "@/lib/protocol/reader"
import { executeReview, prepareReview, type Review } from "@/lib/protocol/review"
import { preStartDraft, routePreStartBlockers } from "@/lib/protocol/route-gates"
import { resolveStep, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import type { SimulationOutcome } from "@/lib/protocol/stellar"
import type { Finding, Manifest, Market } from "@/lib/protocol/types"
import type { KeypairSigner } from "./keypair-signer"
import { json, ledgerClock, sleep } from "./local-stack"

/** The app's defaults (`hooks/use-settings.ts`): 50 bps slippage, a 300 s deadline. */
export const SLIPPAGE_BPS = 50n
export const DEADLINE_SECONDS = 300

export type Snapshot = { ms: MarketState; acc: AccountState; compliance: ComplianceItem[]; ledgerTime: number }

/** The account's balances a snapshot reads again when the RPC fails one (`snapshot`). */
const BALANCES = ["underlying", "sy", "pt", "yt", "lp"] as const
const SNAPSHOT_ATTEMPTS = 4

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
}

const abs = (v: bigint) => (v < 0n ? -v : v)

/**
 * The floors an action is signed with, and a result against them (0001): every slippage-sensitive
 * call has a floor above zero; Buy YT's `max_net_cost` sits above zero and below what the buy
 * spends (in SY for the one step, R4-6); the result honours each floor. The route runner checks a
 * step's simulated output before it is signed and its decoded output once it lands; the lifecycle
 * suite checks every decoded output. One-step Buy YT's net cost in SY needs the exchange rate: the
 * routes suite checks it.
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
    case "buy_yt_underlying": {
      atLeast(out.yt_out, positive(g.minOut, "min_yt_out"), "yt_out")
      const max = positive(g.maxNetCost, "max_net_cost")
      expect(g.syIn !== undefined && max < g.syIn, `${label}: max_net_cost ${max} vs the deposit's SY ${String(g.syIn)}`).toBe(true)
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
}) {
  const { manifest, market, findings, kind, signer, log } = p
  const account = signer.publicKey
  const reader = () => createRpcReader(manifest)
  const horizon = () => createHorizon(manifest.horizonUrl)

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
      if (unread.length === 0 || attempt === SNAPSHOT_ATTEMPTS) {
        return { ms, acc, compliance: evaluateAccountCompliance(acc, kind), ledgerTime: clock.now() }
      }
      log(`snapshot attempt ${attempt}: read again, the RPC did not answer ${unread.join("; ")}`)
      await sleep(1_000)
    }
  }

  /** The SY exchange rate the floors may need (R4-6), from reads that are fresh: `useRoute`'s `ratesFrom`. */
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
      routerId: market.contracts.router,
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
    const simInput: ActionInput = { ...first, guards: openGuards(first.action, first.amount), deadline: BigInt(Math.floor(s.ledgerTime) + DEADLINE_SECONDS) }
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
      guards: openGuards(plan.action, amounts.amount),
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
