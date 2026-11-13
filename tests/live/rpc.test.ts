// @vitest-environment node
import { Account, BASE_FEE, Contract, Keypair, nativeToScVal, Networks, SorobanDataBuilder, StrKey, TransactionBuilder } from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRpcServer } from "@/lib/protocol/stellar"
import { isTransientRpcError } from "./retry"
import { liveReader, RETRIED_RPC_METHODS, submitAndPoll, withTransientRetry } from "./rpc"

/** The JSON-RPC answer of an overloaded stellar-rpc, as run 43511581261 received it. */
const OVERLOADED = { jsonrpc: "2.0", id: 1, error: { code: -32004, message: "preflight queue full; retry later" } }
const HEALTHY = { jsonrpc: "2.0", id: 1, result: { status: "healthy", latestLedger: 5_716_650, oldestLedger: 5_595_691, ledgerRetentionWindow: 120_960 } }

/** The SDK's own server, its HTTP client answering `answers` in turn: the SDK's real parsing and rejection. */
function sdkServer(answers: unknown[]) {
  const server = createRpcServer("https://rpc.example.test")
  const post = vi.fn()
  for (const data of answers) post.mockResolvedValueOnce({ data, status: 200, statusText: "OK", headers: {}, config: {} })
  ;(server as unknown as { httpClient: { post: typeof post } }).httpClient.post = post
  return { server, post }
}

const call = () =>
  new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(StrKey.encodeContract(Buffer.alloc(32))).call("get_reference_value"))
    .setTimeout(30)
    .build()

/** A clock that moves only when the retry waits. */
const fakeClock = () => {
  let t = 0
  return { now: () => t, wait: vi.fn(async (ms: number) => void (t += ms)) }
}

describe("the SDK's rejection on an overloaded RPC", () => {
  it("is the plain JSON-RPC error object, from simulateTransaction and prepareTransaction alike, and it is transient", async () => {
    const { server } = sdkServer([OVERLOADED, OVERLOADED])
    for (const sent of [server.simulateTransaction(call()), server.prepareTransaction(call())]) {
      const rejection = await sent.catch((e: unknown) => e)
      expect(rejection).toEqual({ code: -32004, message: "preflight queue full; retry later" })
      expect(rejection instanceof Error).toBe(false)
      expect(isTransientRpcError(rejection)).toBe(true)
    }
  })
})

describe("withTransientRetry", () => {
  it("asks a read again while the RPC is overloaded, and logs it", async () => {
    const { server, post } = sdkServer([OVERLOADED, OVERLOADED, HEALTHY])
    const log = vi.fn()
    const live = withTransientRetry(server, { log, ...fakeClock() })
    expect(await live.getHealth()).toMatchObject({ status: "healthy", latestLedger: 5_716_650 })
    expect(post).toHaveBeenCalledTimes(3)
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'RPC getHealth: the RPC answered "preflight queue full; retry later (code -32004)" (attempt 1); asking again in 2 s',
      'RPC getHealth: the RPC answered "preflight queue full; retry later (code -32004)" (attempt 2); asking again in 4 s',
    ])
  })

  it("retries prepareTransaction as a whole (its own simulation is not retried inside it), and names it once the budget is spent", async () => {
    const { server, post } = sdkServer(Array.from({ length: 20 }, () => OVERLOADED))
    const live = withTransientRetry(server, { log: () => {}, ...fakeClock() })
    const error = await live.prepareTransaction(call()).catch((e: unknown) => e)
    expect((error as Error).message).toBe('RPC prepareTransaction: the RPC still answered "preflight queue full; retry later (code -32004)" after 8 attempts over 74 s')
    // One request per attempt: no retry nested inside another.
    expect(post).toHaveBeenCalledTimes(8)
  })

  it("never retries sendTransaction: a submission is retried only at the step level, once nothing of it landed", async () => {
    const { server, post } = sdkServer([OVERLOADED, OVERLOADED])
    const clock = fakeClock()
    const live = withTransientRetry(server, { log: () => {}, ...clock })
    await expect(live.sendTransaction(call())).rejects.toEqual({ code: -32004, message: "preflight queue full; retry later" })
    expect(post).toHaveBeenCalledTimes(1)
    expect(clock.wait).not.toHaveBeenCalled()
    expect(RETRIED_RPC_METHODS.has("sendTransaction")).toBe(false)
  })

  it("never retries an answer: an invalid request is thrown at once", async () => {
    const { server, post } = sdkServer([{ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } }])
    const live = withTransientRetry(server, { log: () => {}, ...fakeClock() })
    await expect(live.getHealth()).rejects.toEqual({ code: -32602, message: "invalid params" })
    expect(post).toHaveBeenCalledTimes(1)
  })

  it("leaves the server's other members as they are", () => {
    const { server } = sdkServer([])
    const live = withTransientRetry(server, { log: () => {} })
    expect(live.serverURL.toString()).toBe(server.serverURL.toString())
  })
})

describe("liveReader: the oracle read the maturity tick failed on (lifecycle.test.ts, tick)", () => {
  const network = { rpcUrl: "https://rpc.example.test", networkPassphrase: Networks.TESTNET }
  /** A successful simulation of a read returning `value` (i128), as stellar-rpc answers it. */
  const answered = (value: bigint) => ({
    jsonrpc: "2.0",
    id: 1,
    result: {
      latestLedger: 5_716_650,
      minResourceFee: "90000",
      transactionData: new SorobanDataBuilder().build().toXDR("base64"),
      results: [{ auth: [], xdr: nativeToScVal(value, { type: "i128" }).toXDR("base64") }],
    },
  })
  /** The SDK's fetch answering `answers` in turn (HTTP 200, JSON-RPC bodies). */
  function stubFetch(answers: unknown[]) {
    const fetchMock = vi.fn()
    for (const body of answers) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads through a minute of -32004 and returns the value", async () => {
    const fetchMock = stubFetch([OVERLOADED, OVERLOADED, OVERLOADED, answered(10_500_000n)])
    const log = vi.fn()
    const read = liveReader(network, log, fakeClock())
    const r = await read<bigint>({ contractId: StrKey.encodeContract(Buffer.alloc(32)), functionName: "get_reference_value" })
    expect(r).toMatchObject({ value: 10_500_000n, latestLedger: 5_716_650 })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(log.mock.calls[0][0]).toBe('read get_reference_value: the RPC answered "preflight queue full; retry later (code -32004)" (attempt 1); asking again in 2 s')
  })

  it("names the read and the RPC's answer when the overload outlasts the budget", async () => {
    stubFetch(Array.from({ length: 20 }, () => OVERLOADED))
    const read = liveReader(network, () => {}, fakeClock())
    await expect(read({ contractId: StrKey.encodeContract(Buffer.alloc(32)), functionName: "get_reference_value" })).rejects.toThrow(
      'read get_reference_value: the RPC still answered "preflight queue full; retry later (code -32004)" after 8 attempts over 74 s',
    )
  })

  it("never retries a contract's answer", async () => {
    const fetchMock = stubFetch([{ jsonrpc: "2.0", id: 1, result: { latestLedger: 5_716_650, error: "HostError: Error(Contract, #7)", events: [] } }])
    const read = liveReader(network, () => {}, fakeClock())
    await expect(read({ contractId: StrKey.encodeContract(Buffer.alloc(32)), functionName: "get_reference_value" })).rejects.toThrow("HostError: Error(Contract, #7)")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe("submitAndPoll", () => {
  const signer = Keypair.random()
  const signed = () => {
    const tx = call()
    tx.sign(signer)
    return tx.toXDR()
  }
  const base = { rpcUrl: "https://rpc.example.test", networkPassphrase: Networks.TESTNET, what: "oracle.set_reference_value", log: () => {}, intervalMs: 0 }
  const unanswered = Object.assign(new Error("Request failed with status code 504"), { response: { status: 504 } })

  it("polls the hash of a send the RPC did not answer, and never sends it again: it may have landed", async () => {
    const server = { sendTransaction: vi.fn().mockRejectedValue(unanswered), getTransaction: vi.fn().mockResolvedValueOnce({ status: "NOT_FOUND" }).mockResolvedValueOnce({ status: "SUCCESS" }) }
    const polled = await submitAndPoll({ ...base, signedXdr: signed(), server })
    expect(polled.status).toBe("SUCCESS")
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)
    expect(server.getTransaction).toHaveBeenCalledTimes(2)
  })

  it("throws the unanswered send, named, when the network does not show it: the step's sequence check decides", async () => {
    const server = { sendTransaction: vi.fn().mockRejectedValue(unanswered), getTransaction: vi.fn().mockResolvedValue({ status: "NOT_FOUND" }) }
    const error = await submitAndPoll({ ...base, signedXdr: signed(), server }).catch((e: unknown) => e)
    expect((error as Error).message).toMatch(/^oracle\.set_reference_value [0-9a-f]{64}: the RPC did not answer the submission \(Request failed with status code 504\), and the network does not show it$/)
    expect(isTransientRpcError(error)).toBe(true)
    expect(server.sendTransaction).toHaveBeenCalledTimes(1)
  })

  it("throws any other send failure at once, and TRY_AGAIN_LATER (nothing taken) without polling", async () => {
    const rejected = { sendTransaction: vi.fn().mockRejectedValue(new Error("invalid params")), getTransaction: vi.fn() }
    await expect(submitAndPoll({ ...base, signedXdr: signed(), server: rejected })).rejects.toThrow("invalid params")
    const busy = { sendTransaction: vi.fn().mockResolvedValue({ status: "TRY_AGAIN_LATER", hash: "h" }), getTransaction: vi.fn() }
    await expect(submitAndPoll({ ...base, signedXdr: signed(), server: busy })).rejects.toThrow("TRY_AGAIN_LATER, the network is busy and did not accept it")
    expect(rejected.getTransaction).not.toHaveBeenCalled()
    expect(busy.getTransaction).not.toHaveBeenCalled()
  })
})
