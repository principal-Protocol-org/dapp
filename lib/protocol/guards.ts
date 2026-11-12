import { type ActionId, type ActionInput, type GuardValues } from "./actions"
import { BPS, ceilDiv } from "./math"
import { previewDeposit, previewWithdraw } from "./previews"

export type ActionOutput =
  | { kind: "amount"; value: bigint }
  | { kind: "mint"; pt_minted: bigint; yt_minted: bigint; fee_shares: bigint }
  | { kind: "buy_yt"; yt_out: bigint; sy_back: bigint }
  /** Router.flash_mint_yt: `(yt_out, net_cost)`, the net cost in SY (R5-2). */
  | { kind: "flash_yt"; yt_out: bigint; net_cost: bigint }
  /** Router.flash_mint_yt_from_underlying: `(yt_out, net_cost, underlying_back)`. */
  | { kind: "flash_yt_underlying"; yt_out: bigint; net_cost: bigint; underlying_back: bigint }
  | { kind: "add_liquidity"; pt_used: bigint; sy_used: bigint; lp: bigint }
  /** Router.add_liquidity_keep_yt: `KeepYtResult { pt_used, sy_used, lp_minted, yt_minted }`. */
  | { kind: "keep_yt"; pt_used: bigint; sy_used: bigint; lp: bigint; yt_minted: bigint }
  | { kind: "remove_liquidity"; pt: bigint; sy: bigint }
  | { kind: "redeem"; underlying_from_pt: bigint; underlying_from_yt: bigint }

export type GuardResult = { ok: true; guards: GuardValues } | { ok: false; reason: string }

/** What the floors may need besides the simulation: the SY exchange rate (R5-3), when it is live. */
export type GuardRates = { exchangeRate: bigint }

const YT_PRICE_REASON = "The YT price is not positive, so buying YT is not offered."
/** R5-3: without the exchange rate, the USDY flash's budget in SY cannot be worked out. */
const NO_EXCHANGE_RATE_REASON =
  "The SY exchange rate is not available, so the most this Buy YT may spend cannot be worked out in SY. It is not offered until the market data loads."

/** Output kind each action's simulated return value must have. */
const OUTPUT_KIND: Record<ActionId, ActionOutput["kind"]> = {
  deposit: "amount",
  withdraw: "amount",
  mint: "mint",
  buy_pt: "amount",
  sell_pt: "amount",
  buy_yt: "buy_yt",
  sell_yt: "amount",
  add_liquidity: "add_liquidity",
  add_liquidity_sy: "add_liquidity",
  remove_liquidity: "remove_liquidity",
  recombine: "amount",
  claim_yield: "amount",
  redeem: "redeem",
  buy_pt_underlying: "amount",
  sell_pt_underlying: "amount",
  sell_yt_underlying: "amount",
  add_liquidity_keep_yt: "keep_yt",
  buy_yt_flash: "flash_yt",
  buy_yt_flash_underlying: "flash_yt_underlying",
  add_liquidity_underlying: "add_liquidity",
  remove_liquidity_underlying: "amount",
}

/** Floor of out * (1 - bps/10000). Throws on non-positive output or bps outside [0, 10000). */
export function minAfterSlippage(out: bigint, bps: bigint): bigint {
  if (typeof bps !== "bigint" || bps < 0n || bps >= BPS) throw new Error("Slippage must be between 0 and 9999 bps.")
  if (out <= 0n) throw new Error("Simulated output is not positive.")
  return (out * (BPS - bps)) / BPS
}

/** The SY a flash budget stands for (R5-3): the amount itself for an SY payer, its deposit for a USDY payer. */
function budgetSy(action: ActionId, amount: bigint, rates?: GuardRates): bigint {
  if (action === "buy_yt_flash") return amount
  const xr = rates?.exchangeRate
  if (xr === undefined || xr <= 0n) throw new Error(NO_EXCHANGE_RATE_REASON)
  return previewDeposit(amount, xr)
}

/**
 * Guards used only to simulate: zero floors; the flash's max_net_cost is the whole budget in SY (R5-3,
 * which the pool pulls up front), and a USDY flash's min_underlying_back is 0. A USDY flash needs the
 * exchange rate to state that budget in SY: without it this throws the plain-words reason.
 */
export function openGuards(action: ActionId, amount: bigint, rates?: GuardRates): GuardValues {
  switch (action) {
    case "claim_yield":
    case "redeem":
      return {}
    case "remove_liquidity":
      return { minOut: 0n, minOut2: 0n }
    case "buy_yt":
      return { minOut: 0n, maxNetCost: amount }
    case "buy_yt_flash":
      return { minOut: 0n, maxNetCost: amount }
    case "buy_yt_flash_underlying":
      return { minOut: 0n, maxNetCost: budgetSy(action, amount, rates), minOut2: 0n }
    default:
      return { minOut: 0n }
  }
}

function fail(what: string): never {
  throw new Error(`Unexpected simulation result for ${what}.`)
}

function int(value: unknown, what: string): bigint {
  if (typeof value !== "bigint") fail(what)
  return value
}

function tuple(value: unknown, length: number, what: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) fail(what)
  return value
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(what)
  return value as Record<string, unknown>
}

/** Validates the simulated return value (already through scValToNative). Throws on any other shape. */
export function parseOutput(action: ActionId, retval: unknown): ActionOutput {
  switch (OUTPUT_KIND[action]) {
    case "amount":
      return { kind: "amount", value: int(retval, action) }
    case "mint": {
      const r = record(retval, action)
      return {
        kind: "mint",
        pt_minted: int(r.pt_minted, action),
        yt_minted: int(r.yt_minted, action),
        fee_shares: int(r.fee_shares, action),
      }
    }
    case "buy_yt": {
      const t = tuple(retval, 2, action)
      return { kind: "buy_yt", yt_out: int(t[0], action), sy_back: int(t[1], action) }
    }
    case "flash_yt": {
      const t = tuple(retval, 2, action)
      return { kind: "flash_yt", yt_out: int(t[0], action), net_cost: int(t[1], action) }
    }
    case "flash_yt_underlying": {
      const t = tuple(retval, 3, action)
      return { kind: "flash_yt_underlying", yt_out: int(t[0], action), net_cost: int(t[1], action), underlying_back: int(t[2], action) }
    }
    case "add_liquidity": {
      const t = tuple(retval, 3, action)
      return { kind: "add_liquidity", pt_used: int(t[0], action), sy_used: int(t[1], action), lp: int(t[2], action) }
    }
    case "keep_yt": {
      const r = record(retval, action)
      return {
        kind: "keep_yt",
        pt_used: int(r.pt_used, action),
        sy_used: int(r.sy_used, action),
        lp: int(r.lp_minted, action),
        yt_minted: int(r.yt_minted, action),
      }
    }
    case "remove_liquidity": {
      const t = tuple(retval, 2, action)
      return { kind: "remove_liquidity", pt: int(t[0], action), sy: int(t[1], action) }
    }
    case "redeem": {
      const r = record(retval, action)
      return {
        kind: "redeem",
        underlying_from_pt: int(r.underlying_from_pt, action),
        underlying_from_yt: int(r.underlying_from_yt, action),
      }
    }
  }
}

function floorOf(out: bigint, slippageBps: bigint, what: string): { floor: bigint } | { reason: string } {
  if (out <= 0n) return { reason: `The simulation returned no ${what}, so the transaction is not offered.` }
  const floor = minAfterSlippage(out, slippageBps)
  if (floor <= 0n) return { reason: `The amount is too small for slippage protection on ${what}.` }
  return { floor }
}

/**
 * Slippage floors from the exact simulated output. Never produces a zero floor, but the USDY flash's
 * `min_underlying_back` (R5-3). `rates` is the live SY exchange rate, which only the USDY flash needs:
 * without it that action is refused.
 */
export function guardsFrom(
  action: ActionId,
  input: ActionInput,
  out: ActionOutput,
  slippageBps: bigint,
  rates?: GuardRates,
): GuardResult {
  if (typeof slippageBps !== "bigint" || slippageBps < 0n || slippageBps >= BPS) {
    return { ok: false, reason: "Slippage tolerance must be at least 0% and less than 100%." }
  }
  if (input.action !== action || out.kind !== OUTPUT_KIND[action]) {
    return { ok: false, reason: "The simulation result does not match this action." }
  }
  if (action === "claim_yield" || action === "redeem") return { ok: true, guards: {} }

  switch (out.kind) {
    case "amount":
    case "mint":
    case "add_liquidity":
    case "keep_yt": {
      // Keep YT signs min_lp_out only: the YT it mints has no floor (Router.add_liquidity_keep_yt).
      const value = out.kind === "amount" ? out.value : out.kind === "mint" ? out.pt_minted : out.lp
      const f = floorOf(value, slippageBps, "output")
      return "reason" in f ? { ok: false, reason: f.reason } : { ok: true, guards: { minOut: f.floor } }
    }
    case "remove_liquidity": {
      const pt = floorOf(out.pt, slippageBps, "PT")
      if ("reason" in pt) return { ok: false, reason: pt.reason }
      const sy = floorOf(out.sy, slippageBps, "SY")
      if ("reason" in sy) return { ok: false, reason: sy.reason }
      return { ok: true, guards: { minOut: pt.floor, minOut2: sy.floor } }
    }
    case "buy_yt": {
      const net = input.amount - out.sy_back
      if (net <= 0n) return { ok: false, reason: YT_PRICE_REASON }
      const yt = floorOf(out.yt_out, slippageBps, "YT")
      if ("reason" in yt) return { ok: false, reason: yt.reason }
      const maxNetCost = ceilDiv(net * (BPS + slippageBps), BPS)
      return { ok: true, guards: { minOut: yt.floor, maxNetCost } }
    }
    case "flash_yt":
    case "flash_yt_underlying": {
      // R5-3: the pool pulls max_net_cost up front, so it is capped at the budget: it never takes SY
      // the wallet held before. net_cost <= 0 is PT at or above par: YT is free or paid for.
      if (out.net_cost <= 0n) return { ok: false, reason: YT_PRICE_REASON }
      const yt = floorOf(out.yt_out, slippageBps, "YT")
      if ("reason" in yt) return { ok: false, reason: yt.reason }
      let budget: bigint
      try {
        budget = budgetSy(action, input.amount, rates)
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
      const margin = ceilDiv(out.net_cost * (BPS + slippageBps), BPS)
      const maxNetCost = margin < budget ? margin : budget
      if (out.kind === "flash_yt") return { ok: true, guards: { minOut: yt.floor, maxNetCost } }
      // The SY not spent comes back as the underlying: min_underlying_back follows from maxNetCost
      // and may be 0, the one zero floor allowed (it is not a separate bound).
      const xr = rates?.exchangeRate as bigint
      return { ok: true, guards: { minOut: yt.floor, maxNetCost, minOut2: previewWithdraw(budget - maxNetCost, xr) } }
    }
    case "redeem":
      return { ok: true, guards: {} }
  }
}
