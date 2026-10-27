// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import localExample from "@/config/manifests/local.example.json"
import { getMarket, parseManifest, validateManifest } from "../manifest"
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
    Reflect.set(raw, "schemaVersion", 2)
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

  it("requires at least one market", () => {
    const raw = { ...structuredClone(testnetJson), markets: [] }
    expect(() => parseManifest(raw)).toThrow(/markets/)
    expect(errors({ ...testnet(), markets: [] }).length).toBeGreaterThan(0)
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
