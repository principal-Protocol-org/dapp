import type { ActionId } from "./actions"
import { formatAmount } from "./format"
import type { ActionOutput } from "./guards"
import { previewWithdraw } from "./previews"

/**
 * Route planner (spec 0002 §4). Each panel action is a route: an ordered list of contract actions,
 * one signature each. When the manifest lists the Router's USDY-denominated function for it
 * (`SINGLE_STEP`, R4-3), the route is that one call; otherwise it is the existing actions in a row.
 * Plans are plain serializable data (the route log persists and resumes them); amounts that depend
 * on an earlier step's real output are `AmountSource`s resolved by `resolveStep` at run time.
 */

export type RouteKind =
  | "buy_pt"
  | "sell_pt"
  | "buy_yt"
  | "sell_yt"
  | "lp_keep_yt"
  | "lp_only"
  | "lp_withdraw"
  | "split"
  | "recombine"

export type Token = "underlying" | "sy"

/** `amount` is in the `pay` token (or the LP / PT amount for withdraw, sell and recombine routes). */
export type RouteRequest = {
  kind: RouteKind
  marketId: string
  source: string
  amount: bigint
  pay: Token
  receive: Token
  matured: boolean
}

type DistributeKeys<T> = T extends unknown ? Exclude<keyof T, "kind"> : never
/** Names of the bigint fields of `ActionOutput`. */
export type OutputField = DistributeKeys<ActionOutput>

export type AmountSource =
  | { from: "input" }
  | { from: "value"; value: bigint }
  | { from: "step"; index: number; field: OutputField }
  | { from: "sum"; parts: AmountSource[] }

export type StepPlan = {
  action: ActionId
  amount: AmountSource
  secondaryAmount?: AmountSource
  /** What the user hands over / receives, in plain English, for the route preview. */
  gives: string
  takes: string
  /** Checked by `resolveStep`: `value` must be at least `atLeast`, else the route stops here. */
  requires?: { value: AmountSource; atLeast: AmountSource; reason: string }[]
  /**
   * R4-3, on the first step only: why this route was planned instead of the one-signature Router
   * function the manifest lists (the wallet holds SY it would sweep), in plain English for the route
   * note. Display text, like `gives` and `takes`: it changes nothing the step signs.
   */
  fallback?: string
}

export type RouteDisabled = { disabled: string }

/**
 * A Router function that does a whole route in one signature. `sweepsSy`: it ends with
 * `SYWrapper.withdraw_all`, so it reverts `PreexistingSyBalance` (Router error 9) when the wallet
 * already holds SY (R4-3).
 */
export type SingleStep = { fn: string; action: ActionId; sweepsSy?: true }

/**
 * Single-step table (principal 97ac23e): route kind -> the USDY-denominated Router function that
 * replaces the route when the manifest lists it (R4-3). A buy uses it when paid in USDY, a sale when
 * received in USDY; paid or received in SY, the route is already one step or needs no Router call.
 */
export const SINGLE_STEP: Partial<Record<RouteKind, SingleStep>> = {
  buy_pt: { fn: "swap_underlying_for_pt", action: "buy_pt_underlying" },
  sell_pt: { fn: "swap_pt_for_underlying", action: "sell_pt_underlying", sweepsSy: true },
  buy_yt: { fn: "swap_underlying_for_yt", action: "buy_yt_underlying", sweepsSy: true },
  sell_yt: { fn: "swap_yt_for_underlying", action: "sell_yt_underlying", sweepsSy: true },
  lp_keep_yt: { fn: "add_liquidity_keep_yt", action: "add_liquidity_keep_yt" },
}

export type RouteContext = {
  routerFunctions: string[]
  /**
   * Buy YT, from `solveBuyYt` (Task 5). `syIn` is the exact `sy_in` the buy_yt call must use.
   * `depositUnderlying` (only when paying in underlying) is the underlying the deposit step spends,
   * chosen by the caller so the deposit yields at least `syIn` SY.
   */
  buyYt?: { syIn: bigint; depositUnderlying?: bigint }
  /** LP "keep YT": underlying split between minting PT+YT and depositing for the SY side. */
  keepYtSplit?: { mintUnderlying: bigint; depositUnderlying: bigint }
  /**
   * One-step Keep YT (R4-4): the SY shares of the deposit `add_liquidity_keep_yt` mints into PT + YT,
   * sized by the caller with `1 ≤ mint < shares` (the Router adds `shares − mint` SY).
   */
  keepYtMintSy?: bigint
  /**
   * The connected account's live SY balance; absent when it is not known. Above zero, the routes whose
   * one-step function sweeps SY are planned the old way, with the reason (R4-3).
   */
  syBalance?: bigint
  /** The SY exchange rate (USDY per SY share), when read: the reason tells a balance too small to withdraw. */
  exchangeRate?: bigint
  /** Overrides `SINGLE_STEP` (used by tests; keys are route kinds). */
  singleStep?: Partial<Record<RouteKind, SingleStep>>
}

const input: AmountSource = { from: "input" }
const step = (index: number, field: OutputField): AmountSource => ({ from: "step", index, field })

const DEPOSIT = (amount: AmountSource, takes = "SY"): StepPlan => ({
  action: "deposit",
  amount,
  gives: "USDY",
  takes,
})
const WITHDRAW = (amount: AmountSource, gives = "SY"): StepPlan => ({
  action: "withdraw",
  amount,
  gives,
  takes: "USDY",
})

function disabledIf(reason: string): RouteDisabled {
  return { disabled: reason }
}

/** Kinds paid for with `pay`; `receive` is ignored for them. The others ignore `pay`. */
const BUY_KINDS: RouteKind[] = ["buy_pt", "buy_yt", "split", "lp_keep_yt", "lp_only"]
const GIVES: Record<RouteKind, string> = {
  buy_pt: "USDY",
  buy_yt: "USDY",
  split: "USDY",
  lp_keep_yt: "USDY",
  lp_only: "USDY",
  sell_pt: "PT",
  sell_yt: "YT",
  lp_withdraw: "LP",
  recombine: "PT + YT",
}
const TAKES: Record<RouteKind, string> = {
  buy_pt: "PT",
  buy_yt: "YT",
  split: "PT + YT",
  lp_keep_yt: "LP + YT",
  lp_only: "LP",
  sell_pt: "USDY",
  sell_yt: "USDY",
  lp_withdraw: "USDY",
  recombine: "USDY",
}

/**
 * The one-step Router function for `req`, when the manifest lists it (R4-3). For buy kinds the
 * payment token decides (`receive` is ignored); for sell kinds the receive token decides (`pay` is
 * ignored). It does not look at the SY balance: `planRoute` does.
 */
export function singleStepFor(
  req: Pick<RouteRequest, "kind" | "pay" | "receive">,
  ctx: Pick<RouteContext, "routerFunctions" | "singleStep">,
): SingleStep | undefined {
  const single = (ctx.singleStep ?? SINGLE_STEP)[req.kind]
  const inUnderlying = BUY_KINDS.includes(req.kind) ? req.pay === "underlying" : req.receive === "underlying"
  return single && inUnderlying && ctx.routerFunctions.includes(single.fn) ? single : undefined
}

/**
 * Whether `sy` SY is too small to withdraw: it gives under 2 raw USDY at the SY rate, so any slippage
 * floor rounds to 0, which the withdraw refuses (guards.ts). False when the rate is not known, so the
 * text that points at Withdraw stays.
 */
export function syTooSmallToWithdraw(sy: bigint, exchangeRate: bigint | undefined): boolean {
  return exchangeRate !== undefined && exchangeRate > 0n && previewWithdraw(sy, exchangeRate) < 2n
}

/** R4-3's reason, on the first step of a route planned instead of a one-step function that sweeps SY. */
function sweepFallback(sy: bigint, signatures: number, exchangeRate: bigint | undefined): string {
  const head = `You hold ${formatAmount(sy, PRINCIPAL_DECIMALS, PRINCIPAL_DECIMALS, { group: true })} SY, so this takes ${signatures} signatures: the one-signature trade would withdraw all your SY.`
  return syTooSmallToWithdraw(sy, exchangeRate)
    ? `${head} An amount this small cannot be withdrawn, so this trade keeps its multi-step route.`
    : `${head} Withdraw it first (Quick actions → Withdraw) to trade in one signature.`
}

/**
 * The one step, with the amounts it signs: the input, except Buy YT, which tokenizes the solver's
 * deposit (R4-5), and Keep YT, which also mints the SY shares the caller sized (R4-4).
 */
function oneStep(req: RouteRequest, ctx: RouteContext, single: SingleStep): StepPlan[] | RouteDisabled {
  const isBuy = BUY_KINDS.includes(req.kind)
  const shape = { action: single.action, gives: isBuy ? "USDY" : GIVES[req.kind], takes: isBuy ? TAKES[req.kind] : "USDY" }
  if (req.kind === "buy_yt") {
    const dep = ctx.buyYt?.depositUnderlying
    if (dep === undefined) return disabledIf("Buy YT with USDY needs the amount of USDY to deposit first.")
    return [{ ...shape, amount: { from: "value", value: dep } }]
  }
  if (req.kind === "lp_keep_yt") {
    const mint = ctx.keepYtMintSy
    if (mint === undefined) return disabledIf("Adding liquidity and keeping YT needs the SY to mint first.")
    return [{ ...shape, amount: input, secondaryAmount: { from: "value", value: mint } }]
  }
  return [{ ...shape, amount: input }]
}

export function planRoute(req: RouteRequest, ctx: RouteContext): StepPlan[] | RouteDisabled {
  const single = singleStepFor(req, ctx)
  if (!single) return multiStep(req, ctx)
  // R4-3: a one-step function that ends with withdraw_all reverts on a wallet that already holds SY.
  // A known balance above zero keeps the old route and says why; an unknown one plans the one step,
  // and the `sy_balance` gate refuses it if the live balance turns out above zero.
  const sy = ctx.syBalance
  if (!single.sweepsSy || sy === undefined || sy <= 0n) return oneStep(req, ctx, single)
  const planned = multiStep(req, ctx)
  if (!Array.isArray(planned) || planned.length === 0) return planned
  const [first, ...rest] = planned
  return [{ ...first, fallback: sweepFallback(sy, planned.length, ctx.exchangeRate) }, ...rest]
}

/** The route as the existing contract actions, one signature each (spec §4). */
function multiStep(req: RouteRequest, ctx: RouteContext): StepPlan[] | RouteDisabled {
  const payUnderlying = req.pay === "underlying"
  const recvUnderlying = req.receive === "underlying"

  switch (req.kind) {
    case "buy_pt": {
      if (!payUnderlying) return [{ action: "buy_pt", amount: input, gives: "SY", takes: "PT" }]
      return [DEPOSIT(input), { action: "buy_pt", amount: step(0, "value"), gives: "SY", takes: "PT" }]
    }
    case "sell_pt": {
      const sell: StepPlan = { action: "sell_pt", amount: input, gives: "PT", takes: "SY" }
      return recvUnderlying ? [sell, WITHDRAW(step(0, "value"))] : [sell]
    }
    case "sell_yt": {
      const sell: StepPlan = { action: "sell_yt", amount: input, gives: "YT", takes: "SY" }
      return recvUnderlying ? [sell, WITHDRAW(step(0, "value"))] : [sell]
    }
    case "buy_yt": {
      const syIn = ctx.buyYt?.syIn
      if (syIn === undefined) return disabledIf("Buy YT needs the solved SY amount first.")
      const buy = (idx: number): StepPlan => ({
        action: "buy_yt",
        amount: { from: "value", value: syIn },
        gives: "SY",
        takes: "YT",
        ...(idx === 1
          ? {
              requires: [
                {
                  value: step(0, "value"),
                  atLeast: { from: "value", value: syIn } as AmountSource,
                  reason: "The deposit produced less SY than this Buy YT needs. Nothing further was signed.",
                },
              ],
            }
          : {}),
      })
      const tail = (idx: number): StepPlan[] => (payUnderlying ? [WITHDRAW(step(idx, "sy_back"))] : [])
      if (!payUnderlying) return [buy(0), ...tail(0)]
      const dep = ctx.buyYt?.depositUnderlying
      if (dep === undefined) return disabledIf("Buy YT with USDY needs the amount of USDY to deposit first.")
      return [DEPOSIT({ from: "value", value: dep }), buy(1), ...tail(1)]
    }
    case "lp_keep_yt": {
      const split = ctx.keepYtSplit
      if (!payUnderlying) return disabledIf("Keeping YT while adding liquidity needs USDY: pay in USDY.")
      if (!split) return disabledIf("Adding liquidity and keeping YT needs the USDY split first.")
      return [
        { action: "mint", amount: { from: "value", value: split.mintUnderlying }, gives: "USDY", takes: "PT + YT" },
        DEPOSIT({ from: "value", value: split.depositUnderlying }),
        {
          action: "add_liquidity",
          amount: step(0, "pt_minted"),
          secondaryAmount: step(1, "value"),
          gives: "PT + SY",
          takes: "LP",
        },
      ]
    }
    case "lp_only": {
      // R4-7: [deposit?] -> add_liquidity_sy. The pool takes the whole `sy_in` and refunds what it
      // does not use, so the signed amount always matches.
      const add: StepPlan = {
        action: "add_liquidity_sy",
        amount: payUnderlying ? step(0, "value") : input,
        gives: "SY",
        takes: "LP",
      }
      return payUnderlying ? [DEPOSIT(input), add] : [add]
    }
    case "lp_withdraw": {
      const remove: StepPlan = { action: "remove_liquidity", amount: input, gives: "LP", takes: "PT + SY" }
      if (req.matured) {
        // Only PT is left after removing, so the YT leg of redeem is 0.
        const redeem: StepPlan = {
          action: "redeem",
          amount: step(0, "pt"),
          secondaryAmount: { from: "value", value: 0n },
          gives: "PT",
          takes: "USDY (paid out as USDY even when you receive SY)",
        }
        // redeem_at_maturity pays underlying directly; only the SY removed from the pool is unwrapped.
        return recvUnderlying ? [remove, redeem, WITHDRAW(step(0, "sy"))] : [remove, redeem]
      }
      const sell: StepPlan = { action: "sell_pt", amount: step(0, "pt"), gives: "PT", takes: "SY" }
      const out: AmountSource = { from: "sum", parts: [step(0, "sy"), step(1, "value")] }
      return recvUnderlying ? [remove, sell, WITHDRAW(out)] : [remove, sell]
    }
    case "split": {
      if (!payUnderlying) return disabledIf("Splitting needs USDY: pay in USDY.")
      return [{ action: "mint", amount: input, gives: "USDY", takes: "PT + YT" }]
    }
    case "recombine": {
      const rec: StepPlan = { action: "recombine", amount: input, gives: "PT + YT", takes: "SY" }
      return recvUnderlying ? [rec, WITHDRAW(step(0, "value"))] : [rec]
    }
  }
}

function resolveSource(src: AmountSource, req: RouteRequest, outputs: ActionOutput[]): bigint {
  switch (src.from) {
    case "input":
      return req.amount
    case "value":
      return src.value
    case "sum":
      return src.parts.reduce((acc, p) => acc + resolveSource(p, req, outputs), 0n)
    case "step": {
      const out = outputs[src.index]
      if (!out) {
        throw new Error(`Step ${src.index + 1} has not run yet, so its result is not available.`)
      }
      const v = (out as Record<string, unknown>)[src.field]
      if (typeof v !== "bigint") {
        throw new Error(`Step ${src.index + 1} did not report "${src.field}", so the next step cannot take its amount.`)
      }
      return v
    }
  }
}

export function resolveStep(
  plan: StepPlan,
  input: RouteRequest,
  outputs: ActionOutput[],
): { amount: bigint; secondaryAmount?: bigint } {
  for (const r of plan.requires ?? []) {
    if (resolveSource(r.value, input, outputs) < resolveSource(r.atLeast, input, outputs)) {
      throw new Error(r.reason)
    }
  }
  const amount = resolveSource(plan.amount, input, outputs)
  if (!plan.secondaryAmount) return { amount }
  return { amount, secondaryAmount: resolveSource(plan.secondaryAmount, input, outputs) }
}

// --- What an interrupted route leaves with the user (spec §4 "Interruption") ---

/** A token a route step hands over or receives. `underlying` is the market's USDY. */
export type Holding = "underlying" | "sy" | "pt" | "yt" | "lp"
/** Net amounts the route's confirmed steps left with the user, positive only. */
export type Holdings = Partial<Record<Holding, bigint>>

/** Every Principal token (SY, PT, YT, LP) has 7 decimals. */
const PRINCIPAL_DECIMALS = 7
const HOLDING_ORDER: Holding[] = ["pt", "yt", "lp", "sy", "underlying"]
const HOLDING_LABEL: Record<Exclude<Holding, "underlying">, string> = { sy: "SY", pt: "PT", yt: "YT", lp: "LP" }

/**
 * What one confirmed step moved, per token: negative is handed over, positive received. Amounts are
 * the ones the step was signed with (resolved again from the same plan and outputs) and its decoded
 * output. Undefined if the output does not belong to the action.
 */
function moved(action: ActionId, a: { amount: bigint; secondaryAmount?: bigint }, out: ActionOutput): [Holding, bigint][] | undefined {
  const value = out.kind === "amount" ? out.value : undefined
  switch (action) {
    case "deposit":
      return value === undefined ? undefined : [["underlying", -a.amount], ["sy", value]]
    case "withdraw":
      return value === undefined ? undefined : [["sy", -a.amount], ["underlying", value]]
    case "buy_pt":
      return value === undefined ? undefined : [["sy", -a.amount], ["pt", value]]
    case "sell_pt":
      return value === undefined ? undefined : [["pt", -a.amount], ["sy", value]]
    case "sell_yt":
      return value === undefined ? undefined : [["yt", -a.amount], ["sy", value]]
    case "recombine":
      return value === undefined ? undefined : [["pt", -a.amount], ["yt", -a.amount], ["sy", value]]
    case "claim_yield":
      return value === undefined ? undefined : [["sy", value]]
    case "mint":
      return out.kind !== "mint" ? undefined : [["underlying", -a.amount], ["pt", out.pt_minted], ["yt", out.yt_minted]]
    case "buy_yt":
      return out.kind !== "buy_yt" ? undefined : [["sy", out.sy_back - a.amount], ["yt", out.yt_out]]
    case "add_liquidity":
      // The pool takes only what it uses; the rest stays with the user.
      return out.kind !== "add_liquidity" ? undefined : [["pt", -out.pt_used], ["sy", -out.sy_used], ["lp", out.lp]]
    case "add_liquidity_sy":
      // R4-7: the pool takes the whole `sy_in` and refunds the rest, so `sy_used` in the return value
      // is `split + sy_used`, what it kept. The PT it bought and did not use is refunded too, but it is
      // not in the return value, so it is not counted here.
      return out.kind !== "add_liquidity" ? undefined : [["sy", -out.sy_used], ["lp", out.lp]]
    case "remove_liquidity":
      return out.kind !== "remove_liquidity" ? undefined : [["lp", -a.amount], ["pt", out.pt], ["sy", out.sy]]
    case "redeem":
      return out.kind !== "redeem"
        ? undefined
        : [["pt", -a.amount], ["yt", -(a.secondaryAmount ?? 0n)], ["underlying", out.underlying_from_pt + out.underlying_from_yt]]
    // One transaction each: the SY in between never stays with the user, except Keep YT's.
    case "buy_pt_underlying":
      return value === undefined ? undefined : [["underlying", -a.amount], ["pt", value]]
    case "sell_pt_underlying":
      return value === undefined ? undefined : [["pt", -a.amount], ["underlying", value]]
    case "sell_yt_underlying":
      return value === undefined ? undefined : [["yt", -a.amount], ["underlying", value]]
    case "buy_yt_underlying":
      // R4-5: the whole amount is tokenized; underlying_back comes back in the same transaction.
      return out.kind !== "buy_yt_underlying" ? undefined : [["underlying", out.underlying_back - a.amount], ["yt", out.yt_out]]
    case "add_liquidity_keep_yt":
      // PrincipalManager.mint mints PT 1:1 with YT, so the PT the pool did not take is
      // yt_minted − pt_used. The SY left over (deposit shares − mint_amount − sy_used) needs the
      // deposit's shares, which KeepYtResult does not return, so it is not counted here.
      return out.kind !== "keep_yt"
        ? undefined
        : [["underlying", -a.amount], ["pt", out.yt_minted - out.pt_used], ["yt", out.yt_minted], ["lp", out.lp]]
  }
}

/**
 * What the first `confirmed` steps left with the user, net of what later confirmed steps consumed:
 * a matured LP withdraw interrupted after the redeem still holds the SY its first step removed.
 * Only tokens with a positive net amount are listed; what the user paid in is not. Undefined when a
 * confirmed step's result could not be read: the holdings are then unknown, never guessed.
 */
export function routeHoldings(
  req: RouteRequest,
  plans: StepPlan[],
  outputs: (ActionOutput | null | undefined)[],
  confirmed: number,
): Holdings | undefined {
  const net: Holdings = {}
  const known: ActionOutput[] = []
  for (let i = 0; i < confirmed; i++) {
    const out = outputs[i]
    const plan = plans[i]
    if (!out || !plan) return undefined
    known.push(out)
    let flows: [Holding, bigint][] | undefined
    try {
      const amount = resolveSource(plan.amount, req, known)
      const secondaryAmount = plan.secondaryAmount ? resolveSource(plan.secondaryAmount, req, known) : undefined
      flows = moved(plan.action, { amount, secondaryAmount }, out)
    } catch {
      return undefined
    }
    if (!flows) return undefined
    for (const [token, delta] of flows) net[token] = (net[token] ?? 0n) + delta
  }
  const held: Holdings = {}
  for (const token of HOLDING_ORDER) {
    const v = net[token]
    if (v !== undefined && v > 0n) held[token] = v
  }
  return held
}

function listWords(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}

/**
 * "You hold 1000 SY", exact to the last digit (a small amount is never shown as 0); "You held …" with
 * `verb: "held"`, for holdings before a step whose result is not known. Undefined if nothing is held.
 */
export function describeHoldings(
  h: Holdings,
  underlying: { code: string; decimals: number },
  verb: "hold" | "held" = "hold",
): string | undefined {
  const parts = HOLDING_ORDER.flatMap((token) => {
    const v = h[token]
    if (v === undefined || v <= 0n) return []
    const decimals = token === "underlying" ? underlying.decimals : PRINCIPAL_DECIMALS
    const unit = token === "underlying" ? underlying.code : HOLDING_LABEL[token]
    return [`${formatAmount(v, decimals, decimals, { group: true })} ${unit}`]
  })
  return parts.length === 0 ? undefined : `You ${verb} ${listWords(parts)}`
}

export type Unwind = { available: true; amount: bigint; plan: StepPlan } | { available: false; reason: string }

/**
 * The single call back to USDY from what an interrupted route left, where one exists: SY is
 * unwrapped by `withdraw` (Router.unwrap). Only SY gets this plan. PT or YT go back from the Trade
 * tab, which the reason names: in one Router call (`swap_pt_for_underlying`, `swap_yt_for_underlying`)
 * when the manifest lists it and the wallet holds no SY, else a sale then a withdraw (R4-3), as when
 * the route also left SY. LP needs more than one call (remove, sell the PT, withdraw). After
 * maturity (`matured`) PT and YT can no longer be sold: it names Redeem in the PT tab instead, the
 * LP's withdraw (open at maturity), and the SY's withdraw.
 */
export function unwindFrom(h: Holdings | undefined, opts: { matured?: boolean } = {}): Unwind {
  if (h === undefined) {
    return {
      available: false,
      reason: "This app could not read what the last step produced, so it cannot build the call back to USDY. Check your balances in the Portfolio.",
    }
  }
  const held = (t: Holding) => (h[t] ?? 0n) > 0n
  const others = (["pt", "yt", "lp"] as const).filter(held).map((t) => HOLDING_LABEL[t])
  if (others.length > 0) {
    const what = listWords(others)
    const head = `Going back to USDY in one call works only from SY, and you also hold ${what}.`
    if (!opts.matured) return { available: false, reason: `${head} Continue the route, or sell the ${what} from the Trade tab.` }
    const redeemable = (["pt", "yt"] as const).filter(held).map((t) => HOLDING_LABEL[t])
    const ways = [
      ...(redeemable.length > 0 ? [`redeem the ${listWords(redeemable)} with Redeem in the PT tab`] : []),
      ...(held("lp") ? ["withdraw the LP in the LP tab"] : []),
      ...(held("sy") ? ["withdraw the SY with Quick actions → Withdraw"] : []),
    ]
    const next = `continue the route, or ${listWords(ways)}.`
    return {
      available: false,
      reason: redeemable.length > 0 ? `${head} Trading closed at maturity: ${next}` : `${head} ${next.charAt(0).toUpperCase()}${next.slice(1)}`,
    }
  }
  const sy = h.sy ?? 0n
  if (sy <= 0n) {
    return h.underlying !== undefined
      ? { available: false, reason: "You already hold USDY from this route: there is nothing to turn back." }
      : { available: false, reason: "Nothing has moved, so there is nothing to turn back into USDY." }
  }
  return { available: true, amount: sy, plan: WITHDRAW({ from: "value", value: sy }) }
}
