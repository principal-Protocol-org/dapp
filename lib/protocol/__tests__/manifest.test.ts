// @vitest-environment node
import { describe, expect, it } from "vitest"
// The interim 3 Oct 2026 Testnet file (v1), frozen as a fixture: the committed testnet.json changes with each deployment.
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import committedTestnetJson from "@/config/manifests/testnet.json"
import localExample from "@/config/manifests/local.example.json"
import { getMarket, parseManifest, validateManifest } from "../manifest"
import type { Manifest } from "../types"

const testnet = (): Manifest => parseManifest(structuredClone(testnetJson))
type Raw = typeof testnetJson
const errors = (m: Manifest) => validateManifest(m).filter((f) => f.severity === "error")

describe("manifest v1", () => {
  it("accepts the committed testnet manifest, whatever deployment it holds", () => {
    const m = parseManifest(committedTestnetJson)
    expect(m.network).toBe("testnet")
    expect(errors(m)).toEqual([])
  })

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

  it("validateManifest flags a market whose router or oracle differs from shared", () => {
    const m = testnet()
    expect(errors(m)).toEqual([])
    const other = testnetJson.shared.riskControl
    const badRouter = { ...m, markets: [{ ...m.markets[0], contracts: { ...m.markets[0].contracts, router: other } }] }
    expect(errors(badRouter).some((f) => f.message.includes("router"))).toBe(true)
    const badOracle = { ...m, markets: [{ ...m.markets[0], contracts: { ...m.markets[0].contracts, oracle: other } }] }
    expect(errors(badOracle).some((f) => f.message.includes("oracle"))).toBe(true)
  })
})
