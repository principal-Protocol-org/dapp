"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useExecute, type Execute } from "@/hooks/use-execute"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useSettings } from "@/hooks/use-settings"
import { derive, simulate } from "@/hooks/use-simulation"
import {
  closedCopy,
  firstOpen,
  holdsFunds,
  isDone,
  pickRun,
  readRoutes,
  sameProgress,
  writeRoute,
  type RouteRun,
  type RouteStep,
} from "@/lib/app/route-log"
import { invocationFor, type ActionId, type ActionInput } from "@/lib/protocol/actions"
import type { Blocker } from "@/lib/protocol/gates"
import { openGuards, parseOutput, type ActionOutput } from "@/lib/protocol/guards"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import { isExpired, SIGN_MARGIN_MS, type Review, type TxResult, type TxStatus } from "@/lib/protocol/review"
import {
  describeHoldings,
  resolveStep,
  routeHoldings,
  unwindFrom,
  type Holdings,
  type RouteKind,
  type RouteRequest,
  type StepPlan,
  type Unwind,
} from "@/lib/protocol/routes"
import {
  createRpcServer,
  failedTransactionReason,
  pollTransactionStatus,
  transactionEnvelopeHash,
  type ContractInvocation,
  type SimulationOutcome,
} from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"

/**
 * The 0001 gates for one step, from the panel's live context: `evaluateGates(input, { ...base,
 * simulation })`. The simulation is passed so 0001's own mapping of a failed simulation (contract
 * error, archived entry, RPC error) refuses the step; without it every step reads "waiting for a quote".
 */
export type RouteGate = (input: ActionInput, simulation?: SimulationOutcome) => Blocker[]

export type RoutePhase = "idle" | "reviewing" | "signing" | "waiting" | "interrupted" | "done"

export type RouteState = {
  phase: RoutePhase
  /** The step reviewed, signed, waited on, or next to run (1-based); 0 when idle. */
  step: number
  /** Number of steps; 0 when idle. */
  of: number
  /**
   * Interrupted: what the confirmed steps left with the user, in plain words ("You hold 1000 SY").
   * Waiting: what they had left before the step whose result is unknown ("You held 1000 SY before step 2. …").
   */
  holdings?: string
  /** Why the route stopped, or what it waits for, in plain words. */
  error?: string
  /** Interrupted by a gate: every blocker, in 0001's order (the first is `error`). */
  blockers?: Blocker[]
  /** The run as logged: plans, and each step's status and hash. */
  run?: RouteRun
  /** Reviewing (once prepared) and signing: the step's exact transaction, as 0001 reviews it. */
  review?: Review
  /** Seconds before `review` expires: the route then stops, and Continue prepares the step again. */
  secondsLeft?: number
  /** Interrupted: the single call back to USDY, or why there is none. */
  unwind?: { available: true; amount: bigint } | { available: false; reason: string }
  /** Interrupted by an archived entry: the call to restore first (0001's restore flow). */
  restore?: { source: string; invocation: ContractInvocation }
  /** Waiting: a re-check by hash is in flight. */
  checking?: boolean
  /** `dismiss()` does something now. */
  canDismiss: boolean
}

export type UseRouteOptions = {
  /** The connected account; routes are logged and resumed per account. */
  account: string | null
  marketId: string
  /**
   * The route kinds this host offers (R2-77): it resumes and starts only these, so two hosts never
   * hold the same run (PT tab `buy_pt|sell_pt`, YT tab `buy_yt|sell_yt`, LP tab `lp_*`, Recombine
   * dialogs `recombine`). Read when the route loads or starts; fixed per host.
   */
  kinds: readonly RouteKind[]
  /**
   * The run History's Continue names (`?route=<id>`): shown in place of the newest one when it is
   * this host's and still holds funds, even dismissed (R2-76), which the opening clears.
   */
  routeId?: string | null
  gate: RouteGate
  /**
   * A step reached the network: confirmed, or sent with its result not known yet (as 96c2ded, not
   * a FAILED one). The panel resets its amount fields on the first (R2-3): the route is described by
   * `state` and the log from then on, never by the fields.
   */
  onReachedNetwork?: (event: { step: number; status: TxStatus; hash: string }) => void
}

export type RouteControls = {
  state: RouteState
  /**
   * Logs a new run and prepares its first step. A no-op while a route holds funds between steps, and
   * for a kind this host does not offer.
   */
  start(req: RouteRequest, plans: StepPlan[]): void
  /** Signs the prepared step, exactly the review shown (R31). Prepares it again if it is about to expire. */
  sign(): void
  /** Interrupted: prepares the first step not confirmed. Waiting: re-checks the unknown step by its hash. */
  continue(): void
  /** Interrupted: replaces the remaining steps by the single call back to USDY, and prepares it. */
  unwind(): void
  /**
   * Closes what is on screen: a review not signed yet, a finished or interrupted route, or a lost
   * step. A route that still holds funds is dismissed, not closed: History keeps Continue (R2-76).
   */
  dismiss(): void
}

type View = {
  phase: RoutePhase
  index: number
  error?: string
  blockers?: Blocker[]
  review?: Review
  restore?: { source: string; invocation: ContractInvocation }
  checking?: boolean
  /** Waiting: the step's time limit passed but the network cannot say whether it landed. */
  lost?: boolean
}

/** What `prepareStep` produced for the step on screen: signed only if it still passes the gates. */
type Prepared = { review: Review; draft: ActionInput; outcome: SimulationOutcome; ledgerAt: number }

type Lookup =
  | { status: "SUCCESS"; output: ActionOutput | null; decodeError?: string }
  | { status: "FAILED"; reason: string }
  | { status: "NOT_FOUND"; final: boolean; lost: boolean }

type PollServer = NonNullable<Parameters<typeof pollTransactionStatus>[0]["server"]>

const IDLE: View = { phase: "idle", index: 0 }

/** Slack for the interpolated ledger clock when deciding a step cannot have landed before `sentAt`. */
const CLOCK_SLACK_S = 60

const text = (error: unknown) => (error instanceof Error ? error.message : String(error))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const newId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

const NOTHING_MOVED = "Nothing has moved yet: no step of this route has gone through."
const NOTHING_LEFT = "This route has left nothing waiting between its steps."
const UNREADABLE_HOLDINGS =
  "A step went through, but its result could not be read, so this app cannot say what you now hold. Check your balances in the Portfolio."
const clockMissing = (n: number) =>
  `Waiting for the network clock: the latest ledger time has not loaded, so step ${n}'s deadline cannot be set. Continue once it loads.`
const notSignedYet = (n: number, of: number) => `Step ${n} of ${of} has not been signed yet.`
const reviewExpired = (n: number) =>
  `The review of step ${n} expired before it was signed, so the route stopped. Continue to prepare it again with a fresh quote.`
const notKnown = (n: number) =>
  `Step ${n} was sent, but its result is not known yet. The route waits and never sends it again: check it again in a moment.`
const stillUnknown = (n: number) =>
  `Step ${n} is still not found on the network. It may still land, so the route keeps waiting: check again in a moment.`
const lostStep = (n: number) =>
  `Step ${n}'s time limit has passed, but the network no longer shows that far back, so this app cannot tell whether it went through. Look it up by its hash and check your balances, then close this route.`
const neverLanded = (n: number) =>
  `Step ${n} did not land before its time limit, so the network can no longer include it and it moved nothing. Continue to prepare it again.`
/** Another window (or panel) moved the run on: the log's copy is shown, and nothing runs from the old one. */
const MOVED_ON = "This route moved on in another window."
const unreadable = (n: number, why?: string) =>
  `Step ${n} went through, but its result could not be read${why ? ` (${why})` : ""}, so this app does not know the amount step ${n + 1} should use. Check your balances in the Portfolio.`

/**
 * A ledger close time as RPC passes it through from its JSON: a number or a decimal string (as
 * `getLedgerClock` reads `closeTime`). Anything else is unknown, so it can never prove a step lost.
 */
function closeTimeOf(value: unknown): number | undefined {
  if (typeof value === "string" ? value.trim() === "" : typeof value !== "number") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** The run as the log has it now; undefined when it is not there or the log cannot be read. */
const storedCopy = (run: RouteRun): RouteRun | undefined => readRoutes(run.account).find((r) => r.id === run.id)
/** The log's copy when it has moved on from `run` (another window signed or settled a step). */
function movedOnFrom(run: RouteRun): RouteRun | undefined {
  const now = storedCopy(run)
  return now && !sameProgress(now, run) ? now : undefined
}
/** History's Continue re-opened a dismissed run (R2-76): it is the panel's again. */
function reopened(run: RouteRun): RouteRun {
  const open = { ...run }
  delete open.dismissed
  return open
}

function withStep(run: RouteRun, i: number, step: RouteStep, output?: ActionOutput | null): RouteRun {
  const steps = run.steps.map((s, j) => (j === i ? step : s))
  if (output === undefined) return { ...run, steps }
  const outputs = [...run.outputs]
  while (outputs.length < i) outputs.push(null)
  outputs[i] = output
  return { ...run, steps, outputs }
}

/** What the confirmed steps left with the user; undefined when a confirmed step's result is unreadable. */
const holdingsOf = (run: RouteRun): Holdings | undefined =>
  routeHoldings(run.request, run.plans, run.outputs, firstOpen(run))

/**
 * Waiting on step `n`: what the confirmed steps left before it, said as such, since the unknown step
 * may have changed it (ruling R2-24: shown before a lost step can be closed).
 */
function waitingHoldings(run: RouteRun, n: number, underlying: { code: string; decimals: number }): string {
  const unknown = `Its result is not known yet: if it went through, your balances have changed.`
  if (firstOpen(run) === 0) return `Nothing had moved before step ${n}. ${unknown}`
  const h = holdingsOf(run)
  if (!h) return UNREADABLE_HOLDINGS
  const held = describeHoldings(h, underlying, "held")
  return held ? `${held} before step ${n}. ${unknown}` : `${NOTHING_LEFT} ${unknown}`
}

/** What the confirmed steps left with the user, in words, and the single call back to USDY from it. */
function interruption(run: RouteRun, underlying: { code: string; decimals: number }): { holdings: string; unwind: Unwind } {
  if (firstOpen(run) === 0) return { holdings: NOTHING_MOVED, unwind: unwindFrom({}) }
  const h = holdingsOf(run)
  if (!h) return { holdings: UNREADABLE_HOLDINGS, unwind: unwindFrom(undefined) }
  return { holdings: describeHoldings(h, underlying) ?? NOTHING_LEFT, unwind: unwindFrom(h) }
}

/**
 * One look at a sent step by its hash, through the 0001 poll helper. A NOT_FOUND is `final` only when
 * the network can no longer include it (its ledger close time passed the transaction's time bound)
 * and RPC's history reaches back to before it was sent; `lost` when the time bound passed but the
 * history does not reach that far.
 */
async function lookup(manifest: Manifest, action: ActionId, step: RouteStep): Promise<Lookup> {
  const { rpcUrl } = manifest
  const rpc = createRpcServer(rpcUrl)
  let window: { latest?: number; oldest?: number } = {}
  const server: PollServer = {
    getTransaction: async (hash) => {
      const res = await rpc.getTransaction(hash)
      window = { latest: closeTimeOf(res.latestLedgerCloseTime), oldest: closeTimeOf(res.oldestLedgerCloseTime) }
      return res
    },
  }
  const polled = await pollTransactionStatus({ rpcUrl, hash: step.hash ?? "", attempts: 1, server })
  if (polled.status === "SUCCESS") {
    if (polled.decodeError) return { status: "SUCCESS", output: null, decodeError: polled.decodeError }
    if (polled.returnValue === undefined) return { status: "SUCCESS", output: null, decodeError: "it returned no value" }
    try {
      return { status: "SUCCESS", output: parseOutput(action, polled.returnValue) }
    } catch (error) {
      return { status: "SUCCESS", output: null, decodeError: text(error) }
    }
  }
  if (polled.status === "FAILED") return { status: "FAILED", reason: failedTransactionReason(polled.failure) }
  const { latest, oldest } = window
  const pastLimit = step.validUntil !== undefined && latest !== undefined && latest > step.validUntil
  const covered = step.sentAt !== undefined && oldest !== undefined && oldest <= step.sentAt - CLOCK_SLACK_S
  const final = pastLimit && covered
  return { status: "NOT_FOUND", final, lost: !final && (step.validUntil === undefined || pastLimit) }
}

/**
 * Runs a route (spec 0002 §4) through the 0001 pipeline, one step at a time. Each step is resolved
 * from the outputs the confirmed steps actually produced, simulated as the user, gated, given floors
 * from that fresh simulation at the user's slippage, prepared by `useExecute().prepare` and, on the
 * user's `sign()`, executed by `useExecute().execute`: 0001's pipeline, unchanged, run once per step.
 *
 * Safety rules:
 * - Step n+1 is prepared only after step n is confirmed, from reads refreshed after it.
 * - The step's hash is logged before the wallet sees it, so a reload mid-signature re-checks the
 *   step by its hash instead of signing it again. A refusal before submission reverts it.
 * - A step whose result is not known (NOT_FOUND) is never submitted again: the route waits and
 *   re-checks it by its hash, on resume first of all.
 * - A reload never prepares or signs: it shows the interrupted route, holdings included.
 * - An unmounted, replaced or re-keyed route stops after logging the step in flight.
 * - Hosts are disjoint by kind (R2-77), and the log decides across windows: before a step is
 *   prepared, before it is signed and before a result is written, the run is read again by its id;
 *   if another window moved it on, the log's copy is shown and this one stops ("moved on"), so a
 *   step is never prepared or signed twice and a later step is never written over.
 */
export function useRoute(opts: UseRouteOptions): RouteControls {
  const { account, marketId } = opts
  const routeId = opts.routeId ?? null
  const manifest = useManifest()
  const exec = useExecute()
  const queryClient = useQueryClient()
  const { ledgerTime } = useLedgerClock()
  const { slippageBps, deadlineSeconds } = useSettings()

  const [view, setView] = useState<View>(IDLE)
  const [run, setRun] = useState<RouteRun | null>(null)
  const [nowMs, setNowMs] = useState<number | null>(null)

  const latest = useRef({ opts, exec, ledgerTime, slippageBps, deadlineSeconds, manifest })
  // A layout effect: current right after the commit, before a step resumes after its refetch.
  useLayoutEffect(() => {
    latest.current = { opts, exec, ledgerTime, slippageBps, deadlineSeconds, manifest }
  })
  const gen = useRef(0)
  const busy = useRef(false)
  const viewRef = useRef<View>(IDLE)
  const runRef = useRef<RouteRun | null>(null)
  const prepared = useRef<Prepared | null>(null)

  const engine = useMemo(() => {
    const live = (g: number) => g === gen.current
    const show = (g: number, v: View) => {
      if (!live(g)) return
      viewRef.current = v
      setView(v)
    }
    const interrupt = (g: number, index: number, error: string, extra: Pick<View, "blockers" | "restore"> = {}) =>
      show(g, { phase: "interrupted", index, error, ...extra })
    /** Logs the run whatever happens; shows it only while `g` is the live route. */
    const save = (g: number, next: RouteRun) => {
      writeRoute(next)
      if (!live(g)) return
      runRef.current = next
      setRun(next)
    }
    const release = (g: number) => {
      if (live(g)) busy.current = false
    }
    /** Shows the log's copy of a run another window moved on, and stops: nothing runs from the old copy. */
    const movedOn = (g: number, r: RouteRun) => {
      if (!live(g)) return
      prepared.current = null
      runRef.current = r
      setRun(r)
      const i = firstOpen(r)
      if (i >= r.steps.length) return show(g, { phase: "done", index: r.steps.length - 1 })
      if (r.steps[i].status === "unknown") return show(g, { phase: "waiting", index: i, error: MOVED_ON })
      interrupt(g, i, MOVED_ON)
    }
    /** Logs `next`, made from `base`, only while the log still has `base`'s progress; else shows the log's. */
    const commit = (g: number, base: RouteRun, next: RouteRun): boolean => {
      const elsewhere = movedOnFrom(base)
      if (elsewhere) {
        movedOn(g, elsewhere)
        return false
      }
      save(g, next)
      return true
    }
    const exe = (): Execute => latest.current.exec

    /** Refetches the account and market reads, then lets the panel render them so `gate` sees them. */
    async function refreshReads() {
      const { network } = latest.current.manifest
      try {
        await Promise.all([
          queryClient.refetchQueries({ queryKey: ["account", network] }),
          queryClient.refetchQueries({ queryKey: ["market", network] }),
        ])
      } catch {
        // A failed read shows as stale in the gate context, whose gates then refuse.
      }
      await tick()
      await tick()
    }

    async function prepareStep(g: number, r: RouteRun, i: number, refresh: boolean): Promise<void> {
      if (!live(g)) return
      busy.current = true
      prepared.current = null
      show(g, { phase: "reviewing", index: i })
      try {
        if (refresh) await refreshReads()
        if (!live(g)) return
        const elsewhere = movedOnFrom(r)
        if (elsewhere) return movedOn(g, elsewhere)
        const plan = r.plans[i]
        let amounts: { amount: bigint; secondaryAmount?: bigint }
        try {
          amounts = resolveStep(plan, r.request, r.outputs.map((o) => o ?? undefined) as ActionOutput[])
        } catch (error) {
          const lost = r.outputs.slice(0, i).findIndex((o) => o === null)
          return interrupt(g, i, lost === -1 ? text(error) : unreadable(lost + 1))
        }
        const clock = latest.current.ledgerTime
        if (clock === null) return interrupt(g, i, clockMissing(i + 1))
        const ledgerAt = Math.floor(clock)
        const draft: ActionInput = {
          action: plan.action,
          marketId: r.marketId,
          source: r.account,
          amount: amounts.amount,
          ...(amounts.secondaryAmount !== undefined ? { secondaryAmount: amounts.secondaryAmount } : {}),
          guards: openGuards(plan.action, amounts.amount),
          deadline: BigInt(ledgerAt + latest.current.deadlineSeconds),
        }
        const outcome = await simulate(latest.current.manifest, draft)
        if (!live(g)) return
        const restore =
          !outcome.ok && outcome.kind === "restore_required" ? { source: r.account, invocation: invocationFor(latest.current.manifest, draft) } : undefined
        const blockers = latest.current.opts.gate(draft, outcome)
        if (blockers.length > 0) return interrupt(g, i, blockers[0].message, { blockers, ...(restore ? { restore } : {}) })
        const { guards } = derive(draft, outcome, latest.current.slippageBps)
        if (!guards?.ok) return interrupt(g, i, guards?.reason ?? `Step ${i + 1} has no exact quote, so it was not prepared. Continue to try again.`)
        const review = await exe().prepare({ ...draft, guards: guards.guards })
        if (!live(g)) return
        prepared.current = { review, draft, outcome, ledgerAt }
        show(g, { phase: "reviewing", index: i, review })
      } catch (error) {
        interrupt(g, i, text(error))
      } finally {
        release(g)
      }
    }

    /** After step i settled as confirmed: done, the next step prepared, or (on a resume) stopped before it. */
    function afterConfirmed(g: number, r: RouteRun, i: number, output: ActionOutput | null, decodeError: string | undefined, proceed: boolean) {
      if (i + 1 >= r.steps.length) return show(g, { phase: "done", index: i })
      if (output === null) return interrupt(g, i + 1, unreadable(i + 1, decodeError))
      if (proceed) return void prepareStep(g, r, i + 1, true)
      interrupt(g, i + 1, notSignedYet(i + 2, r.steps.length))
    }

    async function sign(g: number) {
      const v = viewRef.current
      const p = prepared.current
      const r = runRef.current
      if (!r || v.phase !== "reviewing" || !p || v.review !== p.review || busy.current) return
      const i = v.index
      if (isExpired(p.review, Date.now() + SIGN_MARGIN_MS)) return void prepareStep(g, r, i, true)
      // The live gates, as SignFlow checks them at the click: anything new since preparing refuses.
      const blockers = latest.current.opts.gate(p.draft, p.outcome)
      if (blockers.length > 0) {
        prepared.current = null
        return interrupt(g, i, blockers[0].message, { blockers })
      }
      // Another window may have signed this step since it was prepared: the log decides, in the
      // same tick as the hash is logged below.
      const elsewhere = movedOnFrom(r)
      if (elsewhere) return movedOn(g, elsewhere)
      busy.current = true
      prepared.current = null
      const before = r.steps[i]
      // What to do once `busy` is released: preparing the next step takes `busy` again.
      let then: (() => void) | undefined
      try {
        // Logged before the wallet sees it: a reload now re-checks this hash rather than signing again.
        const hash = transactionEnvelopeHash(p.review.unsignedXdr, latest.current.manifest.networkPassphrase)
        const sent: RouteStep = { action: before.action, status: "unknown", hash, validUntil: p.review.summary.validUntil, sentAt: p.ledgerAt }
        const cur = withStep(r, i, sent)
        save(g, cur)
        show(g, { phase: "signing", index: i, review: p.review })
        let result: TxResult | undefined
        try {
          result = await exe().execute(p.review)
        } catch (error) {
          // Refused before anything reached the network (wallet, expiry, R31 checks, a busy network).
          if (commit(g, cur, withStep(cur, i, before))) interrupt(g, i, `Step ${i + 1} was not sent: ${text(error)}`)
        }
        if (result) {
          // A window that moved the run on meanwhile had this step's result already: its log stands.
          if (result.status === "SUCCESS") {
            const output = result.output ?? null
            const done = withStep(cur, i, { action: before.action, status: "confirmed", hash: result.hash }, output)
            const decodeError = result.decodeError
            if (commit(g, cur, done)) then = () => afterConfirmed(g, done, i, output, decodeError, true)
          } else if (result.status === "FAILED") {
            if (commit(g, cur, withStep(cur, i, { action: before.action, status: "failed", hash: result.hash }))) {
              interrupt(g, i, result.reason ?? `Step ${i + 1} failed on-chain. Only the network fee was charged.`)
            }
          } else if (commit(g, cur, withStep(cur, i, { ...sent, hash: result.hash }))) {
            show(g, { phase: "waiting", index: i, error: result.pollError ?? notKnown(i + 1) })
          }
          // Only once the result is logged (here, or already by the window that moved the run on),
          // and only to the panel still showing this route: a callback that throws must not
          // interrupt a route whose step is already settled.
          if (result.status !== "FAILED" && live(g)) {
            try {
              latest.current.opts.onReachedNetwork?.({ step: i + 1, status: result.status, hash: result.hash })
            } catch {
              // the panel's reset failed; the route state and the log stand
            }
          }
        }
      } catch (error) {
        interrupt(g, i, text(error))
      }
      release(g)
      then?.()
    }

    async function recheck(g: number, r: RouteRun, i: number, proceed: boolean) {
      const step = r.steps[i]
      busy.current = true
      const { error, lost } = viewRef.current
      show(g, { phase: "waiting", index: i, checking: true, ...(error ? { error } : {}), ...(lost ? { lost } : {}) })
      let found: Lookup
      try {
        found = await lookup(latest.current.manifest, step.action, step)
      } catch (error) {
        release(g)
        return show(g, {
          phase: "waiting",
          index: i,
          error: `Step ${i + 1}'s result could not be checked (${text(error)}). Check again in a moment.`,
          // One failed look does not undo what an earlier one established.
          ...(lost ? { lost } : {}),
        })
      }
      release(g)
      const hash = step.hash
      // Written only over the copy this look started from: another window may have moved on since.
      if (found.status === "SUCCESS") {
        const cur = withStep(r, i, { action: step.action, status: "confirmed", hash }, found.output)
        if (!commit(g, r, cur)) return
        return afterConfirmed(g, cur, i, found.output, found.decodeError, proceed)
      }
      if (found.status === "FAILED") {
        if (commit(g, r, withStep(r, i, { action: step.action, status: "failed", hash }))) interrupt(g, i, found.reason)
        return
      }
      if (found.final) {
        if (commit(g, r, withStep(r, i, { action: step.action, status: "failed", hash }))) interrupt(g, i, neverLanded(i + 1))
        return
      }
      show(g, { phase: "waiting", index: i, error: found.lost ? lostStep(i + 1) : stillUnknown(i + 1), lost: found.lost })
    }

    function start(req: RouteRequest, plans: StepPlan[]) {
      const { account: who, marketId: market, kinds } = latest.current.opts
      if (busy.current || !who || req.source !== who || req.marketId !== market || plans.length === 0 || !kinds.includes(req.kind)) return
      // The run on screen is always of this host's kinds (load and this guard), so this is the
      // host's funded-run check.
      const active = runRef.current
      if (active && holdsFunds(active)) return
      // Nothing had moved in the route on screen: it is closed (kept in history) and replaced,
      // unless another window moved it on since.
      if (active && !active.closed && !isDone(active)) {
        const elsewhere = movedOnFrom(active)
        if (elsewhere) return movedOn(gen.current, elsewhere)
        writeRoute(closedCopy(active))
      }
      const g = ++gen.current
      const fresh: RouteRun = {
        id: newId(),
        account: who,
        marketId: market,
        kind: req.kind,
        request: req,
        plans,
        outputs: [],
        steps: plans.map((p) => ({ action: p.action, status: "pending" })),
        startedAt: Date.now(),
      }
      save(g, fresh)
      void prepareStep(g, fresh, 0, false)
    }

    function resume() {
      const r = runRef.current
      const v = viewRef.current
      if (!r || busy.current || (v.phase !== "interrupted" && v.phase !== "waiting")) return
      const i = firstOpen(r)
      if (i >= r.steps.length) return show(gen.current, { phase: "done", index: r.steps.length - 1 })
      if (r.steps[i].status === "unknown") return void recheck(gen.current, r, i, true)
      if (v.phase === "interrupted") void prepareStep(gen.current, r, i, true)
    }

    function unwind() {
      const r = runRef.current
      if (!r || busy.current || viewRef.current.phase !== "interrupted") return
      const k = firstOpen(r)
      const u = unwindFrom(holdingsOf(r))
      if (!u.available || r.steps[k]?.status === "unknown") return
      const g = gen.current
      const next: RouteRun = {
        ...r,
        plans: [...r.plans.slice(0, k), u.plan],
        steps: [...r.steps.slice(0, k), { action: u.plan.action, status: "pending" }],
        outputs: r.outputs.slice(0, k),
        unwound: true,
      }
      if (!commit(g, r, next)) return
      void prepareStep(g, next, k, true)
    }

    /** Spec §4: an expired step stops the route. Nothing was sent; Continue prepares it again. */
    function expire(g: number, index: number) {
      if (!live(g) || busy.current || viewRef.current.phase !== "reviewing") return
      prepared.current = null
      interrupt(g, index, reviewExpired(index + 1))
    }

    function close() {
      const r = runRef.current
      // R2-76: a route that holds funds is dismissed (History keeps Continue), one with nothing held
      // is closed for good, a finished one stays "done". Only a flag is added, to the log's copy:
      // closing never undoes a step another window logged.
      if (r) {
        const now = storedCopy(r) ?? r
        const next = closedCopy(now)
        if (next !== now) writeRoute(next)
      }
      const g = ++gen.current
      busy.current = false
      prepared.current = null
      runRef.current = null
      setRun(null)
      show(g, IDLE)
    }

    function dismiss() {
      const r = runRef.current
      const v = viewRef.current
      if (!r || v.phase === "signing" || v.phase === "idle") return
      if (v.phase === "reviewing") {
        // Dropping an unsigned review is always safe; an in-flight preparation is abandoned.
        if (!holdsFunds(r)) return close()
        const g = ++gen.current
        busy.current = false
        prepared.current = null
        return interrupt(g, v.index, notSignedYet(v.index + 1, r.steps.length))
      }
      if (busy.current) return
      if (v.phase === "waiting" && !v.lost) return
      close()
    }

    /**
     * On mount and on an account, market or `routeId` change: the run History's Continue names, else
     * the newest of this host's kinds on this market that holds funds and was not dismissed.
     */
    function load(g: number, who: string | null, market: string) {
      if (!live(g)) return
      const { kinds, routeId } = latest.current.opts
      let found = who ? pickRun(readRoutes(who), { marketId: market, kinds, preferId: routeId }) : undefined
      if (found?.dismissed) {
        found = reopened(found)
        writeRoute(found)
      }
      runRef.current = found ?? null
      setRun(found ?? null)
      if (!found) return show(g, IDLE)
      const i = firstOpen(found)
      if (found.steps[i]?.status === "unknown") return void recheck(g, found, i, false)
      interrupt(g, i, notSignedYet(i + 1, found.steps.length))
    }

    /** Stops the route on screen: a step in flight still logs its result, but nothing shows or continues. */
    function stop() {
      gen.current++
    }

    return { prepareStep, sign, start, resume, unwind, dismiss, load, stop, expire }
  }, [queryClient])

  // Resume from the log; a change of account, market or named run stops the route on screen (it
  // stays logged). `kinds` is read at load time, never a dependency: hosts pass it inline.
  useEffect(() => {
    const g = ++gen.current
    busy.current = false
    prepared.current = null
    void Promise.resolve().then(() => engine.load(g, account, marketId))
    return () => engine.stop()
  }, [account, marketId, routeId, engine])

  // A prepared step left unsigned for 60 s expires and stops the route (spec §4), with its holdings
  // shown. Signing with under 20 s left prepares it again instead (`sign`).
  useEffect(() => {
    if (view.phase !== "reviewing" || !view.review) return
    const review = view.review
    const index = view.index
    const id = setInterval(() => {
      const now = Date.now()
      setNowMs(now)
      if (isExpired(review, now)) engine.expire(gen.current, index)
    }, 1_000)
    return () => clearInterval(id)
  }, [view, engine])

  const market = getMarket(manifest, marketId)
  const underlying = market ? { code: market.underlying.code, decimals: market.underlying.decimals } : { code: "USDY", decimals: 7 }
  const n = run?.steps.length ?? 0
  const idle = view.phase === "idle" || run === null
  const stop = view.phase === "interrupted" && run ? interruption(run, underlying) : undefined
  const pending = view.phase === "waiting" && run ? waitingHoldings(run, view.index + 1, underlying) : undefined
  const shown = view.phase === "reviewing" || view.phase === "signing" ? view.review : undefined
  const state: RouteState = {
    phase: idle ? "idle" : view.phase,
    step: idle ? 0 : Math.min(view.index + 1, n),
    of: idle ? 0 : n,
    ...(stop ? { holdings: stop.holdings, unwind: stop.unwind.available ? { available: true, amount: stop.unwind.amount } : stop.unwind } : {}),
    ...(pending ? { holdings: pending } : {}),
    ...(view.error && !idle ? { error: view.error } : {}),
    ...(view.blockers && !idle ? { blockers: view.blockers } : {}),
    ...(run && !idle ? { run } : {}),
    ...(shown ? { review: shown } : {}),
    ...(shown && nowMs !== null && nowMs >= shown.preparedAtMs
      ? { secondsLeft: Math.max(0, Math.ceil((shown.expiresAtMs - nowMs) / 1000)) }
      : {}),
    ...(view.restore && !idle ? { restore: view.restore } : {}),
    ...(view.checking ? { checking: true } : {}),
    canDismiss:
      !idle &&
      (view.phase === "reviewing" || view.phase === "interrupted" || view.phase === "done" || (view.phase === "waiting" && !!view.lost && !view.checking)),
  }

  return {
    state,
    start: engine.start,
    sign: () => void engine.sign(gen.current),
    continue: engine.resume,
    unwind: engine.unwind,
    dismiss: engine.dismiss,
  }
}
