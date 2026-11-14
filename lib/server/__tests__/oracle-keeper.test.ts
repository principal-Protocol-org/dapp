// @vitest-environment node
import { Keypair, StrKey, Transaction, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import localExample from "@/config/manifests/local.example.json"
import { bytesToHex } from "@/lib/protocol/bytes"
import { isSignificantRejection } from "@/lib/protocol/dashboard/rejections"
import { parseManifest } from "@/lib/protocol/manifest"
import { buildInvocationEnvelope, type ContractInvocation } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"

vi.mock("server-only", () => ({}))

import {
  BROKEN,
  ORACLE_APY_PERCENT,
  OracleKeeperConfigError,
  OracleSubmitError,
  ROUTINE,
  SIGNIFICANT,
  createFeedChain,
  createOracleChain,
  keeperSigner,
  nextReferenceValue,
  tickFeed,
  tickOracle,
  type FeedChain,
  type OracleChain,
  type OracleRpcServer,
} from "../oracle-keeper"

const manifest = parseManifest(localExample)
const ORACLE = manifest.shared.oracle
const keeper = Keypair.random()
const YEAR = 31_536_000

/** A chain whose reads answer from `state` and whose sends are recorded. */
const SOURCE = "cd".repeat(32)
function fakeChain(state: {
  admin: string
  value: bigint
  timestamp: bigint
  now: number
  source?: unknown
  returned?: unknown
  rejection?: unknown
}) {
  const sent: { signer: string; invocation: ContractInvocation }[] = []
  const chain: OracleChain = {
    read: vi.fn(async (fn) =>
      fn === "get_admin"
        ? state.admin
        : fn === "get_reference_value"
          ? state.value
          : fn === "get_primary_source"
            ? ("source" in state ? state.source : Buffer.from(SOURCE, "hex"))
            : fn === "last_rejection"
              ? (state.rejection ?? null)
              : state.timestamp,
    ),
    ledgerTime: vi.fn(async () => state.now),
    send: vi.fn(async (signer, invocation) => {
      sent.push({ signer: signer.publicKey(), invocation })
      return { hash: "ab".repeat(32), returnValue: "returned" in state ? state.returned : true }
    }),
  }
  return { chain, sent }
}

describe("nextReferenceValue", () => {
  it("grows the value at the yearly rate for the time elapsed, floored", () => {
    // 1.0 for one year at 5 % -> 1.05.
    expect(nextReferenceValue({ current: 10_000_000n, lastTimestamp: 0, now: YEAR })).toBe(10_500_000n)
    // Half an hour at 5 %: (1.05)^(1800/31536000) = 1.0000027848...
    expect(nextReferenceValue({ current: 10_000_000n, lastTimestamp: 1_000, now: 2_800 })).toBe(10_000_027n)
    expect(ORACLE_APY_PERCENT).toBe(5)
  })
  it("never goes below the current value", () => {
    expect(nextReferenceValue({ current: 10_000_000n, lastTimestamp: 1_000, now: 1_001 })).toBe(10_000_000n)
  })
  it("is null when the ledger clock has not moved past the last timestamp (the contract would refuse it)", () => {
    expect(nextReferenceValue({ current: 10_000_000n, lastTimestamp: 1_000, now: 1_000 })).toBeNull()
    expect(nextReferenceValue({ current: 10_000_000n, lastTimestamp: 1_000, now: 999 })).toBeNull()
  })
})

describe("tickOracle", () => {
  const base = { admin: keeper.publicKey(), value: 10_000_000n, timestamp: 1_000n, now: 2_800 }

  it("pushes the grown value at the ledger time, signed by the oracle admin", async () => {
    const { chain, sent } = fakeChain(base)
    const tick = await tickOracle({ manifest, secret: keeper.secret(), chain })
    expect(tick).toEqual({ status: "updated", mode: "push", signer: keeper.publicKey(), value: "10000027", timestamp: 2_800, hash: "ab".repeat(32) })
    expect(sent).toEqual([
      {
        signer: keeper.publicKey(),
        invocation: {
          contractId: ORACLE,
          functionName: "set_reference_value",
          args: [
            { type: "address", value: keeper.publicKey() },
            { type: "bytes", value: SOURCE },
            { type: "i128", value: "10000027" },
            { type: "u64", value: "2800" },
          ],
        },
      },
    ])
  })

  it("reports a rejected tick with the contract's reason, never as updated (R4-8)", async () => {
    const { chain } = fakeChain({ ...base, returned: false, rejection: { reason: "deviate", timestamp: 2_800n, value: 99n } })
    expect(await tickOracle({ manifest, secret: keeper.secret(), chain })).toEqual({
      status: "rejected",
      mode: "push",
      signer: keeper.publicKey(),
      value: "10000027",
      timestamp: 2_800,
      hash: "ab".repeat(32),
      reason: "deviate",
    })
  })

  it("a rejected tick without a readable reason is still rejected", async () => {
    const { chain } = fakeChain({ ...base, returned: false })
    expect(await tickOracle({ manifest, secret: keeper.secret(), chain })).toMatchObject({ status: "rejected", reason: "unknown" })
  })

  it("refuses with a config error, sending nothing, when the oracle has no primary source", async () => {
    const { chain, sent } = fakeChain({ ...base, source: null })
    await expect(tickOracle({ manifest, secret: keeper.secret(), chain })).rejects.toThrow(OracleKeeperConfigError)
    expect(sent).toEqual([])
  })

  it("sends nothing when the ledger clock has not moved", async () => {
    const { chain, sent } = fakeChain({ ...base, now: 1_000 })
    expect(await tickOracle({ manifest, secret: keeper.secret(), chain })).toEqual({ status: "unchanged", mode: "push", signer: keeper.publicKey(), value: "10000000", timestamp: 1_000 })
    expect(sent).toEqual([])
  })

  it("refuses, sending nothing, when the key is not the oracle admin", async () => {
    const { chain, sent } = fakeChain({ ...base, admin: Keypair.random().publicKey() })
    await expect(tickOracle({ manifest, secret: keeper.secret(), chain })).rejects.toThrow(OracleKeeperConfigError)
    expect(sent).toEqual([])
  })

  it("refuses without a key, or with a bad one, and never puts the key in the error", async () => {
    const { chain } = fakeChain(base)
    await expect(tickOracle({ manifest, secret: undefined, chain })).rejects.toThrow(OracleKeeperConfigError)
    await expect(tickOracle({ manifest, secret: "  ", chain })).rejects.toThrow(OracleKeeperConfigError)
    const bad = "SNOTAVALIDSECRETKEYATALL"
    const error = await tickOracle({ manifest, secret: bad, chain }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OracleKeeperConfigError)
    expect((error as Error).message).not.toContain(bad)
  })

  it("never runs on mainnet: a real oracle is not this app's to feed", async () => {
    const { chain, sent } = fakeChain(base)
    const mainnet = { ...manifest, network: "mainnet" } as Manifest
    await expect(tickOracle({ manifest: mainnet, secret: keeper.secret(), chain })).rejects.toThrow(OracleKeeperConfigError)
    expect(chain.read).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })
})

describe("keeperSigner", () => {
  it("is the keeper key's public key, for the tick record; null without a key or with a bad one (never the secret)", () => {
    expect(keeperSigner(keeper.secret())).toBe(keeper.publicKey())
    expect(keeperSigner(`  ${keeper.secret()} `)).toBe(keeper.publicKey())
    expect(keeperSigner(undefined)).toBeNull()
    expect(keeperSigner("  ")).toBeNull()
    expect(keeperSigner("SNOTAVALIDSECRETKEYATALL")).toBeNull()
  })
})

describe("the RPC oracle chain", () => {
  function fakeRpc(status = "SUCCESS") {
    const sent: Transaction[] = []
    const server = {
      simulateTransaction: vi.fn(async () => ({
        result: { retval: nativeToScVal(42n, { type: "i128" }), auth: [] },
        latestLedger: 1,
        minResourceFee: "0",
      })),
      getLatestLedger: vi.fn(async () => ({ sequence: 9, closeTime: "1700000000" })),
      getAccount: vi.fn(async () => ({ sequenceNumber: () => "70" })),
      prepareTransaction: vi.fn(async (tx: Transaction) => tx),
      sendTransaction: vi.fn(async (tx: Transaction): Promise<{ status: string; hash?: string; errorResult?: xdr.TransactionResult }> => {
        sent.push(tx)
        return { status: "PENDING", hash: bytesToHex(tx.hash()) }
      }),
      getTransaction: vi.fn(async () => ({ status })),
    }
    return { server: server as typeof server & OracleRpcServer, sent }
  }
  const invocation: ContractInvocation = {
    contractId: ORACLE,
    functionName: "set_reference_value",
    args: [
      { type: "address", value: keeper.publicKey() },
      { type: "bytes", value: SOURCE },
      { type: "i128", value: "10000027" },
      { type: "u64", value: "2800" },
    ],
  }

  it("reads through a simulation and the ledger clock through getLatestLedger", async () => {
    const { server } = fakeRpc()
    const chain = createOracleChain(manifest, { server })
    expect(await chain.read("get_reference_value")).toBe(42n)
    expect(await chain.ledgerTime()).toBe(1_700_000_000)
  })

  it("sends the call it built, prepared by RPC, signed by the keeper, and waits for success", async () => {
    const { server, sent } = fakeRpc()
    const chain = createOracleChain(manifest, { server })
    const { hash } = await chain.send(keeper, invocation)
    expect(server.prepareTransaction).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    const [tx] = sent
    expect(hash).toBe(bytesToHex(tx.hash()))
    expect(tx.signatures.some((s) => bytesToHex(s.hint.value) === bytesToHex(keeper.rawPublicKey().slice(-4)))).toBe(true)
    const expected = buildInvocationEnvelope({ source: keeper.publicKey(), sequence: "0", networkPassphrase: manifest.networkPassphrase, invocation })
    const call = (t: Transaction) => {
      const [op] = t.operations
      return op?.type === "invokeHostFunction" && op.func.type === "hostFunctionTypeInvokeContract" ? op.func.invokeContract.toXdr("base64") : undefined
    }
    expect(call(tx)).toBe(call(expected))
  })

  it("refuses a prepared transaction that changes the call (R29), sending nothing", async () => {
    const { server, sent } = fakeRpc()
    server.prepareTransaction.mockImplementation(async () =>
      buildInvocationEnvelope({
        source: keeper.publicKey(),
        sequence: "70",
        networkPassphrase: manifest.networkPassphrase,
        invocation: { ...invocation, args: [invocation.args[0], invocation.args[1], { type: "i128", value: "99999999" }, invocation.args[3]] },
      }),
    )
    const chain = createOracleChain(manifest, { server })
    await expect(chain.send(keeper, invocation)).rejects.toThrow()
    expect(sent).toEqual([])
  })

  it("throws when the transaction fails on-chain", async () => {
    const { server } = fakeRpc("FAILED")
    const chain = createOracleChain(manifest, { server })
    await expect(chain.send(keeper, invocation)).rejects.toThrow(/failed on-chain/)
  })

  it("a failed submission is an OracleSubmitError carrying its hash and the result code (the contract trapped)", async () => {
    const { server, sent } = fakeRpc("FAILED")
    // As RPC reports a FAILED Soroban transaction (the shape stellar.test.ts pins).
    const trapped = new xdr.TransactionResult({
      feeCharged: 48_031n,
      result: xdr.TransactionResultResult.txFailed([
        xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped())),
      ]),
      ext: xdr.TransactionResultExt.v0(),
    })
    server.getTransaction.mockImplementation(async () => ({ status: "FAILED", resultXdr: trapped }) as never)
    const error = await createOracleChain(manifest, { server }).send(keeper, invocation).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OracleSubmitError)
    expect((error as OracleSubmitError).hash).toBe(bytesToHex(sent[0].hash()))
    expect((error as OracleSubmitError).code).toBe("invokeHostFunctionTrapped")
    expect((error as Error).message).not.toContain(keeper.secret())
  })

  it("a FAILED answer without its result reads FAILED; one never confirmed reads not confirmed, with its hash", async () => {
    const failed = fakeRpc("FAILED")
    const e1 = await createOracleChain(manifest, { server: failed.server }).send(keeper, invocation).catch((e: unknown) => e)
    expect(e1).toMatchObject({ code: "FAILED", hash: bytesToHex(failed.sent[0].hash()) })
    const lost = fakeRpc("NOT_FOUND")
    vi.useFakeTimers()
    try {
      const pending = createOracleChain(manifest, { server: lost.server }).send(keeper, invocation).catch((e: unknown) => e)
      await vi.runAllTimersAsync()
      const e2 = await pending
      expect(e2).toBeInstanceOf(OracleSubmitError)
      expect(e2).toMatchObject({ code: "not confirmed", hash: bytesToHex(lost.sent[0].hash()) })
      expect((e2 as Error).message).toMatch(/not confirmed in time/)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------- feed mode (spec 0004 D-21)

/** A contract event of `contractId` as RPC's simulation reports it: a `DiagnosticEvent`, decoded from XDR. */
function contractEvent(contractId: string, topic: string, data: xdr.ScVal): xdr.DiagnosticEvent {
  const event = new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: new xdr.ContractId(StrKey.decodeContract(contractId)),
      type: xdr.ContractEventType.contract,
      body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol(topic)], data })),
    }),
  })
  return xdr.DiagnosticEvent.fromXdr(event.toXdr("base64"), "base64")
}
const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" })
const u64 = (v: bigint) => nativeToScVal(v, { type: "u64" })
/** The oracle's `ref_rej (value, timestamp, reason)` (24d980d lib.rs:729). */
const refRej = (value: bigint, timestamp: bigint, reason: string, contractId = ORACLE) =>
  contractEvent(contractId, "ref_rej", xdr.ScVal.scvVec([i128(value), u64(timestamp), xdr.ScVal.scvSymbol(reason)]))
/** The oracle's `ref_set (value, timestamp)` (24d980d lib.rs:550). */
const refSet = (value: bigint, timestamp: bigint, contractId = ORACLE) => contractEvent(contractId, "ref_set", xdr.ScVal.scvVec([i128(value), u64(timestamp)]))

/** Contract ids no deployment uses. */
const FEED = StrKey.encodeContract(Buffer.alloc(32, 7))
const HASH = "ab".repeat(32)
const SYNC: ContractInvocation = { contractId: ORACLE, functionName: "sync_from_feed", args: [] }

/** A feed chain: `feed_source` answers `feedSource`, the simulation answers `sim`, and sends are recorded. */
function fakeFeedChain(state: {
  feedSource?: unknown
  readError?: Error
  sim?: { retval: unknown; events: xdr.DiagnosticEvent[] }
  simError?: Error
  returned?: unknown
}) {
  const sent: { signer: string; invocation: ContractInvocation }[] = []
  const simulated: { source: string; invocation: ContractInvocation }[] = []
  const chain: FeedChain = {
    read: vi.fn(async () => {
      if (state.readError) throw state.readError
      return "feedSource" in state ? state.feedSource : [FEED, ["Other", "USDY"]]
    }),
    simulate: vi.fn(async (source, invocation) => {
      simulated.push({ source, invocation })
      if (state.simError) throw state.simError
      return state.sim ?? { retval: true, events: [] }
    }),
    send: vi.fn(async (signer, invocation) => {
      sent.push({ signer: signer.publicKey(), invocation })
      return { hash: HASH, returnValue: "returned" in state ? state.returned : (state.sim?.retval ?? true) }
    }),
  }
  return { chain, sent, simulated }
}

describe("the rejection classes (D-21)", () => {
  it("split the contract's reasons as 24d980d does: routine, significant, broken feed", () => {
    expect(ROUTINE).toEqual(["stale_ts", "no_data"])
    expect(SIGNIFICANT).toEqual(["oob", "decrease", "deviate", "fb_value"])
    expect(BROKEN).toEqual(["bad_price", "rescale", "future_ts"])
    // The same significant split as the dashboard and the alert check use.
    for (const r of [...ROUTINE, ...SIGNIFICANT, ...BROKEN]) expect(isSignificantRejection(r), r).toBe((SIGNIFICANT as readonly string[]).includes(r))
  })
})

describe("tickFeed (D-21): sync_from_feed with a role-less key", () => {
  const secret = keeper.secret()
  const run = { mode: "feed", signer: keeper.publicKey() }

  it("true: submits sync_from_feed, signed by the keeper, and reports synced with the ref_set value and the hash", async () => {
    const { chain, sent, simulated } = fakeFeedChain({ sim: { retval: true, events: [refSet(10_000_000n, 1_700_000_000n)] } })
    expect(await tickFeed({ manifest, secret, chain })).toEqual({ ...run, status: "synced", value: "10000000", timestamp: 1_700_000_000, hash: HASH })
    expect(simulated).toEqual([{ source: keeper.publicKey(), invocation: SYNC }])
    expect(sent).toEqual([{ signer: keeper.publicKey(), invocation: SYNC }])
    // No admin check: the key needs no role (it never reads get_admin).
    expect(chain.read).toHaveBeenCalledTimes(1)
    expect(chain.read).toHaveBeenCalledWith("feed_source")
  })

  it("a routine rejection (stale_ts, no_data) is skipped: no submit, the reason kept", async () => {
    const stale = fakeFeedChain({ sim: { retval: false, events: [refRej(10_000_000n, 1_700_000_000n, "stale_ts")] } })
    expect(await tickFeed({ manifest, secret, chain: stale.chain })).toEqual({ ...run, status: "skipped", value: "10000000", timestamp: 1_700_000_000, reason: "stale_ts" })
    expect(stale.sent).toEqual([])
    // no_data carries the contract's placeholders (0, 0): no value, no timestamp.
    const empty = fakeFeedChain({ sim: { retval: false, events: [refRej(0n, 0n, "no_data")] } })
    expect(await tickFeed({ manifest, secret, chain: empty.chain })).toEqual({ ...run, status: "skipped", value: null, timestamp: null, reason: "no_data" })
    expect(empty.sent).toEqual([])
  })

  it("a significant rejection never submitted before is submitted once: rejected, with its hash", async () => {
    for (const reason of SIGNIFICANT) {
      const { chain, sent } = fakeFeedChain({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_100n, reason)] } })
      expect(await tickFeed({ manifest, secret, chain, lastSubmittedRejection: null })).toEqual({
        ...run,
        status: "rejected",
        value: "11500000",
        timestamp: 1_700_000_100,
        hash: HASH,
        reason,
      })
      expect(sent).toEqual([{ signer: keeper.publicKey(), invocation: SYNC }])
    }
  })

  it("the same significant (reason, value) as the last submitted one is rejected again with no submit", async () => {
    const { chain, sent } = fakeFeedChain({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_200n, "deviate")] } })
    const tick = await tickFeed({ manifest, secret, chain, lastSubmittedRejection: { reason: "deviate", value: "11500000" } })
    expect(tick).toEqual({ ...run, status: "rejected", value: "11500000", timestamp: 1_700_000_200, reason: "deviate" })
    expect(tick).not.toHaveProperty("hash")
    expect(sent).toEqual([])
  })

  it("a new value or a new reason is a new rejection: submitted", async () => {
    const value = fakeFeedChain({ sim: { retval: false, events: [refRej(11_600_000n, 1_700_000_300n, "deviate")] } })
    expect(await tickFeed({ manifest, secret, chain: value.chain, lastSubmittedRejection: { reason: "deviate", value: "11500000" } })).toMatchObject({ status: "rejected", hash: HASH })
    expect(value.sent).toHaveLength(1)
    const reason = fakeFeedChain({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_300n, "oob")] } })
    expect(await tickFeed({ manifest, secret, chain: reason.chain, lastSubmittedRejection: { reason: "deviate", value: "11500000" } })).toMatchObject({ status: "rejected", reason: "oob", hash: HASH })
    expect(reason.sent).toHaveLength(1)
  })

  it("a broken-feed rejection (bad_price, rescale, future_ts) is rejected and never submitted", async () => {
    for (const reason of BROKEN) {
      const { chain, sent } = fakeFeedChain({ sim: { retval: false, events: [refRej(-1n, 1_700_000_000n, reason)] } })
      const tick = await tickFeed({ manifest, secret, chain })
      expect(tick).toEqual({ ...run, status: "rejected", value: "-1", timestamp: 1_700_000_000, reason })
      expect(sent).toEqual([])
    }
  })

  it("false with no ref_rej event is rejected with reason unknown, not submitted", async () => {
    // A ref_rej of another contract (the feed, say) is not the oracle's.
    const { chain, sent } = fakeFeedChain({ sim: { retval: false, events: [refRej(1n, 1n, "deviate", FEED)] } })
    expect(await tickFeed({ manifest, secret, chain })).toEqual({ ...run, status: "rejected", value: null, timestamp: null, reason: "unknown" })
    expect(sent).toEqual([])
  })

  it("the landed call decides: a simulated accept that lands false is a rejection (reason unknown), with the hash", async () => {
    const { chain } = fakeFeedChain({ sim: { retval: true, events: [refSet(10_000_000n, 1_700_000_000n)] }, returned: false })
    expect(await tickFeed({ manifest, secret, chain })).toEqual({ ...run, status: "rejected", value: null, timestamp: null, hash: HASH, reason: "unknown" })
    // A submitted significant rejection that lands true: the feed moved meanwhile; synced, value unknown.
    const moved = fakeFeedChain({ sim: { retval: false, events: [refRej(11_500_000n, 1n, "deviate")] }, returned: true })
    expect(await tickFeed({ manifest, secret, chain: moved.chain })).toEqual({ ...run, status: "synced", value: null, timestamp: null, hash: HASH })
  })

  it("not_configured when the oracle has no feed_source view (a 665bb67 oracle: WasmVm MissingValue), sending nothing", async () => {
    const { chain, sent } = fakeFeedChain({
      readError: new Error('HostError: Error(WasmVm, MissingValue)\n\nEvent log (newest first):\n   0: [Diagnostic Event] ... data:["trying to invoke non-existent contract function", feed_source]'),
    })
    await expect(tickFeed({ manifest, secret, chain })).rejects.toThrow(OracleKeeperConfigError)
    expect(chain.simulate).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it("not_configured when no feed is set (feed_source None), or when the simulation raises FeedNotConfigured (#15)", async () => {
    const none = fakeFeedChain({ feedSource: null })
    await expect(tickFeed({ manifest, secret, chain: none.chain })).rejects.toThrow(OracleKeeperConfigError)
    expect(none.chain.simulate).not.toHaveBeenCalled()
    const fifteen = fakeFeedChain({ simError: new Error("HostError: Error(Contract, #15)") })
    await expect(tickFeed({ manifest, secret, chain: fifteen.chain })).rejects.toThrow(OracleKeeperConfigError)
    expect(fifteen.sent).toEqual([])
  })

  it("any other read or simulation error is no config error: it fails as itself, sending nothing", async () => {
    const read = fakeFeedChain({ readError: new TypeError("fetch failed") })
    await expect(tickFeed({ manifest, secret, chain: read.chain })).rejects.toThrow(TypeError)
    const sim = fakeFeedChain({ simError: new Error("HostError: Error(Contract, #8)") })
    const error = await tickFeed({ manifest, secret, chain: sim.chain }).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(OracleKeeperConfigError)
    expect(sim.sent).toEqual([])
  })

  it("an unexpected return value (neither true nor false) fails, sending nothing", async () => {
    const { chain, sent } = fakeFeedChain({ sim: { retval: undefined, events: [] } })
    await expect(tickFeed({ manifest, secret, chain })).rejects.toThrow()
    expect(sent).toEqual([])
  })

  it("refuses without ORACLE_KEEPER_SECRET, or with a bad one, and never puts the key in the error", async () => {
    const { chain } = fakeFeedChain({})
    await expect(tickFeed({ manifest, secret: undefined, chain })).rejects.toThrow(/ORACLE_KEEPER_SECRET is not set/)
    await expect(tickFeed({ manifest, secret: " ", chain })).rejects.toThrow(OracleKeeperConfigError)
    const bad = "SNOTAVALIDSECRETKEYATALL"
    const error = await tickFeed({ manifest, secret: bad, chain }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(OracleKeeperConfigError)
    expect((error as Error).message).toMatch(/ORACLE_KEEPER_SECRET/)
    expect((error as Error).message).not.toContain(bad)
    expect(chain.read).not.toHaveBeenCalled()
  })

  it("runs on mainnet: the key holds no privilege (push mode keeps its refusal)", async () => {
    const mainnet = { ...manifest, network: "mainnet" } as Manifest
    const { chain, sent } = fakeFeedChain({ sim: { retval: true, events: [refSet(10_000_000n, 1n)] } })
    expect(await tickFeed({ manifest: mainnet, secret, chain })).toMatchObject({ status: "synced", mode: "feed" })
    expect(sent).toHaveLength(1)
  })

  it("targets the oracle it is given (ORACLE_KEEPER_ORACLE_ID), else the manifest's", async () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 9))
    const { chain, sent, simulated } = fakeFeedChain({ sim: { retval: true, events: [refSet(10_000_000n, 1n, other)] } })
    expect(await tickFeed({ manifest, secret, oracle: other, chain })).toMatchObject({ status: "synced", value: "10000000" })
    expect(simulated[0].invocation.contractId).toBe(other)
    expect(sent[0].invocation.contractId).toBe(other)
  })
})

describe("the RPC feed chain", () => {
  function fakeRpc(simulation: unknown) {
    const server = {
      simulateTransaction: vi.fn(async () => simulation),
      getLatestLedger: vi.fn(async () => ({ sequence: 9, closeTime: "1700000000" })),
      getAccount: vi.fn(async () => ({ sequenceNumber: () => "70" })),
      prepareTransaction: vi.fn(async (tx: Transaction) => tx),
      sendTransaction: vi.fn(async (tx: Transaction) => ({ status: "PENDING", hash: bytesToHex(tx.hash()) })),
      getTransaction: vi.fn(async () => ({ status: "SUCCESS" })),
    }
    return server as typeof server & OracleRpcServer
  }

  it("simulates sync_from_feed as the keeper on the oracle it targets, keeping the return value and the events", async () => {
    const events = [refRej(1n, 2n, "stale_ts")]
    const server = fakeRpc({ result: { retval: xdr.ScVal.scvBool(false), auth: [] }, events, latestLedger: 1, minResourceFee: "0", transactionData: {} })
    const chain = createFeedChain(manifest, ORACLE, { server })
    const sim = await chain.simulate(keeper.publicKey(), SYNC)
    expect(sim.retval).toBe(false)
    expect(sim.events).toBe(events)
    const [tx] = server.simulateTransaction.mock.calls[0] as unknown as [Transaction]
    expect(tx.source).toBe(keeper.publicKey())
    const [op] = tx.operations
    expect(op?.type === "invokeHostFunction" && op.func.type === "hostFunctionTypeInvokeContract" && op.func.invokeContract.functionName.toString()).toBe("sync_from_feed")
  })

  it("a simulation error throws its text (the keeper matches #15 and MissingValue on it)", async () => {
    const chain = createFeedChain(manifest, ORACLE, { server: fakeRpc({ error: "HostError: Error(Contract, #15)", events: [], latestLedger: 1 }) })
    await expect(chain.simulate(keeper.publicKey(), SYNC)).rejects.toThrow("HostError: Error(Contract, #15)")
  })

  it("reads feed_source through a simulation of the oracle it targets", async () => {
    const server = fakeRpc({ result: { retval: xdr.ScVal.scvVoid(), auth: [] }, events: [], latestLedger: 1, minResourceFee: "0", transactionData: {} })
    const chain = createFeedChain(manifest, ORACLE, { server })
    expect(await chain.read("feed_source")).toBeNull()
  })
})
