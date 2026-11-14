// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../../manifest"
import type { ScArg } from "../../stellar"
import type { Manifest, Market } from "../../types"
import { EFFECTIVE_WRAP_AND_MINT_LABEL, fetchRiskView } from "../risk"
import { fakeReader, type Handler } from "./fake-reader"

const manifest = parseManifest(testnetJson)
const R = manifest.shared.riskControl
const market = manifest.markets[0]
const { sy, manager } = market.contracts
const SAC = market.underlying.sac

/** A second market on the same RiskControl, with its own SY and manager. */
const m2: Market = { ...market, marketId: "second", contracts: { ...market.contracts, sy: "SY2", manager: "MANAGER2" } }
const two: Manifest = { ...manifest, markets: [market, m2] }

const consumer = (yes: Record<string, boolean | Error>) => (args: ScArg[]) => {
  const who = String(args[0]?.value)
  return who in yes ? yes[who] : false
}

function table(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [`${R}.get_cb_limit`]: 100_000_000_000_000n,
    [`${R}.get_cb_volume`]: 30_000_000_000_000n,
    [`${R}.get_asset_limit`]: 0n,
    [`${R}.get_asset_volume`]: 0n,
    [`${R}.get_window_start`]: 5_707_351,
    [`${R}.get_window_ledgers`]: 17_280,
    [`${R}.is_paused`]: false,
    [`${R}.is_consumer`]: consumer({ [sy]: true, [manager]: true }),
    ...over,
  }
}

describe("fetchRiskView", () => {
  it("limit, volume and remaining", async () => {
    const view = await fetchRiskView(fakeReader(table()), manifest, 5_710_000)
    expect(view.limit).toMatchObject({ status: "live", value: 100_000_000_000_000n })
    expect(view.volume).toMatchObject({ status: "live", value: 30_000_000_000_000n })
    expect(view.remaining).toMatchObject({ status: "live", value: 70_000_000_000_000n })
    expect(view.remaining.status === "live" && view.remaining.sources?.map((s) => s.fn)).toEqual(["get_cb_limit", "get_cb_volume"])
  })

  it("remaining is null (no limit) when the limit is 0, and 0 when volume is over the limit", async () => {
    const off = await fetchRiskView(fakeReader(table({ [`${R}.get_cb_limit`]: 0n })), manifest, 5_710_000)
    expect(off.remaining).toMatchObject({ status: "live", value: null })
    const over = await fetchRiskView(fakeReader(table({ [`${R}.get_cb_limit`]: 10n, [`${R}.get_cb_volume`]: 20n })), manifest, 5_710_000)
    expect(over.remaining).toMatchObject({ status: "live", value: 0n })
  })

  it("effective wrap-and-mint capacity is remaining / 2n when both SY and manager are consumers", async () => {
    const view = await fetchRiskView(fakeReader(table({ [`${R}.get_cb_volume`]: 1n })), manifest, 5_710_000)
    expect(view.effectiveWrapAndMint).toMatchObject({ status: "live", value: (100_000_000_000_000n - 1n) / 2n })
    const fns = view.effectiveWrapAndMint?.status === "live" ? view.effectiveWrapAndMint.sources?.map((s) => s.fn) : []
    expect(fns).toEqual(expect.arrayContaining(["get_cb_limit", "get_cb_volume", "is_consumer"]))
  })

  it.each([
    [{ [sy]: true }],
    [{ [manager]: true }],
    [{}],
  ])("effective capacity is null unless both are consumers (%o)", async (yes) => {
    const view = await fetchRiskView(fakeReader(table({ [`${R}.is_consumer`]: consumer(yes) })), manifest, 5_710_000)
    expect(view.effectiveWrapAndMint).toBeNull()
  })

  it("an unreadable is_consumer makes the effective capacity unavailable, never null", async () => {
    const view = await fetchRiskView(fakeReader(table({ [`${R}.is_consumer`]: consumer({ [sy]: true, [manager]: new Error("down") }) })), manifest, 5_710_000)
    expect(view.effectiveWrapAndMint?.status).toBe("unavailable")
    expect(view.effectiveWrapAndMint?.status === "unavailable" && view.effectiveWrapAndMint.error).toMatch(/down/)
  })

  it("a failed read in a market already ruled out (a false read) is not needed: null", async () => {
    const view = await fetchRiskView(fakeReader(table({ [`${R}.is_consumer`]: consumer({ [sy]: false, [manager]: new Error("down") }) })), manifest, 5_710_000)
    expect(view.effectiveWrapAndMint).toBeNull()
  })

  it("two markets, one double-reports: shown for that market, labelled", async () => {
    const view = await fetchRiskView(
      fakeReader(table({ [`${R}.is_consumer`]: consumer({ [sy]: true, [manager]: true, SY2: true, MANAGER2: false }) })),
      two,
      5_710_000,
    )
    expect(view.effectiveWrapAndMint).toMatchObject({ status: "live", value: 70_000_000_000_000n / 2n })
    expect(view.doubleReporting).toEqual([market.marketId])
    expect(view.consumers.second).toMatchObject({ sy: { value: true }, manager: { value: false } })
    // Only the double-reporting market's reads back the figure.
    const args = view.effectiveWrapAndMint?.status === "live" ? view.effectiveWrapAndMint.sources?.filter((s) => s.fn === "is_consumer").map((s) => (s.args[0] as { value: string }).value) : []
    expect(args).toEqual([sy, manager])
    expect(EFFECTIVE_WRAP_AND_MINT_LABEL).toMatch(/for markets whose SY and manager both report/)
  })

  it("two markets, one double-reports, the other's read fails: still shown (that read is not needed)", async () => {
    const view = await fetchRiskView(
      fakeReader(table({ [`${R}.is_consumer`]: consumer({ [sy]: true, [manager]: true, SY2: true, MANAGER2: new Error("down") }) })),
      two,
      5_710_000,
    )
    expect(view.effectiveWrapAndMint).toMatchObject({ status: "live", value: 35_000_000_000_000n })
    expect(view.doubleReporting).toEqual([market.marketId])
  })

  it("two markets, neither double-reports, one read fails where it could: unavailable", async () => {
    const view = await fetchRiskView(
      fakeReader(table({ [`${R}.is_consumer`]: consumer({ [sy]: false, SY2: true, MANAGER2: new Error("down") }) })),
      two,
      5_710_000,
    )
    expect(view.effectiveWrapAndMint).toMatchObject({ status: "unavailable" })
    expect(view.effectiveWrapAndMint?.status === "unavailable" && view.effectiveWrapAndMint.error).toMatch(/second.*down/)
    expect(view.doubleReporting).toEqual([])
  })

  it("the effective capacity is null (no limit) when the limit is off", async () => {
    const view = await fetchRiskView(fakeReader(table({ [`${R}.get_cb_limit`]: 0n })), manifest, 5_710_000)
    expect(view.effectiveWrapAndMint).toMatchObject({ status: "live", value: null })
  })

  it("lists the consumer reads per market", async () => {
    const view = await fetchRiskView(fakeReader(table()), manifest, 5_710_000)
    expect(view.consumers[market.marketId]).toMatchObject({ sy: { status: "live", value: true }, manager: { status: "live", value: true } })
  })

  it.each([
    [5_707_351 + 17_279, false],
    [5_707_351 + 17_280, true], // ledger − start ≥ length
    [5_707_351 + 50_000, true],
  ])("window at ledger %i: lapsed %s", async (ledger, lapsed) => {
    const view = await fetchRiskView(fakeReader(table()), manifest, ledger)
    expect(view.window.start).toMatchObject({ status: "live", value: 5_707_351 })
    expect(view.window.length).toMatchObject({ status: "live", value: 17_280 })
    expect(view.window.lapsed).toMatchObject({ status: "live", value: lapsed })
  })

  it("lapsed is unavailable when the start cannot be read", async () => {
    const view = await fetchRiskView(fakeReader(table({ [`${R}.get_window_start`]: new Error("down") })), manifest, 5_710_000)
    expect(view.window.lapsed.status).toBe("unavailable")
  })

  it("per-asset limits for each market underlying", async () => {
    const view = await fetchRiskView(
      fakeReader(table({ [`${R}.get_asset_limit`]: 500n, [`${R}.get_asset_volume`]: 200n })),
      manifest,
      5_710_000,
    )
    expect(view.assetLimits).toHaveLength(1)
    expect(view.assetLimits[0]).toMatchObject({
      asset: SAC,
      limit: { status: "live", value: 500n },
      volume: { status: "live", value: 200n },
      remaining: { status: "live", value: 300n },
    })
    expect(view.assetLimits[0].limit).toMatchObject({ source: { fn: "get_asset_limit", args: [{ type: "address", value: SAC }] } })
  })

  it("paused", async () => {
    const view = await fetchRiskView(fakeReader(table({ [`${R}.is_paused`]: true })), manifest, 5_710_000)
    expect(view.paused).toMatchObject({ status: "live", value: true })
  })
})
