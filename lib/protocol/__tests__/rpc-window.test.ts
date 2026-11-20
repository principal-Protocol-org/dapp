// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { isMethodUnsupported, readRpcWindow } from "../rpc-window"

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
    expect(rpc.getLedgers).toHaveBeenCalledWith({ startLedger: 900, pagination: { limit: 1 } })
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
