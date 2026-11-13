import { describe, expect, it, vi } from "vitest"
import { isExternalFailure, isTransientRpcError, retryOnce, retryTransient, RPC_RETRY_BUDGET_MS } from "./retry"

/** What the SDK rejected with in run 43511581261 (`jsonrpc.postObject` throws the response's `error`): a plain object. */
const PREFLIGHT_QUEUE_FULL = { code: -32004, message: "preflight queue full; retry later" }
/** The SDK's HTTP client on a non-2xx answer (`buildHttpError`). */
const httpError = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, statusText: "", data: "" } })
/** Node's fetch on a reset socket: "fetch failed", the code on `cause`. */
const fetchFailed = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(`read ${code}`), { code }) })

describe("isTransientRpcError", () => {
  it("counts the exact rejection of run 43511581261 as transient: the plain JSON-RPC error object -32004", () => {
    expect(PREFLIGHT_QUEUE_FULL instanceof Error).toBe(false)
    expect(isTransientRpcError(PREFLIGHT_QUEUE_FULL)).toBe(true)
    expect(isTransientRpcError({ code: -32004 })).toBe(true)
  })

  it.each<[string, unknown]>([
    ["the overload as `errorMessage` renders it", new Error("preflight queue full; retry later (code -32004)")],
    ["the overload wrapped by a caller", new Error("The transaction could not be prepared (preflight queue full; retry later). Nothing was signed.")],
    ["a retry budget spent on it", new Error('read get_reference_value: the RPC still answered "preflight queue full; retry later (code -32004)" after 8 attempts over 74 s', { cause: PREFLIGHT_QUEUE_FULL })],
    ["HTTP 429", httpError(429)],
    ["HTTP 502", httpError(502)],
    ["HTTP 503", httpError(503)],
    ["HTTP 504", httpError(504)],
    ["HTTP 503 by its message only", new Error("Request failed with status code 503")],
    ["a reset socket under fetch", fetchFailed("ECONNRESET")],
    ["a reset socket", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["the SDK's timeout", new Error("timeout of 20000ms exceeded")],
    ["an aborted request on timeout", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })],
  ])("counts %s as transient", (_, error) => {
    expect(isTransientRpcError(error)).toBe(true)
  })

  it.each<[string, unknown]>([
    ["an invalid request", { code: -32602, message: "invalid params" }],
    ["a contract error", new Error("HostError: Error(Contract, #7)")],
    ["HTTP 400", httpError(400)],
    ["HTTP 500", httpError(500)],
    ["a refused connection", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { code: "ECONNREFUSED" })],
    ["an unknown host", Object.assign(new Error("getaddrinfo ENOTFOUND rpc.example"), { code: "ENOTFOUND" })],
    ["an assertion", new Error("expected 1n to be 2n")],
    ["nothing", undefined],
  ])("does not count %s as transient", (_, error) => {
    expect(isTransientRpcError(error)).toBe(false)
  })
})

describe("retryTransient", () => {
  /** A clock that moves only when the retry waits. */
  const fakeClock = () => {
    let t = 0
    return { now: () => t, wait: vi.fn(async (ms: number) => void (t += ms)) }
  }

  it("returns the first answer without waiting", async () => {
    const clock = fakeClock()
    expect(await retryTransient({ what: "read x", run: async () => 1, ...clock })).toBe(1)
    expect(clock.wait).not.toHaveBeenCalled()
  })

  it("asks again after an overload, 2, 4, 8 then 15 s apart, and logs the RPC's answer each time", async () => {
    const clock = fakeClock()
    const log = vi.fn()
    const run = vi.fn<() => Promise<string>>()
    for (let i = 0; i < 5; i++) run.mockRejectedValueOnce(PREFLIGHT_QUEUE_FULL)
    run.mockResolvedValueOnce("ok")
    expect(await retryTransient({ what: "read get_reference_value", run, log, ...clock })).toBe("ok")
    expect(run).toHaveBeenCalledTimes(6)
    expect(clock.wait.mock.calls.map(([ms]) => ms)).toEqual([2_000, 4_000, 8_000, 15_000, 15_000])
    expect(log.mock.calls[0][0]).toBe('read get_reference_value: the RPC answered "preflight queue full; retry later (code -32004)" (attempt 1); asking again in 2 s')
  })

  it("covers a minute of overload: the last attempt starts 74 s after the first, within the budget", async () => {
    const clock = fakeClock()
    const starts: number[] = []
    const run = vi.fn(async () => {
      starts.push(clock.now())
      if (clock.now() < 74_000) throw PREFLIGHT_QUEUE_FULL
      return "answered"
    })
    expect(await retryTransient({ what: "x", run, ...clock })).toBe("answered")
    expect(starts).toEqual([0, 2_000, 6_000, 14_000, 29_000, 44_000, 59_000, 74_000])
    expect(74_000).toBeLessThanOrEqual(RPC_RETRY_BUDGET_MS)
  })

  it("gives up once the budget is spent, naming what, the RPC's answer, the attempts and the time; the cause is kept", async () => {
    const clock = fakeClock()
    const run = vi.fn(async () => {
      throw PREFLIGHT_QUEUE_FULL
    })
    const error = await retryTransient({ what: "read get_reference_value", run, ...clock }).catch((e: unknown) => e)
    expect(run).toHaveBeenCalledTimes(8)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('read get_reference_value: the RPC still answered "preflight queue full; retry later (code -32004)" after 8 attempts over 74 s')
    expect((error as Error).cause).toBe(PREFLIGHT_QUEUE_FULL)
    // Still an external failure: a step around it may run once more if nothing of it landed.
    expect(isExternalFailure(error)).toBe(true)
  })

  it("throws any other failure at once", async () => {
    const clock = fakeClock()
    const contract = new Error("HostError: Error(Contract, #7)")
    const run = vi.fn(async () => {
      throw contract
    })
    await expect(retryTransient({ what: "x", run, ...clock })).rejects.toBe(contract)
    expect(run).toHaveBeenCalledTimes(1)
    expect(clock.wait).not.toHaveBeenCalled()
  })

  it("redacts a secret key from what it logs and throws", async () => {
    const secret = `S${"B".repeat(55)}`
    const clock = fakeClock()
    const log = vi.fn()
    const run = vi.fn(async () => {
      throw new Error(`fetch failed for ${secret}`)
    })
    const error = await retryTransient({ what: "x", run, log, ...clock }).catch((e: unknown) => e)
    expect(log.mock.calls.flat().join("\n")).not.toContain(secret)
    expect((error as Error).message).not.toContain(secret)
  })
})

describe("isExternalFailure", () => {
  it("counts the plain JSON-RPC error object of an overloaded RPC (-32004) as external", () => {
    expect(isExternalFailure(PREFLIGHT_QUEUE_FULL)).toBe(true)
  })

  it("still counts a refused connection or an unknown host as external (one step-level retry), unlike a read retry", () => {
    expect(isExternalFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8000"), { code: "ECONNREFUSED" }))).toBe(true)
    expect(isExternalFailure(new Error("getaddrinfo ENOTFOUND rpc.example"))).toBe(true)
  })

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

  it("runs once more after the RPC's plain -32004 object when nothing landed (it was \"[object Object]\" to it before)", async () => {
    const run = vi.fn<() => Promise<string>>().mockRejectedValueOnce(PREFLIGHT_QUEUE_FULL).mockResolvedValueOnce("ok")
    const log = vi.fn()
    expect(await retryOnce({ what: "oracle tick", run, nothingLanded: async () => true, log, wait: async () => {} })).toBe("ok")
    expect(run).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0][0]).toBe("oracle tick: preflight queue full; retry later (code -32004); nothing of it landed, so it runs once more")
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
