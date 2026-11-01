// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { AccountState } from "../account-state"
import { ACTION_META } from "../actions"
import type { ComplianceItem } from "../compliance"
import type { Blocker, GateContext } from "../gates"
import type { MarketState } from "../market-state"
import { SCALE } from "../math"
import { isOffered, preStartDraft, routePreStartBlockers, type PreStartInput } from "../route-gates"
import type { RouteRequest, StepPlan } from "../routes"
import type { SimulationOutcome } from "../stellar"
import type { Live } from "../types"
import { indexFor } from "../yield"

// ---------------------------------------------------------------- fixtures

const USER = "GUSERACCOUNT"
const MATURITY = 1_800_000_000
const BEFORE = MATURITY - 86_400
const RATE = 10_500_000n
const U = 10_000_000n
const BIG = 1_000_000n * U

const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 500 })

function market(): MarketState {
  return {
    oracleRate: live(RATE),
    oracleTimestamp: live(BigInt(BEFORE)),
    oracleFresh: live(true),
    maturity: live(BigInt(MATURITY)),
    settledRate: live(null),
    ytFrozen: live(false),
    ytAccruedIndex: live(indexFor(RATE)),
    totalPt: live(BIG),
    totalYt: live(BIG),
    poolState: live({ ptReserve: BIG, syReserve: BIG, totalLp: BIG, rate: RATE, exponent: 10n ** 18n, feeRate: 3n, secondsToMaturity: 86_400n }),
    poolSeeded: live(true),
    ptPrice: live(9_500_000n),
    impliedRate: live(600_000n),
    lpTotalSupply: live(BIG),
    fees: { tokenizationBps: live(10n), ytBps: live(20n), swapTierBps: live(30n), protocolShareBps: live(40n) },
    swapFeeRate: live(3n),
    exchangeRate: live(SCALE),
    managerSy: live(0n),
    syPaused: live(false),
    poolPaused: live(false),
    riskPaused: live(false),
    cb: { limit: live(BIG), volume: live(0n), assetLimit: live(0n), assetVolume: live(0n) },
    topology: live({ matches: true, mismatches: [] }),
  }
}

function account(): AccountState {
  return {
    underlying: live(BIG),
    sy: live(BIG),
    pt: live(BIG),
    yt: live(BIG),
    lp: live(BIG),
    ytLastClaimedIndex: live(indexFor(RATE)),
    ytPendingClaim: live(U),
    depositCap: live(0n),
    netDeposited: live(0n),
    sacAuthorized: live(true),
    sep57: null,
    permAllowed: live(true),
    permPt: live(true),
    permYt: live(true),
    trustline: live("authorized"),
    accountExists: live(true),
  }
}

const compliance: ComplianceItem[] = (["account", "trustline", "authorized", "permissioning", "perm_pt", "perm_yt"] as const).map((id) => ({
  id,
  status: "ok",
  message: `${id} is fine.`,
}))

function base(patch: (b: Omit<GateContext, "simulation">) => void = () => {}): Omit<GateContext, "simulation"> {
  const b: Omit<GateContext, "simulation"> = {
    findings: [],
    wallet: { status: "connected", publicKey: USER, networkPassphrase: "Test SDF Network ; September 2015" },
    market: market(),
    account: account(),
    compliance,
    ledgerTime: BEFORE,
    managerId: "CMANAGER",
  }
  patch(b)
  return b
}

const request = (kind: RouteRequest["kind"], amount: bigint): RouteRequest => ({
  kind,
  marketId: "m1",
  source: USER,
  amount,
  pay: "underlying",
  receive: "underlying",
  matured: false,
})

const ok: SimulationOutcome = { ok: true, retval: 1n, latestLedger: 500, minResourceFee: "100" }
const step = (index: number, field: "value" | "sy_back" | "pt_minted" | "pt" | "sy") => ({ from: "step" as const, index, field })
const value = (v: bigint) => ({ from: "value" as const, value: v })

/** Buy YT paid in USDY (spec §4): deposit, buy with sy_in, withdraw the refund. */
function buyYtPlans(deposit: bigint, syIn: bigint): StepPlan[] {
  return [
    { action: "deposit", amount: value(deposit), gives: "USDY", takes: "SY" },
    {
      action: "buy_yt",
      amount: value(syIn),
      gives: "SY",
      takes: "YT",
      requires: [{ value: step(0, "value"), atLeast: value(syIn), reason: "The deposit produced less SY than this Buy YT needs." }],
    },
    { action: "withdraw", amount: step(1, "sy_back"), gives: "SY", takes: "USDY" },
  ]
}

/** Keep YT (spec §4): mint part, deposit the rest, add both. */
function keepYtPlans(mint: bigint, deposit: bigint): StepPlan[] {
  return [
    { action: "mint", amount: value(mint), gives: "USDY", takes: "PT + YT" },
    { action: "deposit", amount: value(deposit), gives: "USDY", takes: "SY" },
    { action: "add_liquidity", amount: step(0, "pt_minted"), secondaryAmount: step(1, "value"), gives: "PT + SY", takes: "LP" },
  ]
}

const run = (p: Partial<PreStartInput> & Pick<PreStartInput, "plans" | "request">): Blocker[] =>
  routePreStartBlockers({ base: base(), simOutcome: ok, ...p })
const codes = (list: Blocker[]) => list.map((b) => b.code)

// ---------------------------------------------------------------- tests

describe("preStartDraft", () => {
  it("takes a value amount as known, and stands in with the request's amount for one from an earlier step", () => {
    const req = request("buy_yt", 5n * U)
    const [dep, buy, withdraw] = buyYtPlans(60n * U, 60n * U).map((p) => preStartDraft(p, req))
    expect(dep).toEqual({ input: { action: "deposit", marketId: "m1", source: USER, amount: 60n * U, guards: {}, deadline: 0n }, known: true })
    // The buy's `requires` reads step 1's output: it is left out before the start, not refused.
    expect(buy.known).toBe(true)
    expect(buy.input.amount).toBe(60n * U)
    expect(withdraw).toMatchObject({ input: { action: "withdraw", amount: 5n * U }, known: false })
  })

  it("isOffered: false for an action this release does not offer (R47) and for no step", () => {
    expect(isOffered(null)).toBe(false)
    expect(isOffered(preStartDraft({ action: "add_liquidity_sy", amount: value(U), gives: "SY", takes: "LP" }, request("lp_only", U)).input)).toBe(false)
    expect(isOffered(preStartDraft({ action: "deposit", amount: value(U), gives: "USDY", takes: "SY" }, request("buy_pt", U)).input)).toBe(true)
  })
})

describe("routePreStartBlockers", () => {
  it("passes a healthy route", () => {
    expect(run({ plans: buyYtPlans(60n * U, 60n * U), request: request("buy_yt", 5n * U), simOutput: { kind: "amount", value: 60n * U } })).toEqual([])
  })

  it("R2-61: a later step's breaker check counts what the steps before it report", () => {
    const tight = base((b) => {
      b.market.cb = { ...b.market.cb, limit: live(100n * U) }
    })
    const plans = buyYtPlans(60n * U, 60n * U)
    const req = request("buy_yt", 5n * U)
    // Each step alone fits under 100; the deposit's 60 plus the buy's 60 does not.
    const list = routePreStartBlockers({ plans, request: req, base: tight, simOutcome: ok })
    expect(codes(list)).toEqual(["risk"])
    expect(list[0].message).toMatch(/^Step 2 \(Buy YT\), counted after the steps before it: this would trip the protocol-wide circuit breaker: 60 of its 100 limit/)
    // Below the limit together, nothing is refused.
    expect(routePreStartBlockers({ plans: buyYtPlans(40n * U, 40n * U), request: req, base: tight, simOutcome: ok })).toEqual([])
  })

  it("R2-61: an earlier step whose amount is not known makes a later breaker check unverifiable, never passing", () => {
    const tight = base((b) => {
      b.market.cb = { ...b.market.cb, limit: live(1_000n * U) }
    })
    const plans: StepPlan[] = [
      { action: "deposit", amount: { from: "input" }, gives: "USDY", takes: "SY" },
      { action: "deposit", amount: step(0, "value"), gives: "USDY", takes: "SY" },
      { action: "buy_yt", amount: value(10n * U), gives: "SY", takes: "YT" },
    ]
    const list = routePreStartBlockers({ plans, request: request("buy_yt", 10n * U), base: tight, simOutcome: ok })
    expect(codes(list)).toEqual(["unavailable"])
    expect(list[0].message).toContain("it must include what the steps before step 3 of this route add")
  })

  it("R2-62: deposits of the whole route (a mint's included) are charged against one cap, refused for the route", () => {
    const capped = base((b) => {
      b.account = { ...account(), depositCap: live(100n * U), netDeposited: live(0n) }
    })
    const list = routePreStartBlockers({ plans: keepYtPlans(60n * U, 60n * U), request: request("lp_keep_yt", 120n * U), base: capped, simOutcome: ok })
    expect(codes(list)).toEqual(["cap"])
    expect(list[0].message).toBe("This route deposits 120 in total; your cap has 100 left (net of withdrawals). Lower the amount.")
    expect(routePreStartBlockers({ plans: keepYtPlans(50n * U, 50n * U), request: request("lp_keep_yt", 100n * U), base: capped, simOutcome: ok })).toEqual([])
  })

  it("checks a later step's `requires` against step 1's simulated output", () => {
    const plans = buyYtPlans(60n * U, 60n * U)
    const req = request("buy_yt", 5n * U)
    const short = run({ plans, request: req, simOutput: { kind: "amount", value: 60n * U - 1n } })
    expect(codes(short)).toEqual(["quote"])
    expect(short[0].message).toMatch(/^Step 2 \(Buy YT\) needs more than step 1 gives, as simulated now/)
    expect(run({ plans, request: req, simOutput: { kind: "amount", value: 60n * U } })).toEqual([])
    // Without step 1's output there is nothing to check yet.
    expect(run({ plans, request: req })).toEqual([])
  })

  it("lists the planner's refusal, and the R47 refusal of a step that is not offered, without a quote refusal", () => {
    const reason = "Keeping YT while adding liquidity needs USDY: pay in USDY."
    expect(run({ plans: [], disabled: reason, request: request("lp_keep_yt", U) })).toEqual([{ code: "disabled", message: reason }])
    const zap: StepPlan[] = [{ action: "add_liquidity_sy", amount: { from: "input" }, gives: "SY", takes: "LP" }]
    const list = run({ plans: zap, request: request("lp_only", U), simGuards: { ok: false, reason: "no quote" } })
    expect(list).toEqual([{ code: "disabled", message: ACTION_META.add_liquidity_sy.disabled!.reason }])
  })

  it("says a refusal shared by several steps once (dedupe), in 0001's order", () => {
    const paused = base((b) => {
      b.market.syPaused = live(true)
    })
    const plans: StepPlan[] = [
      { action: "sell_pt", amount: { from: "input" }, gives: "PT", takes: "SY" },
      { action: "withdraw", amount: step(0, "value"), gives: "SY", takes: "USDY" },
    ]
    const list = routePreStartBlockers({ plans, request: request("sell_pt", 10n * U), base: paused, simOutcome: ok })
    // Both steps move SY, so both are refused with the same sentence; it is listed once.
    expect(list.filter((b) => b.code === "pause")).toHaveLength(1)
    expect(new Set(list.map((b) => `${b.code}|${b.message}`)).size).toBe(list.length)
  })

  it("puts the amount field's refusal first, in place of the amount and balance gates, and drops quote refusals", () => {
    const list = run({
      plans: buyYtPlans(60n * U, 60n * U),
      request: request("buy_yt", 0n),
      simGuards: { ok: false, reason: "no quote" },
      trade: { check: { ok: false, code: "balance", message: "You hold less than that." } },
    })
    expect(list[0]).toEqual({ code: "balance", message: "You hold less than that." })
    expect(codes(list).filter((c) => c === "amount" || c === "balance")).toEqual(["balance"])
    expect(codes(list)).not.toContain("quote")
  })

  it("keeps step 1's quote refusal only for a complete amount", () => {
    const plans: StepPlan[] = [{ action: "sell_pt", amount: { from: "input" }, gives: "PT", takes: "SY" }]
    const guards = { ok: false as const, reason: "The amount is too small for slippage protection on output." }
    expect(run({ plans, request: request("sell_pt", U), simGuards: guards })).toEqual([{ code: "quote", message: guards.reason }])
    expect(run({ plans, request: request("sell_pt", 0n), simGuards: guards }).map((b) => b.code)).not.toContain("quote")
  })
})
