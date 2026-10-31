// @vitest-environment node
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import type { AccountState } from "../account-state"
import { bytesToHex } from "../bytes"
import { parseManifest } from "../manifest"
import type { ContractReader } from "../reader"
import {
  addTrustline,
  buildChangeTrustXdr,
  fetchMarketPermissions,
  fundWithFriendbot,
  onboardingAvailable,
  onboardingSteps,
  requestTestTokens,
  sharedTestAsset,
  testAsset,
  testAssetOf,
  TEST_TOKEN_AMOUNT,
  TEST_TOKEN_TOP_UP_BELOW,
} from "../onboarding"
import type { Live, Manifest } from "../types"

const manifest = parseManifest(testnetJson)
const asset = manifest.markets[0].underlying
const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 7 })
const down: Live<never> = { status: "unavailable", error: "rpc down" }
const TOKENS = 10n ** 7n

function account(over: Partial<AccountState> = {}): AccountState {
  return {
    underlying: live(0n),
    sy: live(0n),
    pt: live(0n),
    yt: live(0n),
    lp: live(0n),
    ytLastClaimedIndex: live(0n),
    ytPendingClaim: live(0n),
    depositCap: live(0n),
    netDeposited: live(0n),
    sacAuthorized: live(false),
    sep57: null,
    permAllowed: live(false),
    permPt: live(false),
    permYt: live(false),
    trustline: live("none"),
    accountExists: live(false),
    ...over,
  }
}

const ready = account({
  accountExists: live(true),
  trustline: live("authorized"),
  sacAuthorized: live(true),
  permAllowed: live(true),
  permPt: live(true),
  permYt: live(true),
  underlying: live(TEST_TOKEN_TOP_UP_BELOW * TOKENS),
})

const done = (acc: AccountState) => Object.fromEntries(onboardingSteps(acc).map((s) => [s.id, s.done]))

describe("onboarding steps", () => {
  it("lists fund, trustline and grant in order, none done for a fresh wallet", () => {
    expect(onboardingSteps(account())).toEqual([
      { id: "fund", done: false },
      { id: "trustline", done: false },
      { id: "grant", done: false },
    ])
  })

  it("skips completed steps", () => {
    expect(done(account({ accountExists: live(true) }))).toEqual({ fund: true, trustline: false, grant: false })
    expect(done(account({ accountExists: live(true), trustline: live("unauthorized") }))).toEqual({
      fund: true,
      trustline: true,
      grant: false,
    })
    expect(done(ready)).toEqual({ fund: true, trustline: true, grant: true })
  })

  it("keeps the grant step open while any grant is missing or the balance is below the top-up threshold", () => {
    expect(done({ ...ready, permYt: live(false) }).grant).toBe(false)
    expect(done({ ...ready, permAllowed: live(false) }).grant).toBe(false)
    expect(done({ ...ready, sacAuthorized: live(false), trustline: live("unauthorized") }).grant).toBe(false)
    expect(done({ ...ready, underlying: live(TEST_TOKEN_TOP_UP_BELOW * TOKENS - 1n) }).grant).toBe(false)
  })

  it("treats an unavailable read as not done, never as done", () => {
    expect(done({ ...ready, accountExists: down }).fund).toBe(false)
    expect(done({ ...ready, trustline: down }).trustline).toBe(false)
    expect(done({ ...ready, permPt: down }).grant).toBe(false)
    expect(done({ ...ready, underlying: down }).grant).toBe(false)
  })

  it("converts the top-up threshold with the asset's decimals", () => {
    const six = { ...ready, underlying: live(TEST_TOKEN_TOP_UP_BELOW * 10n ** 6n) }
    expect(done(six).grant).toBe(false)
    expect(onboardingSteps(six, { decimals: 6 }).find((s) => s.id === "grant")?.done).toBe(true)
  })

  it("judges the grant step from every market's PT and YT permissions, not only the opened one (R44)", () => {
    const granted = { permPt: live(true), permYt: live(true) }
    expect(done(ready).grant).toBe(true)
    const all = (markets: { permPt: Live<boolean>; permYt: Live<boolean> }[]) =>
      onboardingSteps(ready, { markets }).find((s) => s.id === "grant")?.done
    expect(all([granted, granted])).toBe(true)
    expect(all([granted, { permPt: live(true), permYt: live(false) }])).toBe(false)
    expect(all([granted, { permPt: live(false), permYt: live(true) }])).toBe(false)
    expect(all([granted, { permPt: down, permYt: live(true) }])).toBe(false)
  })

  it("uses the faucet constants of spec 0002: 100 000 units, topped up below 10 000", () => {
    expect(TEST_TOKEN_AMOUNT).toBe(100_000n)
    expect(TEST_TOKEN_TOP_UP_BELOW).toBe(10_000n)
  })
})

describe("onboarding availability", () => {
  it("is offered on testnet and local only", () => {
    expect(onboardingAvailable({ network: "testnet" })).toBe(true)
    expect(onboardingAvailable({ network: "local" })).toBe(true)
    expect(onboardingAvailable({ network: "mainnet" })).toBe(false)
  })

  it("names the first market's underlying as the test asset", () => {
    expect(testAsset(manifest)).toEqual(asset)
  })

  it("requires every market to share one underlying: code, issuer and SAC (R44)", () => {
    const second = { ...manifest.markets[0], marketId: "second" }
    expect(sharedTestAsset({ markets: [manifest.markets[0], second] })).toEqual(asset)
    for (const other of [
      { ...asset, code: "STB" },
      { ...asset, issuer: Keypair.random().publicKey() },
      { ...asset, sac: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ]) {
      expect(sharedTestAsset({ markets: [manifest.markets[0], { ...second, underlying: other }] })).toBeNull()
    }
  })

  it("testAssetOf names the manifest's testAsset first, else the one underlying every market shares (R2-14)", () => {
    const declared = { code: "USDY", issuer: Keypair.random().publicKey(), sac: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", decimals: 7 }
    expect(testAssetOf({ ...manifest, testAsset: { ...declared, displayName: "USDY (test)" } })).toEqual(declared)
    expect(testAssetOf({ ...manifest, testAsset: undefined })).toEqual(asset)
    const mixed = [manifest.markets[0], { ...manifest.markets[0], marketId: "b", underlying: { ...asset, code: "STB" } }]
    expect(testAssetOf({ ...manifest, testAsset: undefined, markets: mixed })).toBeNull()
  })
})

describe("buildChangeTrustXdr", () => {
  it("builds one changeTrust to the asset, from the account, at the next sequence, on the manifest network", () => {
    const user = Keypair.random().publicKey()
    const xdr = buildChangeTrustXdr({ account: user, asset, manifest, sequence: "41" })
    const tx = new Transaction(xdr, manifest.networkPassphrase)
    expect(tx.source).toBe(user)
    expect(tx.sequence).toBe("42")
    expect(tx.operations).toHaveLength(1)
    const [op] = tx.operations
    expect(op.type).toBe("changeTrust")
    if (op.type !== "changeTrust") throw new Error("unreachable")
    expect(op.line).toMatchObject({ code: asset.code, issuer: asset.issuer })
    expect(tx.timeBounds?.maxTime).not.toBe("0")
  })
})

describe("addTrustline", () => {
  function fakeServer() {
    return {
      getAccount: vi.fn<(address: string) => Promise<{ sequenceNumber(): string }>>(async () => ({ sequenceNumber: () => "100" })),
      sendTransaction: vi.fn<(tx: Transaction) => Promise<{ status: string; hash: string }>>(async () => ({ status: "PENDING", hash: "abc" })),
      getTransaction: vi.fn<(hash: string) => Promise<{ status: string }>>(async () => ({ status: "SUCCESS" })),
    }
  }
  const keySigner = (kp: Keypair) => async (unsignedXdr: string) => {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, manifest.networkPassphrase) as Transaction
    tx.sign(kp)
    return tx.toXDR()
  }

  it("has the wallet sign the changeTrust for the account, checks the signature, submits and waits for success", async () => {
    const kp = Keypair.random()
    const server = fakeServer()
    const sign = vi.fn(keySigner(kp))
    const result = await addTrustline({ manifest, account: kp.publicKey(), asset, sign, server, wait: async () => {} })
    expect(server.getAccount).toHaveBeenCalledWith(kp.publicKey())
    expect(sign).toHaveBeenCalledTimes(1)
    const sent = server.sendTransaction.mock.calls[0][0]
    expect(sent.source).toBe(kp.publicKey())
    expect(sent.operations[0].type).toBe("changeTrust")
    expect(sent.signatures).toHaveLength(1)
    // The hash is the envelope's own, computed locally.
    expect(result.hash).toBe(bytesToHex(sent.hash()))
    expect(server.getTransaction).toHaveBeenCalledWith(result.hash)
  })

  it("refuses to submit a transaction signed by another key", async () => {
    const kp = Keypair.random()
    const server = fakeServer()
    await expect(
      addTrustline({ manifest, account: kp.publicKey(), asset, sign: keySigner(Keypair.random()), server, wait: async () => {} }),
    ).rejects.toThrow(/not signed by the connected wallet/)
    expect(server.sendTransaction).not.toHaveBeenCalled()
  })

  it("fails with the cause when the network does not confirm it", async () => {
    const kp = Keypair.random()
    const server = fakeServer()
    server.getTransaction.mockResolvedValue({ status: "FAILED" })
    await expect(
      addTrustline({ manifest, account: kp.publicKey(), asset, sign: keySigner(kp), server, wait: async () => {} }),
    ).rejects.toThrow(/trustline transaction failed/i)
  })

  it("waits for a just-funded account to appear before building", async () => {
    const kp = Keypair.random()
    const server = fakeServer()
    server.getAccount
      .mockRejectedValueOnce(new Error("Account not found"))
      .mockResolvedValueOnce({ sequenceNumber: () => "5" })
    await addTrustline({ manifest, account: kp.publicKey(), asset, sign: keySigner(kp), server, wait: async () => {} })
    expect(server.getAccount).toHaveBeenCalledTimes(2)
    expect(server.sendTransaction.mock.calls[0][0].sequence).toBe("6")
  })
})

describe("fundWithFriendbot", () => {
  it("asks the manifest's Friendbot to fund the account", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }))
    const user = Keypair.random().publicKey()
    await fundWithFriendbot({ manifest, account: user, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(`https://friendbot.stellar.org/?addr=${user}`)
  })

  it("names the cause when Friendbot refuses, and refuses without a Friendbot", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }))
    const user = Keypair.random().publicKey()
    await expect(fundWithFriendbot({ manifest, account: user, fetchImpl })).rejects.toThrow(/Friendbot.*400/)
    const noBot: Manifest = { ...manifest, friendbotUrl: undefined }
    await expect(fundWithFriendbot({ manifest: noBot, account: user, fetchImpl })).rejects.toThrow(/no Friendbot/)
  })
})

describe("fetchMarketPermissions", () => {
  it("reads is_allowed_for_asset for the PT and the YT of every market, keeping failures unavailable", async () => {
    const second = { ...manifest.markets[0], marketId: "second", contracts: { ...manifest.markets[0].contracts, pt: "CPT2", yt: "CYT2" } }
    const two: Manifest = { ...manifest, markets: [manifest.markets[0], second] }
    const user = Keypair.random().publicKey()
    const reader = vi.fn(async (call: { contractId: string; functionName: string; args?: { value: unknown }[] }) => {
      const asset = call.args?.[1]?.value
      if (asset === "CYT2") throw new Error("rpc down")
      return { value: asset !== "CPT2", latestLedger: 5, minResourceFee: "0" }
    }) as unknown as ContractReader
    const perms = await fetchMarketPermissions(reader, two, user)
    expect(perms.map((p) => p.marketId)).toEqual([manifest.markets[0].marketId, "second"])
    expect(perms[0]).toMatchObject({ permPt: { status: "live", value: true }, permYt: { status: "live", value: true } })
    expect(perms[1]).toMatchObject({ permPt: { status: "live", value: false }, permYt: { status: "unavailable" } })
    expect(reader).toHaveBeenCalledWith({
      contractId: manifest.shared.permissioning,
      functionName: "is_allowed_for_asset",
      args: [{ type: "address", value: user }, { type: "address", value: "CPT2" }],
    })
  })
})

describe("requestTestTokens", () => {
  it("posts the account as JSON to /api/faucet and returns the steps performed", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ performed: ["authorize", "pay"] }))
    const user = Keypair.random().publicKey()
    await expect(requestTestTokens({ account: user, fetchImpl })).resolves.toEqual({ performed: ["authorize", "pay"] })
    expect(fetchImpl).toHaveBeenCalledWith("/api/faucet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: user }),
    })
  })

  it("keeps the step and the retry delay of a refusal", async () => {
    const user = Keypair.random().publicKey()
    const failed = vi.fn(async () => Response.json({ error: "failed", step: "grant_pt" }, { status: 502 }))
    await expect(requestTestTokens({ account: user, fetchImpl: failed })).resolves.toEqual({ error: "failed", step: "grant_pt" })
    const busy = vi.fn(async () => Response.json({ error: "busy", retryAfterSeconds: 60 }, { status: 503 }))
    await expect(requestTestTokens({ account: user, fetchImpl: busy })).resolves.toEqual({ error: "busy", retryAfterSeconds: 60 })
  })

  it("returns the typed refusal, and `failed` for an unreadable answer", async () => {
    const user = Keypair.random().publicKey()
    const refused = vi.fn(async () => Response.json({ error: "rate_limited", message: "x" }, { status: 429 }))
    await expect(requestTestTokens({ account: user, fetchImpl: refused })).resolves.toMatchObject({ error: "rate_limited" })
    const html = vi.fn(async () => new Response("<html>", { status: 504 }))
    await expect(requestTestTokens({ account: user, fetchImpl: html })).resolves.toMatchObject({ error: "failed" })
    const unknown = vi.fn(async () => Response.json({ error: "something_else" }, { status: 500 }))
    await expect(requestTestTokens({ account: user, fetchImpl: unknown })).resolves.toMatchObject({ error: "failed" })
  })
})
