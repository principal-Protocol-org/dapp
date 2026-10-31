import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { nativeToScVal } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ActionInput } from "@/lib/protocol/actions"
import type { Blocker } from "@/lib/protocol/gates"
import type { Review, TxResult } from "@/lib/protocol/review"
import type { SimulationOutcome } from "@/lib/protocol/stellar"

/**
 * The route runner drives the 0001 pipeline once per step. `useExecute` is a fake (component and
 * hook tests never build real transactions), the simulation and the hash lookup are fakes of
 * `lib/protocol/stellar`, and the route log is jsdom's localStorage.
 */

const S = 10_000_000n
const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const LEDGER = 1_700_000_000

const mocks = vi.hoisted(() => ({
  exec: {
    prepare: vi.fn(),
    execute: vi.fn(),
    prepareRestore: vi.fn(),
    executeRestore: vi.fn(),
    pending: false,
  },
  ledgerTime: 1_700_000_000 as number | null,
  simulateInvocation: vi.fn(),
  getTransaction: vi.fn(),
}))

vi.mock("@/hooks/use-execute", () => ({ useExecute: () => mocks.exec }))
vi.mock("@/hooks/use-ledger-clock", () => ({
  useLedgerClock: () => ({ ledgerTime: mocks.ledgerTime, sequence: 1, isError: false }),
}))
vi.mock("@/lib/protocol/manifest-source", () => ({
  activeManifest: () => ({
    network: "testnet",
    rpcUrl: "https://rpc",
    networkPassphrase: "Test SDF Network ; September 2015",
    markets: [
      {
        marketId: "m1",
        displayName: "x",
        underlying: { code: "USDY", decimals: 7 },
        contracts: { router: "CROUTER", sy: "CSY", pool: "CPOOL", manager: "CMANAGER" },
      },
    ],
  }),
}))
vi.mock("@/lib/protocol/stellar", async (orig) => ({
  ...(await orig<object>()),
  simulateInvocation: mocks.simulateInvocation,
  createRpcServer: () => ({ getTransaction: mocks.getTransaction }),
  transactionEnvelopeHash: (xdr: string) => `hash-of-${xdr}`,
}))

import { useRoute, type RouteGate } from "@/hooks/use-route"
import { readRoutes, writeRoute, type RouteRun } from "@/lib/app/route-log"
import { planRoute, type RouteRequest, type StepPlan } from "@/lib/protocol/routes"

let client: QueryClient
const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>

/** What the simulation returns for each action, through scValToNative. */
const SIMULATED: Partial<Record<ActionInput["action"], unknown>> = {
  deposit: 998n * S,
  buy_pt: 1_010n * S,
  withdraw: 997n * S,
  sell_pt: 9n * S,
  remove_liquidity: [10n * S, 5n * S],
}

let xdrSeq = 0
function fakeReview(input: ActionInput): Review {
  const now = Date.now()
  return {
    input,
    invocation: { contractId: "C", functionName: input.action, args: [] },
    unsignedXdr: `xdr-${input.action}-${++xdrSeq}`,
    unsignedXdrHash: "x",
    fee: "100",
    preparedAtMs: now,
    expiresAtMs: now + 60_000,
    summary: { give: [], getAtLeast: [], fees: [], validUntil: LEDGER + 300 },
    callTree: [],
  }
}

const hashOf = (review: Review) => `hash-of-${review.unsignedXdr}`
const success = (review: Review, output: TxResult["output"]): TxResult => ({ hash: hashOf(review), status: "SUCCESS", output })
const amountOut = (value: bigint): TxResult["output"] => ({ kind: "amount", value })

const buyPt: RouteRequest = {
  kind: "buy_pt",
  marketId: "m1",
  source: A,
  amount: 1_000n * S,
  pay: "underlying",
  receive: "underlying",
  matured: false,
}
const plansFor = (req: RouteRequest): StepPlan[] => {
  const p = planRoute(req, { routerFunctions: [] })
  if ("disabled" in p) throw new Error(p.disabled)
  return p
}

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(gateImpl: RouteGate = () => []) {
  const gate = vi.fn(gateImpl)
  const onReachedNetwork = vi.fn()
  const hook = renderHook(() => useRoute({ account: A, marketId: "m1", gate, onReachedNetwork }), { wrapper })
  return { ...hook, gate, onReachedNetwork }
}

async function untilReview(result: { current: ReturnType<typeof useRoute> }, step: number) {
  await waitFor(() => {
    expect(result.current.state.phase).toBe("reviewing")
    expect(result.current.state.step).toBe(step)
    expect(result.current.state.review).toBeDefined()
  })
}

const loggedRun = (): RouteRun | undefined => readRoutes(A)[0]

beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  mocks.ledgerTime = LEDGER
  mocks.exec.prepare.mockReset().mockImplementation(async (input: ActionInput) => fakeReview(input))
  mocks.exec.execute.mockReset()
  mocks.getTransaction.mockReset()
  mocks.simulateInvocation.mockReset().mockImplementation(async (p: { invocation: { functionName: string } }): Promise<SimulationOutcome> => {
    const byFn: Record<string, ActionInput["action"]> = {
      deposit: "deposit",
      swap_sy_for_pt: "buy_pt",
      unwrap: "withdraw",
      swap_pt_for_sy: "sell_pt",
      remove_liquidity: "remove_liquidity",
    }
    const action = byFn[p.invocation.functionName]
    return { ok: true, retval: SIMULATED[action], latestLedger: 1, minResourceFee: "1" }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useRoute", () => {
  it("steps run in order and step 2 is prepared only after step 1 is confirmed", async () => {
    const calls: string[] = []
    mocks.exec.prepare.mockImplementation(async (input: ActionInput) => {
      calls.push(`prepare:${input.action}`)
      return fakeReview(input)
    })
    const step1 = deferred<TxResult>()
    mocks.exec.execute.mockImplementation((review: Review) => {
      calls.push(`execute:${review.input.action}`)
      return review.input.action === "deposit" ? step1.promise : Promise.resolve(success(review, amountOut(1_010n * S)))
    })
    const { result } = setup()

    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    expect(result.current.state.of).toBe(2)
    // Prepared, not signed: signing is the user's click.
    expect(mocks.exec.execute).not.toHaveBeenCalled()

    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("signing"))
    expect(calls).toEqual(["prepare:deposit", "execute:deposit"])

    await act(async () => step1.resolve(success(mocks.exec.execute.mock.calls[0][0], amountOut(998n * S))))
    await untilReview(result, 2)
    expect(calls).toEqual(["prepare:deposit", "execute:deposit", "prepare:buy_pt"])

    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("done"))
    expect(result.current.state).toMatchObject({ step: 2, of: 2 })
    expect(calls).toEqual(["prepare:deposit", "execute:deposit", "prepare:buy_pt", "execute:buy_pt"])
    expect(loggedRun()?.steps.map((s) => s.status)).toEqual(["confirmed", "confirmed"])
  })

  it("step 2 uses step 1's parsed output, with floors from a fresh simulation", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review) => success(review, amountOut(998n * S)))
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await untilReview(result, 2)

    const step2: ActionInput = mocks.exec.prepare.mock.calls[1][0]
    expect(step2.action).toBe("buy_pt")
    // The deposit returned 998 SY, not the 1 000 USDY typed: step 2 spends what step 1 produced.
    expect(step2.amount).toBe(998n * S)
    // Floor = the fresh simulation of step 2 (1 010 PT) at the default 50 bps, never zero.
    expect(step2.guards.minOut).toBe((1_010n * S * 9_950n) / 10_000n)
    const simulated = mocks.simulateInvocation.mock.calls.map((c) => c[0].invocation.functionName)
    expect(simulated).toEqual(["deposit", "swap_sy_for_pt"])
    // The deadline is ledger time plus the default 300 s, never the device clock.
    expect(step2.deadline).toBe(BigInt(LEDGER + 300))
  })

  it("interrupted route reports holdings", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review) => {
      if (review.input.action === "buy_pt") throw new Error("The wallet declined the request.")
      return success(review, amountOut(998n * S))
    })
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await untilReview(result, 2)
    act(() => result.current.sign())

    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(result.current.state.step).toBe(2)
    expect(result.current.state.holdings).toMatch(/You hold .* SY/)
    expect(result.current.state.holdings).toBe("You hold 998 SY")
    expect(result.current.state.error).toMatch(/declined/)
    // A refusal sent nothing: step 2 stays pending, with no hash.
    expect(loggedRun()?.steps[1]).toEqual({ action: "buy_pt", status: "pending" })
  })

  it("NOT_FOUND waits, never resubmits", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review): Promise<TxResult> => ({ hash: hashOf(review), status: "NOT_FOUND" }))
    mocks.getTransaction.mockResolvedValue({ status: "NOT_FOUND", latestLedgerCloseTime: LEDGER + 20, oldestLedgerCloseTime: LEDGER - 3600 })
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())

    await waitFor(() => expect(result.current.state.phase).toBe("waiting"))
    expect(result.current.state.step).toBe(1)
    const hash = hashOf(mocks.exec.execute.mock.calls[0][0])
    expect(loggedRun()?.steps[0]).toMatchObject({ action: "deposit", status: "unknown", hash })

    // Neither signing again nor continuing submits it again: continue re-checks it by its hash.
    act(() => result.current.sign())
    act(() => result.current.continue())
    await waitFor(() => expect(mocks.getTransaction).toHaveBeenCalledWith(hash))
    await waitFor(() => expect(result.current.state.phase).toBe("waiting"))
    expect(result.current.state.error).toMatch(/not found/i)
    expect(mocks.exec.execute).toHaveBeenCalledTimes(1)
    expect(mocks.exec.prepare).toHaveBeenCalledTimes(1)
    // A new route cannot start over a step whose result is unknown.
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    expect(mocks.exec.prepare).toHaveBeenCalledTimes(1)
  })

  it("a re-check by hash that finds SUCCESS reads its output and moves on to step 2", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review): Promise<TxResult> => ({ hash: hashOf(review), status: "NOT_FOUND" }))
    mocks.getTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: nativeToScVal(996n * S, { type: "i128" }) })
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("waiting"))

    act(() => result.current.continue())
    await untilReview(result, 2)
    expect(mocks.exec.prepare.mock.calls[1][0]).toMatchObject({ action: "buy_pt", amount: 996n * S })
    expect(loggedRun()?.steps[0].status).toBe("confirmed")
    expect(mocks.exec.execute).toHaveBeenCalledTimes(1)
  })

  it("a step still unknown after its time limit, with history covering it, never landed", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review): Promise<TxResult> => ({ hash: hashOf(review), status: "NOT_FOUND" }))
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("waiting"))

    // RPC history that starts after the step was sent cannot prove anything: it keeps waiting.
    mocks.getTransaction.mockResolvedValueOnce({ status: "NOT_FOUND", latestLedgerCloseTime: LEDGER + 400, oldestLedgerCloseTime: LEDGER + 100 })
    act(() => result.current.continue())
    await waitFor(() => expect(mocks.getTransaction).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.state.phase).toBe("waiting"))
    expect(result.current.state.canDismiss).toBe(true)

    // History covering the whole validity window, past its end: the network can no longer include it.
    mocks.getTransaction.mockResolvedValueOnce({ status: "NOT_FOUND", latestLedgerCloseTime: LEDGER + 400, oldestLedgerCloseTime: LEDGER - 3600 })
    act(() => result.current.continue())
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(result.current.state.error).toMatch(/time limit/)
    expect(loggedRun()?.steps[0].status).toBe("failed")
    expect(mocks.exec.execute).toHaveBeenCalledTimes(1)
  })

  it("reload resumes from log", async () => {
    const plans = plansFor(buyPt)
    writeRoute({
      id: "run-1",
      account: A,
      marketId: "m1",
      kind: "buy_pt",
      request: buyPt,
      plans,
      outputs: [{ kind: "amount", value: 998n * S }],
      steps: [
        { action: "deposit", status: "confirmed", hash: "f".repeat(64) },
        { action: "buy_pt", status: "pending" },
      ],
      startedAt: 1,
    })
    const first = setup()
    await waitFor(() => expect(first.result.current.state.phase).toBe("interrupted"))
    first.unmount()

    const { result } = setup()
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(result.current.state).toMatchObject({ step: 2, of: 2, holdings: "You hold 998 SY" })
    // Nothing is prepared, let alone signed, on a reload: the user continues.
    expect(mocks.exec.prepare).not.toHaveBeenCalled()

    act(() => result.current.continue())
    await untilReview(result, 2)
    expect(mocks.exec.prepare).toHaveBeenCalledTimes(1)
    expect(mocks.exec.prepare.mock.calls[0][0]).toMatchObject({ action: "buy_pt", amount: 998n * S })
  })

  it("on reload an unknown step is re-checked by its hash before anything else", async () => {
    writeRoute({
      id: "run-2",
      account: A,
      marketId: "m1",
      kind: "buy_pt",
      request: buyPt,
      plans: plansFor(buyPt),
      outputs: [],
      steps: [
        { action: "deposit", status: "unknown", hash: "e".repeat(64), validUntil: LEDGER + 300, sentAt: LEDGER },
        { action: "buy_pt", status: "pending" },
      ],
      startedAt: 1,
    })
    mocks.getTransaction.mockResolvedValue({ status: "SUCCESS", returnValue: nativeToScVal(998n * S, { type: "i128" }) })
    const { result } = setup()
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(mocks.getTransaction).toHaveBeenCalledWith("e".repeat(64))
    expect(result.current.state).toMatchObject({ step: 2, holdings: "You hold 998 SY" })
    expect(mocks.exec.prepare).not.toHaveBeenCalled()
    expect(loggedRun()?.outputs[0]).toEqual({ kind: "amount", value: 998n * S })
  })

  it("unwind builds the single call back to USDY, withdraw for SY holdings", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review) => {
      if (review.input.action === "buy_pt") throw new Error("The wallet declined the request.")
      return success(review, amountOut(review.input.action === "withdraw" ? 997n * S : 998n * S))
    })
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await untilReview(result, 2)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(result.current.state.unwind).toEqual({ available: true, amount: 998n * S })

    act(() => result.current.unwind())
    await untilReview(result, 2)
    expect(mocks.exec.prepare.mock.calls.at(-1)?.[0]).toMatchObject({ action: "withdraw", amount: 998n * S })
    expect(result.current.state.of).toBe(2)
    expect(loggedRun()).toMatchObject({ unwound: true, steps: [{ action: "deposit", status: "confirmed" }, { action: "withdraw", status: "pending" }] })

    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("done"))
  })

  it("unwind is disabled when no single call goes back to USDY", async () => {
    const withdrawLp: RouteRequest = { ...buyPt, kind: "lp_withdraw", amount: 3n * S }
    mocks.exec.execute.mockImplementation(async (review: Review) =>
      success(review, { kind: "remove_liquidity", pt: 10n * S, sy: 5n * S }),
    )
    // Step 2 (sell the PT) is refused by a gate: the user holds PT and SY.
    const { result } = setup((input) => (input.action === "sell_pt" ? [{ code: "maturity", message: "The market has matured." }] : []))
    act(() => result.current.start(withdrawLp, plansFor(withdrawLp)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(result.current.state.holdings).toBe("You hold 10 PT and 5 SY")
    const u = result.current.state.unwind
    expect(u?.available).toBe(false)
    if (u && !u.available) expect(u.reason).toMatch(/PT/)

    const prepared = mocks.exec.prepare.mock.calls.length
    act(() => result.current.unwind())
    expect(mocks.exec.prepare).toHaveBeenCalledTimes(prepared)
    expect(result.current.state.phase).toBe("interrupted")
  })

  it("every step passes the gates before prepare", async () => {
    const calls: string[] = []
    let blockStep2 = true
    mocks.exec.prepare.mockImplementation(async (input: ActionInput) => {
      calls.push(`prepare:${input.action}`)
      return fakeReview(input)
    })
    mocks.exec.execute.mockImplementation(async (review: Review) => success(review, amountOut(998n * S)))
    const { result, gate } = setup((input, simulation) => {
      calls.push(`gate:${input.action}:${simulation?.ok ? "simulated" : "unsimulated"}`)
      return input.action === "buy_pt" && blockStep2 ? [{ code: "pause", message: "The pool is paused." } satisfies Blocker] : []
    })
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))

    // Each gate call sees the step's own input and simulation; a blocked step is never prepared.
    // The prepared step is gated again at the click, as SignFlow does with the live blockers.
    expect(calls).toEqual(["gate:deposit:simulated", "prepare:deposit", "gate:deposit:simulated", "gate:buy_pt:simulated"])
    expect(gate.mock.calls[2][0]).toMatchObject({ action: "buy_pt", amount: 998n * S })
    expect(result.current.state).toMatchObject({ step: 2, error: "The pool is paused.", holdings: "You hold 998 SY" })
    expect(result.current.state.blockers).toEqual([{ code: "pause", message: "The pool is paused." }])

    blockStep2 = false
    act(() => result.current.continue())
    await untilReview(result, 2)
    expect(calls.slice(-2)).toEqual(["gate:buy_pt:simulated", "prepare:buy_pt"])
  })

  it("a blocker that appears after the step was prepared refuses the signature", async () => {
    let paused = false
    const { result } = setup(() => (paused ? [{ code: "pause", message: "The pool is paused." }] : []))
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    paused = true
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(result.current.state.error).toBe("The pool is paused.")
    expect(mocks.exec.execute).not.toHaveBeenCalled()
    expect(loggedRun()?.steps[0]).toEqual({ action: "deposit", status: "pending" })
  })

  it("step 2 is gated on reads refreshed after step 1 confirmed", async () => {
    const order: string[] = []
    const refetch = vi.spyOn(client, "refetchQueries").mockImplementation(async (filters) => {
      order.push(`refetch:${String((filters as { queryKey?: unknown[] })?.queryKey?.[0])}`)
    })
    mocks.exec.execute.mockImplementation(async (review: Review) => success(review, amountOut(998n * S)))
    const { result } = setup((input) => {
      order.push(`gate:${input.action}`)
      return []
    })
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await untilReview(result, 2)
    // gate:deposit twice: when prepared, and again at the click.
    expect(order).toEqual(["gate:deposit", "gate:deposit", "refetch:account", "refetch:market", "gate:buy_pt"])
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["account", "testnet"] })
  })

  it("logs the step's hash before the wallet signs, and reverts it when the wallet refuses", async () => {
    const step1 = deferred<TxResult>()
    mocks.exec.execute.mockImplementation(() => step1.promise)
    const { result, onReachedNetwork } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    const review = result.current.state.review!
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("signing"))

    // A reload now finds the hash, so the step is re-checked instead of signed a second time.
    expect(loggedRun()?.steps[0]).toEqual({ action: "deposit", status: "unknown", hash: hashOf(review), validUntil: LEDGER + 300, sentAt: LEDGER })

    await act(async () => step1.reject(new Error("The wallet declined the request.")))
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(loggedRun()?.steps[0]).toEqual({ action: "deposit", status: "pending" })
    expect(result.current.state.holdings).toMatch(/Nothing has moved/)
    expect(result.current.state.unwind).toMatchObject({ available: false })
    expect(onReachedNetwork).not.toHaveBeenCalled()
    // Nothing moved, so a new route may replace this one.
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    expect(readRoutes(A).filter((r) => !r.closed)).toHaveLength(1)
  })

  it("an unmount mid-signature logs the step's result but never prepares the next step", async () => {
    const step1 = deferred<TxResult>()
    mocks.exec.execute.mockImplementation(() => step1.promise)
    const { result, unmount } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("signing"))
    const review = mocks.exec.execute.mock.calls[0][0] as Review
    unmount()
    await act(async () => step1.resolve(success(review, amountOut(998n * S))))
    await new Promise((r) => setTimeout(r, 20))
    expect(loggedRun()?.steps.map((s) => s.status)).toEqual(["confirmed", "pending"])
    expect(loggedRun()?.outputs[0]).toEqual({ kind: "amount", value: 998n * S })
    expect(mocks.exec.prepare).toHaveBeenCalledTimes(1)
    expect(mocks.simulateInvocation).toHaveBeenCalledTimes(1)
  })

  it("tells the panel when a step reaches the network (R2-3), not when it fails or is refused", async () => {
    mocks.exec.execute.mockImplementationOnce(async (review: Review): Promise<TxResult> => ({ hash: hashOf(review), status: "FAILED", reason: "Cause: the pool moved." }))
    const { result, onReachedNetwork } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    expect(result.current.state.error).toMatch(/pool moved/)
    expect(loggedRun()?.steps[0]).toMatchObject({ status: "failed" })
    expect(onReachedNetwork).not.toHaveBeenCalled()

    // Continue prepares the failed step again (a FAILED transaction is final), then it lands.
    mocks.exec.execute.mockImplementation(async (review: Review) => success(review, amountOut(998n * S)))
    act(() => result.current.continue())
    await untilReview(result, 1)
    act(() => result.current.sign())
    await untilReview(result, 2)
    expect(onReachedNetwork).toHaveBeenCalledTimes(1)
    expect(onReachedNetwork).toHaveBeenCalledWith({ step: 1, status: "SUCCESS", hash: expect.stringContaining("hash-of-") })
  })

  it("does not start while a route holds funds between steps", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review) => {
      if (review.input.action === "buy_pt") throw new Error("declined")
      return success(review, amountOut(998n * S))
    })
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await untilReview(result, 2)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("interrupted"))
    const prepared = mocks.exec.prepare.mock.calls.length
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    expect(mocks.exec.prepare).toHaveBeenCalledTimes(prepared)
    expect(result.current.state.step).toBe(2)

    // Closing it keeps it in the log, and frees the panel.
    act(() => result.current.dismiss())
    expect(result.current.state.phase).toBe("idle")
    expect(loggedRun()?.closed).toBe(true)
  })

  it("re-prepares an expiring review instead of signing it", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review) => success(review, amountOut(998n * S)))
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    const first = result.current.state.review!
    const now = Date.now()
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 45_000)
    try {
      act(() => result.current.sign())
      await waitFor(() => expect(result.current.state.review).not.toBe(first))
      await untilReview(result, 1)
      expect(mocks.exec.execute).not.toHaveBeenCalled()
      expect(mocks.exec.prepare).toHaveBeenCalledTimes(2)
      expect(mocks.simulateInvocation).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
  })

  it("an expired step stops the route, with its holdings, and Continue prepares it again", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review) => success(review, amountOut(998n * S)))
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await untilReview(result, 2)
    const spy = vi.spyOn(Date, "now").mockReturnValue(result.current.state.review!.preparedAtMs + 60_000)
    try {
      await waitFor(() => expect(result.current.state.phase).toBe("interrupted"), { timeout: 3_000 })
      expect(result.current.state).toMatchObject({ step: 2, holdings: "You hold 998 SY" })
      expect(result.current.state.error).toMatch(/expired before it was signed/)
      expect(mocks.exec.execute).toHaveBeenCalledTimes(1)
      expect(mocks.exec.prepare).toHaveBeenCalledTimes(2)
    } finally {
      spy.mockRestore()
    }
    act(() => result.current.continue())
    await untilReview(result, 2)
    expect(mocks.exec.prepare).toHaveBeenCalledTimes(3)
  })

  it("dismissing a finished route keeps it done in the log", async () => {
    mocks.exec.execute.mockImplementation(async (review: Review) => success(review, amountOut(998n * S)))
    const { result } = setup()
    act(() => result.current.start(buyPt, plansFor(buyPt)))
    await untilReview(result, 1)
    act(() => result.current.sign())
    await untilReview(result, 2)
    act(() => result.current.sign())
    await waitFor(() => expect(result.current.state.phase).toBe("done"))
    act(() => result.current.dismiss())
    expect(result.current.state.phase).toBe("idle")
    expect(loggedRun()?.closed).toBeUndefined()
    expect(loggedRun()?.steps.map((s) => s.status)).toEqual(["confirmed", "confirmed"])
  })
})
