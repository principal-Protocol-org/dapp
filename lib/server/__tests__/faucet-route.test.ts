// @vitest-environment node
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "@/lib/protocol/manifest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({ runFaucet: vi.fn() }))
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

function post(body: string, headers: Record<string, string> = {}) {
  return route.POST(new Request("http://localhost/api/faucet", { method: "POST", body, headers }))
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

  it("passes the account, the first x-forwarded-for hop, the manifest and the time", async () => {
    await post(JSON.stringify({ account: ACCOUNT }), { "x-forwarded-for": " 203.0.113.5 , 10.0.0.1" })
    expect(mocks.runFaucet).toHaveBeenCalledWith({ account: ACCOUNT, ip: "203.0.113.5", manifest, now: expect.any(Number) })
  })

  it("uses one fallback key when there is no x-forwarded-for", async () => {
    await post(JSON.stringify({ account: ACCOUNT }))
    await post(JSON.stringify({ account: ACCOUNT }), { "x-forwarded-for": "" })
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
      JSON.stringify({ account: ACCOUNT, padding: "x".repeat(5_000) }),
    ]
    for (const body of bodies) {
      const res = await post(body)
      expect(res.status, body.slice(0, 40)).toBe(400)
      expect((await res.json()).error).toBe("invalid_account")
    }
    const declared = await post(JSON.stringify({ account: ACCOUNT }), { "content-length": "5000" })
    expect(declared.status).toBe(400)
    expect(mocks.runFaucet).not.toHaveBeenCalled()
  })

  it("maps each refusal to a typed error and status", async () => {
    const cases = [
      ["network", 403],
      ["no_trustline", 409],
      ["rate_limited", 429],
    ] as const
    for (const [error, status] of cases) {
      mocks.runFaucet.mockResolvedValueOnce({ error })
      const res = await post(JSON.stringify({ account: ACCOUNT }))
      expect(res.status).toBe(status)
      const body = await res.json()
      expect(body.error).toBe(error)
      expect(typeof body.message).toBe("string")
      if (error === "rate_limited") {
        expect(res.headers.get("retry-after")).toBe("60")
        expect(body.retryAfterSeconds).toBe(60)
      }
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
