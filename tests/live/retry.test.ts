import { describe, expect, it, vi } from "vitest"
import { isExternalFailure, retryOnce } from "./retry"

describe("isExternalFailure", () => {
  it.each([
    "Friendbot could not be reached. Check your connection, then try again.",
    "Friendbot could not fund your account (it answered 502). Try again in a minute.",
    "Request failed with status code 503",
    "Request failed with status code 429",
    "fetch failed",
    "read ECONNRESET",
    "socket hang up",
    "The network is busy and did not accept the trustline transaction. Try again in a moment.",
    "Soroban submission failed: the network rejected the transaction because the account's sequence number changed, so another transaction was sent from this account; prepare it again. Nothing was executed.",
  ])("counts %s as external", (message) => {
    expect(isExternalFailure(new Error(message))).toBe(true)
  })

  it.each([
    "Friendbot could not fund your account (it answered 400). Try again in a minute.",
    "buy_pt: underlying moved: expected -3000000000n to be -1000000000n",
    "The trustline transaction failed on the network. Nothing changed; try again.",
    "Request failed with status code 400",
  ])("does not count %s as external", (message) => {
    expect(isExternalFailure(new Error(message))).toBe(false)
  })

  it("reads an assertion's received value too: a gate that could not read or simulate is external", () => {
    const error = Object.assign(new Error("buy_pt step 1/1: gates: expected [ { code: 'quote', …(1) } ] to deeply equal []"), {
      actual: [{ code: "quote", message: "The simulation could not run (Request failed with status code 502), so there is no exact quote. Try again in a moment." }],
    })
    expect(isExternalFailure(error)).toBe(true)
    const refused = Object.assign(new Error("gates"), { actual: [{ code: "compliance", message: "Blocked by the issuer" }] })
    expect(isExternalFailure(refused)).toBe(false)
  })
})

describe("retryOnce", () => {
  const external = () => new Error("Request failed with status code 503")

  it("returns the first result without checking anything", async () => {
    const nothingLanded = vi.fn(async () => true)
    expect(await retryOnce({ what: "x", run: async () => 1, nothingLanded, wait: async () => {} })).toBe(1)
    expect(nothingLanded).not.toHaveBeenCalled()
  })

  it("runs once more after an external failure when nothing landed, and logs it", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValueOnce(external()).mockResolvedValueOnce("ok")
    const log = vi.fn()
    const wait = vi.fn(async () => {})
    expect(await retryOnce({ what: "the deposit", run, nothingLanded: async () => true, log, wait, delayMs: 7 })).toBe("ok")
    expect(run).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(7)
    expect(log.mock.calls[0][0]).toMatch(/the deposit: .*503.*once more/)
  })

  it("never runs a third time", async () => {
    const run = vi.fn(async () => {
      throw external()
    })
    await expect(retryOnce({ what: "x", run, nothingLanded: async () => true, wait: async () => {} })).rejects.toThrow("503")
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("rethrows a failure that is not external, without a second run", async () => {
    const run = vi.fn(async () => {
      throw new Error("expected 1n to be 2n")
    })
    await expect(retryOnce({ what: "x", run, nothingLanded: async () => true, wait: async () => {} })).rejects.toThrow("expected 1n")
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("rethrows when something of the first run may have landed, or when that cannot be told", async () => {
    for (const nothingLanded of [async () => false, async () => Promise.reject(new Error("rpc down"))]) {
      const run = vi.fn(async () => {
        throw external()
      })
      await expect(retryOnce({ what: "x", run, nothingLanded, wait: async () => {} })).rejects.toThrow("503")
      expect(run).toHaveBeenCalledTimes(1)
    }
  })

  it("redacts a secret key from what it logs", async () => {
    const secret = `S${"A".repeat(55)}`
    const run = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error(`fetch failed for ${secret}`)).mockResolvedValueOnce(1)
    const log = vi.fn()
    await retryOnce({ what: "x", run, nothingLanded: async () => true, log, wait: async () => {} })
    expect(log.mock.calls[0][0]).not.toContain(secret)
  })
})
