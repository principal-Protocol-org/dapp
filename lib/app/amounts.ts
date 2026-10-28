import type { AccountState } from "@/lib/protocol/account-state"
import type { ActionId } from "@/lib/protocol/actions"
import { formatAmount, parseDecimalToRaw } from "@/lib/protocol/format"
import type { Live } from "@/lib/protocol/types"

/** The two amounts an `ActionInput` carries. */
export type FieldKey = "amount" | "secondaryAmount"

/** A refusal is about the amount itself, or about the balance it would spend (gate codes). */
export type AmountCheck = { ok: true; raw: bigint } | { ok: false; code: "amount" | "balance"; message: string }

const refuse = (message: string, code: "amount" | "balance" = "amount"): AmountCheck => ({ ok: false, code, message })

/** Contract amounts are i128. */
const MAX_I128 = (1n << 127n) - 1n

/**
 * Typed text to a raw amount, or the plain-words reason it is refused (Review Focus 3). Never
 * rounds: more fractional digits than the token has is a refusal. An empty `optional` field is 0.
 * `balance`, when live, is the most this field may spend; an unavailable balance is not compared
 * here (the gates refuse it).
 */
export function checkAmount(
  text: string,
  opts: { decimals: number; unit: string; optional?: boolean; balance?: Live<bigint> | null },
): AmountCheck {
  const trimmed = text.trim()
  if (trimmed === "") return opts.optional ? { ok: true, raw: 0n } : refuse("Enter an amount.")
  if (trimmed.startsWith("-")) return refuse("Amounts cannot be negative.")
  if (/e/i.test(trimmed) && /^[\d.]+e[+-]?\d+$/i.test(trimmed)) {
    return refuse("Exponents like 1e3 are not accepted: enter the plain number, for example 1000.")
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return refuse("Enter a number using digits and one decimal point, for example 12.5.")
  const raw = parseDecimalToRaw(trimmed, opts.decimals)
  if (raw === null) {
    return refuse(`${opts.unit} has ${opts.decimals} decimal places: use at most ${opts.decimals} digits after the point.`)
  }
  if (raw > MAX_I128) return refuse("This amount is too large.")
  const balance = opts.balance?.status === "live" ? opts.balance.value : undefined
  if (raw === 0n && !opts.optional) {
    return balance === 0n ? refuse(`You have no ${opts.unit} to use.`, "balance") : refuse("Enter an amount greater than zero.")
  }
  if (balance !== undefined && raw > balance) {
    return refuse(`More than your balance: you have ${maxText(balance, opts.decimals)} ${opts.unit}.`, "balance")
  }
  return { ok: true, raw }
}

/** A balance as the exact text MAX puts in the field: every decimal, so it parses back unchanged. */
export function maxText(raw: bigint, decimals: number): string {
  return formatAmount(raw, decimals, decimals)
}

function smaller(a: Live<bigint>, b: Live<bigint>): Live<bigint> {
  if (a.status === "unavailable") return a
  if (b.status === "unavailable") return b
  return a.value <= b.value ? a : b
}

/**
 * The balance a field spends (R24), which MAX fills and the amount is checked against. Null when
 * the field spends nothing (claim) or the action has no such field. Recombine burns PT and YT one
 * for one, so its MAX is the smaller of the two.
 */
export function spendBalance(action: ActionId, field: FieldKey, acc: AccountState): Live<bigint> | null {
  if (field === "secondaryAmount") {
    if (action === "add_liquidity") return acc.sy
    if (action === "redeem") return acc.yt
    return null
  }
  switch (action) {
    case "deposit":
    case "mint":
      return acc.underlying
    case "withdraw":
    case "buy_pt":
    case "buy_yt":
    case "add_liquidity_sy":
      return acc.sy
    case "sell_pt":
    case "add_liquidity":
    case "redeem":
      return acc.pt
    case "sell_yt":
      return acc.yt
    case "remove_liquidity":
      return acc.lp
    case "recombine":
      return smaller(acc.pt, acc.yt)
    case "claim_yield":
      return null
  }
}

/** Whether the amounts are complete enough to simulate (the amount gate's rule, ahead of it). */
export function amountsComplete(action: ActionId, amount: bigint, secondaryAmount: bigint | undefined): boolean {
  const second = secondaryAmount ?? 0n
  switch (action) {
    case "claim_yield":
      return true
    case "redeem":
      return amount >= 0n && second >= 0n && amount + second > 0n
    case "add_liquidity":
      return amount > 0n && second > 0n
    default:
      return amount > 0n
  }
}
