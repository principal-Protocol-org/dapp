/**
 * The app's route pipeline without React, for the live suites: what `useTradeRoute` checks before a
 * route starts, then what `useRoute` does for each step (`prepareStep`, then `sign`), with a keypair
 * in place of Freighter.
 *
 * Per step, as `useRoute.prepareStep` does it: fresh reads, `resolveStep` from the outputs the
 * confirmed steps really produced, a draft with open guards and a deadline from the ledger clock,
 * `simulate` (the hook's own, as the user), the gates with that simulation (expected empty),
 * `derive` (the floors at the slippage setting, from that simulation), `prepareReview`; then, as
 * `sign` does it, `executeReview` (R31 checks, sign, submit, poll, decode).
 */
import { expect } from "vitest"
import { derive, simulate } from "@/hooks/use-simulation"
import { fetchAccountState, type AccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { ACTION_META, type ActionInput, type GuardValues } from "@/lib/protocol/actions"
import { evaluateAccountCompliance, type ComplianceItem } from "@/lib/protocol/compliance"
import {
  BLOCKER_ORDER,
  breakerReport,
  capCharge,
  evaluateGates,
  withEarlierCapCharges,
  withEarlierReports,
  type Blocker,
  type BlockerCode,
  type GateContext,
} from "@/lib/protocol/gates"
import { openGuards, type ActionOutput } from "@/lib/protocol/guards"
import { createHorizon } from "@/lib/protocol/horizon"
import { fetchMarketState, type MarketState } from "@/lib/protocol/market-state"
import { BPS, ceilDiv } from "@/lib/protocol/math"
import { createRpcReader } from "@/lib/protocol/reader"
import { executeReview, prepareReview, type Review } from "@/lib/protocol/review"
import { resolveStep, type AmountSource, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"
import type { SimulationOutcome } from "@/lib/protocol/stellar"
import type { Finding, Manifest, Market } from "@/lib/protocol/types"
import type { KeypairSigner } from "./keypair-signer"
import { json, ledgerClock } from "./local-stack"

/** The app's defaults (`hooks/use-settings.ts`): 50 bps slippage, a 300 s deadline. */
export const SLIPPAGE_BPS = 50n
export const DEADLINE_SECONDS = 300

export type Snapshot = { ms: MarketState; acc: AccountState; compliance: ComplianceItem[]; ledgerTime: number }

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

/** Blockers `useTradeRoute` does not check before the start for a later step (they need step outputs). */
const LATER_STEP_SKIPS = new Set<BlockerCode>(["amount", "balance", "quote", "archived"])

const readsOnlyFirst = (src: AmountSource): boolean => (src.from === "step" ? src.index === 0 : src.from === "sum" ? src.parts.every(readsOnlyFirst) : true)

export function createRunner(p: {
  manifest: Manifest
  market: Market
  findings: Finding[]
  kind: ComplianceKind
  signer: KeypairSigner
  log: (line: string) => void
}) {
  const { manifest, market, findings, kind, signer, log } = p
  const account = signer.publicKey
  const reader = () => createRpcReader(manifest)
  const horizon = () => createHorizon(manifest.horizonUrl)

  async function snapshot(): Promise<Snapshot> {
    const [clock, ms, acc] = await Promise.all([
      ledgerClock(manifest),
      fetchMarketState(reader(), manifest, market.marketId),
      fetchAccountState(reader(), horizon(), manifest, market.marketId, account, kind),
    ])
    return { ms, acc, compliance: evaluateAccountCompliance(acc, kind), ledgerTime: clock.now() }
  }

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
   * `useTradeRoute`'s refusals before the start, for `plans` (expected empty): step 1 with its own
   * simulation, the later steps on what does not need earlier outputs, the circuit breaker and the
   * deposit cap counted across the steps (R2-61, R2-62), and a later step's `requires` that reads only
   * step 1 checked against step 1's simulated output.
   */
  async function preStart(req: RouteRequest, plans: StepPlan[]): Promise<{ blockers: Blocker[]; firstOutput?: ActionOutput }> {
    const s = await snapshot()
    const ctx = base(s)
    const draftOf = (plan: StepPlan): { input: ActionInput; known: boolean } => {
      let amounts: { amount: bigint; secondaryAmount?: bigint }
      let known = true
      try {
        amounts = resolveStep({ ...plan, requires: [] }, req, [])
      } catch {
        amounts = { amount: req.amount }
        known = false
      }
      return {
        input: {
          action: plan.action,
          marketId: market.marketId,
          source: account,
          amount: amounts.amount,
          ...(amounts.secondaryAmount !== undefined ? { secondaryAmount: amounts.secondaryAmount } : {}),
          guards: {},
          deadline: 0n,
        },
        known,
      }
    }
    const counted = (total: bigint | undefined, adds: bigint | undefined, known: boolean) =>
      total === undefined || adds === undefined || (!known && adds !== 0n) ? undefined : total + adds
    const drafts = plans.map(draftOf)
    const first = drafts[0]
    const simInput: ActionInput = { ...first.input, guards: openGuards(first.input.action, first.input.amount), deadline: BigInt(Math.floor(s.ledgerTime) + DEADLINE_SECONDS) }
    const outcome = await simulate(manifest, simInput)
    const { output, guards } = derive(simInput, outcome, SLIPPAGE_BPS)
    const list: Blocker[] = [...evaluateGates(first.input, { ...ctx, simulation: outcome })]
    if (guards && !guards.ok) list.push({ code: "quote", message: guards.reason })
    let reported = counted(0n, breakerReport(first.input, ctx), first.known)
    let charged = counted(0n, capCharge(first.input), first.known)
    drafts.slice(1).forEach(({ input, known }, k) => {
      const n = k + 2
      const seen = withEarlierCapCharges(withEarlierReports(ctx, reported, n), charged, n)
      list.push(...evaluateGates(input, seen).filter((b) => !LATER_STEP_SKIPS.has(b.code)))
      reported = counted(reported, breakerReport(input, ctx), known)
      charged = counted(charged, capCharge(input), known)
    })
    if (output) {
      plans.slice(1).forEach((plan, k) => {
        const checks = (plan.requires ?? []).filter((r) => readsOnlyFirst(r.value) && readsOnlyFirst(r.atLeast))
        if (checks.length === 0) return
        try {
          resolveStep({ ...plan, amount: { from: "value", value: 0n }, secondaryAmount: undefined, requires: checks }, req, [output])
        } catch (error) {
          list.push({ code: "quote", message: `step ${k + 2}: ${error instanceof Error ? error.message : String(error)}` })
        }
      })
    }
    return { blockers: list.sort((a, b) => BLOCKER_ORDER.indexOf(a.code) - BLOCKER_ORDER.indexOf(b.code)), ...(output ? { firstOutput: output } : {}) }
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
    const { output: simulated, guards } = derive(draft, outcome, SLIPPAGE_BPS)
    if (!simulated || !guards?.ok) throw new Error(`${label}: no exact quote: ${json({ outcome, guards })}`)
    // A nonzero floor on every slippage-sensitive call, from this step's own simulation.
    const g = guards.guards
    expect(ACTION_META[plan.action].slippageSensitive, `${label} is slippage-sensitive`).toBe(true)
    expect(g.minOut !== undefined && g.minOut > 0n, `${label}: minOut ${String(g.minOut)}`).toBe(true)
    if (plan.action === "remove_liquidity") expect(g.minOut2 !== undefined && g.minOut2 > 0n, `${label}: minOut2`).toBe(true)
    if (plan.action === "buy_yt") expect(g.maxNetCost !== undefined && g.maxNetCost > 0n && g.maxNetCost < draft.amount, `${label}: maxNetCost`).toBe(true)

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
    return { index: i, action: plan.action, ...amounts, guards: g, simulated, decoded, hash: result.hash }
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
