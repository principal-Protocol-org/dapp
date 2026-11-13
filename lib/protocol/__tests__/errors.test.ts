import { describe, expect, it } from "vitest"
import { errorMessage, errorReason, failureSentence, isRpcBusy, RPC_BUSY_MESSAGE, RPC_BUSY_REASON, saysRpcBusy, userErrorMessage } from "../errors"

describe("errorMessage", () => {
  it("reads an Error, a string and an object message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("plain")).toBe("plain")
    expect(errorMessage({ message: "no code" })).toBe("no code")
  })
  it("includes a JSON-RPC code", () => {
    expect(errorMessage({ code: -32600, message: "start is before oldest ledger" })).toBe("start is before oldest ledger (code -32600)")
  })
  it("never returns [object Object]", () => {
    expect(errorMessage({ a: 1 })).toBe('{"a":1}')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(errorMessage(circular)).toBe("unknown error")
    expect(errorMessage(undefined)).toBe("undefined")
    expect(errorMessage(42)).toBe("42")
  })
})

/** What the Stellar SDK rejects with when stellar-rpc is overloaded (`jsonrpc.postObject` throws the response's `error`). */
const PREFLIGHT_QUEUE_FULL = { code: -32004, message: "preflight queue full; retry later" }
/** The SDK's HTTP client on a non-2xx answer. */
const httpError = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } })

describe("isRpcBusy", () => {
  it.each<[string, unknown]>([
    ["the SDK's plain JSON-RPC error object", PREFLIGHT_QUEUE_FULL],
    ["its code alone", { code: -32004 }],
    ["its message alone", new Error("preflight queue full; retry later")],
    ["its message as errorMessage renders it", "preflight queue full; retry later (code -32004)"],
    ["HTTP 429", httpError(429)],
    ["HTTP 503", httpError(503)],
    ["HTTP 503 by its message only", new Error("Request failed with status code 503")],
    ["the user's message, wrapped", new Error(`The transaction could not be prepared: ${RPC_BUSY_MESSAGE}`)],
  ])("is true for %s", (_, error) => {
    expect(isRpcBusy(error)).toBe(true)
  })

  it.each<[string, unknown]>([
    ["another JSON-RPC error", { code: -32600, message: "start is before oldest ledger" }],
    ["a contract error", new Error("HostError: Error(Contract, #7)")],
    ["a plain Error", new Error("boom")],
    ["HTTP 400", httpError(400)],
    ["HTTP 502", httpError(502)],
    ["a reset socket", new Error("socket hang up")],
    ["no response", { response: null }],
    ["nothing", undefined],
  ])("is false for %s", (_, error) => {
    expect(isRpcBusy(error)).toBe(false)
  })
})

describe("userErrorMessage", () => {
  it("shows the plain busy message for the SDK's -32004 object, never its raw text", () => {
    expect(userErrorMessage(PREFLIGHT_QUEUE_FULL)).toBe("The Stellar network is busy. Try again in a moment.")
    expect(userErrorMessage(httpError(503))).toBe(RPC_BUSY_MESSAGE)
  })
  it("keeps any other message as errorMessage reads it", () => {
    expect(userErrorMessage(new Error("boom"))).toBe("boom")
    expect(userErrorMessage({ code: -32600, message: "start is before oldest ledger" })).toBe("start is before oldest ledger (code -32600)")
    expect(userErrorMessage({ a: 1 })).toBe('{"a":1}')
  })
})

describe("failureSentence", () => {
  const prepared = (message: string) => `The transaction could not be prepared (${message}). Nothing was signed; check the reasons shown and try again.`
  it("is the busy message, then what the caller adds, for an overloaded RPC", () => {
    expect(failureSentence(PREFLIGHT_QUEUE_FULL, prepared, "Nothing was signed.")).toBe("The Stellar network is busy. Try again in a moment. Nothing was signed.")
    expect(failureSentence(PREFLIGHT_QUEUE_FULL, prepared)).toBe(RPC_BUSY_MESSAGE)
  })
  it("keeps the sentence as it always read for any other failure", () => {
    expect(failureSentence(new Error("HostError: Error(Contract, #9)"), prepared, "Nothing was signed.")).toBe(
      "The transaction could not be prepared (HostError: Error(Contract, #9)). Nothing was signed; check the reasons shown and try again.",
    )
  })
})

describe("wrapping twice", () => {
  const prepared = (message: string) => `The transaction could not be prepared (${message}). Nothing was signed; check the reasons shown and try again.`
  it("keeps a message that already says the network is busy, and what the first wrap added", () => {
    const once = new Error(failureSentence(PREFLIGHT_QUEUE_FULL, prepared, "Nothing was signed."))
    expect(once.message).toBe("The Stellar network is busy. Try again in a moment. Nothing was signed.")
    // The sign flows and the route show a prepare error with userErrorMessage: it stays whole.
    expect(userErrorMessage(once)).toBe(once.message)
    expect(failureSentence(once, prepared, "Nothing was signed.")).toBe(once.message)
    expect(`Step 2 was not sent: ${userErrorMessage(once)}`).toBe("Step 2 was not sent: The Stellar network is busy. Try again in a moment. Nothing was signed.")
  })
  it("recognizes the app's own wording, derived from one sentence", () => {
    expect(saysRpcBusy(RPC_BUSY_MESSAGE)).toBe(true)
    expect(saysRpcBusy(`Could not read the pool state (${RPC_BUSY_REASON}).`)).toBe(true)
    expect(saysRpcBusy("boom")).toBe(false)
  })
})

describe("errorReason", () => {
  it("is the short reason for an overloaded RPC, for a sentence that already says what to do", () => {
    expect(errorReason(PREFLIGHT_QUEUE_FULL)).toBe("the Stellar network is busy")
    expect(errorReason(RPC_BUSY_MESSAGE)).toBe(RPC_BUSY_REASON)
    expect(`Step 2's result could not be checked (${errorReason(PREFLIGHT_QUEUE_FULL)}). Check again in a moment.`).toBe(
      "Step 2's result could not be checked (the Stellar network is busy). Check again in a moment.",
    )
  })
  it("keeps any other message", () => {
    expect(errorReason(new Error("boom"))).toBe("boom")
    expect(errorReason({ code: -32600, message: "start is before oldest ledger" })).toBe("start is before oldest ledger (code -32600)")
  })
})
