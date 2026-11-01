import { ACTION_META, ADD_LIQUIDITY_SY_DISABLED_PAYING_SY, type ActionId } from "./actions"
import { formatAmount } from "./format"
import type { ActionOutput } from "./guards"

/**
 * Route planner (spec 0002 §4). Until the Router gains USDY-denominated functions, each panel
 * action is a route: an ordered list of existing contract actions, one signature each. Plans are
 * plain serializable data (a later task persists and resumes them); amounts that depend on an
 * earlier step's real output are `AmountSource`s resolved by `resolveStep` at run time.
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
}

export type RouteDisabled = { disabled: string }

/** A Router function that does a whole route in one signature. */
export type SingleStep = { fn: string; action: ActionId }

/**
 * Single-step table: route kind -> the USDY-denominated Router function replacing the route when
 * the manifest lists it. Empty today: no such function ships. Adding one later is one entry here
 * plus one `ActionId`.
 */
export const SINGLE_STEP: Partial<Record<RouteKind, SingleStep>> = {}

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

export function planRoute(req: RouteRequest, ctx: RouteContext): StepPlan[] | RouteDisabled {
  const payUnderlying = req.pay === "underlying"
  const recvUnderlying = req.receive === "underlying"

  // Single-step Router function, when one ships and the manifest lists it. For buy kinds the
  // payment token decides (`receive` is ignored); for sell kinds the receive token decides (`pay`
  // is ignored).
  const single = (ctx.singleStep ?? SINGLE_STEP)[req.kind]
  const isBuy = BUY_KINDS.includes(req.kind)
  if (single && (isBuy ? payUnderlying : recvUnderlying) && ctx.routerFunctions.includes(single.fn)) {
    return [
      {
        action: single.action,
        amount: input,
        gives: isBuy ? "USDY" : GIVES[req.kind],
        takes: isBuy ? TAKES[req.kind] : "USDY",
      },
    ]
  }

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
      const reason = ACTION_META.add_liquidity_sy.disabled?.reason
      // An SY payer's Keep YT is off (R2-22): their fix is to pay in USDY, then turn it on.
      if (reason) return disabledIf(payUnderlying ? reason : ADD_LIQUIDITY_SY_DISABLED_PAYING_SY)
      // Once R47 is lifted: [deposit?] -> add_liquidity_sy.
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
      return out.kind !== "add_liquidity" ? undefined : [["sy", -a.amount], ["lp", out.lp]]
    case "remove_liquidity":
      return out.kind !== "remove_liquidity" ? undefined : [["lp", -a.amount], ["pt", out.pt], ["sy", out.sy]]
    case "redeem":
      return out.kind !== "redeem"
        ? undefined
        : [["pt", -a.amount], ["yt", -(a.secondaryAmount ?? 0n)], ["underlying", out.underlying_from_pt + out.underlying_from_yt]]
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
 * unwrapped by `withdraw` (Router.unwrap). PT, YT or LP need more than one call (a sale, then a
 * withdraw), so there is no single call back from them, and the reason names the way out. After
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
