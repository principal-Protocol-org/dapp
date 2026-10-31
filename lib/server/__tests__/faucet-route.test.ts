// @vitest-environment node
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "@/lib/protocol/manifest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({ runFaucet: vi.fn(), registry: [] as Record<string, unknown>[], dbReads: 0 }))
vi.mock("@/lib/server/db", () => ({
  sql: async () => {
    mocks.dbReads++
    return mocks.registry
  },
  DatabaseConfigError: class DatabaseConfigError extends Error {},
}))
vi.mock("@/lib/server/faucet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/faucet")>()),
  runFaucet: mocks.runFaucet,
}))
vi.mock("@/lib/protocol/manifest-source", async () => {
  const { parseManifest: parse } = await import("@/lib/protocol/manifest")
  const json = (await import("@/config/manifests/testnet.json")).default
  const m = parse(json)
  return { activeManifest: () => m }
})

import * as route from "@/app/api/faucet/route"
import { FaucetConfigError, FaucetStepError, FaucetTxError } from "@/lib/server/faucet"

const manifest = parseManifest(testnetJson)
const ACCOUNT = Keypair.random().publicKey()

const JSON_TYPE = { "content-type": "application/json" }
function post(body: string, headers: Record<string, string> = {}, base: Record<string, string> = JSON_TYPE) {
  return route.POST(new Request("http://localhost/api/faucet", { method: "POST", body, headers: { ...base, ...headers } }))
}

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  mocks.runFaucet.mockReset()
  mocks.runFaucet.mockResolvedValue({ performed: ["pay"] })
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  consoleError.mockRestore()
})

describe("POST /api/faucet", () => {
  it("handles POST only", () => {
    expect(typeof route.POST).toBe("function")
    expect(Object.keys(route).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["POST"])
  })

  it("returns the steps performed, never cached", async () => {
    const res = await post(JSON.stringify({ account: ACCOUNT }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ performed: ["pay"] })
    expect(res.headers.get("cache-control")).toContain("no-store")
  })

  it("grants over the resolved markets: seeds plus valid registry markets", async () => {
    const pool = "C" + "B".repeat(55)
    const market = { ...manifest.markets[0], marketId: "testnet-sta-discovered", contracts: { ...manifest.markets[0].contracts, pool } }
    mocks.registry = [{ pool, market_id: market.marketId, source: "discovered", valid: true, reason: null, market }]
    try {
      await post(JSON.stringify({ account: ACCOUNT }))
      const { markets } = mocks.runFaucet.mock.calls[0][0]
      expect((await markets()).map((m: { marketId: string }) => m.marketId)).toEqual([manifest.markets[0].marketId, "testnet-sta-discovered"])
    } finally {
      mocks.registry = []
    }
  })

  it("the route reads no database before the faucet's rate limit admits the request (R2-40 M4)", async () => {
    mocks.dbReads = 0
    mocks.runFaucet.mockResolvedValue({ error: "rate_limited" })
    expect((await post(JSON.stringify({ account: ACCOUNT }))).status).toBe(429)
    expect(mocks.dbReads).toBe(0)
  })

  it("passes the account, the client key, the manifest and the time", async () => {
    await post(JSON.stringify({ account: ACCOUNT }), { "x-vercel-forwarded-for": "198.51.100.7" })
    expect(mocks.runFaucet).toHaveBeenCalledWith({ account: ACCOUNT, ip: "198.51.100.7", manifest, markets: expect.any(Function), now: expect.any(Number) })
  })

  const ipOf = async (headers: Record<string, string>) => {
    mocks.runFaucet.mockClear()
    await post(JSON.stringify({ account: ACCOUNT }), headers)
    return (mocks.runFaucet.mock.calls[0][0] as { ip: string }).ip
  }

  it("keys the client by the platform's header: x-vercel-forwarded-for, then x-real-ip (R42)", async () => {
    const spoofed = { "x-forwarded-for": "6.6.6.6, 10.0.0.1" }
    expect(await ipOf({ ...spoofed, "x-vercel-forwarded-for": " 198.51.100.7 ", "x-real-ip": "192.0.2.1" })).toBe("198.51.100.7")
    expect(await ipOf({ ...spoofed, "x-real-ip": " 192.0.2.1 " })).toBe("192.0.2.1")
  })

  it("otherwise takes the rightmost x-forwarded-for hop, so a spoofed leftmost entry does not change the key (R42)", async () => {
    const a = await ipOf({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" })
    const b = await ipOf({ "x-forwarded-for": "2.2.2.2, 203.0.113.9" })
    const c = await ipOf({ "x-forwarded-for": " 203.0.113.9 " })
    expect([a, b, c]).toEqual(["203.0.113.9", "203.0.113.9", "203.0.113.9"])
  })

  it("uses one fallback key when no client header is present", async () => {
    await post(JSON.stringify({ account: ACCOUNT }))
    await post(JSON.stringify({ account: ACCOUNT }), { "x-forwarded-for": " , " })
    const ips = mocks.runFaucet.mock.calls.map(([p]) => (p as { ip: string }).ip)
    expect(ips[0]).toBe(ips[1])
    expect(ips[0]).toBeTruthy()
  })

  it("rejects anything but a valid G… account with 400, before running the faucet", async () => {
    const contract = StrKey.encodeContract(Keypair.random().rawPublicKey())
    const bodies = [
      "not json",
      "",
      "null",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ account: 5 }),
      JSON.stringify({ account: "GABC" }),
      JSON.stringify({ account: contract }),
      JSON.stringify({ account: ACCOUNT.toLowerCase() }),
      JSON.stringify({ account: ` ${ACCOUNT}` }),
      JSON.stringify({ account: Keypair.random().secret() }),
    ]
    for (const body of bodies) {
      const res = await post(body)
      expect(res.status, body.slice(0, 40)).toBe(400)
      expect((await res.json()).error).toBe("invalid_account")
    }
    expect(mocks.runFaucet).not.toHaveBeenCalled()
  })

  it("refuses an oversized body with 413: declared, or streamed past the limit (R42)", async () => {
    const big = await post(JSON.stringify({ account: ACCOUNT, padding: "x".repeat(5_000) }))
    expect(big.status).toBe(413)
    expect((await big.json()).error).toBe("request_too_large")
    const declared = await post(JSON.stringify({ account: ACCOUNT }), { "content-length": "5000" })
    expect(declared.status).toBe(413)
    expect(mocks.runFaucet).not.toHaveBeenCalled()
  })

  it("stops reading a streamed body without content-length once it passes the limit, and cancels it (R42)", async () => {
    let pulls = 0
    let cancelled = false
    const chunk = new TextEncoder().encode(`{"account":"${ACCOUNT}","pad":"${"x".repeat(400)}`)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        // An endless body: only cancelling stops it.
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request("http://localhost/api/faucet", { method: "POST", body: stream, duplex: "half", headers: JSON_TYPE } as RequestInit)
    expect(request.headers.get("content-length")).toBeNull()
    const res = await route.POST(request)
    expect(res.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(10)
    expect(mocks.runFaucet).not.toHaveBeenCalled()
  })

  it("reads a valid body arriving in several chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ account: ACCOUNT }))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10))
        controller.enqueue(bytes.slice(10, 30))
        controller.enqueue(bytes.slice(30))
        controller.close()
      },
    })
    const res = await route.POST(
      new Request("http://localhost/api/faucet", { method: "POST", body: stream, duplex: "half", headers: JSON_TYPE } as RequestInit),
    )
    expect(res.status).toBe(200)
    expect(mocks.runFaucet).toHaveBeenCalledWith(expect.objectContaining({ account: ACCOUNT }))
  })

  it("requires a JSON content type (415), so a plain cross-site form cannot post (minor 5)", async () => {
    const body = JSON.stringify({ account: ACCOUNT })
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp"]) {
      const res = await post(body, type ? { "content-type": type } : {}, {})
      expect(res.status, String(type)).toBe(415)
      expect((await res.json()).error).toBe("invalid_content_type")
    }
    expect(mocks.runFaucet).not.toHaveBeenCalled()
    const ok = await post(body, { "content-type": "Application/JSON; charset=utf-8" }, {})
    expect(ok.status).toBe(200)
  })

  it("refuses a browser request that is not same-origin, by Sec-Fetch-Site (minor 5)", async () => {
    const body = JSON.stringify({ account: ACCOUNT })
    for (const site of ["cross-site", "same-site", "none"]) {
      const res = await post(body, { "sec-fetch-site": site })
      expect(res.status, site).toBe(403)
      expect((await res.json()).error).toBe("cross_site")
    }
    expect(mocks.runFaucet).not.toHaveBeenCalled()
    expect((await post(body, { "sec-fetch-site": "same-origin" })).status).toBe(200)
    // Without the header (a non-browser client) the other checks still apply.
    expect((await post(body)).status).toBe(200)
  })

  it("maps each refusal to a typed error and status", async () => {
    const cases = [
      ["network", 403],
      ["no_trustline", 409],
      ["rate_limited", 429],
      ["busy", 503],
      ["not_configured", 503],
    ] as const
    for (const [error, status] of cases) {
      mocks.runFaucet.mockResolvedValueOnce({ error })
      const res = await post(JSON.stringify({ account: ACCOUNT }))
      expect(res.status).toBe(status)
      const body = await res.json()
      expect(body.error).toBe(error)
      expect(typeof body.message).toBe("string")
      if (error === "rate_limited" || error === "busy") {
        expect(res.headers.get("retry-after")).toBe("60")
        expect(body.retryAfterSeconds).toBe(60)
      }
      if (error === "busy") expect(body.message).toBe("The faucet is busy — try again in a minute.")
    }
  })

  it("never echoes a chain error or a key; names the step that stopped", async () => {
    const secret = Keypair.random().secret()
    mocks.runFaucet.mockRejectedValueOnce(new FaucetStepError("grant_pt", new FaucetTxError(`rpc said ${secret}`)))
    const res = await post(JSON.stringify({ account: ACCOUNT }))
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).not.toContain(secret)
    expect(text).not.toContain("rpc said")
    expect(JSON.parse(text)).toMatchObject({ error: "failed", step: "grant_pt" })
    // Neutral: a read failure or a timeout is not necessarily a refused transaction (minor 6).
    expect(JSON.parse(text).message).toMatch(/^The faucet could not finish — try again/)
    expect(JSON.parse(text).message).not.toMatch(/transaction/)

    mocks.runFaucet.mockRejectedValueOnce(new Error(`boom ${secret}`))
    const other = await post(JSON.stringify({ account: ACCOUNT }))
    expect(other.status).toBe(502)
    const otherText = await other.text()
    expect(otherText).not.toContain(secret)
    expect(otherText).not.toContain("boom")
    // Server logs never carry the key either.
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(secret)
  })

  it("reports a server without its keys as not_configured (503), without naming them", async () => {
    mocks.runFaucet.mockRejectedValueOnce(new FaucetConfigError("the issuer secret is not set"))
    const res = await post(JSON.stringify({ account: ACCOUNT }))
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(JSON.parse(text).error).toBe("not_configured")
    expect(text).not.toMatch(/secret/i)
  })
})
