// @vitest-environment node
import { describe, expect, it } from "vitest"
import { explorerUrl } from "../explorer"

describe("explorerUrl", () => {
  it("links testnet, mainnet and every kind, and has none for a local network", () => {
    expect(explorerUrl("testnet", "tx", "abc")).toBe("https://stellar.expert/explorer/testnet/tx/abc")
    expect(explorerUrl("testnet", "contract", "CABC")).toBe("https://stellar.expert/explorer/testnet/contract/CABC")
    expect(explorerUrl("testnet", "account", "GABC")).toBe("https://stellar.expert/explorer/testnet/account/GABC")
    expect(explorerUrl("mainnet", "tx", "abc")).toBe("https://stellar.expert/explorer/public/tx/abc")
    expect(explorerUrl("mainnet", "contract", "CABC")).toBe("https://stellar.expert/explorer/public/contract/CABC")
    expect(explorerUrl("mainnet", "account", "GABC")).toBe("https://stellar.expert/explorer/public/account/GABC")
    expect(explorerUrl("local", "tx", "abc")).toBeNull()
  })
})
