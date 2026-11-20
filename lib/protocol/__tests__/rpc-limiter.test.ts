// @vitest-environment node
import { describe, expect, it } from "vitest"
import { limitRpc, RPC_CONCURRENCY, requestKey, shareInFlight } from "../rpc-limiter"

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** `count` runs through the limiter, each held until the test settles it; records starts and the peak in flight. */
function burst(count: number) {
  const gates = Array.from({ length: count }, () => deferred<number>())
  const started: number[] = []
  let inFlight = 0
  let peak = 0
  const results = gates.map((gate, i) =>
    limitRpc(async () => {
      started.push(i)
      inFlight++
      peak = Math.max(peak, inFlight)
      try {
        return await gate.promise
      } finally {
        inFlight--
      }
    }),
  )
  // Handled from the start, so a run the test rejects is never an unhandled rejection.
  const settled = Promise.allSettled(results)
  return { gates, started, results, settled, peak: () => peak, inFlight: () => inFlight }
}

// A 429 as the SDK's HTTP client reports it.
const tooMany = () => Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } })

describe("limitRpc", () => {
  it("caps the requests at six", () => {
    expect(RPC_CONCURRENCY).toBe(6)
  })

  it("runs 20 started together never more than 6 at a time, each in arrival order, and every one resolves", async () => {
    const b = burst(20)
    await tick()
    expect(b.started).toEqual([0, 1, 2, 3, 4, 5])
    // Settle them one by one: each freed slot goes to the next in line.
    for (let i = 0; i < 20; i++) {
      b.gates[i].resolve(i * 10)
      await tick()
      expect(b.inFlight()).toBeLessThanOrEqual(RPC_CONCURRENCY)
    }
    expect(await Promise.all(b.results)).toEqual(Array.from({ length: 20 }, (_, i) => i * 10))
    expect(b.started).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(b.peak()).toBe(RPC_CONCURRENCY)
  })

  it("frees the slot of a rejected run: when the first 6 answer 429, the other 14 still run and the peak stays 6", async () => {
    const b = burst(20)
    await tick()
    for (let i = 0; i < 6; i++) b.gates[i].reject(tooMany())
    await tick()
    expect(b.started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    for (let i = 6; i < 20; i++) {
      b.gates[i].resolve(i)
      await tick()
    }
    const settled = await b.settled
    expect(settled.slice(0, 6).map((s) => s.status)).toEqual(Array(6).fill("rejected"))
    expect(settled.slice(0, 6).map((s) => s.status === "rejected" && (s.reason as { response: { status: number } }).response.status)).toEqual(Array(6).fill(429))
    expect(settled.slice(6).map((s) => s.status === "fulfilled" && s.value)).toEqual(Array.from({ length: 14 }, (_, i) => i + 6))
    expect(b.started).toHaveLength(20)
    expect(b.peak()).toBe(RPC_CONCURRENCY)
  })

  it("frees the slot of a run that throws before it returns a promise", async () => {
    const throwing = Array.from({ length: RPC_CONCURRENCY }, () =>
      limitRpc((): Promise<never> => {
        throw new TypeError("x is not a function")
      }),
    )
    for (const t of await Promise.allSettled(throwing)) expect(t.status).toBe("rejected")
    await expect(limitRpc(async () => "next")).resolves.toBe("next")
  })
})

describe("shareInFlight", () => {
  it("hands two identical reads in flight one request; two different arguments make two", async () => {
    const gate = deferred<string>()
    let requests = 0
    const run = () => {
      requests++
      return gate.promise
    }
    const a = shareInFlight(requestKey("https://rpc.test", "C1", "balance", [{ type: "address", value: "GA" }]), run)
    const b = shareInFlight(requestKey("https://rpc.test", "C1", "balance", [{ type: "address", value: "GA" }]), run)
    const c = shareInFlight(requestKey("https://rpc.test", "C1", "balance", [{ type: "address", value: "GB" }]), run)
    expect(requests).toBe(2)
    gate.resolve("answer")
    expect(await Promise.all([a, b, c])).toEqual(["answer", "answer", "answer"])
  })

  it("shares a failure, then forgets the key once it settles: a later identical read asks again", async () => {
    let requests = 0
    const failing = () => {
      requests++
      return Promise.reject(tooMany())
    }
    const key = requestKey("https://rpc.test", "C1", "pool_state", [])
    const settled = await Promise.allSettled([shareInFlight(key, failing), shareInFlight(key, failing)])
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"])
    expect(requests).toBe(1)
    await expect(shareInFlight(key, async () => "fresh")).resolves.toBe("fresh")
  })

  it("keys bigints at any depth without throwing, apart from the same digits as text", () => {
    const struct = (amount: bigint | string) => [{ type: "struct", value: { amount: { type: "i128", value: amount } } }]
    expect(requestKey("u", "C", "f", struct(5n))).toBe(requestKey("u", "C", "f", struct(5n)))
    expect(requestKey("u", "C", "f", struct(5n))).not.toBe(requestKey("u", "C", "f", struct("5")))
    expect(requestKey("u", "C", "f", struct(5n))).not.toBe(requestKey("v", "C", "f", struct(5n)))
  })
})
