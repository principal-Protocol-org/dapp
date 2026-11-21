// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const stellar = vi.hoisted(() => ({ servers: [] as string[], reads: [] as string[], failing: new Set<string>() }))
vi.mock("@/lib/protocol/stellar", async (importActual) => ({
  ...(await importActual<object>()),
  createRpcServer: (url: string) => {
    stellar.servers.push(url)
    return { url }
  },
  simulateContractRead: async (p: { rpcUrl: string }) => {
    stellar.reads.push(p.rpcUrl)
    if (stellar.failing.has(p.rpcUrl)) throw new TypeError("fetch failed")
    return { value: 1, latestLedger: 7, minResourceFee: "0", rawXdr: "AAAA", rpcUrl: p.rpcUrl }
  },
}))

import { parseManifest } from "@/lib/protocol/manifest"
import testnet from "@/config/manifests/testnet.json"
import { resetRpcSkipsForTests } from "@/lib/protocol/reader"
import { createKeeperAccount, createOracleChain } from "../oracle-keeper"
import { createServerRpc, resetServerRpcWarningForTests, serverReader, serverRpcUrl, serverRpcUrlOf, serverRpcUrls } from "../rpc-urls"

const SENTINEL = "https://server-rpc.invalid/secret-sentinel"
const PUBLIC = "https://public.invalid/key"
const GATEWAY = "https://gateway.invalid"
const manifest = { ...parseManifest(testnet), rpcUrl: PUBLIC, rpcFallbackUrls: [GATEWAY] }
const call = { contractId: "C1", functionName: "price" }

describe("server RPC URLs", () => {
  beforeEach(() => {
    stellar.servers.length = 0
    stellar.reads.length = 0
    stellar.failing.clear()
    resetRpcSkipsForTests()
    resetServerRpcWarningForTests()
    vi.stubEnv("SERVER_RPC_URL", "")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("orders the secret URL first, then rpcUrl and the fallbacks; unset, as the manifest does", () => {
    expect(serverRpcUrls(manifest, {})).toEqual([PUBLIC, GATEWAY])
    expect(serverRpcUrls(manifest, { SERVER_RPC_URL: SENTINEL })).toEqual([SENTINEL, PUBLIC, GATEWAY])
    expect(serverRpcUrlOf(manifest, {})).toBe(PUBLIC)
    expect(serverRpcUrlOf(manifest, { SERVER_RPC_URL: SENTINEL })).toBe(SENTINEL)
  })

  it("ignores a value that is not an http(s) URL, with one warning that names the variable only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const bad = "ftp://server-rpc.invalid/secret-sentinel"
    expect(serverRpcUrl({ SERVER_RPC_URL: bad })).toBeNull()
    expect(serverRpcUrl({ SERVER_RPC_URL: "not a url secret-sentinel" })).toBeNull()
    expect(serverRpcUrls(manifest, { SERVER_RPC_URL: bad })).toEqual([PUBLIC, GATEWAY])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0])).toContain("SERVER_RPC_URL")
    expect(String(warn.mock.calls[0])).not.toContain("sentinel")
    warn.mockRestore()
  })

  it("builds the server and the keeper's chain on the secret URL when set, else on rpcUrl", () => {
    vi.stubEnv("SERVER_RPC_URL", SENTINEL)
    createServerRpc(manifest)
    createOracleChain(manifest)
    createKeeperAccount(manifest)
    expect(stellar.servers).toEqual([SENTINEL, SENTINEL, SENTINEL])
    stellar.servers.length = 0
    vi.stubEnv("SERVER_RPC_URL", "")
    createOracleChain(manifest)
    expect(stellar.servers).toEqual([PUBLIC])
  })

  it("reads the secret URL first, falls back after it, and never names it in an answer", async () => {
    vi.stubEnv("SERVER_RPC_URL", SENTINEL)
    const first = await serverReader(manifest)(call)
    expect(stellar.reads).toEqual([SENTINEL])
    expect(JSON.stringify(first)).not.toContain("sentinel")
    expect(first.rpcUrl).toBe(PUBLIC)
    expect(first.viaFallback).toBeUndefined()

    stellar.reads.length = 0
    stellar.failing.add(SENTINEL)
    const second = await serverReader(manifest)({ ...call, functionName: "other" })
    expect(stellar.reads).toEqual([SENTINEL, PUBLIC])
    expect(second.viaFallback).toBe(true)
    expect(JSON.stringify(second)).not.toContain("sentinel")
  })

  it("a failure with the secret URL set does not put it in the thrown error", async () => {
    vi.stubEnv("SERVER_RPC_URL", SENTINEL)
    stellar.failing.add(SENTINEL).add(PUBLIC).add(GATEWAY)
    const error = await serverReader(manifest)({ ...call, functionName: "third" }).catch((e: unknown) => e)
    expect(String((error as Error).message)).not.toContain("sentinel")
  })
})
