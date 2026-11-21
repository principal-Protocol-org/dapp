// @vitest-environment node
/**
 * The committed Mainnet manifest is the contracts team's handover file plus our additions.
 *
 * The fixture `fixtures/mainnet-handover.json` is `deployments/mainnet-dapp-manifest.json` from the
 * principal repository, unchanged: branch `mainnet` at 94050d03d3bce806e1df73c20b5f753c555270af,
 * the file last changed in ae8c0e8382cb3aa652924e3e4742094bfea1ed6b (the v2 redeploy of MOCKUSTRY,
 * MOCKGILTS, MOCKCETES and MOCKXAUM, 2026-11-20/21; the v1 contracts of those four are abandoned).
 *
 * Our additions: `deployLedger` (the ledger before the first contract creation, Permissioning at
 * 65525736), `protocolAbi` (the Router at 3af9388 speaks version 2) and each market's
 * `underlying.tracks`. `createdLedgers` (the v2 oracles and market contracts, from the ledgers of
 * their creating transactions: Horizon, by the hashes in each asset's `transactions[]`),
 * `accessContact` (spec 0005 M-17) and `rpcFallbackUrls`
 * (spec 0004) are ours too when present.
 *
 * `rpcUrl` differs from the handover on purpose: the developer chose a keyed provider (dRPC) as the
 * read path, and the handover's public gateway is kept as our fallback. The comparison with the
 * handover therefore asserts that the handover's `rpcUrl` is in our `rpcFallbackUrls` and puts it
 * back as `rpcUrl`; any other difference stays visible (spec M-1).
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
  // Our `rpcUrl` is the keyed provider; the contracts team's is our fallback. Assert that, then put it back.
  expect(raw.rpcFallbackUrls).toContain(handover.rpcUrl)
  raw.rpcUrl = handover.rpcUrl
  for (const key of ["deployLedger", "protocolAbi", "createdLedgers", "accessContact", "rpcFallbackUrls", "verifyRpcUrl"]) delete raw[key]
  for (const market of raw.markets) delete market.underlying.tracks
  return raw
}

describe("config/manifests/mainnet.json", () => {
  it("parses and validates with no finding", () => {
    const m = parseManifest(mainnetJson)
    expect(m.network).toBe("mainnet")
    expect(validateManifest(m)).toEqual([])
  })

  it("reads through a keyed provider and keeps the handover's RPC as its first fallback", () => {
    const m = parseManifest(mainnetJson)
    expect(m.rpcUrl).not.toBe(handover.rpcUrl)
    expect(m.rpcFallbackUrls?.[0]).toBe(handover.rpcUrl)
  })

  it("is the handover file once our additions are removed", () => {
    expect(withoutOurAdditions(mainnetJson as RawManifest)).toEqual(handover)
  })

  it.each([
    ["an access contact", { accessContact: { label: "the Principal access desk", url: "https://principal.example/access" } }],
    ["RPC fallbacks", { rpcFallbackUrls: ["https://rpc.second.example"] }],
    ["both", { accessContact: { label: "access@principal.example", url: "mailto:access@principal.example" }, rpcFallbackUrls: ["https://rpc.second.example"] }],
  ])("stays the handover file with %s added (ours too)", (_, added) => {
    const base = structuredClone(mainnetJson) as RawManifest
    const extra = (added as { rpcFallbackUrls?: string[] }).rpcFallbackUrls
    const raw = { ...base, ...added, ...(extra ? { rpcFallbackUrls: [...(base.rpcFallbackUrls as string[]), ...extra] } : {}) }
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
      "mainnet-CDHQ4B-CAFCV4KB",
      "mainnet-CBBF4H-CBYNXSR3",
      "mainnet-CBVSL3-CBAUFMQH",
      "mainnet-CBAJVV-CDG77CSN",
    ])
  })

  it("gives each v2 oracle and market contract a creation ledger after the deploy ledger, none to the shared ones", () => {
    const m = parseManifest(mainnetJson)
    const v2 = m.markets.filter((x) => x.underlying.code !== "MOCKUSDY")
    const ids = v2.flatMap((x) => [x.contracts.oracle, x.contracts.sy, x.contracts.manager, x.contracts.pool, x.contracts.recoveryEscrow])
    expect(Object.keys(m.createdLedgers ?? {}).sort()).toEqual([...ids].sort())
    for (const id of ids) expect(m.createdLedgers?.[id]).toBeGreaterThan(m.deployLedger as number)
    for (const x of v2) expect(m.createdLedgers?.[x.contracts.oracle]).toBeLessThanOrEqual(m.createdLedgers?.[x.contracts.sy] as number)
  })

  it("names the access contact: the support address, as a mailto link", () => {
    expect(parseManifest(mainnetJson).accessContact).toEqual({
      label: "hello@principalmarket.fi",
      url: "mailto:hello@principalmarket.fi?subject=Mainnet%20access%20request",
    })
  })

  it("the old pending stub is now refused like any incomplete manifest", () => {
    expect(() => parseManifest({ network: "mainnet", pending: true })).toThrow(/^Invalid manifest: /)
  })
})
