// @vitest-environment node
import { StrKey } from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../../manifest"
import type { ScArg } from "../../stellar"
import type { Live, ReadSource } from "../../types"
import { BLOCKED_WHEN_STALE, fetchOracleView, rescaleTo7, type OracleView } from "../oracle"
import { verifyCommand } from "../verify"
import { fakeReader, RPC, type Calls, type Handler } from "./fake-reader"

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
    // 665bb67 (our Testnet oracle) has no feed views.
    [`${O}.feed_source`]: MISSING,
    [`${O}.feed_min_interval_seconds`]: MISSING,
    ...over,
  }
}

afterEach(() => vi.restoreAllMocks())

describe("fetchOracleView", () => {
  it("timeToBlock uses ledger time: timestamp + maxStale − ledgerTime, never Date.now()", async () => {
    const now = vi.spyOn(Date, "now")
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS + 1000)
    expect(view.timeToBlock).toMatchObject({ status: "live", value: MAX_STALE - 1000 })
    expect(now).not.toHaveBeenCalled()
  })

  it("timeToBlock is negative once blocked, and carries the timestamp and max-stale reads", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS + MAX_STALE + 5)
    expect(view.timeToBlock).toMatchObject({ status: "live", value: -5 })
    expect(view.timeToBlock.status === "live" && view.timeToBlock.sources?.map((s) => s.fn)).toEqual([
      "get_reference_timestamp",
      "max_stale_seconds",
    ])
  })

  it("timeToBlock is unavailable without a ledger time", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, O, null)
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
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS + age)
    expect(view.freshness).toBe(freshness)
  })

  it("a ledger clock behind the oracle timestamp counts as age 0, not stale", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS - 6)
    expect(view.freshness).toBe("fresh")
  })

  it("the contract's own is_available = false wins: stale", async () => {
    const view = await fetchOracleView(fakeReader(table({ [`${O}.is_available`]: false })), manifest, O, TS + 10)
    expect(view.freshness).toBe("stale")
  })

  it("freshness is unavailable when the timestamp cannot be read", async () => {
    const view = await fetchOracleView(fakeReader(table({ [`${O}.get_reference_timestamp`]: new Error("down") })), manifest, O, TS)
    expect(view.freshness).toBe("unavailable")
  })

  it("path is unsupported on WasmVm, MissingValue (665bb67 oracle)", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS)
    expect(view.path).toMatchObject({ status: "unsupported" })
  })

  it("an unsupported path keeps the call it attempted, so the drawer gives the command that shows MissingValue", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS)
    expect(view.path).toEqual({ status: "unsupported", source: expect.objectContaining({ contractId: O, fn: "last_update_was_feed", args: [] }) })
  })

  it("path is push or feed when the view exists", async () => {
    const push = await fetchOracleView(fakeReader(table({ [`${O}.last_update_was_feed`]: false })), manifest, O, TS)
    expect(push.path).toMatchObject({ status: "live", value: "push" })
    const feed = await fetchOracleView(fakeReader(table({ [`${O}.last_update_was_feed`]: true })), manifest, O, TS)
    expect(feed.path).toMatchObject({ status: "live", value: "feed" })
  })

  it("another WasmVm error, or a transport failure, leaves path unavailable", async () => {
    const other = await fetchOracleView(
      fakeReader(table({ [`${O}.last_update_was_feed`]: new Error("HostError: Error(WasmVm, InvalidAction)") })),
      manifest,
      O,
      TS,
    )
    expect(other.path.status).toBe("unavailable")
    const down = await fetchOracleView(fakeReader(table({ [`${O}.last_update_was_feed`]: new Error("fetch failed") })), manifest, O, TS)
    expect(down.path.status).toBe("unavailable")
  })

  it("resolves source preimages from the manifest", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS)
    expect(view.sources.primary).toMatchObject({ hash: { status: "live", value: PRIMARY }, preimage: PREIMAGE })
    expect(view.sources.active).toMatchObject({ hash: { status: "live", value: PRIMARY }, preimage: PREIMAGE })
    expect(view.sources.fallback).toEqual({ hash: expect.objectContaining({ status: "live", value: null }) })
  })

  it("an unknown source hash has no preimage", async () => {
    const view = await fetchOracleView(fakeReader(table({ [`${O}.get_primary_source`]: new Uint8Array(32).fill(1) })), manifest, O, TS)
    expect(view.sources.primary.preimage).toBeUndefined()
  })

  it("reads the policy: max stale, deviation cap and bounds", async () => {
    const view = await fetchOracleView(fakeReader(table({ [`${O}.value_bounds`]: [9_000_000n, 20_000_000n] })), manifest, O, TS)
    expect(view.maxStale).toMatchObject({ status: "live", value: 3600n })
    expect(view.deviationBps).toMatchObject({ status: "live", value: 1000n })
    expect(view.bounds).toMatchObject({ status: "live", value: { min: 9_000_000n, max: 20_000_000n } })
    const none = await fetchOracleView(fakeReader(table()), manifest, O, TS)
    expect(none.bounds).toMatchObject({ status: "live", value: null })
  })

  it("value, timestamp and the last rejection", async () => {
    const view = await fetchOracleView(
      fakeReader(table({ [`${O}.last_rejection`]: { reason: "deviate", value: 99n, timestamp: 5n } })),
      manifest,
      O,
      TS,
    )
    expect(view.value).toMatchObject({ status: "live", value: 10_500_000n })
    expect(view.timestamp).toMatchObject({ status: "live", value: BigInt(TS) })
    expect(view.lastRejection).toMatchObject({ status: "live", value: { reason: "deviate", value: 99n, timestamp: 5n } })
  })

  it("names the operations blocked when stale", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS)
    expect(view.blockedWhenStale).toEqual(["mint", "trade", "single-sided liquidity", "redemption"])
    expect(BLOCKED_WHEN_STALE).toEqual(view.blockedWhenStale)
  })

  it("every figure carries its provenance", async () => {
    const view = await fetchOracleView(fakeReader(table()), manifest, O, TS)
    expect(view.value).toMatchObject({ source: { contractId: O, fn: "get_reference_value", rawXdr: `raw:${O}.get_reference_value` } })
  })

  it("reads the oracle it is given, not the manifest's", async () => {
    const OTHER = StrKey.encodeContract(Buffer.alloc(32, 9))
    const calls: Calls = []
    const moved = Object.fromEntries(Object.entries(table()).map(([k, v]) => [k.replace(O, OTHER), v]))
    const view = await fetchOracleView(fakeReader(moved, calls), manifest, OTHER, TS)
    expect(view.contractId).toBe(OTHER)
    expect(view.value).toMatchObject({ status: "live", value: 10_500_000n, source: { contractId: OTHER } })
    expect(calls.every((c) => c.key.startsWith(`${OTHER}.`))).toBe(true)
    // The preimages still come from the manifest.
    expect(view.sources.primary.preimage).toBe(PREIMAGE)
  })
})

describe("fetchOracleView: the feed side (3af9388 feed_source, feed_min_interval_seconds; the SEP-40 feed's decimals and lastprice)", () => {
  const FEED = StrKey.encodeContract(Buffer.alloc(32, 7))
  const SAC = StrKey.encodeContract(Buffer.alloc(32, 8))
  const FEED_TS = 1_794_616_100n

  /** A 3af9388 oracle wired to FEED for `asset` (native form), with an 8-decimal price. */
  function fed(asset: unknown = ["Other", "USDY"], over: Record<string, Handler> = {}): Record<string, Handler> {
    return table({
      [`${O}.last_update_was_feed`]: true,
      [`${O}.feed_source`]: [FEED, asset],
      [`${O}.feed_min_interval_seconds`]: 300n,
      [`${FEED}.decimals`]: 8,
      [`${FEED}.lastprice`]: { price: 115_359_071n, timestamp: FEED_TS },
      ...over,
    })
  }

  it("reads feed_source and feed_min_interval_seconds, then the feed's decimals and lastprice(asset); the price rescaled to 7 decimals", async () => {
    const calls: Calls = []
    const view = await fetchOracleView(fakeReader(fed(), calls), manifest, O, TS)
    expect(view.feed).toMatchObject({ status: "live", value: { contract: FEED, asset: { kind: "Other", symbol: "USDY" } }, source: { contractId: O, fn: "feed_source" } })
    expect(view.feedMinInterval).toMatchObject({ status: "live", value: 300n, source: { contractId: O, fn: "feed_min_interval_seconds" } })
    expect(view.feedPrice).toMatchObject({ status: "live", value: { raw: 115_359_071n, decimals: 8, value: 11_535_907n, timestamp: FEED_TS } })
    const keys = calls.map((c) => c.key)
    expect(keys).toContain(`${O}.feed_source`)
    expect(keys).toContain(`${O}.feed_min_interval_seconds`)
    // The feed's two reads come after the feed is known, each once.
    expect(keys.slice(-2).sort()).toEqual([`${FEED}.decimals`, `${FEED}.lastprice`])
    expect(keys.filter((k) => k.startsWith(`${FEED}.`))).toHaveLength(2)
    const lastprice = calls.find((c) => c.key === `${FEED}.lastprice`)!
    expect(lastprice.args).toEqual([{ type: "enum", variant: "Other", value: { type: "symbol", value: "USDY" } }] satisfies ScArg[])
  })

  it("a Stellar asset is asked by its address", async () => {
    const calls: Calls = []
    const view = await fetchOracleView(fakeReader(fed(["Stellar", SAC]), calls), manifest, O, TS)
    expect(view.feed).toMatchObject({ status: "live", value: { contract: FEED, asset: { kind: "Stellar", address: SAC } } })
    expect(calls.find((c) => c.key === `${FEED}.lastprice`)!.args).toEqual([{ type: "enum", variant: "Stellar", value: { type: "address", value: SAC } }])
  })

  it("the feed price carries both feed reads, and every new figure's How to verify command is valid", async () => {
    const view = await fetchOracleView(fakeReader(fed(["Stellar", SAC])), manifest, O, TS)
    if (view.feedPrice?.status !== "live" || view.feed.status !== "live" || view.feedMinInterval.status !== "live") throw new Error("expected live feed figures")
    expect(view.feedPrice.sources?.map((s) => `${s.contractId}.${s.fn}`)).toEqual([`${FEED}.decimals`, `${FEED}.lastprice`])
    const sources: ReadSource[] = [view.feed.source!, view.feedMinInterval.source!, ...view.feedPrice.sources!]
    const commands = sources.map((s) => verifyCommand("testnet", s))
    expect(commands[0]).toMatch(new RegExp(`--id ${O} .* -- feed_source$`))
    expect(commands[1]).toMatch(new RegExp(`--id ${O} .* -- feed_min_interval_seconds$`))
    expect(commands[2]).toMatch(new RegExp(`--id ${FEED} .* -- decimals$`))
    expect(commands[3]).toMatch(new RegExp(`--id ${FEED} .* -- lastprice --asset '\\{"Stellar":"${SAC}"\\}'$`))
    expect(() => JSON.stringify(sources)).not.toThrow()
    // Mainnet's form too (RPC and passphrase named).
    for (const s of sources) expect(verifyCommand("mainnet", s, "https://rpc.example")).toContain("--rpc-url https://rpc.example")
  })

  it("no feed set (feed_source None): feedPrice is null and nothing is read on any feed", async () => {
    for (const none of [null, undefined]) {
      const calls: Calls = []
      // The fixture still answers the feed's two views: a stray read would succeed, so only `calls` can catch it.
      const view = await fetchOracleView(fakeReader(fed(undefined, { [`${O}.feed_source`]: none }), calls), manifest, O, TS)
      expect(view.feed).toMatchObject({ status: "live", value: null })
      expect(view.feedPrice).toBeNull()
      expect(view.feedMinInterval).toMatchObject({ status: "live", value: 300n })
      expect(calls.map((c) => c.key)).toContain(`${O}.feed_source`)
      expect(calls).toHaveLength(13)
      expect(calls.filter((c) => c.key.startsWith(`${FEED}.`))).toEqual([])
    }
  })

  it("an oracle without the two views (MissingValue, 665bb67): both unsupported, no feed read, and the rest of the view intact", async () => {
    const calls: Calls = []
    const view = await fetchOracleView(fakeReader(table(), calls), manifest, O, TS)
    expect(view.feed).toEqual({ status: "unsupported", source: expect.objectContaining({ contractId: O, fn: "feed_source", args: [] }) })
    expect(view.feedMinInterval).toEqual({ status: "unsupported", source: expect.objectContaining({ contractId: O, fn: "feed_min_interval_seconds", args: [] }) })
    expect(view.feedPrice).toBeNull()
    expect(calls.every((c) => c.key.startsWith(`${O}.`))).toBe(true)
    // Exactly the views read before, plus the two new ones.
    expect(calls.map((c) => c.key.slice(O.length + 1)).sort()).toEqual(
      [
        "get_reference_value",
        "get_reference_timestamp",
        "is_available",
        "max_stale_seconds",
        "max_deviation_bps",
        "value_bounds",
        "get_primary_source",
        "get_fallback_source",
        "get_active_source",
        "last_update_was_feed",
        "last_rejection",
        "feed_source",
        "feed_min_interval_seconds",
      ].sort(),
    )
    // The rest is what it was.
    expect(view.value).toMatchObject({ status: "live", value: 10_500_000n })
    expect(view.timestamp).toMatchObject({ status: "live", value: BigInt(TS) })
    expect(view.freshness).toBe("fresh")
    expect(view.path).toMatchObject({ status: "unsupported" })
    expect(view.sources.primary).toMatchObject({ preimage: PREIMAGE })
    expect(view.lastRejection).toMatchObject({ status: "live", value: null })
    for (const f of [view.value, view.timestamp, view.available, view.maxStale, view.deviationBps, view.bounds, view.lastRejection] as Live<unknown>[]) expect(f.status).toBe("live")
  })

  it("another failure of the two views is unavailable, not unsupported; the feed price says the source could not be read", async () => {
    const view = await fetchOracleView(
      fakeReader(fed(undefined, { [`${O}.feed_source`]: new Error("fetch failed"), [`${O}.feed_min_interval_seconds`]: new Error("HostError: Error(WasmVm, InvalidAction)") })),
      manifest,
      O,
      TS,
    )
    expect(view.feed).toMatchObject({ status: "unavailable", error: "fetch failed", source: { fn: "feed_source" } })
    expect(view.feedMinInterval.status).toBe("unavailable")
    expect(view.feedPrice).toMatchObject({ status: "unavailable", error: "fetch failed" })
  })

  it.each([
    ["an unknown variant", ["Native", "XLM"]],
    ["a Stellar asset that is no address", ["Stellar", "not-an-address"]],
    ["an Other asset that is no symbol", ["Other", 5]],
    ["no variant at all", "USDY"],
  ])("an asset of unrecognized shape (%s) makes feed_source unavailable with a plain reason, never a guess; no feed read", async (_label, asset) => {
    const calls: Calls = []
    const view = await fetchOracleView(fakeReader(fed(asset), calls), manifest, O, TS)
    expect(view.feed).toMatchObject({ status: "unavailable", error: expect.stringMatching(/asset/), source: { fn: "feed_source" } })
    expect(view.feedPrice?.status).toBe("unavailable")
    expect(calls.some((c) => c.key.startsWith(`${FEED}.`))).toBe(false)
  })

  it("a feed id that is no contract makes feed_source unavailable", async () => {
    const view = await fetchOracleView(fakeReader(fed(undefined, { [`${O}.feed_source`]: ["nope", ["Other", "USDY"]] })), manifest, O, TS)
    expect(view.feed.status).toBe("unavailable")
  })

  it("the feed has no price for the asset (lastprice None): feedPrice is unavailable, saying so, with the call to repeat", async () => {
    const view = await fetchOracleView(fakeReader(fed(undefined, { [`${FEED}.lastprice`]: null })), manifest, O, TS)
    expect(view.feedPrice).toMatchObject({ status: "unavailable", error: "The feed has no price for this asset.", source: { contractId: FEED, fn: "lastprice" } })
    const feedPrice = view.feedPrice as Extract<OracleView["feedPrice"], { status: "unavailable" }>
    expect(verifyCommand("testnet", feedPrice.source!)).toMatch(/-- lastprice --asset '\{"Other":"USDY"\}'$/)
    // The feed itself is still known.
    expect(view.feed).toMatchObject({ status: "live", value: { contract: FEED } })
  })

  it("a price the oracle could not rescale (past i128) is unavailable, saying so, with the lastprice call to repeat", async () => {
    // 2^127 − 1 at 6 decimals: × 10 overflows an i128, so the contract would reject it with `rescale`.
    const huge = 2n ** 127n - 1n
    const view = await fetchOracleView(fakeReader(fed(undefined, { [`${FEED}.decimals`]: 6, [`${FEED}.lastprice`]: { price: huge, timestamp: FEED_TS } })), manifest, O, TS)
    expect(view.feedPrice).toEqual({
      status: "unavailable",
      error: "The feed's price could not be converted to 7 decimals.",
      source: { contractId: FEED, fn: "lastprice", args: [{ type: "enum", variant: "Other", value: { type: "symbol", value: "USDY" } }], rpcUrl: RPC },
    })
    const feedPrice = view.feedPrice as Extract<OracleView["feedPrice"], { status: "unavailable" }>
    expect(verifyCommand("testnet", feedPrice.source!)).toMatch(new RegExp(`--id ${FEED} .* -- lastprice --asset '\\{"Other":"USDY"\\}'$`))
  })

  it("either feed read failing makes feedPrice unavailable with that read's reason", async () => {
    const decimals = await fetchOracleView(fakeReader(fed(undefined, { [`${FEED}.decimals`]: new Error("HostError: Error(Contract, #1)") })), manifest, O, TS)
    expect(decimals.feedPrice).toMatchObject({ status: "unavailable", error: "HostError: Error(Contract, #1)", source: { contractId: FEED, fn: "decimals" } })
    const price = await fetchOracleView(fakeReader(fed(undefined, { [`${FEED}.lastprice`]: new Error("fetch failed") })), manifest, O, TS)
    expect(price.feedPrice).toMatchObject({ status: "unavailable", error: "fetch failed", source: { contractId: FEED, fn: "lastprice" } })
    const shape = await fetchOracleView(fakeReader(fed(undefined, { [`${FEED}.lastprice`]: { price: "x", timestamp: 1n } })), manifest, O, TS)
    expect(shape.feedPrice?.status).toBe("unavailable")
    const odd = await fetchOracleView(fakeReader(fed(undefined, { [`${FEED}.decimals`]: -1 })), manifest, O, TS)
    expect(odd.feedPrice?.status).toBe("unavailable")
  })
})

describe("rescaleTo7: the oracle's rescale to protocol decimals (3af9388 rescale_to_protocol_decimals)", () => {
  it.each([
    [108_076_700n, 8, 10_807_670n], // more decimals: divided
    [19n, 8, 1n], // truncates toward zero
    [115_359_071n, 8, 11_535_907n],
    [5n, 6, 50n], // fewer decimals: multiplied
    [3n, 0, 30_000_000n],
    [10_500_000n, 7, 10_500_000n], // equal: unchanged
    [-19n, 8, -1n], // toward zero, not down (i128 division)
    [123_456_789n, 18, 0n],
  ])("rescaleTo7(%s, %i) = %s", (raw, decimals, expected) => {
    expect(rescaleTo7(raw, decimals)).toBe(expected)
  })

  it("refuses what the contract refuses (None: a rescale rejection): an i128 overflow, a power of ten past i128, a decimals that is no u32", () => {
    const I128_MAX = 2n ** 127n - 1n
    expect(() => rescaleTo7(I128_MAX, 6)).toThrow(/7 decimals/)
    expect(rescaleTo7(I128_MAX / 10n, 6)).toBe((I128_MAX / 10n) * 10n)
    expect(rescaleTo7(5n, 7 + 38)).toBe(0n) // 10^38 fits an i128
    expect(() => rescaleTo7(5n, 7 + 39)).toThrow(/7 decimals/) // 10^39 does not
    expect(() => rescaleTo7(5n, 4_294_967_295)).toThrow(/7 decimals/) // no 10^(4e9) computed
    expect(() => rescaleTo7(5n, -1)).toThrow()
    expect(() => rescaleTo7(5n, 1.5)).toThrow()
  })
})
