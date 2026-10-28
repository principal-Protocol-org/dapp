// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import localJson from "@/config/manifests/local.json"
import testnetJson from "@/config/manifests/testnet.json"
import { activeManifest } from "../manifest-source"

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
    vi.stubEnv("NEXT_PUBLIC_PRINCIPAL_NETWORK", "mainnet")
    expect(() => activeManifest()).toThrow('NEXT_PUBLIC_PRINCIPAL_NETWORK must be "testnet" or "local", got "mainnet".')
    expect(() => activeManifest()).toThrow("must be")
  })
})
