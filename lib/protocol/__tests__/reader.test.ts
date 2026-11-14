// @vitest-environment node
import { describe, expect, it } from "vitest"
import { dedupeReads, isContractError, readLive, unavailable, type ContractReader } from "../reader"

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
    expect(live).toMatchObject({ status: "unavailable", error: "The Stellar network is busy. Try again in a moment." })
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
    expect(live).toMatchObject({ status: "unavailable", error: "HostError: Error(Contract, #13)" })
  })
})

describe("dedupeReads", () => {
  const counting = () => {
    const calls: string[] = []
    const reader = Object.assign(
      async <T,>({ contractId, functionName, args = [] }: { contractId: string; functionName: string; args?: { value: unknown }[] }) => {
        calls.push(`${contractId}.${functionName}`)
        if (functionName === "boom") throw new Error("rpc down")
        return { value: `${contractId}.${functionName}(${args.map((a) => String(a.value)).join(",")})` as T, latestLedger: 7, minResourceFee: "0" }
      },
      { rpcUrl: "https://rpc.test" },
    ) as unknown as ContractReader
    return { calls, reader }
  }

  it("makes each distinct call once and hands every caller the same answer", async () => {
    const { calls, reader } = counting()
    const once = dedupeReads(reader)
    expect(once.rpcUrl).toBe("https://rpc.test")
    const [a, b, c, d] = await Promise.all([
      once({ contractId: "CORACLE", functionName: "get_reference_value" }),
      once({ contractId: "CORACLE", functionName: "get_reference_value" }),
      once({ contractId: "CSAC", functionName: "balance", args: [{ type: "address", value: "CESCROW1" }] }),
      once({ contractId: "CSAC", functionName: "balance", args: [{ type: "address", value: "CESCROW2" }] }),
    ])
    expect(a).toBe(b)
    expect(c.value).toBe("CSAC.balance(CESCROW1)")
    expect(d.value).toBe("CSAC.balance(CESCROW2)")
    // Arguments are part of the call: two escrows, two reads.
    expect(calls).toEqual(["CORACLE.get_reference_value", "CSAC.balance", "CSAC.balance"])
  })

  it("shares a failure too, and a new one reads afresh", async () => {
    const { calls, reader } = counting()
    const once = dedupeReads(reader)
    const results = await Promise.allSettled([once({ contractId: "C1", functionName: "boom" }), once({ contractId: "C1", functionName: "boom" })])
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"])
    expect(calls).toEqual(["C1.boom"])
    await dedupeReads(reader)({ contractId: "C1", functionName: "x", args: [{ type: "u64", value: 5n }] })
    await dedupeReads(reader)({ contractId: "C1", functionName: "x", args: [{ type: "u64", value: 5n }] })
    expect(calls).toEqual(["C1.boom", "C1.x", "C1.x"])
  })
})
