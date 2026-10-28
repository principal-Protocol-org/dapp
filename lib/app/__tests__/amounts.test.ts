// @vitest-environment node
import { describe, expect, it } from "vitest"
import { amountsComplete, checkAmount, maxText, spendBalance } from "../amounts"
import type { AccountState } from "@/lib/protocol/account-state"
import type { Live } from "@/lib/protocol/types"

const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 1 })
const down: Live<never> = { status: "unavailable", error: "rpc down" }
const SY = { decimals: 7, unit: "SY" }

function account(over: Partial<AccountState> = {}): AccountState {
  return {
    underlying: live(1n),
    sy: live(2n),
    pt: live(3n),
    yt: live(4n),
    lp: live(5n),
    ytLastClaimedIndex: live(0n),
    ytPendingClaim: live(0n),
    depositCap: live(0n),
    netDeposited: live(0n),
    sacAuthorized: live(true),
    sep57: null,
    permAllowed: live(true),
    permPt: live(true),
    permYt: live(true),
    trustline: live("authorized"),
    accountExists: live(true),
    ...over,
  }
}

describe("checkAmount (Review Focus 3)", () => {
  it("parses a plain decimal at the token's decimals", () => {
    expect(checkAmount("12.5", SY)).toEqual({ ok: true, raw: 125_000_000n })
    expect(checkAmount(" 1 ", SY)).toEqual({ ok: true, raw: 10_000_000n })
  })

  it("refuses more decimals than the token has, without rounding", () => {
    const r = checkAmount("1.12345678", SY)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/at most 7 digits after the point/)
  })

  it("refuses exponents", () => {
    const r = checkAmount("1e3", SY)
    expect(!r.ok && r.message).toMatch(/Exponents like 1e3 are not accepted/)
  })

  it("refuses negative amounts", () => {
    const r = checkAmount("-1", SY)
    expect(!r.ok && r.message).toBe("Amounts cannot be negative.")
  })

  it("refuses anything that is not digits and one point", () => {
    for (const text of ["1,5", ".5", "5.", "1.2.3", "abc", "0x10", "+1"]) {
      const r = checkAmount(text, SY)
      expect(r.ok, text).toBe(false)
      expect(!r.ok && r.message, text).toMatch(/digits and one decimal point/)
    }
  })

  it("refuses an empty field unless the field is optional, where it means zero", () => {
    expect(checkAmount("", SY)).toEqual({ ok: false, message: "Enter an amount." })
    expect(checkAmount("  ", SY)).toEqual({ ok: false, message: "Enter an amount." })
    expect(checkAmount("", { ...SY, optional: true })).toEqual({ ok: true, raw: 0n })
  })

  it("refuses zero, and says so plainly when the balance itself is zero", () => {
    expect(checkAmount("0", SY)).toEqual({ ok: false, message: "Enter an amount greater than zero." })
    expect(checkAmount("0", { ...SY, balance: live(0n) })).toEqual({ ok: false, message: "You have no SY to use." })
    expect(checkAmount("0", { ...SY, optional: true })).toEqual({ ok: true, raw: 0n })
  })

  it("refuses more than the balance, naming the balance exactly", () => {
    const r = checkAmount("100.0000001", { ...SY, balance: live(1_000_000_000n) })
    expect(r).toEqual({ ok: false, message: "More than your balance: you have 100 SY." })
    expect(checkAmount("100", { ...SY, balance: live(1_000_000_000n) })).toEqual({ ok: true, raw: 1_000_000_000n })
  })

  it("does not compare with an unavailable balance (the gates refuse it instead)", () => {
    expect(checkAmount("5", { ...SY, balance: down })).toEqual({ ok: true, raw: 50_000_000n })
  })

  it("refuses an amount that does not fit a contract i128", () => {
    const r = checkAmount("9".repeat(40), SY)
    expect(!r.ok && r.message).toBe("This amount is too large.")
  })
})

describe("maxText", () => {
  it("formats the balance exactly, so it parses back to the same raw value", () => {
    expect(maxText(123_456_789n, 7)).toBe("12.3456789")
    expect(maxText(1_000_000_000n, 7)).toBe("100")
    expect(maxText(0n, 7)).toBe("0")
    expect(checkAmount(maxText(123_456_789n, 7), SY)).toEqual({ ok: true, raw: 123_456_789n })
  })
})

describe("spendBalance (R24)", () => {
  const acc = account()
  it.each([
    ["deposit", "amount", 1n],
    ["mint", "amount", 1n],
    ["withdraw", "amount", 2n],
    ["buy_pt", "amount", 2n],
    ["buy_yt", "amount", 2n],
    ["add_liquidity_sy", "amount", 2n],
    ["sell_pt", "amount", 3n],
    ["sell_yt", "amount", 4n],
    ["add_liquidity", "amount", 3n],
    ["add_liquidity", "secondaryAmount", 2n],
    ["remove_liquidity", "amount", 5n],
    ["redeem", "amount", 3n],
    ["redeem", "secondaryAmount", 4n],
    ["recombine", "amount", 3n],
  ] as const)("%s %s spends the right balance", (action, field, expected) => {
    expect(spendBalance(action, field, acc)).toEqual(live(expected))
  })

  it("recombine spends PT and YT one for one, so its MAX is the smaller balance", () => {
    expect(spendBalance("recombine", "amount", account({ pt: live(9n), yt: live(7n) }))).toEqual(live(7n))
    expect(spendBalance("recombine", "amount", account({ pt: down }))).toEqual(down)
  })

  it("claim spends nothing, and a field an action does not have has no balance", () => {
    expect(spendBalance("claim_yield", "amount", acc)).toBeNull()
    expect(spendBalance("buy_pt", "secondaryAmount", acc)).toBeNull()
  })
})

describe("amountsComplete", () => {
  it("knows which amounts each action needs before it can be simulated", () => {
    expect(amountsComplete("claim_yield", 0n, undefined)).toBe(true)
    expect(amountsComplete("buy_pt", 1n, undefined)).toBe(true)
    expect(amountsComplete("buy_pt", 0n, undefined)).toBe(false)
    expect(amountsComplete("add_liquidity", 1n, 0n)).toBe(false)
    expect(amountsComplete("add_liquidity", 1n, 1n)).toBe(true)
    expect(amountsComplete("redeem", 0n, 0n)).toBe(false)
    expect(amountsComplete("redeem", 0n, 1n)).toBe(true)
    expect(amountsComplete("redeem", 1n, undefined)).toBe(true)
  })
})
