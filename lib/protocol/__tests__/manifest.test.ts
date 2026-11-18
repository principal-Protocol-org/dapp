// @vitest-environment node
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
// The interim 3 Oct 2026 Testnet file (v1), frozen as a fixture: the committed testnet.json changes with each deployment.
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import committedTestnetJson from "@/config/manifests/testnet.json"
import localExample from "@/config/manifests/local.example.json"
import { getMarket, manifestOracles, parseManifest, protocolAbi, ROUTER_ABI_BY_WASM, validateManifest } from "../manifest"
import type { Manifest } from "../types"

const testnet = (): Manifest => parseManifest(structuredClone(testnetJson))
type Raw = typeof testnetJson
const errors = (m: Manifest) => validateManifest(m).filter((f) => f.severity === "error")

describe("manifest v1", () => {
  it("accepts the interim testnet manifest", () => {
    const m = parseManifest(testnetJson)
    expect(validateManifest(m)).toEqual([])
    expect(m.markets[0].marketId).toBe("sta-2026-10-03")
  })

  it("accepts the local example manifest", () => {
    const m = parseManifest(localExample)
    expect(m.network).toBe("local")
    expect(errors(m)).toEqual([])
  })

  it("rejects a passphrase that does not match the network", () => {
    const m = { ...testnet(), networkPassphrase: "Public Global Stellar Network ; September 2015" }
    expect(errors(m).some((f) => f.message.includes("networkPassphrase"))).toBe(true)
    const local = { ...parseManifest(localExample), networkPassphrase: "Test SDF Network ; September 2015" }
    expect(errors(local).some((f) => f.message.includes("networkPassphrase"))).toBe(true)
    const mainnet = { ...testnet(), network: "mainnet" as const }
    expect(errors(mainnet).some((f) => f.message.includes("networkPassphrase"))).toBe(true)
  })

  it("rejects a non-C contract address", () => {
    const raw = structuredClone(testnetJson) as Raw
    raw.markets[0].contracts.router = "GCWFJKLE45TMVZS42TMIYKAORKGBWE74753YPOSCC5ESJR2G2UMBXBDB"
    expect(() => parseManifest(raw)).toThrow(/markets\.0\.contracts\.router/)
    raw.markets[0].contracts.router = "not-a-contract"
    expect(() => parseManifest(raw)).toThrow(/markets\.0\.contracts\.router/)
  })

  it("keeps optional wasmHashes and rejects a malformed one (R29b)", () => {
    const raw = structuredClone(testnetJson) as Raw & { markets: { wasmHashes?: Record<string, string> }[] }
    expect(parseManifest(raw).markets[0].wasmHashes).toBeUndefined()
    raw.markets[0].wasmHashes = { manager: "AB".repeat(32) }
    expect(parseManifest(raw).markets[0].wasmHashes).toEqual({ manager: "AB".repeat(32) })
    raw.markets[0].wasmHashes = { manager: "ab".repeat(31) }
    expect(() => parseManifest(raw)).toThrow(/markets\.0\.wasmHashes\.manager/)
  })

  it("rejects a non-G issuer", () => {
    const raw = structuredClone(testnetJson) as Raw
    raw.markets[0].underlying.issuer = testnetJson.shared.riskControl
    expect(() => parseManifest(raw)).toThrow(/markets\.0\.underlying\.issuer/)
  })

  it("rejects a wrong schema version and missing shared contracts", () => {
    const raw = structuredClone(testnetJson) as Raw
    Reflect.set(raw, "schemaVersion", 3)
    expect(() => parseManifest(raw)).toThrow(/schemaVersion/)
    const raw2 = structuredClone(testnetJson) as Raw
    Reflect.deleteProperty(raw2.shared, "riskControl")
    expect(() => parseManifest(raw2)).toThrow(/shared\.riskControl/)
  })

  it("rejects duplicate marketId", () => {
    const m = testnet()
    const dup = { ...m, markets: [m.markets[0], { ...m.markets[0] }] }
    expect(errors(dup).some((f) => f.message.includes("Duplicate marketId"))).toBe(true)
  })

  it("requires at least one market in a v1 file (v2 allows none)", () => {
    const raw = { ...structuredClone(testnetJson), markets: [] }
    expect(() => parseManifest(raw)).toThrow(/markets/)
  })

  it("requires https rpc on testnet and mainnet, allows http on local", () => {
    const t = { ...testnet(), rpcUrl: "http://soroban.example.com" }
    expect(errors(t).some((f) => f.message.includes("rpcUrl"))).toBe(true)
    const h = { ...testnet(), horizonUrl: "http://horizon.example.com" }
    expect(errors(h).some((f) => f.message.includes("horizonUrl"))).toBe(true)
    const main = {
      ...testnet(),
      network: "mainnet" as const,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      rpcUrl: "http://soroban.example.com",
    }
    expect(errors(main).some((f) => f.message.includes("rpcUrl"))).toBe(true)
    const local = parseManifest(localExample)
    expect(local.rpcUrl.startsWith("http://")).toBe(true)
    expect(errors(local)).toEqual([])
  })

  it("getMarket returns undefined for unknown id", () => {
    const m = testnet()
    expect(getMarket(m, "nope")).toBeUndefined()
    expect(getMarket(m, "sta-2026-10-03")?.displayName).toContain("STA")
  })
})

const ROUTER_FUNCTIONS = [
  "wrap_and_mint",
  "unwrap",
  "swap_sy_for_pt",
  "swap_pt_for_sy",
  "swap_sy_for_yt",
  "swap_yt_for_sy",
  "add_liquidity",
  "add_liquidity_single_sy",
  "remove_liquidity",
  "recombine",
  "redeem_at_maturity",
  "claim_yield",
]

describe("manifest v2", () => {
  it("accepts the committed testnet manifest, whatever deployment it holds", () => {
    const m = parseManifest(committedTestnetJson)
    expect(m.network).toBe("testnet")
    expect(errors(m)).toEqual([])
  })

  const v2Raw = () => structuredClone(parseManifest(localExample)) as Manifest

  it("upgrades the interim v1 testnet file", () => {
    const m = parseManifest(testnetJson)
    expect(m.schemaVersion).toBe(2)
    expect(m.shared.router).toBe(m.markets[0].contracts.router)
    expect(m.shared.oracle).toBe(m.markets[0].contracts.oracle)
    expect(m.shared.riskControl).toBe(testnetJson.shared.riskControl)
    expect(m.shared.permissioning).toBe(testnetJson.shared.permissioning)
    expect(m.wasmHashes).toEqual(m.markets[0].wasmHashes ?? {})
    expect(m.routerFunctions).toEqual(ROUTER_FUNCTIONS)
    expect(m.testAsset).toBeUndefined()
    expect(errors(m)).toEqual([])
  })

  it("parses a v2 file with zero markets", () => {
    const m = parseManifest({ ...v2Raw(), markets: [] })
    expect(m.markets).toEqual([])
    expect(errors(m)).toEqual([])
  })

  it("keeps the v2 local example as v2 with testAsset optional", () => {
    const m = parseManifest(localExample)
    expect(m.schemaVersion).toBe(2)
    expect(m.testAsset).toBeUndefined()
    expect(m.shared.factory).toBeDefined()
  })

  it("accepts a testAsset", () => {
    const raw = v2Raw()
    raw.testAsset = {
      code: "USDY",
      issuer: testnetJson.markets[0].underlying.issuer,
      sac: testnetJson.markets[0].contracts.router,
      decimals: 7,
      displayName: "USDY (test)",
    }
    expect(parseManifest(raw).testAsset?.displayName).toBe("USDY (test)")
  })

  it("rejects a non-hex wasm hash", () => {
    const raw = v2Raw()
    raw.wasmHashes = { manager: "zz".repeat(32) }
    expect(() => parseManifest(raw)).toThrow(/wasmHashes\.manager/)
    raw.wasmHashes = { manager: "ab".repeat(31) }
    expect(() => parseManifest(raw)).toThrow(/wasmHashes\.manager/)
    raw.wasmHashes = { manager: "AB".repeat(32) }
    expect(parseManifest(raw).wasmHashes.manager).toBe("AB".repeat(32))
  })

  it("rejects an unknown wasm hash contract name", () => {
    const raw = v2Raw() as unknown as { wasmHashes: Record<string, string> }
    raw.wasmHashes = { nope: "ab".repeat(32) }
    expect(() => parseManifest(raw)).toThrow(/wasmHashes/)
  })

  it("validateManifest flags a market whose router differs from shared, but not one on its own oracle", () => {
    const m = testnet()
    expect(errors(m)).toEqual([])
    const other = testnetJson.shared.riskControl
    const badRouter = { ...m, markets: [{ ...m.markets[0], contracts: { ...m.markets[0].contracts, router: other } }] }
    expect(errors(badRouter).some((f) => f.message.includes("router"))).toBe(true)
    const ownOracle = { ...m, markets: [{ ...m.markets[0], contracts: { ...m.markets[0].contracts, oracle: other } }] }
    expect(errors(ownOracle)).toEqual([])
  })
})

describe("manifest protocolAbi and Mainnet fields", () => {
  const committed = () => structuredClone(committedTestnetJson) as Record<string, unknown>
  const parsed = () => parseManifest(committed())
  const C1 = testnetJson.shared.riskControl
  const C2 = testnetJson.shared.permissioning

  it("protocolAbi defaults to 1 and accepts 1 or 2 only", () => {
    expect(protocolAbi({})).toBe(1)
    expect(protocolAbi({ protocolAbi: 2 })).toBe(2)
    expect(parseManifest({ ...committed(), protocolAbi: 2 }).protocolAbi).toBe(2)
    expect(() => parseManifest({ ...committed(), protocolAbi: 3 })).toThrow(/protocolAbi/)
    expect(() => parseManifest({ ...committed(), protocolAbi: "2" })).toThrow(/protocolAbi/)
  })

  it("accessContact.url accepts https and mailto only", () => {
    const ok = (url: string) => parseManifest({ ...committed(), accessContact: { label: "Help", url } })
    expect(ok("https://example.org/help").accessContact).toEqual({ label: "Help", url: "https://example.org/help" })
    expect(ok("mailto:a@b.org").accessContact?.url).toBe("mailto:a@b.org")
    expect(() => ok("http://example.org")).toThrow(/accessContact/)
    expect(() => ok("javascript:alert(1)")).toThrow(/accessContact/)
  })

  it("tracks is 1 to 12 characters and survives parsing", () => {
    const withTracks = (tracks: string) => {
      const raw = committed() as { markets: { underlying: Record<string, unknown> }[] }
      raw.markets[0].underlying.tracks = tracks
      return parseManifest(raw)
    }
    expect(withTracks("USDY").markets[0].underlying.tracks).toBe("USDY")
    expect(() => withTracks("")).toThrow(/tracks/)
    expect(() => withTracks("X".repeat(13))).toThrow(/tracks/)
  })

  it("createdLedgers keys are contract ids and values positive integers", () => {
    expect(parseManifest({ ...committed(), createdLedgers: { [C1]: 100 } }).createdLedgers).toEqual({ [C1]: 100 })
    expect(() => parseManifest({ ...committed(), createdLedgers: { nope: 100 } })).toThrow(/createdLedgers/)
    expect(() => parseManifest({ ...committed(), createdLedgers: { [C1]: 0 } })).toThrow(/createdLedgers/)
    expect(() => parseManifest({ ...committed(), createdLedgers: { [C1]: 1.5 } })).toThrow(/createdLedgers/)
  })

  it("manifestOracles groups markets by distinct oracle in first-seen order", () => {
    const m = parsed()
    const mk = (id: string, oracle: string) => ({ ...m.markets[0], marketId: id, contracts: { ...m.markets[0].contracts, oracle } })
    const shared = manifestOracles({ markets: [mk("a", C1), mk("b", C1)] })
    expect(shared).toHaveLength(1)
    expect(shared[0].markets.map((x) => x.marketId)).toEqual(["a", "b"])
    const ids = [C2, C1, m.markets[0].contracts.oracle, m.markets[0].contracts.sy, m.markets[0].contracts.pt]
    const five = manifestOracles({ markets: ids.map((o, i) => mk(`m${i}`, o)) })
    expect(five.map((e) => e.oracle)).toEqual(ids)
    expect(five.map((e) => e.markets[0].marketId)).toEqual(["m0", "m1", "m2", "m3", "m4"])
  })

  it("manifestOracles of a manifest without markets is empty", () => {
    expect(manifestOracles({ markets: [] })).toEqual([])
  })

  // The Router hashes are pinned here, not read from the committed testnet.json: a redeploy changes that file.
  const V1_ROUTER = "9cd0403a156b192e09c1c614743e99c0b167e9a3c65c7e5553596639e772fd39"
  const V2_ROUTER = "2a0997317651edb0f7e2bd753570b03a88462aa6d216c14b06ebec246bb3c1c2"
  const withRouter = (router: string | undefined): Manifest => {
    const m = parsed()
    const wasmHashes = { ...m.wasmHashes }
    if (router === undefined) delete wasmHashes.router
    else wasmHashes.router = router
    return { ...m, wasmHashes }
  }

  it("ROUTER_ABI_BY_WASM pins the two known Router hashes", () => {
    expect(ROUTER_ABI_BY_WASM[V1_ROUTER]).toBe(1)
    expect(ROUTER_ABI_BY_WASM[V2_ROUTER]).toBe(2)
  })

  it("validateManifest cross-checks protocolAbi against the Router code hash", () => {
    const v1 = withRouter(V1_ROUTER)
    expect(errors(v1)).toEqual([])
    expect(errors({ ...v1, protocolAbi: 1 })).toEqual([])
    expect(errors({ ...v1, protocolAbi: 2 }).map((f) => f.message)).toEqual(["protocolAbi is 2 but the Router code is the version-1 one."])
    const v2 = withRouter(V2_ROUTER)
    expect(errors(v2).map((f) => f.message)).toEqual(["protocolAbi is 1 but the Router code is the version-2 one."])
    expect(errors({ ...v2, protocolAbi: 2 })).toEqual([])
    const unknown = withRouter("ab".repeat(32))
    expect(errors(unknown)).toEqual([])
    expect(errors({ ...unknown, protocolAbi: 2 })).toEqual([])
  })

  it("a manifest that pins no Router hash gives no cross-check finding", () => {
    const none = withRouter(undefined)
    expect(none.wasmHashes.router).toBeUndefined()
    expect(errors(none)).toEqual([])
    expect(errors({ ...none, protocolAbi: 2 })).toEqual([])
  })

  it("an upper-case Router hash is still matched", () => {
    const upper = withRouter(V2_ROUTER.toUpperCase())
    expect(errors(upper).map((f) => f.message)).toEqual(["protocolAbi is 1 but the Router code is the version-2 one."])
    expect(errors({ ...upper, protocolAbi: 2 })).toEqual([])
  })

  it("a Router hash named like a prototype member finds no version", () => {
    for (const key of ["constructor", "__proto__"]) {
      const messages = validateManifest({ ...withRouter(key), protocolAbi: 2 }).map((f) => f.message)
      // The schema refuses the hash; the cross-check says nothing about it.
      expect(messages.some((msg) => msg.startsWith("wasmHashes.router"))).toBe(true)
      expect(messages.filter((msg) => msg.startsWith("protocolAbi"))).toEqual([])
    }
  })
})

describe("manifest monitoring fields", () => {
  const base = () => structuredClone(committedTestnetJson) as Record<string, unknown>
  const HASH = "8f157e8d" + "0".repeat(56)

  it("accepts deployLedger, oracleSources and rpcFallbackUrls", () => {
    const m = parseManifest({
      ...base(),
      deployLedger: 5707342,
      oracleSources: [{ hash: HASH, preimage: "principal-oracle-source:testnet:USDY:app-team:keeper" }],
      rpcFallbackUrls: ["https://rpc.example.org"],
    })
    expect(m.deployLedger).toBe(5707342)
    expect(m.oracleSources?.[0].hash).toBe(HASH)
    expect(m.rpcFallbackUrls).toEqual(["https://rpc.example.org"])
    expect(errors(m)).toEqual([])
  })

  it("refuses an oracle source hash that is not 64 hex characters", () => {
    for (const hash of ["8f157e8d", HASH + "0", "z".repeat(64)]) {
      expect(() => parseManifest({ ...base(), oracleSources: [{ hash, preimage: "x" }] })).toThrow(/oracleSources/)
    }
  })

  it("refuses a non-https fallback RPC off local and allows it on local", () => {
    const bad = parseManifest({ ...base(), rpcFallbackUrls: ["http://rpc.example.org"] })
    expect(errors(bad).some((f) => f.message.includes("rpcFallbackUrls"))).toBe(true)
    const local = parseManifest({ ...structuredClone(localExample), rpcFallbackUrls: ["http://localhost:8001"] })
    expect(errors(local)).toEqual([])
  })

  it("refuses a non-positive deployLedger", () => {
    expect(() => parseManifest({ ...base(), deployLedger: 0 })).toThrow(/deployLedger/)
  })

  it("pins testnet.json: every oracle source hash is sha256 of its preimage", () => {
    const m = parseManifest(committedTestnetJson)
    expect(m.deployLedger).toBeGreaterThan(0)
    expect(m.oracleSources?.length).toBeGreaterThan(0)
    for (const s of m.oracleSources ?? []) {
      expect(createHash("sha256").update(s.preimage).digest("hex")).toBe(s.hash)
    }
  })
})

describe("deployLedger off local (Task 2, carried to Task 11)", () => {
  const base = () => structuredClone(committedTestnetJson) as Record<string, unknown>

  it("refuses a testnet or mainnet manifest without deployLedger", () => {
    const testnetFile = base()
    delete testnetFile.deployLedger
    expect(() => parseManifest(testnetFile)).toThrow(/deployLedger: Required on testnet/)
    const mainnetFile: Record<string, unknown> = { ...base(), network: "mainnet", networkPassphrase: "Public Global Stellar Network ; September 2015" }
    delete mainnetFile.deployLedger
    expect(() => parseManifest(mainnetFile)).toThrow(/deployLedger: Required on mainnet/)
  })

  it("leaves it optional on local", () => {
    expect(parseManifest(localExample).deployLedger).toBeUndefined()
  })

  it("the committed testnet.json carries it", () => {
    expect(parseManifest(committedTestnetJson).deployLedger).toBe(5707342)
  })
})
