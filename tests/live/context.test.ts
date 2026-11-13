import { Keypair } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import { FAUCET_PACE_MS, FAUCET_TIMEOUT_MS, faucetStepsDone, fundOnce, liveContext, requestFaucetWithRetry, TESTNET_ORIGIN } from "./context"
import type { FaucetResponse } from "@/lib/protocol/onboarding"

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

  describe("endpoint robustness (Task 1 review)", () => {
    const failed = { error: "failed", message: "The faucet could not finish — try again in a minute. Steps already done are kept." }

    it("retries a transient failed answer (HTTP 502) once, a faucet minute later, then takes the answer", async () => {
      const answers = [res(502, failed), res(200, { performed: ["pay"] })]
      const fetchImpl = vi.fn(async () => answers.shift()!)
      const sleep = vi.fn(async () => {})
      const out = await requestFaucetWithRetry({ origin: "https://x.test", account, fetchImpl, sleep })
      expect(out).toEqual({ performed: ["pay"] })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      // A run that failed after a transaction keeps its address slot for the minute: wait it out.
      expect(sleep).toHaveBeenCalledWith(FAUCET_PACE_MS)
    })

    it("retries a network error once (the faucet could not be reached)", async () => {
      let calls = 0
      const fetchImpl = vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new TypeError("fetch failed")
        return res(200, { performed: [] })
      })
      const out = await requestFaucetWithRetry({ origin: "https://x.test", account, fetchImpl, sleep: async () => {} })
      expect(out).toEqual({ performed: [] })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it("retries a transient failure only once: the second one is final", async () => {
      const fetchImpl = vi.fn(async () => res(502, failed))
      const out = await requestFaucetWithRetry({ origin: "https://x.test", account, fetchImpl, sleep: async () => {} })
      expect(out).toMatchObject({ error: "failed" })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it("does not retry a failed answer that is not transient (HTTP 500 without a readable result)", async () => {
      const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 500 }))
      const out = await requestFaucetWithRetry({ origin: "https://x.test", account, fetchImpl, sleep: async () => {} })
      expect(out).toMatchObject({ error: "failed" })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it("clamps the server's retryAfterSeconds at 120 s", async () => {
      const answers = [res(503, { error: "busy", retryAfterSeconds: 3_600 }), res(200, { performed: [] })]
      const sleep = vi.fn(async () => {})
      await requestFaucetWithRetry({ origin: "https://x.test", account, fetchImpl: async () => answers.shift()!, sleep })
      expect(sleep).toHaveBeenCalledWith(120_000 + 1_000)
    })

    it("gives every request a timeout just past the route's maxDuration, and treats an abort as a network error", async () => {
      expect(FAUCET_TIMEOUT_MS).toBeGreaterThan(120_000)
      const signals: AbortSignal[] = []
      let calls = 0
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal
        if (!signal) throw new Error("no signal")
        signals.push(signal)
        calls += 1
        if (calls > 1) return Promise.resolve(res(200, { performed: ["pay"] }))
        // The first request hangs until its signal fires.
        return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
      })
      const out = await requestFaucetWithRetry({ origin: "https://x.test", account, fetchImpl: fetchImpl as never, sleep: async () => {}, timeoutMs: 20 })
      expect(signals[0].aborted).toBe(true)
      expect(out).toEqual({ performed: ["pay"] })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it("records every step a partial run and its retry did: 502 after authorize and grant_account, then the rest", async () => {
      // The faucet stopped at grant_pt (its 502 names the step); the retry re-plans only what is missing.
      const answers = [
        res(502, { ...failed, step: "grant_pt" }),
        res(200, { performed: ["grant_pt", "grant_yt", "pay"] }),
      ]
      const seen: FaucetResponse[] = []
      const out = await requestFaucetWithRetry({
        origin: "https://x.test",
        account,
        fetchImpl: async () => answers.shift()!,
        sleep: async () => {},
        onAnswer: (a) => seen.push(a),
      })
      expect(out).toEqual({ performed: ["grant_pt", "grant_yt", "pay"] })
      expect(seen).toEqual([{ ...failed, step: "grant_pt" }, { performed: ["grant_pt", "grant_yt", "pay"] }])
      expect(faucetStepsDone(seen)).toEqual(["authorize", "grant_account", "grant_pt", "grant_yt", "pay"])
    })

    it("paces requests that share a pacer a faucet minute apart (one request per IP per minute)", async () => {
      let t = 1_000_000
      const now = () => t
      const sleep = vi.fn(async (ms: number) => {
        t += ms
      })
      const pacer: { lastAt?: number } = {}
      const fetchImpl = async () => res(200, { performed: [] })
      await requestFaucetWithRetry({ origin: "https://x.test", account, fetchImpl, sleep, now, pacer })
      expect(sleep).not.toHaveBeenCalled()
      t += 10_000
      await requestFaucetWithRetry({ origin: "https://x.test", account: Keypair.random().publicKey(), fetchImpl, sleep, now, pacer })
      expect(sleep).toHaveBeenCalledWith(FAUCET_PACE_MS - 10_000)
      expect(pacer.lastAt).toBe(t)
    })
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

describe("fundOnce (Friendbot, retried once)", () => {
  const manifest = { friendbotUrl: "https://friendbot.test" }
  const answer = (status: number) => new Response("{}", { status })

  it("asks Friendbot again once after a server error, when the account still does not exist", async () => {
    const answers = [answer(502), answer(200)]
    const fetchImpl = vi.fn(async () => answers.shift()!)
    await fundOnce({ manifest, account, exists: async () => false, fetchImpl, wait: async () => {} })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("takes an account that exists after a Friendbot error as funded", async () => {
    const fetchImpl = vi.fn(async () => answer(504))
    await fundOnce({ manifest, account, exists: async () => true, fetchImpl, wait: async () => {} })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("does not ask again after a refusal (4xx), nor a third time", async () => {
    const refused = vi.fn(async () => answer(400))
    await expect(fundOnce({ manifest, account, exists: async () => false, fetchImpl: refused, wait: async () => {} })).rejects.toThrow(/400/)
    expect(refused).toHaveBeenCalledTimes(1)
    const failing = vi.fn(async () => answer(503))
    await expect(fundOnce({ manifest, account, exists: async () => false, fetchImpl: failing, wait: async () => {} })).rejects.toThrow(/503/)
    expect(failing).toHaveBeenCalledTimes(2)
  })
})

describe("faucetStepsDone", () => {
  it("merges the steps every answer reports, once each, in the faucet's order", () => {
    expect(faucetStepsDone([{ performed: ["authorize", "pay"] }, { performed: ["authorize", "grant_account"] }])).toEqual(["authorize", "grant_account", "pay"])
  })

  it("counts the steps before the one a failed run stopped at as done, and not that step", () => {
    expect(faucetStepsDone([{ error: "failed", step: "grant_yt" }])).toEqual(["authorize", "grant_account", "grant_pt"])
  })

  it("infers nothing from an answer that names no step: the account's end state is the proof", () => {
    expect(faucetStepsDone([{ error: "failed", message: "The faucet could not be reached." }, { performed: [] }])).toEqual([])
    expect(faucetStepsDone([{ error: "busy", retryAfterSeconds: 60 }])).toEqual([])
  })
})
