// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../../manifest"
import type { Manifest, Market } from "../../types"
import { fetchPauses } from "../pauses"
import { fakeReader, type Calls, type Handler } from "./fake-reader"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const { sy, pool, manager } = market.contracts
const R = manifest.shared.riskControl

const m2: Market = { ...market, marketId: "second", contracts: { ...market.contracts, sy: "SY2", pool: "POOL2", manager: "MANAGER2" } }
const two: Manifest = { ...manifest, markets: [market, m2] }

function table(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [`${sy}.is_paused`]: false,
    [`${pool}.is_paused`]: false,
    [`${manager}.is_paused`]: false,
    [`${R}.is_paused`]: false,
    "SY2.is_paused": false,
    "POOL2.is_paused": false,
    "MANAGER2.is_paused": false,
    ...over,
  }
}

describe("fetchPauses", () => {
  it("reads is_paused on every market's SY, pool and manager, and on RiskControl, once each", async () => {
    const calls: Calls = []
    const view = await fetchPauses(fakeReader(table(), calls), two)
    expect(calls.map((c) => c.key).sort()).toEqual(
      [`${sy}.is_paused`, `${pool}.is_paused`, `${manager}.is_paused`, "SY2.is_paused", "POOL2.is_paused", "MANAGER2.is_paused", `${R}.is_paused`].sort(),
    )
    expect(view.contracts.map((c) => [c.kind, c.marketId ?? null])).toEqual([
      ["riskControl", null],
      ["sy", market.marketId],
      ["pool", market.marketId],
      ["manager", market.marketId],
      ["sy", "second"],
      ["pool", "second"],
      ["manager", "second"],
    ])
  })

  it("paused lists nothing when no contract is paused, with every read as its source", async () => {
    const view = await fetchPauses(fakeReader(table()), manifest)
    expect(view.paused).toMatchObject({ status: "live", value: [] })
    expect(view.paused.status === "live" && view.paused.sources?.length).toBe(4)
  })

  it("paused names each paused contract, with its market", async () => {
    const view = await fetchPauses(fakeReader(table({ [`${R}.is_paused`]: true, "POOL2.is_paused": true })), two)
    expect(view.paused).toMatchObject({ status: "live", value: ["Risk control", "Market pool (second)"] })
  })

  it("paused is unavailable, naming the contract, when any read fails: never 'none paused' from a partial read", async () => {
    const view = await fetchPauses(fakeReader(table({ [`${manager}.is_paused`]: new Error("rpc down") })), manifest)
    expect(view.paused.status).toBe("unavailable")
    expect(view.paused.status === "unavailable" && view.paused.error).toBe(`Principal manager (${market.marketId}): rpc down`)
    expect(view.paused.status === "unavailable" && view.paused.source?.contractId).toBe(manager)
  })
})
