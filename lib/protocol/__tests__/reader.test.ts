// @vitest-environment node
import { nativeToScVal, type rpc } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../manifest"
import { createRpcReader, dedupeReads, isContractError, isTransientRpcError, readLive, resetRpcSkipsForTests, unavailable, type ContractReader } from "../reader"
import type { ScArg } from "../stellar"
import type { Manifest } from "../types"

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

  it("records the arguments as plain JSON-safe data: bigints as decimal strings at any depth (an enum's value, a struct's fields)", async () => {
    const reader: ContractReader = async <T,>() => ({ value: 1n as T, latestLedger: 9, minResourceFee: "1", rawXdr: "AAAA", rpcUrl: "https://rpc.test" })
    const args: ScArg[] = [
      { type: "enum", variant: "Amount", value: { type: "i128", value: 5n } },
      { type: "struct", value: { at: { type: "u64", value: 7n }, inner: { type: "enum", variant: "Other", value: { type: "symbol", value: "USDY" } } } },
      { type: "enum", variant: "None" },
      { type: "i128", value: 12n },
    ]
    for (const live of [await readLive(reader, { contractId: "C", functionName: "f", args }), await readLive(async () => Promise.reject(new Error("down")), { contractId: "C", functionName: "f", args })]) {
      expect(live.source?.args).toEqual([
        { type: "enum", variant: "Amount", value: { type: "i128", value: "5" } },
        { type: "struct", value: { at: { type: "u64", value: "7" }, inner: { type: "enum", variant: "Other", value: { type: "symbol", value: "USDY" } } } },
        { type: "enum", variant: "None" },
        { type: "i128", value: "12" },
      ])
      expect(() => JSON.stringify(live.source)).not.toThrow()
    }
    // The call itself still carries the bigints: only the record is plain.
    expect(args[0]).toEqual({ type: "enum", variant: "Amount", value: { type: "i128", value: 5n } })
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

  it("keys a struct argument with a nested bigint without throwing, and tells its values apart", async () => {
    const { calls, reader } = counting()
    const once = dedupeReads(reader)
    const struct = (amount: bigint): ScArg => ({ type: "struct", value: { amount: { type: "i128", value: amount }, to: { type: "address", value: "CX" } } })
    await expect(once({ contractId: "C1", functionName: "quote", args: [struct(5n)] })).resolves.toBeDefined()
    await once({ contractId: "C1", functionName: "quote", args: [struct(5n)] })
    await once({ contractId: "C1", functionName: "quote", args: [struct(6n)] })
    // A bigint and the same digits as a string are different arguments.
    await once({ contractId: "C1", functionName: "quote", args: [{ type: "i128", value: 5n }] })
    await once({ contractId: "C1", functionName: "quote", args: [{ type: "i128", value: "5" }] })
    expect(calls).toEqual(["C1.quote", "C1.quote", "C1.quote", "C1.quote"])
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

// ---------------------------------------------------------------- fallback RPC endpoints (D-6)

const PRIMARY = "https://rpc.primary.test"
const SECOND = "https://rpc.second.test"
const THIRD = "https://rpc.third.test"

function manifestWith(fallbacks: string[] | undefined): Manifest {
  const m = parseManifest(testnetJson)
  return { ...m, rpcUrl: PRIMARY, rpcFallbackUrls: fallbacks }
}

const answer = (ledger: number) =>
  ({
    id: "1",
    _parsed: true,
    latestLedger: ledger,
    events: [],
    minResourceFee: "100",
    transactionData: {},
    result: { auth: [], retval: nativeToScVal(42n, { type: "i128" }) },
  }) as unknown as rpc.Api.SimulateTransactionSuccessResponse

/** One fake RPC per URL: an answer at `ledger`, or the thrown value. */
function servers(table: Record<string, unknown>) {
  const asked: string[] = []
  const serverFor = (url: string) => ({
    async simulateTransaction() {
      asked.push(url)
      const v = table[url]
      if (typeof v === "number") return answer(v)
      throw v
    },
  })
  return { serverFor, asked }
}

const httpError = (status: number) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } })

describe("isTransientRpcError", () => {
  it.each([
    ["a fetch network failure", new TypeError("fetch failed")],
    ["Chrome's fetch network failure", new TypeError("Failed to fetch")],
    ["Safari's fetch network failure", new TypeError("Load failed")],
    ["Firefox's fetch network failure", new TypeError("NetworkError when attempting to fetch resource.")],
    ["a socket error code", Object.assign(new Error("connect"), { code: "ECONNREFUSED" })],
    ["a socket error in the cause", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })],
    ["the SDK's timeout", new Error("timeout of 20000ms exceeded")],
    ["an aborted request", Object.assign(new Error("aborted"), { name: "TimeoutError" })],
    ["HTTP 500", httpError(500)],
    ["HTTP 503", httpError(503)],
    ["HTTP 429", httpError(429)],
    ["the RPC's busy answer", { code: -32004, message: "preflight queue full; retry later" }],
    // What SDK 17's HTTP client throws in Node for a refused connection: no HTTP answer at all.
    ["the SDK's wrapped network failure", Object.assign(new Error("fetch failed"), { name: "AxiosError", isAxiosError: true, response: null, status: undefined })],
    ["the SDK's wrapped 502 (status on the error)", Object.assign(new Error("Request failed"), { isAxiosError: true, response: null, status: 502 })],
  ])("%s is transient", (_name, error) => {
    expect(isTransientRpcError(error)).toBe(true)
  })

  it.each([
    ["a contract error", new Error("HostError: Error(Contract, #13)")],
    ["an archived entry", new Error("Contract read requires restoring archived ledger entries before it can be queried.")],
    ["HTTP 404", httpError(404)],
    ["HTTP 400", httpError(400)],
    ["the SDK's wrapped 404", Object.assign(new Error("Request failed with status code 404"), { isAxiosError: true, response: { status: 404 }, status: 404 })],
    ["another JSON-RPC error", { code: -32602, message: "invalid params" }],
    ["a string", "boom"],
    // A TypeError is a network failure only when fetch says so; anything else is a bug in the code.
    ["a TypeError from the code", new TypeError("x is not a function")],
    ["a TypeError reading a missing field", new TypeError("Cannot read properties of undefined (reading 'retval')")],
  ])("%s is final", (_name, error) => {
    expect(isTransientRpcError(error)).toBe(false)
  })
})

describe("createRpcReader with fallback endpoints (D-6)", () => {
  const call = { contractId: "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS", functionName: "max_stale_seconds" }

  // The skip memory is the module's: each test starts with every endpoint in good standing.
  beforeEach(() => resetRpcSkipsForTests())
  afterEach(() => vi.useRealTimers())

  it("reads the manifest's rpcUrl first and stops there when it answers", async () => {
    const s = servers({ [PRIMARY]: 100, [SECOND]: 200 })
    const live = await readLive(createRpcReader(manifestWith([SECOND]), { serverFor: s.serverFor }), call)
    expect(s.asked).toEqual([PRIMARY])
    expect(live).toMatchObject({ status: "live", value: 42n, ledger: 100, source: { rpcUrl: PRIMARY, ledger: 100 } })
    expect(live.status === "live" && live.source && "viaFallback" in live.source).toBe(false)
  })

  it("on a transient failure tries each fallback in order; the source names the endpoint that answered", async () => {
    const s = servers({ [PRIMARY]: httpError(503), [SECOND]: new TypeError("fetch failed"), [THIRD]: 300 })
    const live = await readLive(createRpcReader(manifestWith([SECOND, THIRD]), { serverFor: s.serverFor }), call)
    expect(s.asked).toEqual([PRIMARY, SECOND, THIRD])
    expect(live).toMatchObject({ status: "live", value: 42n, ledger: 300, source: { rpcUrl: THIRD, viaFallback: true, rawXdr: nativeToScVal(42n, { type: "i128" }).toXDR("base64") } })
  })

  it("a contract error is final: never asked again on a fallback", async () => {
    const s = servers({ [PRIMARY]: new Error("HostError: Error(Contract, #3)"), [SECOND]: 200 })
    const live = await readLive(createRpcReader(manifestWith([SECOND]), { serverFor: s.serverFor }), call)
    expect(s.asked).toEqual([PRIMARY])
    expect(live).toMatchObject({ status: "unavailable", error: "HostError: Error(Contract, #3)" })
  })

  it("a fallback's contract error is final too", async () => {
    const s = servers({ [PRIMARY]: httpError(503), [SECOND]: new Error("HostError: Error(Contract, #3)"), [THIRD]: 300 })
    const live = await readLive(createRpcReader(manifestWith([SECOND, THIRD]), { serverFor: s.serverFor }), call)
    expect(s.asked).toEqual([PRIMARY, SECOND])
    expect(live).toMatchObject({ status: "unavailable", error: "HostError: Error(Contract, #3)" })
  })

  it("every endpoint failing gives the primary's error, not the last fallback's", async () => {
    const primary = httpError(503)
    const s = servers({ [PRIMARY]: primary, [SECOND]: httpError(503) })
    await expect(createRpcReader(manifestWith([SECOND]), { serverFor: s.serverFor })(call)).rejects.toBe(primary)
    expect(s.asked).toEqual([PRIMARY, SECOND])
    // As a figure shows it: the primary's busy answer, not the fallback's 502.
    resetRpcSkipsForTests()
    const u = servers({ [PRIMARY]: { code: -32004, message: "busy" }, [SECOND]: httpError(502) })
    const live = await readLive(createRpcReader(manifestWith([SECOND]), { serverFor: u.serverFor }), call)
    expect(u.asked).toEqual([PRIMARY, SECOND])
    expect(live).toMatchObject({ status: "unavailable", error: "The Stellar network is busy. Try again in a moment." })
  })

  it("a TypeError from the code is final: never retried on the fallback", async () => {
    const s = servers({ [PRIMARY]: new TypeError("x is not a function"), [SECOND]: 200 })
    const live = await readLive(createRpcReader(manifestWith([SECOND]), { serverFor: s.serverFor }), call)
    expect(s.asked).toEqual([PRIMARY])
    expect(live).toMatchObject({ status: "unavailable", error: "x is not a function" })
  })

  it("after a transient failure the primary is skipped for 30 s: reads go straight to the fallback, then the primary is asked again", async () => {
    vi.useFakeTimers()
    const table: Record<string, unknown> = { [PRIMARY]: httpError(503), [SECOND]: 200 }
    const s = servers(table)
    const read = createRpcReader(manifestWith([SECOND]), { serverFor: s.serverFor })
    expect((await read(call)).rpcUrl).toBe(SECOND)
    expect(s.asked).toEqual([PRIMARY, SECOND])

    // The primary is back, but it failed under 30 s ago: not asked, from this reader or a new one.
    table[PRIMARY] = 100
    vi.advanceTimersByTime(29_999)
    s.asked.length = 0
    expect(await read(call)).toMatchObject({ rpcUrl: SECOND, viaFallback: true })
    expect(await createRpcReader(manifestWith([SECOND]), { serverFor: s.serverFor })(call)).toMatchObject({ rpcUrl: SECOND })
    expect(s.asked).toEqual([SECOND, SECOND])

    vi.advanceTimersByTime(1)
    s.asked.length = 0
    const back = await read(call)
    expect(s.asked).toEqual([PRIMARY])
    expect(back).toMatchObject({ rpcUrl: PRIMARY, latestLedger: 100 })
    expect("viaFallback" in back).toBe(false)
  })

  it("a skipped primary is still asked last when the fallback fails too, and its error is the one reported", async () => {
    vi.useFakeTimers()
    const table: Record<string, unknown> = { [PRIMARY]: httpError(503), [SECOND]: 200 }
    const s = servers(table)
    const read = createRpcReader(manifestWith([SECOND]), { serverFor: s.serverFor })
    await read(call)
    const busy = { code: -32004, message: "busy" }
    table[PRIMARY] = busy
    table[SECOND] = httpError(502)
    vi.advanceTimersByTime(10_000)
    s.asked.length = 0
    await expect(read(call)).rejects.toBe(busy)
    expect(s.asked).toEqual([SECOND, PRIMARY])
  })

  it("with no fallback, a primary that just failed is still asked: there is nothing to skip to", async () => {
    vi.useFakeTimers()
    const table: Record<string, unknown> = { [PRIMARY]: httpError(429) }
    const s = servers(table)
    const read = createRpcReader(manifestWith(undefined), { serverFor: s.serverFor })
    await expect(read(call)).rejects.toMatchObject({ response: { status: 429 } })
    table[PRIMARY] = 100
    vi.advanceTimersByTime(1_000)
    expect(await read(call)).toMatchObject({ rpcUrl: PRIMARY, latestLedger: 100 })
    expect(s.asked).toEqual([PRIMARY, PRIMARY])
  })

  it("no fallback configured: a transient failure is the read's answer", async () => {
    const s = servers({ [PRIMARY]: new TypeError("fetch failed") })
    const live = await readLive(createRpcReader(manifestWith(undefined), { serverFor: s.serverFor }), call)
    expect(s.asked).toEqual([PRIMARY])
    expect(live).toMatchObject({ status: "unavailable", source: { rpcUrl: PRIMARY } })
  })
})

describe("createRpcReader's shared and limited reads", () => {
  const contractId = "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS"
  beforeEach(() => resetRpcSkipsForTests())

  it("two identical reads in flight share one request; two different arguments do not", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const asked: string[] = []
    const serverFor = () => ({
      async simulateTransaction() {
        asked.push("simulate")
        await held
        return answer(100)
      },
    })
    const read = createRpcReader(manifestWith(undefined), { serverFor })
    const balance = (holder: string) => ({ contractId, functionName: "balance", args: [{ type: "address", value: holder } as ScArg] })
    const holderA = "GDDKLGGW5HG76QBESUX4JHFVYA3765HJGVUDXFGQLAJYJ4CQDPHW7ZHQ"
    const holderB = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"
    // Two readers, as two panels of one page each make their own.
    const pending = [read(balance(holderA)), createRpcReader(manifestWith(undefined), { serverFor })(balance(holderA)), read(balance(holderB))]
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toHaveLength(2)
    release()
    const [a, b, c] = await Promise.all(pending)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
  })

  it("never has more than six simulations in flight, and every read is answered", async () => {
    let inFlight = 0
    let peak = 0
    const serverFor = () => ({
      async simulateTransaction() {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
        return answer(100)
      },
    })
    const read = createRpcReader(manifestWith(undefined), { serverFor })
    const reads = Array.from({ length: 20 }, (_, i) => read({ contractId, functionName: `view_${i}` }))
    expect((await Promise.all(reads)).map((r) => r.value)).toEqual(Array(20).fill(42n))
    expect(peak).toBe(6)
  })
})
