// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../../manifest"
import { BLOCKED_WHEN_STALE, fetchOracleView } from "../oracle"
import { fakeReader, type Handler } from "./fake-reader"

const base = parseManifest(testnetJson)
const PRIMARY = "8f157e8dfc6b0bef22553de5a980e24fc7c7c9eacc8bccbb8df0f2cab866b3b4"
const PREIMAGE = "principal-oracle-source:testnet:USDY:app-team:keeper"
const manifest = { ...base, oracleSources: [{ hash: PRIMARY, preimage: PREIMAGE }] }
const O = manifest.shared.oracle

const TS = 1_794_616_199
const MAX_STALE = 3600

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)))
const MISSING = new Error("HostError: Error(WasmVm, MissingValue)\n\nEvent log (newest first):\n   0: [Diagnostic Event] ...")

function table(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [`${O}.get_reference_value`]: 10_500_000n,
    [`${O}.get_reference_timestamp`]: BigInt(TS),
    [`${O}.is_available`]: true,
    [`${O}.max_stale_seconds`]: BigInt(MAX_STALE),
    [`${O}.max_deviation_bps`]: 1000,
    [`${O}.value_bounds`]: null,
    [`${O}.get_primary_source`]: hex(PRIMARY),
    [`${O}.get_fallback_source`]: null,
    [`${O}.get_active_source`]: hex(PRIMARY),
    [`${O}.last_update_was_feed`]: MISSING,
    [`${O}.last_rejection`]: null,
    ...over,
  }
}

afterEach(() => vi.restoreAllMocks())

describe("fetchOracleView", () => {
  it("timeToBlock uses ledger time: timestamp + maxStale − ledgerTime, never Date.now()", async () => {
    const now = vi.spyOn(Date, "now")
    const view = await fetchOracleView(fakeReader(table()), manifest, TS + 1000)
    expect(view.timeToBlock).toMatchObject({ status: "live", value: MAX_STALE - 1000 })
    expect(now).not.toHaveBeenCalled()
  })

  it("timeToBlock is negative once blocked, and carries the timestamp and max-stale reads", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, TS + MAX_STALE + 5)
    expect(view.timeToBlock).toMatchObject({ status: "live", value: -5 })
    expect(view.timeToBlock.status === "live" && view.timeToBlock.sources?.map((s) => s.fn)).toEqual([
      "get_reference_timestamp",
      "max_stale_seconds",
    ])
  })

  it("timeToBlock is unavailable without a ledger time", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, null)
    expect(view.timeToBlock.status).toBe("unavailable")
    expect(view.freshness).toBe("unavailable")
  })

  it.each([
    [0, "fresh"],
    [2699, "fresh"], // just under 0.75 × 3600 = 2700
    [2700, "warning"], // 0.75 × maxStale
    [3600, "warning"], // 1 × maxStale: the contract's is_fresh (age <= max) still passes
    [3601, "stale"], // operations block
  ])("freshness at age %i is %s", async (age, freshness) => {
    const view = await fetchOracleView(fakeReader(table()), manifest, TS + age)
    expect(view.freshness).toBe(freshness)
  })

  it("a ledger clock behind the oracle timestamp counts as age 0, not stale", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, TS - 6)
    expect(view.freshness).toBe("fresh")
  })

  it("the contract's own is_available = false wins: stale", async () => {
    const view = await fetchOracleView(fakeReader(table({ [`${O}.is_available`]: false })), manifest, TS + 10)
    expect(view.freshness).toBe("stale")
  })

  it("freshness is unavailable when the timestamp cannot be read", async () => {
    const view = await fetchOracleView(fakeReader(table({ [`${O}.get_reference_timestamp`]: new Error("down") })), manifest, TS)
    expect(view.freshness).toBe("unavailable")
  })

  it("path is unsupported on WasmVm, MissingValue (665bb67 oracle)", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, TS)
    expect(view.path).toEqual({ status: "unsupported" })
  })

  it("path is push or feed when the view exists", async () => {
    const push = await fetchOracleView(fakeReader(table({ [`${O}.last_update_was_feed`]: false })), manifest, TS)
    expect(push.path).toMatchObject({ status: "live", value: "push" })
    const feed = await fetchOracleView(fakeReader(table({ [`${O}.last_update_was_feed`]: true })), manifest, TS)
    expect(feed.path).toMatchObject({ status: "live", value: "feed" })
  })

  it("another WasmVm error, or a transport failure, leaves path unavailable", async () => {
    const other = await fetchOracleView(
      fakeReader(table({ [`${O}.last_update_was_feed`]: new Error("HostError: Error(WasmVm, InvalidAction)") })),
      manifest,
      TS,
    )
    expect(other.path.status).toBe("unavailable")
    const down = await fetchOracleView(fakeReader(table({ [`${O}.last_update_was_feed`]: new Error("fetch failed") })), manifest, TS)
    expect(down.path.status).toBe("unavailable")
  })

  it("resolves source preimages from the manifest", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, TS)
    expect(view.sources.primary).toMatchObject({ hash: { status: "live", value: PRIMARY }, preimage: PREIMAGE })
    expect(view.sources.active).toMatchObject({ hash: { status: "live", value: PRIMARY }, preimage: PREIMAGE })
    expect(view.sources.fallback).toEqual({ hash: expect.objectContaining({ status: "live", value: null }) })
  })

  it("an unknown source hash has no preimage", async () => {
    const view = await fetchOracleView(fakeReader(table({ [`${O}.get_primary_source`]: new Uint8Array(32).fill(1) })), manifest, TS)
    expect(view.sources.primary.preimage).toBeUndefined()
  })

  it("reads the policy: max stale, deviation cap and bounds", async () => {
    const view = await fetchOracleView(fakeReader(table({ [`${O}.value_bounds`]: [9_000_000n, 20_000_000n] })), manifest, TS)
    expect(view.maxStale).toMatchObject({ status: "live", value: 3600n })
    expect(view.deviationBps).toMatchObject({ status: "live", value: 1000n })
    expect(view.bounds).toMatchObject({ status: "live", value: { min: 9_000_000n, max: 20_000_000n } })
    const none = await fetchOracleView(fakeReader(table()), manifest, TS)
    expect(none.bounds).toMatchObject({ status: "live", value: null })
  })

  it("value, timestamp and the last rejection", async () => {
    const view = await fetchOracleView(
      fakeReader(table({ [`${O}.last_rejection`]: { reason: "deviate", value: 99n, timestamp: 5n } })),
      manifest,
      TS,
    )
    expect(view.value).toMatchObject({ status: "live", value: 10_500_000n })
    expect(view.timestamp).toMatchObject({ status: "live", value: BigInt(TS) })
    expect(view.lastRejection).toMatchObject({ status: "live", value: { reason: "deviate", value: 99n, timestamp: 5n } })
  })

  it("names the operations blocked when stale", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, TS)
    expect(view.blockedWhenStale).toEqual(["mint", "trade", "single-sided liquidity", "redemption"])
    expect(BLOCKED_WHEN_STALE).toEqual(view.blockedWhenStale)
  })

  it("every figure carries its provenance", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, TS)
    expect(view.value).toMatchObject({ source: { contractId: O, fn: "get_reference_value", rawXdr: `raw:${O}.get_reference_value` } })
  })
})
