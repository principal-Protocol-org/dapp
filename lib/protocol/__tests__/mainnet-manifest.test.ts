// @vitest-environment node
/**
 * The committed Mainnet manifest is the contracts team's handover file plus our additions.
 *
 * The fixture `fixtures/mainnet-handover.json` is `deployments/mainnet-dapp-manifest.json` from the
 * principal repository, unchanged: branch `mainnet` at ad012a06676c7d9656d182526e8eeddd38b4dd3c,
 * the file last changed in d348c551dc8289508358c156022ed56bd1e7217b.
 *
 * Our additions: `deployLedger` (the ledger before the first contract creation, Permissioning at
 * 65525736), `protocolAbi` (the Router at 3af9388 speaks version 2) and each market's
 * `underlying.tracks`. `createdLedgers`, `accessContact` (spec 0005 M-17) and `rpcFallbackUrls`
 * (spec 0004) are ours too when present.
 */
import { describe, expect, it } from "vitest"
import mainnetJson from "@/config/manifests/mainnet.json"
import handover from "@/lib/protocol/__tests__/fixtures/mainnet-handover.json"
import { manifestOracles, parseManifest, protocolAbi, validateManifest } from "../manifest"

const TRACKS: Record<string, string> = { MOCKUSDY: "USDY", MOCKUSTRY: "USTRY", MOCKGILTS: "GILTS", MOCKCETES: "CETES", MOCKXAUM: "XAUM" }

type RawManifest = Record<string, unknown> & { markets: { underlying: Record<string, unknown> }[] }

/** A copy of `json` without the fields we add to the contracts team's file. */
function withoutOurAdditions(json: RawManifest): RawManifest {
  const raw = structuredClone(json)
  for (const key of ["deployLedger", "protocolAbi", "createdLedgers", "accessContact", "rpcFallbackUrls"]) delete raw[key]
  for (const market of raw.markets) delete market.underlying.tracks
  return raw
}

describe("config/manifests/mainnet.json", () => {
  it("parses and validates with no finding", () => {
    const m = parseManifest(mainnetJson)
    expect(m.network).toBe("mainnet")
    expect(validateManifest(m)).toEqual([])
  })

  it("is the handover file once our additions are removed", () => {
    expect(withoutOurAdditions(mainnetJson as RawManifest)).toEqual(handover)
  })

  it.each([
    ["an access contact", { accessContact: { label: "the Principal access desk", url: "https://principal.example/access" } }],
    ["RPC fallbacks", { rpcFallbackUrls: ["https://rpc.second.example"] }],
    ["both", { accessContact: { label: "access@principal.example", url: "mailto:access@principal.example" }, rpcFallbackUrls: ["https://rpc.second.example"] }],
  ])("stays the handover file with %s added (ours too)", (_, added) => {
    const raw = { ...(structuredClone(mainnetJson) as RawManifest), ...added }
    expect(validateManifest(parseManifest(raw))).toEqual([])
    expect(withoutOurAdditions(raw)).toEqual(handover)
  })

  it("names five oracles, starts at 65525735 and speaks protocol version 2", () => {
    const m = parseManifest(mainnetJson)
    expect(manifestOracles(m)).toHaveLength(5)
    expect(m.deployLedger).toBe(65525735)
    expect(protocolAbi(m)).toBe(2)
  })

  it("keeps every addition through parsing: each market tracks its asset", () => {
    const m = parseManifest(mainnetJson)
    expect(m.protocolAbi).toBe(2)
    expect(m.markets.map((x) => [x.underlying.code, x.underlying.tracks])).toEqual(
      handover.markets.map((x) => [x.underlying.code, TRACKS[x.underlying.code]]),
    )
    expect(m.markets.map((x) => x.marketId)).toEqual([
      "mainnet-CDQYZU-CCY5P6CC",
      "mainnet-CDHQ4B-CA4EMPWQ",
      "mainnet-CBBF4H-CDXXRJJS",
      "mainnet-CBVSL3-CCSETNMX",
      "mainnet-CBAJVV-CB7KQ4O6",
    ])
  })

  it("has no access contact yet", () => {
    expect(parseManifest(mainnetJson).accessContact).toBeUndefined()
  })

  it("the old pending stub is now refused like any incomplete manifest", () => {
    expect(() => parseManifest({ network: "mainnet", pending: true })).toThrow(/^Invalid manifest: /)
  })
})
