import { Keypair } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import { liveContext, requestFaucetWithRetry, TESTNET_ORIGIN } from "./context"

const secret = Keypair.random().secret()
const account = Keypair.random().publicKey()

describe("liveContext resolution", () => {
  it("resolves the official testnet manifest in endpoint mode by default, with no secret", () => {
    const ctx = liveContext({ network: "testnet" })
    expect(ctx.network).toBe("testnet")
    expect(ctx.faucet).toEqual({ mode: "endpoint", origin: TESTNET_ORIGIN })
    expect(ctx.manifest.network).toBe("testnet")
    expect(ctx.rpcUrl).toBe(ctx.manifest.rpcUrl)
    expect(ctx.friendbotUrl).toMatch(/^https:\/\//)
  })

  it("takes a custom origin without a trailing slash", () => {
    const ctx = liveContext({
      network: "testnet",
      faucet: { mode: "endpoint", origin: "https://example.test/" },
    })
    expect(ctx.faucet).toEqual({
      mode: "endpoint",
      origin: "https://example.test",
    })
  })

  it("resolves keys mode on testnet when the caller supplies the issuer key", () => {
    const ctx = liveContext({
      network: "testnet",
      faucet: { mode: "keys", issuerSecret: secret },
    })
    expect(ctx.faucet.mode).toBe("keys")
  })

  it("refuses keys mode without a key, or with something that is not a secret key", () => {
    expect(() => liveContext({ network: "testnet", faucet: { mode: "keys" } })).toThrow(/issuer secret/)
    expect(() =>
      liveContext({
        network: "testnet",
        faucet: { mode: "keys", issuerSecret: "nope" },
      }),
    ).toThrow(/not a Stellar secret key/)
    expect(() =>
      liveContext({
        network: "testnet",
        faucet: {
          mode: "keys",
          issuerSecret: secret,
          permissioningAdminSecret: "x",
        },
      }),
    ).toThrow(/not a Stellar secret key/)
  })

  it("refuses endpoint mode on local", () => {
    expect(() => liveContext({ network: "local", faucet: { mode: "endpoint" } })).toThrow(/endpoint.*local/)
  })

  it("resolves local to keys mode by default, reading the dev stack key only when onboarding", () => {
    const ctx = liveContext({ network: "local" })
    expect(ctx.faucet).toEqual({ mode: "keys" })
    expect(ctx.manifest.network).toBe("local")
  })

  it("refuses a manifest of another network", () => {
    expect(() =>
      liveContext({
        network: "local",
        manifestPath: "config/manifests/testnet.json",
      }),
    ).toThrow(/is for "testnet", not "local"/)
  })

  it("redacts secret keys from anything it prints", () => {
    expect(liveContext({ network: "testnet" }).redact(`key ${secret} end`)).not.toContain(secret)
  })
})

describe("requestFaucetWithRetry", () => {
  const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const busy = { error: "busy", retryAfterSeconds: 60 }

  it("posts the account to <origin>/api/faucet and parses success", async () => {
    const fetchImpl = vi.fn(async () => res(200, { performed: ["authorize", "pay"] }))
    const out = await requestFaucetWithRetry({
      origin: "https://x.test",
      account,
      fetchImpl,
      sleep: async () => {},
    })
    expect(out).toEqual({ performed: ["authorize", "pay"] })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://x.test/api/faucet")
    expect(JSON.parse(String(init.body))).toEqual({ account })
  })

  it("waits out busy and rate_limited, then succeeds", async () => {
    const answers = [res(503, busy), res(429, { error: "rate_limited", retryAfterSeconds: 60 }), res(200, { performed: [] })]
    const sleep = vi.fn(async () => {})
    const out = await requestFaucetWithRetry({
      origin: "https://x.test",
      account,
      fetchImpl: async () => answers.shift()!,
      sleep,
    })
    expect(out).toEqual({ performed: [] })
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(60_000 + 1_000)
  })

  it("gives up after the bounded attempts and returns the last refusal", async () => {
    const fetchImpl = vi.fn(async () => res(503, busy))
    const out = await requestFaucetWithRetry({
      origin: "https://x.test",
      account,
      fetchImpl,
      sleep: async () => {},
      attempts: 3,
    })
    expect(out).toMatchObject({ error: "busy" })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("does not retry other refusals", async () => {
    const fetchImpl = vi.fn(async () => res(409, { error: "no_trustline" }))
    const out = await requestFaucetWithRetry({
      origin: "https://x.test",
      account,
      fetchImpl,
      sleep: async () => {},
    })
    expect(out).toMatchObject({ error: "no_trustline" })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
