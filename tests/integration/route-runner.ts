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
    // A nonzero floor on every slippage-sensitive call, from this step's own simulation.
    const g = guards.guards
    expect(ACTION_META[plan.action].slippageSensitive, `${label} is slippage-sensitive`).toBe(true)
    expect(g.minOut !== undefined && g.minOut > 0n, `${label}: minOut ${String(g.minOut)}`).toBe(true)
    if (plan.action === "remove_liquidity") expect(g.minOut2 !== undefined && g.minOut2 > 0n, `${label}: minOut2`).toBe(true)
    if (plan.action === "buy_yt") expect(g.maxNetCost !== undefined && g.maxNetCost > 0n && g.maxNetCost < draft.amount, `${label}: maxNetCost`).toBe(true)
    // R4-6: one-step Buy YT's bound is in SY, below the SY its deposit produces.
    if (plan.action === "buy_yt_underlying") {
      expect(g.syIn !== undefined && g.maxNetCost !== undefined && g.maxNetCost > 0n && g.maxNetCost < g.syIn, `${label}: maxNetCost ${String(g.maxNetCost)} vs syIn ${String(g.syIn)}`).toBe(true)
    }

    const review: Review = await prepareReview({ manifest, input: { ...draft, guards: g } })
    expect(review.input.guards).toEqual(g)
    const result = await executeReview({ review, manifest, sign: signer.sign })
    expect(result.status, `${label}: ${json(result)}`).toBe("SUCCESS")
    expect(result.decodeError).toBeUndefined()
    const decoded = result.output
    if (!decoded) throw new Error(`${label}: no decoded output`)
    expect(decoded.kind).toBe(simulated.kind)
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
