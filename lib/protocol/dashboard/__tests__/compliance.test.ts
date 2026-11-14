// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { ScArg } from "../../stellar"
import { fetchEscrowRecords } from "../compliance"
import { fakeReader, type Calls, type Handler } from "./fake-reader"

const ESCROW = "CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q"
const ACCOUNT = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const ARCHIVED = new Error("Contract read requires restoring archived ledger entries before it can be queried.")

/** `get_record(id)` as `scValToNative` decodes the `RecoveryRecord` struct (recovery_escrow 665bb67 :161-187). */
const raw = (id: bigint) => ({
  id,
  account: ACCOUNT,
  ledger: 5_720_000,
  timestamp: 1_794_620_000n,
  sy_shares: 10n,
  underlying_from_sy: 11n,
  lp_amount: 12n,
  lp_pt: 13n,
  lp_sy_shares: 14n,
  underlying_from_lp: 15n,
  pt_amount: 16n,
  yt_amount: 17n,
  yt_yield_at_seize: 18n,
  finalized: false,
  underlying_from_pt: 0n,
  underlying_from_yt: 0n,
})

const records = (byId: Record<string, unknown>) => (args: ScArg[]) => {
  const id = String(args[0]?.value)
  return id in byId ? byId[id] : new Error(`HostError: Error(Contract, #8)`)
}

function table(count: bigint, byId: Record<string, unknown>): Record<string, Handler> {
  return { [`${ESCROW}.record_count`]: count, [`${ESCROW}.get_record`]: records(byId) }
}

describe("fetchEscrowRecords", () => {
  it("no records: an empty list read live", async () => {
    const live = await fetchEscrowRecords(fakeReader(table(0n, {})), ESCROW)
    expect(live).toMatchObject({ status: "live", value: [] })
    expect(live.status === "live" && live.sources?.map((s) => s.fn)).toEqual(["record_count"])
  })

  it("reads get_record(0..record_count) with every RecoveryRecord field", async () => {
    const calls: Calls = []
    const live = await fetchEscrowRecords(fakeReader(table(2n, { 0: raw(0n), 1: raw(1n) }), calls), ESCROW)
    expect(calls.filter((c) => c.key.endsWith(".get_record")).map((c) => c.args)).toEqual([
      [{ type: "u64", value: 0n }],
      [{ type: "u64", value: 1n }],
    ])
    expect(live.status).toBe("live")
    if (live.status !== "live") return
    expect(live.value).toHaveLength(2)
    expect(live.value[1]).toMatchObject({
      status: "live",
      id: 1n,
      account: ACCOUNT,
      ledger: 5_720_000,
      timestamp: 1_794_620_000n,
      syShares: 10n,
      underlyingFromSy: 11n,
      lpAmount: 12n,
      lpPt: 13n,
      lpSyShares: 14n,
      underlyingFromLp: 15n,
      ptAmount: 16n,
      ytAmount: 17n,
      ytYieldAtSeize: 18n,
      finalized: false,
      underlyingFromPt: 0n,
      underlyingFromYt: 0n,
    })
    // Each record carries its own read, so the drawer can show `get_record --id 1`.
    expect(live.value[1]).toMatchObject({ source: { fn: "get_record", args: [{ type: "u64", value: "1" }] } })
    expect(live.sources?.map((s) => s.fn)).toEqual(["record_count", "get_record", "get_record"])
  })

  it("an archived record maps to { status: archived, id }", async () => {
    const live = await fetchEscrowRecords(fakeReader(table(2n, { 0: ARCHIVED, 1: raw(1n) })), ESCROW)
    expect(live.status).toBe("live")
    if (live.status !== "live") return
    expect(live.value[0]).toEqual({ status: "archived", id: 0n })
    expect(live.value[1]).toMatchObject({ status: "live", id: 1n })
  })

  it("any other failed record makes the list unavailable: never a partial list", async () => {
    const live = await fetchEscrowRecords(fakeReader(table(2n, { 0: raw(0n), 1: new Error("fetch failed") })), ESCROW)
    expect(live).toMatchObject({ status: "unavailable" })
    expect(live.status === "unavailable" && live.error).toMatch(/record 1.*fetch failed/)
  })

  it("a malformed record is unavailable, not guessed", async () => {
    const live = await fetchEscrowRecords(fakeReader(table(1n, { 0: { ...raw(0n), finalized: "no" } })), ESCROW)
    expect(live.status).toBe("unavailable")
  })

  it("record_count unavailable: the list is unavailable", async () => {
    const live = await fetchEscrowRecords(fakeReader({ [`${ESCROW}.record_count`]: new Error("down") }), ESCROW)
    expect(live).toMatchObject({ status: "unavailable", error: "down" })
  })
})
