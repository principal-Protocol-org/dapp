import { describe, expect, it } from "vitest"
import { accountShort, ago, closeTimeText, complianceEventWords, eventSubject, eventWords, txShort } from "../event-words"

describe("event words", () => {
  it("words every compliance topic, and shows an unknown one as it is", () => {
    for (const topic of ["recovery", "finalize", "acc_grant", "acc_rev", "acc_batch", "ast_grant", "ast_rev"])
      expect(complianceEventWords(topic)).not.toBe(topic)
    expect(complianceEventWords("mystery")).toBe("mystery")
  })

  it("names the account, or a batch's caller (its accounts are not in the event)", () => {
    expect(eventSubject("acc_grant", { caller: "GC", account: "GA" })).toBe("GA")
    expect(eventSubject("acc_batch", { caller: "GC" })).toBe("GC")
    expect(eventSubject("finalize", {})).toBeNull()
  })

  it("words the risk topics, a pause from its value, and names a pauser or consumer as the subject", () => {
    for (const topic of ["cb_limit", "ast_limit", "cb_window", "add_psr", "rm_psr", "add_cons", "rm_cons", "acc_grant"]) expect(eventWords(topic)).not.toBe(topic)
    expect(eventWords("paused", { caller: "GC", paused: true })).toBe("Paused")
    expect(eventWords("paused", { paused: false })).toBe("Unpaused")
    // An undecoded event (stored with data {}) is never read as a pause.
    expect(eventWords("paused", {})).toBe("Pause state not decoded")
    expect(eventWords("paused", { paused: "true" })).toBe("Pause state not decoded")
    expect(eventWords("mystery")).toBe("mystery")
    expect(eventSubject("add_psr", { caller: "GC", pauser: "GP" })).toBe("GP")
    expect(eventSubject("add_cons", { caller: "GC", consumer: "CS" })).toBe("CS")
  })

  it("words every market and oracle topic the index decodes (the activity feed), and names who acted", () => {
    const market = ["deposit", "withdraw", "sy_xfer", "seize", "mint", "recombine", "redeem", "yt_claim", "settled", "fee_claim"]
    const pool = ["buy_pt", "sell_pt", "sell_yt", "flash_yt", "add_liq", "zap_liq", "rem_liq", "lp_xfer", "lp_seize"]
    const oracle = ["ref_set", "ref_rej", "src_set", "feed_set", "adm_xfer"]
    for (const topic of [...market, ...pool, ...oracle]) expect(eventWords(topic), topic).not.toBe(topic)
    expect(eventWords("buy_pt")).toBe("PT bought")
    expect(eventWords("ref_rej")).toBe("Oracle update rejected")
    // Every topic the indexed contracts publish has words (principal 665bb67 and origin/main), the wiring ones included.
    expect(eventWords("esc_set")).toBe("RecoveryEscrow wired")
    expect(eventWords("rc_set")).toBe("RiskControl wired")
    expect(eventWords("cap_set")).toBe("Deposit cap set")
    expect(eventWords("not_a_topic")).toBe("not_a_topic")
    for (const topic of ["deposit", "withdraw", "mint", "recombine", "redeem", "yt_claim", "buy_pt", "sell_pt", "sell_yt", "flash_yt", "add_liq", "zap_liq", "rem_liq", "sy_xfer", "lp_xfer"])
      expect(eventSubject(topic, { from: "GF", to: "GT" }), topic).toBe("GF")
    expect(eventSubject("seize", { caller: "GC", account: "GA" })).toBe("GA")
    expect(eventSubject("fee_claim", { payee: "GP", owed: "1" })).toBe("GP")
    expect(eventSubject("adm_xfer", { current_admin: "GO", new_admin: "GN" })).toBe("GN")
    expect(eventSubject("ref_set", { value: "1", timestamp: "2" })).toBeNull()
  })

  it("reads a close time as UTC, whole seconds", () => {
    expect(closeTimeText("2026-11-14T00:04:59.000Z")).toBe("2026-11-14 00:04:59 UTC")
    expect(closeTimeText("2026-11-14T00:04:59Z")).toBe("2026-11-14 00:04:59 UTC")
    expect(closeTimeText("not a time")).toBe("not a time")
  })

  it("shortens ids and dates history coarsely", () => {
    expect(txShort("68be08ad3f0c4e2b9a1d7c5e8f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a")).toBe("68be08…8f7a")
    expect(accountShort("GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI")).toBe("GBZX…MADI")
    expect(ago(42.9)).toBe("42s ago")
    expect(ago(125)).toBe("2m ago")
    expect(ago(3 * 3600 + 43 * 60 + 47)).toBe("3h 43m ago")
    expect(ago(2 * 86400 + 5 * 3600)).toBe("2d 5h ago")
    expect(ago(-5)).toBe("0s ago")
  })
})
