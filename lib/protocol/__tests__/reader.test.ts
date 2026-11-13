// @vitest-environment node
import { describe, expect, it } from "vitest"
import { isContractError, readLive, unavailable, type ContractReader } from "../reader"

// The shape Soroban RPC returns in `simulation.error`: one HostError line, then the diagnostic event log.
const SIMULATION_ERROR = [
  "HostError: Error(Contract, #13)",
  "",
  "Event log (newest first):",
  '   0: [Diagnostic Event] contract:CCESAXEYLLFI34BLJ7NBTQP2554K7PZJRFPZBET3ZE7NRDTE3BGMRJDU, topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", GDDKLGGW5HG76QBESUX4JHFVYA3765HJGVUDXFGQLAJYJ4CQDPHW7ZHQ]',
  '   1: [Diagnostic Event] topics:[fn_call, CCESAXEYLLFI34BLJ7NBTQP2554K7PZJRFPZBET3ZE7NRDTE3BGMRJDU, balance], data:GDDKLGGW5HG76QBESUX4JHFVYA3765HJGVUDXFGQLAJYJ4CQDPHW7ZHQ',
].join("\n")

describe("unavailable", () => {
  it("shows an overloaded RPC (the SDK's plain -32004 object) as the busy message, never its raw text", async () => {
    const busy = { code: -32004, message: "preflight queue full; retry later" }
    expect(unavailable(busy)).toEqual({ status: "unavailable", error: "The Stellar network is busy. Try again in a moment." })
    // Through a read, as every panel and gate gets it; and it is no contract error (it was not refused).
    const reader: ContractReader = async () => {
      throw busy
    }
    const live = await readLive(reader, { contractId: "C", functionName: "pool_state" })
    expect(live).toEqual({ status: "unavailable", error: "The Stellar network is busy. Try again in a moment." })
    expect(live.status === "unavailable" && isContractError(live.error)).toBe(false)
  })

  it("summarizes a JSON-RPC error object rather than [object Object]", () => {
    expect(unavailable({ code: -32600, message: "rpc refused" })).toEqual({ status: "unavailable", error: "rpc refused (code -32600)" })
  })

  it("keeps only the error's first line, without the simulation's diagnostic event log", () => {
    const live = unavailable(new Error(SIMULATION_ERROR))
    expect(live).toEqual({ status: "unavailable", error: "HostError: Error(Contract, #13)" })
  })

  it("still lets isContractError recognise a contract trap", () => {
    const live = unavailable(new Error(SIMULATION_ERROR))
    expect(live.status === "unavailable" && isContractError(live.error)).toBe(true)
  })

  it("caps a long single-line error so it cannot flood the UI", () => {
    const live = unavailable(new Error(`request failed: ${"x".repeat(500)}`))
    expect(live.status).toBe("unavailable")
    if (live.status !== "unavailable") return
    expect(live.error.length).toBeLessThanOrEqual(160)
    expect(live.error.endsWith("…")).toBe(true)
    expect(live.error.startsWith("request failed: x")).toBe(true)
  })

  it("keeps a short error unchanged, including a non-Error value", () => {
    expect(unavailable(new Error("Contract read simulation returned no result."))).toEqual({
      status: "unavailable",
      error: "Contract read simulation returned no result.",
    })
    expect(unavailable("timeout")).toEqual({ status: "unavailable", error: "timeout" })
  })

  it("falls back to a plain phrase when the error has no text", () => {
    expect(unavailable(new Error("\n\n"))).toEqual({ status: "unavailable", error: "unknown error" })
  })
})

describe("readLive", () => {
  it("returns the summarised error when the simulation fails", async () => {
    const reader: ContractReader = async () => {
      throw new Error(SIMULATION_ERROR)
    }
    const live = await readLive(reader, { contractId: "C", functionName: "balance" })
    expect(live).toEqual({ status: "unavailable", error: "HostError: Error(Contract, #13)" })
  })
})
