import { describe, expect, it } from "vitest"
import { accountShort, ago, complianceEventWords, eventSubject, txShort } from "../event-words"

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
