// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import type { Horizon } from "../../horizon"
import { parseManifest } from "../../manifest"
import type { ScArg } from "../../stellar"
import type { Live } from "../../types"
import { fetchAssetCompliance, fetchEscrowRecords, joinEscrowRecords, type IndexedEscrowEvent, type RecoveryRecord } from "../compliance"
import { verifyCommand } from "../verify"
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

const SEIZE_TX = "445a001b1a22259cc9566fadbd9645da017240fb8a31c3b068ca12e437c7e336"
const FINAL_TX = "1ef22da5".padEnd(64, "0")
const OTHER_ESCROW = "CDYL4ZOIZ3DKEDWIMBUXHYQUAT4BAZTYZ7ZRCVLAMFAXGTJZRTOLVG47"

const indexed = (topic: "recovery" | "finalize", id: string, over: Partial<IndexedEscrowEvent> = {}): IndexedEscrowEvent => ({
  id: `00245128902832${topic === "recovery" ? "98816" : "99999"}-000000000${id}`,
  contractId: ESCROW,
  topic,
  ledger: topic === "recovery" ? 5_720_000 : 5_800_000,
  closeTime: "2026-11-14T02:00:00.000Z",
  txHash: topic === "recovery" ? SEIZE_TX : FINAL_TX,
  data:
    topic === "recovery"
      ? { caller: ACCOUNT, id, account: ACCOUNT, sy_shares: "10", pt_amount: "16", yt_amount: "17", lp_amount: "12" }
      : { id, account: ACCOUNT, underlying_from_pt: "5", underlying_from_yt: "6" },
  ...over,
})

async function liveList(byId: Record<string, unknown>, count: bigint): Promise<Extract<Live<RecoveryRecord[]>, { status: "live" }>> {
  const list = await fetchEscrowRecords(fakeReader(table(count, byId)), ESCROW)
  if (list.status !== "live") throw new Error("expected a live list")
  return list
}

describe("joinEscrowRecords (D-16)", () => {
  it("a live record keeps its read and gains the seizure and finalization tx hashes, joined by escrow and record id", async () => {
    const list = await liveList({ 0: raw(0n), 1: { ...raw(1n), finalized: true } }, 2n)
    const rows = joinEscrowRecords(ESCROW, list, {
      events: [indexed("finalize", "1"), indexed("recovery", "1"), indexed("recovery", "0"), indexed("recovery", "1", { contractId: OTHER_ESCROW, txHash: "ff".repeat(32) })],
    })
    expect(rows.map((r) => r.kind)).toEqual(["live", "live"])
    const [zero, one] = rows
    if (zero.kind !== "live" || one.kind !== "live") return
    expect(zero.seizure?.txHash).toBe(SEIZE_TX)
    expect(zero.finalization).toBeNull()
    expect(one.seizure?.txHash).toBe(SEIZE_TX)
    expect(one.finalization?.txHash).toBe(FINAL_TX)
    // The record's own read, for its drawer: get_record --id 1.
    expect(one.record).toMatchObject({ status: "live", value: { id: 1n, syShares: 10n, finalized: true } })
    // The value is the record's fields alone.
    expect(one.record.status === "live" && "status" in one.record.value).toBe(false)
    expect(one.record.status === "live" && one.record.source && verifyCommand("testnet", one.record.source)).toContain("-- get_record --id 1")
  })

  it("Review Focus 4: an archived record the index holds is shown from the index, never as unavailable", async () => {
    const list = await liveList({ 0: ARCHIVED, 1: raw(1n) }, 2n)
    const rows = joinEscrowRecords(ESCROW, list, { events: [indexed("recovery", "0"), indexed("recovery", "1")] })
    expect(rows[0]).toEqual({ kind: "indexed", id: 0n, seizure: indexed("recovery", "0"), finalization: null })
    expect(rows[1].kind).toBe("live")
  })

  it("an archived record the index does not hold is Unavailable, with the reason", async () => {
    const list = await liveList({ 0: ARCHIVED }, 1n)
    const [row] = joinEscrowRecords(ESCROW, list, { events: [indexed("recovery", "0", { contractId: OTHER_ESCROW })] })
    expect(row).toMatchObject({ kind: "unavailable", id: 0n })
    expect(row.kind === "unavailable" && row.reason).toBe(
      "Record 0 is archived on-chain (its read requires restoring), and the event index holds no recovery event for it",
    )
  })

  it("when the index cannot be read: live records keep their fields with the reason; an archived one is Unavailable", async () => {
    const list = await liveList({ 0: ARCHIVED, 1: raw(1n) }, 2n)
    const rows = joinEscrowRecords(ESCROW, list, { error: "the event index is not configured on this server" })
    expect(rows[0]).toMatchObject({ kind: "unavailable" })
    expect(rows[0].kind === "unavailable" && rows[0].reason).toBe(
      "Record 0 is archived on-chain (its read requires restoring), and the event index could not be read: the event index is not configured on this server",
    )
    expect(rows[1]).toMatchObject({ kind: "live", seizure: null, indexError: "the event index is not configured on this server" })
  })
})

describe("fetchAssetCompliance", () => {
  const manifest = parseManifest(testnetJson)
  const market = manifest.markets[0]
  const SAC = market.underlying.sac
  const ISSUER = market.underlying.issuer
  const flags = { authRequired: true, authRevocable: true, clawbackEnabled: true }
  const horizon = (over: Partial<Horizon> = {}): Horizon => ({
    fetchAccount: async () => ({ status: "live", value: null, ledger: 1 }),
    fetchIssuerFlags: async () => ({ status: "live", value: flags, ledger: 5_000_000 }),
    ...over,
  })

  it("one entry per underlying SAC: admin() with its read (one call, shared with the model), and the issuer flags from Horizon", async () => {
    const calls: Calls = []
    const [asset, ...rest] = await fetchAssetCompliance(horizon(), "https://horizon-testnet.stellar.org/", fakeReader({ [`${SAC}.admin`]: ISSUER }, calls), {
      ...manifest,
      markets: [market, { ...market, marketId: "second" }],
    })
    expect(rest).toEqual([])
    expect(asset).toMatchObject({ sac: SAC, code: "USDY", issuer: ISSUER, marketIds: [market.marketId, "second"] })
    expect(asset.model).toMatchObject({ status: "live", value: { kind: "sac", administrator: ISSUER, ...flags } })
    expect(asset.admin).toMatchObject({ status: "live", value: ISSUER, source: { contractId: SAC, fn: "admin" } })
    expect(asset.flagsUrl).toBe(`https://horizon-testnet.stellar.org/accounts/${ISSUER}`)
    expect(calls.filter((c) => c.key === `${SAC}.admin`)).toHaveLength(1)
  })

  it("flags Horizon cannot give leave the model Unavailable; the admin read stands on its own", async () => {
    const [asset] = await fetchAssetCompliance(
      horizon({ fetchIssuerFlags: async () => ({ status: "unavailable", error: "Horizon responded 503" }) }),
      "https://horizon-testnet.stellar.org",
      fakeReader({ [`${SAC}.admin`]: ISSUER }),
      manifest,
    )
    expect(asset.model).toMatchObject({ status: "unavailable", error: "Horizon responded 503" })
    expect(asset.admin).toMatchObject({ status: "live", value: ISSUER })
  })
})
