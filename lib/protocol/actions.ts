import { getMarket, protocolAbi } from "./manifest"
import { previewDeposit, previewMint } from "./previews"
import type { ContractInvocation, ScArg } from "./stellar"
import type { Manifest } from "./types"

export type ActionId =
  | "deposit"
  | "withdraw"
  | "mint"
  | "buy_pt"
  | "sell_pt"
  | "buy_yt"
  | "sell_yt"
  | "add_liquidity"
  | "add_liquidity_sy"
  | "remove_liquidity"
  | "recombine"
  | "claim_yield"
  | "redeem"
  // One transaction each, paid or received in the underlying (0004 Task 3). Each is the composition of
  // existing actions, and behaves as their union (gates, history):
  //   buy_pt_underlying = deposit + buy_pt; sell_pt_underlying = sell_pt + withdraw;
  //   sell_yt_underlying = sell_yt + withdraw;
  //   add_liquidity_keep_yt = deposit + mint (of SY) + add_liquidity.
  | "buy_pt_underlying"
  | "sell_pt_underlying"
  | "sell_yt_underlying"
  | "add_liquidity_keep_yt"
  // R5-2, the flash swap (principal 665bb67): the pool tokenizes SY of its own reserve and sells the PT
  // into itself, so the buyer pays only the net cost, which `max_net_cost` bounds. `amount` is the budget.
  //   buy_yt_flash = Router.flash_mint_yt (SY payer);
  //   buy_yt_flash_underlying = deposit + flash_mint_yt + withdraw of the gain (USDY payer).
  | "buy_yt_flash"
  | "buy_yt_flash_underlying"
  // R5-5 / R5-6, one signature in or out of the underlying:
  //   add_liquidity_underlying = deposit + add_liquidity_single_sy; remove_liquidity_underlying =
  //   remove_liquidity + the sale of the gained PT + withdraw.
  | "add_liquidity_underlying"
  | "remove_liquidity_underlying"

export type GuardValues = {
  minOut?: bigint
  minOut2?: bigint
  maxNetCost?: bigint
}

export type ActionInput = {
  action: ActionId
  marketId: string
  source: string
  amount: bigint
  /**
   * The second amount a call takes: SY in (`add_liquidity`, `add_liquidity_underlying`, the flash
   * `sy_in`), SY to mint (Keep YT), or the YT leg of a redemption. On a version-2 Router
   * (`protocolAbi` 2) also the literal `mint` and `buy_pt_underlying` sign as `sy_in`, and `buy_yt`
   * as `pt_in` (`abiSecondaryAmount`): never something the user gives or gets.
   */
  secondaryAmount?: bigint
  /** One-step Keep YT only (R5-7): the PT and SY the pool is offered, signed as literals. */
  desired?: { pt: bigint; sy: bigint }
  guards: GuardValues
  deadline: bigint
}

export type ActionMeta = {
  label: string
  slippageSensitive: boolean
  hasDeadline: boolean
  tab: "mint" | "trade" | "liquidity" | "redeem"
}

export const ACTION_META: Record<ActionId, ActionMeta> = {
  deposit: { label: "Deposit", slippageSensitive: true, hasDeadline: false, tab: "mint" },
  withdraw: { label: "Withdraw", slippageSensitive: true, hasDeadline: true, tab: "mint" },
  mint: { label: "Mint PT + YT", slippageSensitive: true, hasDeadline: true, tab: "mint" },
  buy_pt: { label: "Buy PT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  sell_pt: { label: "Sell PT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  buy_yt: { label: "Buy YT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  sell_yt: { label: "Sell YT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  add_liquidity: { label: "Add liquidity", slippageSensitive: true, hasDeadline: true, tab: "liquidity" },
  add_liquidity_sy: {
    label: "Add liquidity (SY only)",
    slippageSensitive: true,
    hasDeadline: true,
    tab: "liquidity",
  },
  remove_liquidity: { label: "Remove liquidity", slippageSensitive: true, hasDeadline: true, tab: "liquidity" },
  recombine: { label: "Recombine PT + YT", slippageSensitive: true, hasDeadline: true, tab: "redeem" },
  claim_yield: { label: "Claim yield", slippageSensitive: false, hasDeadline: false, tab: "redeem" },
  redeem: { label: "Redeem at maturity", slippageSensitive: false, hasDeadline: false, tab: "redeem" },
  buy_pt_underlying: { label: "Buy PT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  sell_pt_underlying: { label: "Sell PT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  sell_yt_underlying: { label: "Sell YT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  add_liquidity_keep_yt: { label: "Add liquidity, keep YT", slippageSensitive: true, hasDeadline: true, tab: "liquidity" },
  buy_yt_flash: { label: "Buy YT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  buy_yt_flash_underlying: { label: "Buy YT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  add_liquidity_underlying: { label: "Add liquidity (LP only)", slippageSensitive: true, hasDeadline: true, tab: "liquidity" },
  remove_liquidity_underlying: { label: "Remove liquidity", slippageSensitive: true, hasDeadline: true, tab: "liquidity" },
}

export const MAX_I128 = (1n << 127n) - 1n
const MIN_I128 = -(1n << 127n)

const address = (value: string): ScArg => ({ type: "address", value })

function i128(value: bigint): ScArg {
  if (value < MIN_I128 || value > MAX_I128) throw new Error("i128 argument is out of range.")
  return { type: "i128", value }
}

function u64(value: bigint): ScArg {
  if (value < 0n || value >= 1n << 64n) throw new Error("u64 argument is out of range.")
  return { type: "u64", value }
}

function floor(value: bigint | undefined): ScArg {
  if (value === undefined) throw new Error("missing floor")
  return i128(value)
}

/**
 * What a call refuses to be built from on a version-2 Router: one of the three actions below without
 * its literal, i.e. a plan stored before the upgrade (plan 0009, Review Focus 1). Never sent with the
 * old argument count.
 */
export const STALE_PLAN = "This trade was prepared for an older version of the contracts. Start it again."

/**
 * The actions whose Router call gained a literal in principal 3af9388 (audit H-1): the amount the
 * second leg spends is the caller's, not the first leg's return value.
 */
const ABI2_LITERAL: ReadonlySet<ActionId> = new Set<ActionId>(["mint", "buy_pt_underlying", "buy_yt"])

/** Whether `action`'s call on this deployment signs `abiSecondaryAmount`'s literal: version 2 only. */
export function signsAbiSecondary(m: Pick<Manifest, "protocolAbi">, action: ActionId): boolean {
  return protocolAbi(m) === 2 && ABI2_LITERAL.has(action)
}

/**
 * The literal a version-2 Router call signs in `secondaryAmount`, from the reads the preview uses
 * (plan 0009, M-5); `undefined` on version 1 and for every other action.
 * - `mint` (`wrap_and_mint`) and `buy_pt_underlying` (`swap_underlying_for_pt`): `sy_in`, the SY the
 *   deposit of `amount` gives, `amount * RATE_SCALE / exchange_rate()` floored (`previewDeposit`), as
 *   the Router's own comment specifies. For today's wrappers the rate is 1, so it equals `amount`.
 * - `buy_yt` (`swap_sy_for_yt`, `amount` is `sy_in`): `pt_in`, the PT minting `sy_in` yields after the
 *   tokenization fee (`previewMint`, rounded as `PrincipalManager.mint` rounds). The oracle value never
 *   decreases, so it never exceeds what the mint gives; if the oracle moves up before inclusion, the
 *   few PT more stay in the wallet (the Router sweeps nothing).
 */
export function abiSecondaryAmount(
  m: Manifest,
  action: ActionId,
  amount: bigint,
  r: { exchangeRate: bigint; oracleRate: bigint; tokenizationFeeBps: bigint },
): bigint | undefined {
  if (!signsAbiSecondary(m, action)) return undefined
  return action === "buy_yt" ? previewMint(amount, r.oracleRate, r.tokenizationFeeBps).pt : previewDeposit(amount, r.exchangeRate)
}

export function invocationFor(m: Manifest, input: ActionInput): ContractInvocation {
  const market = getMarket(m, input.marketId)
  if (!market) throw new Error(`Unknown market "${input.marketId}".`)
  const { router, sy, pool: poolId } = market.contracts
  const from = address(input.source)
  const pool = address(poolId)
  const amount = i128(input.amount)
  const g = input.guards
  const deadline = u64(input.deadline)
  const viaRouter = (functionName: string, args: ScArg[]): ContractInvocation => ({
    contractId: router,
    functionName,
    args,
  })
  /**
   * Version 2's literal (`sy_in`, Buy YT's `pt_in`), between the amount and the floors; nothing on
   * version 1, where `secondaryAmount` is not signed for these actions.
   */
  const literal = (): ScArg[] => {
    if (!signsAbiSecondary(m, input.action)) return []
    if (input.secondaryAmount === undefined) throw new Error(STALE_PLAN)
    return [i128(input.secondaryAmount)]
  }

  switch (input.action) {
    case "deposit":
      return { contractId: sy, functionName: "deposit", args: [from, amount, floor(g.minOut)] }
    case "withdraw":
      return viaRouter("unwrap", [from, pool, amount, floor(g.minOut), deadline])
    case "mint":
      // wrap_and_mint(from, pool, amount, [sy_in,] min_pt_out, deadline)
      return viaRouter("wrap_and_mint", [from, pool, amount, ...literal(), floor(g.minOut), deadline])
    case "buy_pt":
      return viaRouter("swap_sy_for_pt", [from, pool, amount, floor(g.minOut), deadline])
    case "sell_pt":
      return viaRouter("swap_pt_for_sy", [from, pool, amount, floor(g.minOut), deadline])
    case "buy_yt":
      // swap_sy_for_yt(from, pool, sy_in, [pt_in,] min_yt_out, max_net_cost, deadline).
      // max_net_cost bounds the PT-for-SY leg funding the YT purchase; Router derives
      // min_sy_back = sy_in - max_net_cost, so it must be a real quote-derived bound.
      return viaRouter("swap_sy_for_yt", [from, pool, amount, ...literal(), floor(g.minOut), floor(g.maxNetCost), deadline])
    case "sell_yt":
      return viaRouter("swap_yt_for_sy", [from, pool, amount, floor(g.minOut), deadline])
    case "add_liquidity": {
      if (input.secondaryAmount === undefined) throw new Error("add_liquidity requires secondaryAmount (SY in).")
      return viaRouter("add_liquidity", [from, pool, amount, i128(input.secondaryAmount), floor(g.minOut), deadline])
    }
    case "add_liquidity_sy":
      return viaRouter("add_liquidity_single_sy", [from, pool, amount, floor(g.minOut), deadline])
    case "remove_liquidity":
      return viaRouter("remove_liquidity", [from, pool, amount, floor(g.minOut), floor(g.minOut2), deadline])
    case "recombine":
      return viaRouter("recombine", [from, pool, amount, floor(g.minOut), deadline])
    case "claim_yield":
      return viaRouter("claim_yield", [from, pool])
    case "redeem":
      // redeem_at_maturity(from, pool, pt_amount, yt_amount): settlement rate is frozen, no floor.
      return viaRouter("redeem_at_maturity", [from, pool, amount, i128(input.secondaryAmount ?? 0n)])
    case "buy_pt_underlying":
      // swap_underlying_for_pt(from, pool, underlying_amount, [sy_in,] min_pt_out, deadline)
      return viaRouter("swap_underlying_for_pt", [from, pool, amount, ...literal(), floor(g.minOut), deadline])
    case "sell_pt_underlying":
      // swap_pt_for_underlying(from, pool, pt_in, min_underlying_out, deadline)
      return viaRouter("swap_pt_for_underlying", [from, pool, amount, floor(g.minOut), deadline])
    case "sell_yt_underlying":
      // swap_yt_for_underlying(from, pool, yt_in, min_underlying_out, deadline)
      return viaRouter("swap_yt_for_underlying", [from, pool, amount, floor(g.minOut), deadline])
    case "add_liquidity_keep_yt": {
      // add_liquidity_keep_yt(from, pool, underlying_amount, mint_amount, pt_desired, sy_desired,
      // min_lp_out, deadline): mint_amount is SY shares of the deposit, sized by the dApp (R4-4); the
      // desired PT and SY are signed as literals, never left to the contract (R5-7).
      if (input.secondaryAmount === undefined) throw new Error("add_liquidity_keep_yt requires secondaryAmount (SY to mint).")
      if (input.desired === undefined) throw new Error("add_liquidity_keep_yt requires desired (the PT and SY offered to the pool).")
      return viaRouter("add_liquidity_keep_yt", [
        from,
        pool,
        amount,
        i128(input.secondaryAmount),
        i128(input.desired.pt),
        i128(input.desired.sy),
        floor(g.minOut),
        deadline,
      ])
    }
    case "buy_yt_flash": {
      // flash_mint_yt(from, pool, sy_in, min_yt_out, max_net_cost, deadline). `amount` is the budget (R5-2):
      // the pool pulls max_net_cost up front, which R5-3 caps at the budget. `sy_in` is what it tokenizes.
      if (input.secondaryAmount === undefined) throw new Error("buy_yt_flash requires secondaryAmount (SY tokenized).")
      return viaRouter("flash_mint_yt", [from, pool, i128(input.secondaryAmount), floor(g.minOut), floor(g.maxNetCost), deadline])
    }
    case "buy_yt_flash_underlying": {
      // flash_mint_yt_from_underlying(from, pool, sy_in, min_yt_out, max_net_cost, underlying_budget,
      // min_underlying_back, deadline). The zero `min_underlying_back` is allowed (R5-3): it follows
      // from the signed max_net_cost.
      if (input.secondaryAmount === undefined) throw new Error("buy_yt_flash_underlying requires secondaryAmount (SY tokenized).")
      return viaRouter("flash_mint_yt_from_underlying", [
        from,
        pool,
        i128(input.secondaryAmount),
        floor(g.minOut),
        floor(g.maxNetCost),
        amount,
        floor(g.minOut2),
        deadline,
      ])
    }
    case "add_liquidity_underlying": {
      // add_liquidity_single_underlying(from, pool, underlying_amount, sy_in, min_lp_out, deadline):
      // sy_in = previewDeposit(amount, xr) as a literal (R5-5).
      if (input.secondaryAmount === undefined) throw new Error("add_liquidity_underlying requires secondaryAmount (SY in).")
      return viaRouter("add_liquidity_single_underlying", [from, pool, amount, i128(input.secondaryAmount), floor(g.minOut), deadline])
    }
    case "remove_liquidity_underlying":
      // remove_liquidity_to_underlying(from, pool, lp_in, min_underlying_out, deadline)
      return viaRouter("remove_liquidity_to_underlying", [from, pool, amount, floor(g.minOut), deadline])
  }
}
