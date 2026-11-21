// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { isMethodUnsupported, prunedOldestOf, readRpcWindow } from "../rpc-window"

const WINDOW = { oldestLedger: 100, latestLedger: 900 }

function withoutHealth(error: unknown) {
  return {
    getHealth: vi.fn(async () => {
      throw error
    }),
    getLatestLedger: vi.fn(async () => ({ sequence: 900 })),
    getLedgers: vi.fn(async () => ({ ...WINDOW, ledgers: [] })),
  }
}

describe("readRpcWindow", () => {
  it("uses getHealth when it works", async () => {
    const rpc = { getHealth: vi.fn(async () => WINDOW), getLedgers: vi.fn() }
    expect(await readRpcWindow(rpc)).toEqual(WINDOW)
    expect(rpc.getLedgers).not.toHaveBeenCalled()
  })

  it.each([
    ["HTTP 400", { response: { status: 400 } }],
    ["JSON-RPC -32601", { code: -32601, message: "x" }],
    ["the provider's message", new Error("the method getHealth does not exist/is not available")],
  ])("takes the window from getLedgers when getHealth is unsupported (%s)", async (_, error) => {
    const rpc = withoutHealth(error)
    expect(await readRpcWindow(rpc)).toEqual(WINDOW)
    expect(rpc.getLedgers).toHaveBeenCalledWith({ startLedger: 880, pagination: { limit: 1 } })
  })

  it.each([
    ["HTTP 500", { response: { status: 500 } }],
    ["a timeout", new Error("timeout of 20000ms exceeded")],
    ["HTTP 429", { response: { status: 429 } }],
  ])("still fails as before when getHealth fails for another reason (%s)", async (_, error) => {
    const rpc = withoutHealth(error)
    await expect(readRpcWindow(rpc)).rejects.toBe(error)
    expect(rpc.getLedgers).not.toHaveBeenCalled()
  })

  it("throws the getHealth error when the server cannot fall back", async () => {
    const error = { response: { status: 400 } }
    await expect(readRpcWindow({ getHealth: async () => { throw error } })).rejects.toBe(error)
  })

  it("isMethodUnsupported is false for non-errors", () => {
    expect(isMethodUnsupported(undefined)).toBe(false)
    expect(isMethodUnsupported("x")).toBe(false)
  })
})

describe("prunedOldestOf", () => {
  it("reads Stellar's range refusal", () => {
    expect(prunedOldestOf(new Error("startLedger must be within the ledger range: 500 - 900"))).toBe(500)
  })
  it("reads dRPC's refusal from the JSON-RPC error of an HTTP 400", () => {
    const error = Object.assign(new Error("Request failed with status code 400"), {
      response: { status: 400, data: { error: { code: 27, message: "Unknown state. First available state is 65465671" } } },
    })
    expect(prunedOldestOf(error)).toBe(65465671)
  })
  it("is undefined for any other failure", () => {
    expect(prunedOldestOf(new Error("boom"))).toBeUndefined()
    expect(prunedOldestOf(undefined)).toBeUndefined()
  })
})
