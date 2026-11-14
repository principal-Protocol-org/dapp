// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import localJson from "@/config/manifests/local.json"
import testnetJson from "@/config/manifests/testnet.json"
import { MainnetPendingError } from "../manifest"
import { activeManifest, activeNetwork, manifestPending } from "../manifest-source"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("activeManifest (M8)", () => {
  it("parses the active manifest once: every call returns the same object", () => {
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "testnet")
    const first = activeManifest()
    expect(first.network).toBe(testnetJson.network)
    expect(activeManifest()).toBe(first)
  })

  it("is keyed by the network, and defaults to testnet", () => {
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "local")
    const local = activeManifest()
    expect(local.network).toBe(localJson.network)
    expect(activeManifest()).toBe(local)
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", undefined)
    expect(activeManifest().network).toBe("testnet")
  })

  it("refuses an unknown network every time, never caching the failure", () => {
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "futurenet")
    expect(() => activeManifest()).toThrow('NEXT_PUBLIC_PRINCIPAL_NETWORK must be "testnet", "local" or "mainnet", got "futurenet".')
    expect(() => activeManifest()).toThrow("must be")
    expect(() => activeNetwork()).toThrow("must be")
  })
})

describe("the Mainnet branch (D-24)", () => {
  it("throws MainnetPendingError for the committed stub, every time", () => {
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "mainnet")
    expect(() => activeManifest()).toThrow(MainnetPendingError)
    expect(() => activeManifest()).toThrow("Mainnet contracts are not deployed yet.")
    expect(manifestPending()).toBe(true)
  })

  it("names the network without parsing its manifest, for the static shell", () => {
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "mainnet")
    expect(activeNetwork()).toBe("mainnet")
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "local")
    expect(activeNetwork()).toBe("local")
    expect(manifestPending()).toBe(false)
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", undefined)
    expect(activeNetwork()).toBe("testnet")
    expect(manifestPending()).toBe(false)
  })
})

describe("the file matches the network asked for (fix round 1)", () => {
  afterEach(() => {
    vi.doUnmock("@/config/manifests/mainnet.json")
    vi.resetModules()
  })

  it("refuses a manifest whose network is not NEXT_PUBLIC_PRINCIPAL_NETWORK: never testnet data under mainnet", async () => {
    vi.resetModules()
    vi.doMock("@/config/manifests/mainnet.json", () => ({ default: structuredClone(testnetJson) }))
    const source = await import("../manifest-source")
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "mainnet")
    expect(() => source.activeManifest()).toThrow('config/manifests/mainnet.json is for "testnet", not "mainnet"')
    // Every time: the refusal is never cached as a manifest.
    expect(() => source.activeManifest()).toThrow("is for")
    expect(() => source.manifestPending()).toThrow("is for")
  })
})
