import { describe, expect, it } from "vitest"
import type { Live, ReadSource } from "../../types"
import type { FeedPrice, OracleView } from "../oracle"
import {
  FEED_NOT_POSITIVE,
  oracleEntries,
  oracleNow,
  STORED_NOT_POSITIVE,
  storedAgainstFeed,
  storedAgainstFeedLive,
  type OracleViewAt,
} from "../oracle-state"

const RPC = "https://rpc.test"
const ORACLE = "CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT"
const FEED = "CAL7LXAUKP634THLOVPESX4WBZKKONY2PZN4A2CJ6HM4JW6QKU5ILLCT"
const src = (contractId: string, fn: string): ReadSource => ({ contractId, fn, args: [], rawXdr: "AAAA", ledger: 10, rpcUrl: RPC })
const live = <T>(value: T, contractId: string, fn: string): Live<T> => ({ status: "live", value, ledger: 10, source: src(contractId, fn) })
const feedPrice = (value: bigint): Live<FeedPrice> => ({
  status: "live",
  value: { raw: value, decimals: 7, value, timestamp: 1_000n },
  ledger: 10,
  sources: [src(FEED, "decimals"), src(FEED, "lastprice")],
})

describe("storedAgainstFeed (Review Focus 5), integer math only", () => {
  it.each([
    ["equal", 11_535_907n, 11_535_907n, "Equal"],
    ["one unit apart on large values", 10n ** 30n + 1n, 10n ** 30n, "Differs by less than 0.01 %"],
    ["one unit apart at 7 decimals", 10_000_001n, 10_000_000n, "Differs by less than 0.01 %"],
    ["exactly 2×", 20_000_000n, 10_000_000n, "Differs by a factor of 2.0"],
    ["just under 2×", 19_999_999n, 10_000_000n, "Differs by 99.99 %"],
    ["10×, the Mainnet case (stored above)", 108_065_700n, 10_807_670n, "Differs by a factor of 10.0"],
    ["0.01 %, the Mainnet case (stored below)", 11_534_743n, 11_535_907n, "Differs by 0.01 %"],
    ["stored smaller than the feed, 10×", 10_807_670n, 108_065_700n, "Differs by a factor of 10.0"],
    ["stored smaller than the feed, a percent", 10_000_000n, 10_500_000n, "Differs by 5.00 %"],
    ["above 2^64, 10×", 2n ** 70n * 10n, 2n ** 70n, "Differs by a factor of 10.0"],
    ["above 2^64, a percent (1/1024, rounded down)", 2n ** 70n + 2n ** 60n, 2n ** 70n, "Differs by 0.09 %"],
    ["above 2^64, 1.95× (below 2: a percent)", 2n ** 64n * 195n, 2n ** 64n * 100n, "Differs by 95.00 %"],
    ["a factor that rounds to the nearest tenth", 29_960_000n, 10_000_000n, "Differs by a factor of 3.0"],
  ])("%s: %s against %s reads %s", (_case, stored, feed, text) => {
    expect(storedAgainstFeed(stored, feed)).toBe(text)
  })

  it("a feed price of zero or negative: no comparison, the oracle would refuse it", () => {
    expect(storedAgainstFeed(10_000_000n, 0n)).toBe(FEED_NOT_POSITIVE)
    expect(storedAgainstFeed(10_000_000n, -1n)).toBe(FEED_NOT_POSITIVE)
    expect(storedAgainstFeed(0n, 0n)).toBe(FEED_NOT_POSITIVE)
  })

  it("a stored value of zero or below against a positive feed price has no ratio: it throws", () => {
    expect(() => storedAgainstFeed(0n, 10_000_000n)).toThrow(STORED_NOT_POSITIVE)
    expect(() => storedAgainstFeed(-5n, 10_000_000n)).toThrow(STORED_NOT_POSITIVE)
  })
})

describe("storedAgainstFeedLive", () => {
  it("lists both inputs: the stored value's read and the feed's two", () => {
    const l = storedAgainstFeedLive(live(108_065_700n, ORACLE, "get_reference_value"), feedPrice(10_807_670n))
    expect(l).toMatchObject({ status: "live", value: "Differs by a factor of 10.0" })
    expect(l.status === "live" && l.sources?.map((s) => `${s.contractId === ORACLE ? "oracle" : "feed"}.${s.fn}`)).toEqual(["oracle.get_reference_value", "feed.decimals", "feed.lastprice"])
  })

  it("a stored value of zero or below is Unavailable with the get_reference_value call, so it can be repeated", () => {
    const l = storedAgainstFeedLive(live(0n, ORACLE, "get_reference_value"), feedPrice(10_807_670n))
    expect(l).toEqual({ status: "unavailable", error: STORED_NOT_POSITIVE, source: { contractId: ORACLE, fn: "get_reference_value", args: [], rpcUrl: RPC } })
  })

  it("either input unavailable: that input's reason", () => {
    const down: Live<FeedPrice> = { status: "unavailable", error: "The feed has no price for this asset." }
    expect(storedAgainstFeedLive(live(1n, ORACLE, "get_reference_value"), down)).toEqual(down)
  })
})

describe("oracleEntries", () => {
  const market = (oracle: string, code: string) => ({ contracts: { oracle }, underlying: { code } })
  it("one entry per distinct oracle, named by its markets' codes, in market order", () => {
    const m = { markets: [market("CA", "USDY"), market("CB", "GILT"), market("CA", "USTRY")], shared: { oracle: "CA" } }
    expect(oracleEntries(m as never)).toEqual([
      { oracle: "CA", asset: "USDY, USTRY" },
      { oracle: "CB", asset: "GILT" },
    ])
  })

  it("no market listed: the shared oracle", () => {
    expect(oracleEntries({ markets: [], shared: { oracle: "CSHARED" } } as never)).toEqual([{ oracle: "CSHARED", asset: "OracleAdapter" }])
  })
})

describe("oracleNow", () => {
  const view = (timeToBlock: number, available = true) =>
    ({
      contractId: ORACLE,
      available: live(available, ORACLE, "is_available"),
      maxStale: live(3_600n, ORACLE, "max_stale_seconds"),
      freshness: "fresh",
      timeToBlock: { status: "live", value: timeToBlock, ledger: 10, sources: [src(ORACLE, "get_reference_timestamp"), src(ORACLE, "max_stale_seconds")] },
    }) as unknown as OracleView
  const q = (data?: OracleViewAt, stale = false) => ({ data, stale, error: stale ? new Error("rpc down") : null })

  it("follows the ledger clock: Fresh, Warning from 75%, Stale past max_stale", () => {
    const data = { view: view(2_880), ledgerTime: 1_000 }
    expect(oracleNow(q(data), 1_000, undefined)).toMatchObject({ state: "fresh", left: 2_880 })
    expect(oracleNow(q(data), 1_000 + 2_000, undefined)).toMatchObject({ state: "warning", left: 880 })
    expect(oracleNow(q(data), 1_000 + 2_900, undefined)).toMatchObject({ state: "stale", left: -20 })
  })

  it("its reads are timestamp, max_stale and is_available; is_available false reads Stale", () => {
    const now = oracleNow(q({ view: view(2_880, false), ledgerTime: 1_000 }), 1_000, undefined)
    expect(now.state).toBe("stale")
    expect(now.live?.status === "live" && now.live.sources?.map((s) => s.fn)).toEqual(["get_reference_timestamp", "max_stale_seconds", "is_available"])
  })

  it("pending: no live; a failed refresh or no clock: Unavailable with the reason", () => {
    expect(oracleNow(q(), 1_000, undefined)).toEqual({ state: "unavailable", left: null, live: undefined })
    expect(oracleNow(q({ view: view(2_880), ledgerTime: 1_000 }, true), 1_000, undefined).live).toMatchObject({ status: "unavailable", error: "the last refresh failed: rpc down" })
    expect(oracleNow(q(), null, "the ledger time could not be read").live).toMatchObject({ status: "unavailable", error: "the ledger time could not be read" })
  })
})
