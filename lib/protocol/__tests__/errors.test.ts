import { describe, expect, it } from "vitest"
import { errorMessage } from "../errors"

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
