// @vitest-environment node
import { describe, expect, it } from "vitest"
import { allLive, liveValue, readLive, type ContractReader } from "../reader"
import { showLiveReason } from "@/components/app/live"
import { unavailable } from "../reader"

const reader = (ledger: number, fail?: Error): ContractReader =>
  Object.assign(
    async <T,>() => {
      if (fail) throw fail
      return { value: 5n as T, latestLedger: ledger, minResourceFee: "1", rawXdr: "AAAA", rpcUrl: "https://rpc.test" }
    },
    { rpcUrl: "https://rpc.test" },
  ) as ContractReader

const call = { contractId: "CABC", functionName: "total", args: [{ type: "i128" as const, value: 7n }] }

describe("provenance", () => {
  it("readLive records contractId, fn, args, rawXdr, ledger, rpcUrl", async () => {
    const live = await readLive(reader(10), call)
    expect(live).toMatchObject({
      status: "live",
      value: 5n,
      ledger: 10,
      source: { contractId: "CABC", fn: "total", args: [{ type: "i128", value: "7" }], rawXdr: "AAAA", ledger: 10, rpcUrl: "https://rpc.test" },
    })
  })

  it("unavailable keeps contractId and fn", async () => {
    const live = await readLive(reader(10, new Error("boom")), call)
    expect(live).toMatchObject({ status: "unavailable", error: "boom", source: { contractId: "CABC", fn: "total", rpcUrl: "https://rpc.test" } })
  })

  it("allLive over ledgers 10 and 12 gives ledgerSpread {min:10,max:12} and both sources", async () => {
    const a = await readLive(reader(10), call)
    const b = await readLive(reader(12), { ...call, functionName: "other" })
    const both = allLive([a, b] as const, ([x, y]) => (x as bigint) + (y as bigint))
    expect(both).toMatchObject({ status: "live", value: 10n, ledger: 12, ledgerSpread: { min: 10, max: 12 } })
    expect(both.status === "live" && both.sources?.map((s) => s.fn)).toEqual(["total", "other"])
  })

  it("allLive over equal ledgers has no ledgerSpread", async () => {
    const a = await readLive(reader(10), call)
    const both = allLive([a, liveValue(1n, 10)] as const, ([x]) => x)
    expect(both.status === "live" && both.ledgerSpread).toBeUndefined()
    expect(both.status === "live" && both.sources).toHaveLength(1)
  })

  it("nested allLive keeps an inner spread", async () => {
    const a = await readLive(reader(10), call)
    const b = await readLive(reader(12), { ...call, functionName: "other" })
    const inner = allLive([a, b] as const, ([x]) => x)
    const outer = allLive([inner, liveValue(1n, 12)] as const, ([x]) => x)
    expect(outer).toMatchObject({ ledger: 12, ledgerSpread: { min: 10, max: 12 } })
  })

  it("showLiveReason(unavailable('x')) gives Unavailable with its reason", () => {
    expect(showLiveReason(unavailable("x"), String)).toEqual({ text: "Unavailable", reason: "x" })
    expect(showLiveReason(liveValue(3, 1), (v) => `n${v}`)).toEqual({ text: "n3" })
  })
})
