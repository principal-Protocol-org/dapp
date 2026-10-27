import { getMarket } from "./manifest"
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

export type GuardValues = { minOut?: bigint; minOut2?: bigint; maxNetCost?: bigint }

export type ActionInput = {
  action: ActionId
  marketId: string
  source: string
  amount: bigint
  secondaryAmount?: bigint
  guards: GuardValues
  deadline: bigint
}

export const ACTION_META: Record<
  ActionId,
  { label: string; slippageSensitive: boolean; hasDeadline: boolean; tab: "mint" | "trade" | "liquidity" | "redeem" }
> = {
  deposit: { label: "Deposit", slippageSensitive: true, hasDeadline: false, tab: "mint" },
  withdraw: { label: "Withdraw", slippageSensitive: true, hasDeadline: true, tab: "mint" },
  mint: { label: "Mint PT + YT", slippageSensitive: true, hasDeadline: true, tab: "mint" },
  buy_pt: { label: "Buy PT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  sell_pt: { label: "Sell PT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  buy_yt: { label: "Buy YT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  sell_yt: { label: "Sell YT", slippageSensitive: true, hasDeadline: true, tab: "trade" },
  add_liquidity: { label: "Add liquidity", slippageSensitive: true, hasDeadline: true, tab: "liquidity" },
  add_liquidity_sy: { label: "Add liquidity (SY only)", slippageSensitive: true, hasDeadline: true, tab: "liquidity" },
  remove_liquidity: { label: "Remove liquidity", slippageSensitive: true, hasDeadline: true, tab: "liquidity" },
  recombine: { label: "Recombine PT + YT", slippageSensitive: true, hasDeadline: true, tab: "redeem" },
  claim_yield: { label: "Claim yield", slippageSensitive: false, hasDeadline: false, tab: "redeem" },
  redeem: { label: "Redeem at maturity", slippageSensitive: false, hasDeadline: false, tab: "redeem" },
}

const MAX_I128 = (1n << 127n) - 1n
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

  switch (input.action) {
    case "deposit":
      return { contractId: sy, functionName: "deposit", args: [from, amount, floor(g.minOut)] }
    case "withdraw":
      return viaRouter("unwrap", [from, pool, amount, floor(g.minOut), deadline])
    case "mint":
      return viaRouter("wrap_and_mint", [from, pool, amount, floor(g.minOut), deadline])
    case "buy_pt":
      return viaRouter("swap_sy_for_pt", [from, pool, amount, floor(g.minOut), deadline])
    case "sell_pt":
      return viaRouter("swap_pt_for_sy", [from, pool, amount, floor(g.minOut), deadline])
    case "buy_yt":
      // max_net_cost bounds the PT-for-SY leg funding the YT purchase; Router derives
      // min_sy_back = sy_in - max_net_cost, so it must be a real quote-derived bound.
      return viaRouter("swap_sy_for_yt", [from, pool, amount, floor(g.minOut), floor(g.maxNetCost), deadline])
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
  }
}
