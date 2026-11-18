// @vitest-environment node
import { Address, Keypair, StrKey, Transaction, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import localExample from "@/config/manifests/local.example.json"
import { bytesToHex } from "@/lib/protocol/bytes"
import * as classes from "@/lib/protocol/dashboard/rejections"
import { isSignificantRejection } from "@/lib/protocol/dashboard/rejections"
import { parseManifest } from "@/lib/protocol/manifest"
import { buildInvocationEnvelope, type ContractInvocation, type PolledTransactionResult } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"

vi.mock("server-only", () => ({}))

import {
  BROKEN,
  KEEPER_IS_ADMIN,
  NO_FEED_REASON,
  NO_PRICE_REASONS,
  NOT_CONFIRMED,
  NOT_SENT,
  ORACLE_APY_PERCENT,
  OracleKeeperConfigError,
  OracleSubmitError,
  ROUTINE,
  SIGNIFICANT,
  createFeedChain,
  createKeeperAccount,
  createOracleChain,
  keeperSigner,
  nextReferenceValue,
  tickFeedAll,
  tickOracle,
  type FeedChain,
  type KeeperAccount,
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

// ---------------------------------------------------------------- feed mode (spec 0004 D-21, spec 0005 M-13)

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
/** Three oracles of one manifest, in its order. */
const [A, B, C] = [1, 2, 3].map((n) => StrKey.encodeContract(Buffer.alloc(32, n)))

/** The oracle admin of the fake feed chains: a key the keeper is not. */
const ORACLE_ADMIN = Keypair.random().publicKey()

/**
 * One oracle on a fake network: `feed_source` answers `feedSource` (or throws `readError`),
 * `get_admin` answers `admin` (the oracle admin by default), the simulation answers `sim`; a sent
 * `sync_from_feed` lands returning `returned` (the simulated value by default) with the contract
 * events `landed` (none when absent).
 */
type FeedState = {
  feedSource?: unknown
  readError?: Error
  admin?: string
  sim?: { retval: unknown; events: xdr.DiagnosticEvent[] }
  simError?: Error
  returned?: unknown
  landed?: xdr.DiagnosticEvent[]
}

function fakeFeedChain(state: FeedState) {
  const simulated: { source: string; invocation: ContractInvocation }[] = []
  const chain: FeedChain = {
    read: vi.fn(async (fn) => {
      if (fn === "get_admin") return state.admin ?? ORACLE_ADMIN
      if (state.readError) throw state.readError
      return "feedSource" in state ? state.feedSource : [FEED, ["Other", "USDY"]]
    }),
    simulate: vi.fn(async (source, invocation) => {
      simulated.push({ source, invocation })
      if (state.simError) throw state.simError
      return state.sim ?? { retval: true, events: [] }
    }),
  }
  return { chain, simulated }
}

/** A transaction's source, sequence number, contract and function. */
function callOf(tx: Transaction) {
  const [op] = tx.operations
  if (op?.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call")
  const call = op.func.invokeContract
  return { source: tx.source, sequence: tx.sequence, contractId: Address.fromScAddress(call.contractAddress).toString(), functionName: call.functionName.toString() }
}
const signedBy = (tx: Transaction, signer: Keypair) => tx.signatures.some((s) => bytesToHex(s.hint.value) === bytesToHex(signer.rawPublicKey().slice(-4)))
const hashOf = (tx: Transaction) => bytesToHex(tx.hash())

type SendAnswer = { status: string; errorResult?: xdr.TransactionResult }
/** A transaction-level result, as RPC parses a refused send's `errorResultXdr` (`txBadSeq`, …). */
const txResult = (code: "txBadSeq" | "txInsufficientFee") =>
  new xdr.TransactionResult({ feeCharged: 100n, result: xdr.TransactionResultResult[code](), ext: xdr.TransactionResultExt.v0() })

/**
 * The keeper account on a fake network. `sequence` answers `start` (each read counted); `prepare`
 * hands back the transaction as built; `send` records what it is given and answers `answers[i]` for
 * the i-th send (PENDING by default; a function may throw); `lookup` finds the i-th sent transaction
 * as `seen(i, attempt)` says (null: not in a ledger yet), by default in a ledger at once, SUCCESS,
 * returning and emitting what its oracle's state says.
 */
function fakeAccount(opts: {
  start?: string
  states?: Record<string, FeedState>
  answers?: (SendAnswer | (() => Promise<SendAnswer>))[]
  seen?: (index: number, attempt: number) => Partial<PolledTransactionResult> | null | undefined
}) {
  const sent: Transaction[] = []
  const attempts: number[] = []
  const account = {
    sequence: vi.fn<(address: string) => Promise<string>>(async () => opts.start ?? "100"),
    prepare: vi.fn(async (tx: Transaction) => tx),
    send: vi.fn(async (tx: Transaction): Promise<SendAnswer> => {
      sent.push(tx)
      const answer = opts.answers?.[sent.length - 1] ?? { status: "PENDING" }
      return typeof answer === "function" ? answer() : answer
    }),
    lookup: vi.fn(async (hash: string): Promise<PolledTransactionResult> => {
      const index = sent.findIndex((tx) => hashOf(tx) === hash)
      if (index < 0) throw new Error(`a lookup of a hash never sent: ${hash}`)
      attempts[index] = (attempts[index] ?? 0) + 1
      const over = opts.seen?.(index, attempts[index])
      if (over === null) return { hash, status: "NOT_FOUND", attempts: 1 }
      if (over) return { hash, status: "SUCCESS", attempts: 1, ...over }
      const state = opts.states?.[callOf(sent[index]).contractId] ?? {}
      const returnValue = "returned" in state ? state.returned : (state.sim?.retval ?? true)
      return { hash, status: "SUCCESS", attempts: 1, returnValue, ...(state.landed ? { contractEvents: state.landed.map((d) => d.event) } : {}) }
    }),
  } satisfies KeeperAccount
  return { account, sent }
}

/** Oracles on one fake network (`states`, in manifest order): each its own feed chain, and one keeper account. */
function fakeNetwork(states: Record<string, FeedState>, opts: Omit<Parameters<typeof fakeAccount>[0], "states"> = {}) {
  const chains = Object.fromEntries(Object.entries(states).map(([oracle, s]) => [oracle, fakeFeedChain(s)]))
  const { account, sent } = fakeAccount({ ...opts, states })
  return { chains, account, sent, oracles: Object.keys(states), chainFor: vi.fn((oracle: string) => chains[oracle].chain) }
}
type FakeNetwork = ReturnType<typeof fakeNetwork>
type FeedDeps = Parameters<typeof tickFeedAll>[0]

/** One feed run over every oracle of `net`, as the route makes it (rejections on-chain, today's rule, unless `over` says). */
function runFeed(net: FakeNetwork, over: Partial<FeedDeps> = {}) {
  return tickFeedAll({
    manifest,
    secret: keeper.secret(),
    oracles: net.oracles,
    recordRejections: true,
    deadlineMs: Date.now() + 50_000,
    lastSubmittedRejection: async () => null,
    chainFor: net.chainFor,
    account: net.account,
    ...over,
  })
}

/** `run` under fake timers: every poll and wait plays out at once. */
async function withFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  try {
    const pending = run()
    await vi.runAllTimersAsync()
    return await pending
  } finally {
    vi.useRealTimers()
  }
}

const SYNC: ContractInvocation = { contractId: ORACLE, functionName: "sync_from_feed", args: [] }
/** What the keeper sends for `oracle`: `sync_from_feed`, from its own account, signed by it. */
const sentCall = (oracle = ORACLE) => ({ source: keeper.publicKey(), contractId: oracle, functionName: "sync_from_feed", signed: true })
const callsOf = (net: FakeNetwork) =>
  net.sent.map((tx) => {
    const { source, contractId, functionName } = callOf(tx)
    return { source, contractId, functionName, signed: signedBy(tx, keeper) }
  })

/** One oracle's run (ORACLE), the shape of the single-oracle cases: its outcome, what was sent and simulated. */
async function tickOne(state: FeedState, over: Partial<FeedDeps> = {}) {
  const net = fakeNetwork({ [ORACLE]: state })
  const runs = await runFeed(net, over)
  expect(runs.map((r) => r.oracle)).toEqual([ORACLE])
  return { outcome: runs[0].outcome, sent: callsOf(net), simulated: net.chains[ORACLE].simulated, chain: net.chains[ORACLE].chain, net }
}

describe("the rejection classes (D-21)", () => {
  it("split the contract's reasons as 3af9388 does: routine (throttle included), significant, broken feed (feed_err included)", () => {
    expect(ROUTINE).toEqual(["stale_ts", "no_data", "throttle"])
    expect(SIGNIFICANT).toEqual(["oob", "decrease", "deviate", "fb_value"])
    expect(BROKEN).toEqual(["bad_price", "rescale", "future_ts", "feed_err"])
    // The same significant split as the dashboard and the alert check use, from their one source.
    for (const r of [...ROUTINE, ...SIGNIFICANT, ...BROKEN]) expect(isSignificantRejection(r), r).toBe((SIGNIFICANT as readonly string[]).includes(r))
    expect(ROUTINE).toBe(classes.ROUTINE)
    expect(SIGNIFICANT).toBe(classes.SIGNIFICANT)
    expect(BROKEN).toBe(classes.BROKEN)
  })

  it("no_feed is the keeper's own reason, no contract rejection: in none of the three classes", () => {
    expect(NO_FEED_REASON).toBe("no_feed")
    expect([...ROUTINE, ...SIGNIFICANT, ...BROKEN]).not.toContain(NO_FEED_REASON)
  })
})

describe("tickFeedAll (M-13): every oracle in one run, from one account", () => {
  const run = { mode: "feed", signer: keeper.publicKey() }
  const synced = (oracle: string, value: bigint, timestamp: bigint): FeedState => ({ sim: { retval: true, events: [refSet(value, timestamp, oracle)] } })

  it("three oracles, two to sync: the account is read once, the two transactions use sequence n+1 and n+2, three outcomes in manifest order", async () => {
    const net = fakeNetwork({ [A]: synced(A, 10_000_000n, 1n), [B]: { sim: { retval: false, events: [refRej(10_000_000n, 1n, "stale_ts", B)] } }, [C]: synced(C, 20_000_000n, 2n) }, { start: "4200" })
    const runs = await runFeed(net)
    expect(runs).toEqual([
      { oracle: A, outcome: { ...run, status: "synced", value: "10000000", timestamp: 1, hash: hashOf(net.sent[0]) } },
      { oracle: B, outcome: { ...run, status: "skipped", value: "10000000", timestamp: 1, reason: "stale_ts" } },
      { oracle: C, outcome: { ...run, status: "synced", value: "20000000", timestamp: 2, hash: hashOf(net.sent[1]) } },
    ])
    expect(net.account.sequence).toHaveBeenCalledTimes(1)
    expect(net.account.sequence).toHaveBeenCalledWith(keeper.publicKey())
    expect(net.sent.map(callOf)).toEqual([
      { source: keeper.publicKey(), sequence: "4201", contractId: A, functionName: "sync_from_feed" },
      { source: keeper.publicKey(), sequence: "4202", contractId: C, functionName: "sync_from_feed" },
    ])
    expect(net.sent.every((tx) => signedBy(tx, keeper))).toBe(true)
    // Each was prepared by RPC, then checked (the prepared transaction keeps the built sequence number).
    expect(net.account.prepare).toHaveBeenCalledTimes(2)
    // Every oracle was decided (reads and one simulation each) before anything was sent.
    for (const oracle of net.oracles) expect(net.chains[oracle].simulated).toHaveLength(1)
    const lastSimulation = Math.max(...net.oracles.map((o) => vi.mocked(net.chains[o].chain.simulate).mock.invocationCallOrder[0]))
    expect(net.account.sequence.mock.invocationCallOrder[0]).toBeGreaterThan(lastSimulation)
  })

  it("the network keeps one transaction per account: the next one is sent only once the previous one is in a ledger", async () => {
    // A's transaction is in no ledger for two looks; then it lands.
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n) }, { seen: (i, attempt) => (i === 0 && attempt <= 2 ? null : undefined) })
    const runs = await withFakeTimers(() => runFeed(net))
    expect(runs.map((r) => r.outcome.status)).toEqual(["synced", "synced"])
    const lookups = net.account.lookup.mock.calls.map(([hash]) => hash)
    expect(lookups.slice(0, 3)).toEqual([hashOf(net.sent[0]), hashOf(net.sent[0]), hashOf(net.sent[0])])
    // B's send came after A's third look, the one that found it.
    expect(net.account.send.mock.invocationCallOrder[1]).toBeGreaterThan(net.account.lookup.mock.invocationCallOrder[2])
    expect(net.sent.map((tx) => tx.sequence)).toEqual(["101", "102"])
  })

  it("no_feed: an oracle with no feed source (feed_source None) is skipped, with no value, nothing sent and no account read", async () => {
    const net = fakeNetwork({ [A]: { feedSource: null }, [B]: { feedSource: undefined } })
    const runs = await runFeed(net)
    expect(runs).toEqual([
      { oracle: A, outcome: { ...run, status: "skipped", value: null, timestamp: null, reason: "no_feed" } },
      { oracle: B, outcome: { ...run, status: "skipped", value: null, timestamp: null, reason: "no_feed" } },
    ])
    expect(net.chains[A].simulated).toEqual([])
    expect(net.sent).toEqual([])
    expect(net.account.sequence).not.toHaveBeenCalled()
  })

  it("recordRejections false (the default on Mainnet, M-14): a simulated decrease is rejected with no transaction, and no memory read", async () => {
    const memory = vi.fn(async () => null)
    const { outcome, sent, net } = await tickOne({ sim: { retval: false, events: [refRej(9_000_000n, 1_700_000_100n, "decrease")] } }, { recordRejections: false, lastSubmittedRejection: memory })
    expect(outcome).toEqual({ ...run, status: "rejected", value: "9000000", timestamp: 1_700_000_100, reason: "decrease" })
    expect(outcome).not.toHaveProperty("hash")
    expect(sent).toEqual([])
    expect(net.account.sequence).not.toHaveBeenCalled()
    expect(memory).not.toHaveBeenCalled()
  })

  it("recordRejections true: a new decrease is sent once, with its hash; a repeat of the same (reason, value) sends nothing", async () => {
    const decrease: FeedState = { sim: { retval: false, events: [refRej(9_000_000n, 1_700_000_100n, "decrease")] } }
    const memory = vi.fn<(oracle: string) => Promise<null>>(async () => null)
    const first = await tickOne(decrease, { lastSubmittedRejection: memory })
    expect(first.outcome).toEqual({ ...run, status: "rejected", value: "9000000", timestamp: 1_700_000_100, hash: hashOf(first.net.sent[0]), reason: "decrease" })
    expect(first.sent).toEqual([sentCall()])
    expect(memory).toHaveBeenCalledWith(ORACLE)
    const repeat = await tickOne(decrease, { lastSubmittedRejection: async () => ({ reason: "decrease", value: "9000000" }) })
    expect(repeat.outcome).toEqual({ ...run, status: "rejected", value: "9000000", timestamp: 1_700_000_100, reason: "decrease" })
    expect(repeat.sent).toEqual([])
  })

  it("a send that throws after signing is failed with its hash, and the next oracle still syncs, on the same sequence number when the first never reached a ledger", async () => {
    const net = fakeNetwork(
      { [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n) },
      { answers: [() => Promise.reject(new TypeError("fetch failed: https://rpc.example/key=abc"))], seen: (i) => (i === 0 ? null : undefined) },
    )
    const runs = await withFakeTimers(() => runFeed(net))
    expect(runs[0]).toEqual({ oracle: A, outcome: { ...run, status: "failed", name: "TypeError", hash: hashOf(net.sent[0]) } })
    expect(JSON.stringify(runs)).not.toContain("rpc.example")
    expect(runs[1]).toEqual({ oracle: B, outcome: { ...run, status: "synced", value: "2", timestamp: 2, hash: hashOf(net.sent[1]) } })
    // The thrown send's transaction never showed up in a ledger: its number was not used, B's transaction takes it.
    expect(net.sent.map((tx) => tx.sequence)).toEqual(["101", "101"])
    expect(net.account.sequence).toHaveBeenCalledTimes(1)
  })

  it("a send that throws, whose transaction did reach a ledger, is that oracle's result; the next one takes the next number", async () => {
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n) }, { answers: [() => Promise.reject(new TypeError("socket hang up"))] })
    const runs = await runFeed(net)
    expect(runs.map((r) => r.outcome)).toEqual([
      { ...run, status: "synced", value: "1", timestamp: 1, hash: hashOf(net.sent[0]) },
      { ...run, status: "synced", value: "2", timestamp: 2, hash: hashOf(net.sent[1]) },
    ])
    expect(net.sent.map((tx) => tx.sequence)).toEqual(["101", "102"])
  })

  it("a sequence collision is recorded and does not stop the other oracles", async () => {
    // Another run used the account in between: the network refuses A's transaction (txBadSeq).
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n), [C]: { feedSource: null } }, { answers: [{ status: "ERROR", errorResult: txResult("txBadSeq") }] })
    const runs = await runFeed(net)
    expect(runs).toEqual([
      { oracle: A, outcome: { ...run, status: "failed", name: "txBadSeq", hash: hashOf(net.sent[0]) } },
      { oracle: B, outcome: { ...run, status: "synced", value: "2", timestamp: 2, hash: hashOf(net.sent[1]) } },
      { oracle: C, outcome: { ...run, status: "skipped", value: null, timestamp: null, reason: "no_feed" } },
    ])
    // B's transaction was still built, prepared and sent; the refused one took no number, and nothing re-read the account.
    expect(net.sent.map(callOf).map((c) => [c.contractId, c.sequence])).toEqual([
      [A, "101"],
      [B, "101"],
    ])
    expect(net.account.prepare).toHaveBeenCalledTimes(2)
    expect(net.account.sequence).toHaveBeenCalledTimes(1)
    // A refused transaction is never looked up: it is in no ledger.
    expect(net.account.lookup.mock.calls.map(([h]) => h)).not.toContain(hashOf(net.sent[0]))
  })

  it("another run's transaction still pending (TRY_AGAIN_LATER) or a fee refused: failed with the network's word and the hash; the next oracle is still sent", async () => {
    const net = fakeNetwork(
      { [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n), [C]: synced(C, 3n, 3n) },
      { answers: [{ status: "TRY_AGAIN_LATER" }, { status: "ERROR", errorResult: txResult("txInsufficientFee") }] },
    )
    const runs = await runFeed(net)
    expect(runs.map((r) => r.outcome)).toEqual([
      { ...run, status: "failed", name: "TRY_AGAIN_LATER", hash: hashOf(net.sent[0]) },
      { ...run, status: "failed", name: "txInsufficientFee", hash: hashOf(net.sent[1]) },
      { ...run, status: "synced", value: "3", timestamp: 3, hash: hashOf(net.sent[2]) },
    ])
    expect(net.sent.map((tx) => tx.sequence)).toEqual(["101", "101", "101"])
  })

  it("a transaction that fails on-chain is failed with its result code and hash; its number is used, the next takes the next one", async () => {
    const trapped = new xdr.TransactionResult({
      feeCharged: 48_031n,
      result: xdr.TransactionResultResult.txFailed([
        xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped())),
      ]),
      ext: xdr.TransactionResultExt.v0(),
    })
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n) }, { seen: (i) => (i === 0 ? { status: "FAILED", failure: { result: trapped } } : undefined) })
    const runs = await runFeed(net)
    expect(runs.map((r) => r.outcome)).toEqual([
      { ...run, status: "failed", name: "invokeHostFunctionTrapped", hash: hashOf(net.sent[0]) },
      { ...run, status: "synced", value: "2", timestamp: 2, hash: hashOf(net.sent[1]) },
    ])
    expect(net.sent.map((tx) => tx.sequence)).toEqual(["101", "102"])
  })

  it("the deadline: a hash still in no ledger at deadlineMs is failed: not confirmed, with its hash", async () => {
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n) }, { seen: (i) => (i === 1 ? null : undefined) })
    let deadline = 0
    const runs = await withFakeTimers(() => {
      deadline = Date.now() + 50_000
      return runFeed(net, { deadlineMs: deadline })
    })
    expect(runs.map((r) => r.outcome)).toEqual([
      { ...run, status: "synced", value: "1", timestamp: 1, hash: hashOf(net.sent[0]) },
      { ...run, status: "failed", name: NOT_CONFIRMED, hash: hashOf(net.sent[1]) },
    ])
    // B was looked up until the deadline, about once a second, and not after it.
    const looksAtB = net.account.lookup.mock.calls.filter(([h]) => h === hashOf(net.sent[1])).length
    expect(looksAtB).toBeGreaterThanOrEqual(45)
    expect(looksAtB).toBeLessThanOrEqual(52)
  })

  it("the deadline: a transaction still pending blocks the account, so the oracles after it are failed: not sent, with no hash", async () => {
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n), [C]: synced(C, 3n, 3n) }, { seen: () => null })
    const runs = await withFakeTimers(() => runFeed(net, { deadlineMs: Date.now() + 20_000 }))
    expect(runs.map((r) => r.outcome)).toEqual([
      { ...run, status: "failed", name: NOT_CONFIRMED, hash: hashOf(net.sent[0]) },
      { ...run, status: "failed", name: NOT_SENT },
      { ...run, status: "failed", name: NOT_SENT },
    ])
    expect(net.sent).toHaveLength(1)
    expect(net.account.prepare).toHaveBeenCalledTimes(1)
  })

  it("a preparation that ends past the deadline is not sent: failed: not sent, its number unused", async () => {
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n) })
    net.account.prepare.mockImplementationOnce(async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, 10_000))
      return tx
    })
    const runs = await withFakeTimers(() => runFeed(net, { deadlineMs: Date.now() + 5_000 }))
    expect(runs.map((r) => r.outcome)).toEqual([{ ...run, status: "failed", name: NOT_SENT }])
    expect(net.account.send).not.toHaveBeenCalled()
  })

  it("a deadline already passed sends nothing: every oracle to sync is failed: not sent", async () => {
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: { feedSource: null } })
    const runs = await runFeed(net, { deadlineMs: Date.now() - 1 })
    expect(runs.map((r) => r.outcome)).toEqual([
      { ...run, status: "failed", name: NOT_SENT },
      { ...run, status: "skipped", value: null, timestamp: null, reason: "no_feed" },
    ])
    expect(net.sent).toEqual([])
  })

  it("a preparation that throws, or that changes the call (R29), sends nothing for that oracle: its number goes to the next one", async () => {
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: synced(B, 2n, 2n), [C]: synced(C, 3n, 3n) })
    net.account.prepare
      .mockImplementationOnce(async () => {
        throw new TypeError("simulation failed at https://rpc.example/key=abc")
      })
      // RPC hands back another call (B's transaction prepared as a call to A): refused before signing.
      .mockImplementationOnce(async (tx) =>
        buildInvocationEnvelope({ source: tx.source, sequence: "100", networkPassphrase: manifest.networkPassphrase, invocation: { contractId: A, functionName: "sync_from_feed", args: [] } }),
      )
    const runs = await runFeed(net)
    expect(runs.map((r) => r.outcome)).toEqual([
      { ...run, status: "failed", name: "TypeError" },
      { ...run, status: "failed", name: "Error" },
      { ...run, status: "synced", value: "3", timestamp: 3, hash: hashOf(net.sent[0]) },
    ])
    expect(net.sent.map(callOf).map((c) => [c.contractId, c.sequence])).toEqual([[C, "101"]])
  })

  it("an account that cannot be read fails every oracle to sync, by error name; the others keep their outcome", async () => {
    const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: { feedSource: null }, [C]: synced(C, 3n, 3n) })
    net.account.sequence.mockRejectedValue(new TypeError("Account not found"))
    const runs = await runFeed(net)
    expect(runs.map((r) => r.outcome)).toEqual([
      { ...run, status: "failed", name: "TypeError" },
      { ...run, status: "skipped", value: null, timestamp: null, reason: "no_feed" },
      { ...run, status: "failed", name: "TypeError" },
    ])
    expect(net.account.sequence).toHaveBeenCalledTimes(1)
    expect(net.sent).toEqual([])
  })

  it("one oracle's error is its own outcome: a read that fails, a missing feed_source view, the admin's key; the others still run", async () => {
    const missing = new Error("HostError: Error(WasmVm, MissingValue)\n\nEvent log (newest first): ... non-existent contract function, feed_source]")
    const D = StrKey.encodeContract(Buffer.alloc(32, 4))
    const net = fakeNetwork({
      [A]: { readError: new TypeError("fetch failed") },
      [B]: { readError: missing },
      [C]: { admin: keeper.publicKey(), sim: { retval: true, events: [refSet(3n, 3n, C)] } },
      [D]: synced(D, 4n, 4n),
    })
    const runs = await runFeed(net)
    expect(runs.map((r) => [r.oracle, r.outcome])).toEqual([
      [A, { ...run, status: "failed", name: "TypeError" }],
      [B, { ...run, status: "not_configured", message: "the oracle has no feed_source function: its code predates sync_from_feed (principal 665bb67 or older)." }],
      [C, { ...run, status: "not_configured", message: KEEPER_IS_ADMIN }],
      [D, { ...run, status: "synced", value: "4", timestamp: 4, hash: hashOf(net.sent[0]) }],
    ])
    expect(callsOf(net)).toEqual([sentCall(D)])
    expect(net.chains[C].simulated).toEqual([])
  })

  it("without ORACLE_KEEPER_SECRET, or with a bad one, every oracle is not_configured, nothing is read, and the key is in no outcome", async () => {
    for (const secret of [undefined, " ", "SNOTAVALIDSECRETKEYATALL"]) {
      const net = fakeNetwork({ [A]: synced(A, 1n, 1n), [B]: { feedSource: null } })
      const runs = await runFeed(net, { secret })
      const message = secret?.trim() ? "ORACLE_KEEPER_SECRET is not a valid Stellar secret key." : "ORACLE_KEEPER_SECRET is not set."
      expect(runs).toEqual([
        { oracle: A, outcome: { status: "not_configured", mode: "feed", signer: null, message } },
        { oracle: B, outcome: { status: "not_configured", mode: "feed", signer: null, message } },
      ])
      expect(net.chainFor).not.toHaveBeenCalled()
      expect(JSON.stringify(runs)).not.toContain("SNOTAVALIDSECRETKEYATALL")
    }
  })

  it("no oracle: no reads, no account, an empty answer", async () => {
    const net = fakeNetwork({})
    expect(await runFeed(net)).toEqual([])
    expect(net.account.sequence).not.toHaveBeenCalled()
  })
})

describe("tickFeedAll, one oracle (D-21): sync_from_feed with a role-less key", () => {
  const secret = keeper.secret()
  const run = { mode: "feed", signer: keeper.publicKey() }

  it("true: submits sync_from_feed, signed by the keeper, and reports synced with the ref_set value and the hash", async () => {
    const { outcome, sent, simulated, chain, net } = await tickOne({ sim: { retval: true, events: [refSet(10_000_000n, 1_700_000_000n)] } })
    expect(outcome).toEqual({ ...run, status: "synced", value: "10000000", timestamp: 1_700_000_000, hash: hashOf(net.sent[0]) })
    expect(simulated).toEqual([{ source: keeper.publicKey(), invocation: SYNC }])
    expect(sent).toEqual([sentCall()])
    // Two views: the feed, then the admin (the key must not be the admin's).
    expect(vi.mocked(chain.read).mock.calls).toEqual([["feed_source"], ["get_admin"]])
  })

  it("the hash is the signed transaction's own, computed before the send (RPC's answer is not trusted for it)", async () => {
    const net = fakeNetwork({ [ORACLE]: { sim: { retval: true, events: [refSet(1n, 1n)] } } })
    const [{ outcome }] = await runFeed(net)
    expect(outcome).toMatchObject({ status: "synced", hash: hashOf(net.sent[0]) })
    expect(net.account.lookup).toHaveBeenCalledWith(hashOf(net.sent[0]))
  })

  it("not_configured when ORACLE_KEEPER_SECRET is the oracle admin's key: it never simulates nor sends (I-2, D-21)", async () => {
    const { outcome, sent, simulated } = await tickOne({ admin: keeper.publicKey(), sim: { retval: true, events: [refSet(10_000_000n, 1n)] } })
    expect(outcome).toEqual({ ...run, status: "not_configured", message: "ORACLE_KEEPER_SECRET is the oracle admin's key: feed mode needs a key with no protocol role." })
    expect(JSON.stringify(outcome)).not.toContain(secret)
    expect(simulated).toEqual([])
    expect(sent).toEqual([])
    // On mainnet too: feed mode runs there, the admin key never does.
    const mainnet = await tickOne({ admin: keeper.publicKey() }, { manifest: { ...manifest, network: "mainnet" } as Manifest })
    expect(mainnet.outcome).toMatchObject({ status: "not_configured", message: KEEPER_IS_ADMIN })
    expect(mainnet.sent).toEqual([])
    // An oracle with no feed set is refused the same way: the key is the admin's, whatever the oracle needs.
    const none = await tickOne({ admin: keeper.publicKey(), feedSource: null })
    expect(none.outcome).toMatchObject({ status: "not_configured", message: KEEPER_IS_ADMIN })
  })

  it("a get_admin read that fails is no config error: it fails as itself, sending nothing", async () => {
    const net = fakeNetwork({ [ORACLE]: {} })
    vi.mocked(net.chains[ORACLE].chain.read).mockImplementation(async (fn) => {
      if (fn === "get_admin") throw new TypeError("fetch failed")
      return [FEED, ["Other", "USDY"]]
    })
    const [{ outcome }] = await runFeed(net)
    expect(outcome).toEqual({ ...run, status: "failed", name: "TypeError" })
    expect(net.chains[ORACLE].simulated).toEqual([])
    expect(net.sent).toEqual([])
  })

  it("a routine rejection (stale_ts, no_data, throttle) is skipped: no submit, the reason kept", async () => {
    const stale = await tickOne({ sim: { retval: false, events: [refRej(10_000_000n, 1_700_000_000n, "stale_ts")] } })
    expect(stale.outcome).toEqual({ ...run, status: "skipped", value: "10000000", timestamp: 1_700_000_000, reason: "stale_ts" })
    expect(stale.sent).toEqual([])
    // throttle (3af9388): a feed update sooner than the minimum interval after the last accepted one; it carries the feed's rescaled point.
    const soon = await tickOne({ sim: { retval: false, events: [refRej(10_000_500n, 1_700_000_060n, "throttle")] } })
    expect(soon.outcome).toEqual({ ...run, status: "skipped", value: "10000500", timestamp: 1_700_000_060, reason: "throttle" })
    expect(soon.sent).toEqual([])
    // no_data carries the contract's placeholders (0, 0): no value, no timestamp.
    const empty = await tickOne({ sim: { retval: false, events: [refRej(0n, 0n, "no_data")] } })
    expect(empty.outcome).toEqual({ ...run, status: "skipped", value: null, timestamp: null, reason: "no_data" })
    expect(empty.sent).toEqual([])
  })

  it("a significant rejection never submitted before is submitted once: rejected, with its hash", async () => {
    for (const reason of SIGNIFICANT) {
      const { outcome, sent, net } = await tickOne({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_100n, reason)] } })
      expect(outcome).toEqual({ ...run, status: "rejected", value: "11500000", timestamp: 1_700_000_100, hash: hashOf(net.sent[0]), reason })
      expect(sent).toEqual([sentCall()])
    }
  })

  it("with recordRejections off, no significant rejection is submitted, whatever the memory says", async () => {
    for (const reason of SIGNIFICANT) {
      const { outcome, sent } = await tickOne({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_100n, reason)] } }, { recordRejections: false })
      expect(outcome).toEqual({ ...run, status: "rejected", value: "11500000", timestamp: 1_700_000_100, reason })
      expect(sent).toEqual([])
    }
  })

  it("the same significant (reason, value) as the last submitted one is rejected again with no submit", async () => {
    const { outcome, sent } = await tickOne(
      { sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_200n, "deviate")] } },
      { lastSubmittedRejection: async () => ({ reason: "deviate", value: "11500000" }) },
    )
    expect(outcome).toEqual({ ...run, status: "rejected", value: "11500000", timestamp: 1_700_000_200, reason: "deviate" })
    expect(outcome).not.toHaveProperty("hash")
    expect(sent).toEqual([])
  })

  it("a new value or a new reason is a new rejection: submitted", async () => {
    const memory = { lastSubmittedRejection: async () => ({ reason: "deviate", value: "11500000" }) }
    const value = await tickOne({ sim: { retval: false, events: [refRej(11_600_000n, 1_700_000_300n, "deviate")] } }, memory)
    expect(value.outcome).toMatchObject({ status: "rejected", hash: hashOf(value.net.sent[0]) })
    expect(value.sent).toHaveLength(1)
    const reason = await tickOne({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_300n, "oob")] } }, memory)
    expect(reason.outcome).toMatchObject({ status: "rejected", reason: "oob", hash: hashOf(reason.net.sent[0]) })
    expect(reason.sent).toHaveLength(1)
  })

  it("a memory that cannot be read fails that oracle by error name, sending nothing", async () => {
    const { outcome, sent } = await tickOne(
      { sim: { retval: false, events: [refRej(11_500_000n, 1n, "deviate")] } },
      { lastSubmittedRejection: () => Promise.reject(new RangeError("no database")) },
    )
    expect(outcome).toEqual({ ...run, status: "failed", name: "RangeError" })
    expect(sent).toEqual([])
  })

  it("a broken-feed rejection with a price (bad_price, rescale, future_ts) is rejected and never submitted", async () => {
    // Every broken-feed reason but those whose ref_rej carries (0, 0) placeholders (feed_err, below).
    const priced = BROKEN.filter((r) => !NO_PRICE_REASONS.has(r))
    expect(priced.length).toBeGreaterThan(0)
    for (const reason of priced) {
      const { outcome, sent } = await tickOne({ sim: { retval: false, events: [refRej(-1n, 1_700_000_000n, reason)] } })
      expect(outcome).toEqual({ ...run, status: "rejected", value: "-1", timestamp: 1_700_000_000, reason })
      expect(sent).toEqual([])
    }
  })

  it("feed_err (3af9388: the feed's decimals or lastprice call failed) is a broken feed: rejected, never submitted, its (0, 0) placeholders blanked", async () => {
    expect(BROKEN).toContain("feed_err")
    const { outcome, sent } = await tickOne({ sim: { retval: false, events: [refRej(0n, 0n, "feed_err")] } })
    expect(outcome).toEqual({ ...run, status: "rejected", value: null, timestamp: null, reason: "feed_err" })
    expect(sent).toEqual([])
  })

  it("false with no ref_rej event is rejected with reason unknown, not submitted", async () => {
    // A ref_rej of another contract (the feed, say) is not the oracle's.
    const { outcome, sent } = await tickOne({ sim: { retval: false, events: [refRej(1n, 1n, "deviate", FEED)] } })
    expect(outcome).toEqual({ ...run, status: "rejected", value: null, timestamp: null, reason: "unknown" })
    expect(sent).toEqual([])
  })

  it("a submitted significant rejection takes its (reason, value) from the landed transaction's ref_rej", async () => {
    // The feed moved between the simulation and the landing: the landed event is what is on-chain.
    const moved = await tickOne({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_100n, "deviate")] }, landed: [refRej(9_000_000n, 1_700_000_200n, "decrease")] })
    expect(moved.outcome).toEqual({ ...run, status: "rejected", value: "9000000", timestamp: 1_700_000_200, hash: hashOf(moved.net.sent[0]), reason: "decrease" })
    // The feed failed by the time it landed: feed_err's (0, 0) are placeholders, not a point.
    const failed = await tickOne({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_100n, "deviate")] }, landed: [refRej(0n, 0n, "feed_err")] })
    expect(failed.outcome).toEqual({ ...run, status: "rejected", value: null, timestamp: null, hash: hashOf(failed.net.sent[0]), reason: "feed_err" })
  })

  it("without the landed ref_rej (no events, or none of the oracle's), the simulated pair stands", async () => {
    for (const landed of [[], [refRej(1n, 1n, "oob", FEED)]]) {
      const { outcome, net } = await tickOne({ sim: { retval: false, events: [refRej(11_500_000n, 1_700_000_100n, "deviate")] }, landed })
      expect(outcome).toEqual({ ...run, status: "rejected", value: "11500000", timestamp: 1_700_000_100, hash: hashOf(net.sent[0]), reason: "deviate" })
    }
  })

  it("a simulated accept that lands false takes the landed ref_rej's reason; a sync takes the landed ref_set", async () => {
    const rejected = await tickOne({ sim: { retval: true, events: [refSet(10_000_000n, 1n)] }, returned: false, landed: [refRej(11_500_000n, 2n, "deviate")] })
    expect(rejected.outcome).toEqual({ ...run, status: "rejected", value: "11500000", timestamp: 2, hash: hashOf(rejected.net.sent[0]), reason: "deviate" })
    const synced = await tickOne({ sim: { retval: false, events: [refRej(11_500_000n, 1n, "deviate")] }, returned: true, landed: [refSet(10_100_000n, 3n)] })
    expect(synced.outcome).toEqual({ ...run, status: "synced", value: "10100000", timestamp: 3, hash: hashOf(synced.net.sent[0]) })
  })

  it("the landed call decides: a simulated accept that lands false is a rejection (reason unknown), with the hash", async () => {
    const accept = await tickOne({ sim: { retval: true, events: [refSet(10_000_000n, 1_700_000_000n)] }, returned: false })
    expect(accept.outcome).toEqual({ ...run, status: "rejected", value: null, timestamp: null, hash: hashOf(accept.net.sent[0]), reason: "unknown" })
    // A submitted significant rejection that lands true: the feed moved meanwhile; synced, value unknown.
    const moved = await tickOne({ sim: { retval: false, events: [refRej(11_500_000n, 1n, "deviate")] }, returned: true })
    expect(moved.outcome).toEqual({ ...run, status: "synced", value: null, timestamp: null, hash: hashOf(moved.net.sent[0]) })
  })

  it("not_configured when the oracle has no feed_source view (a 665bb67 oracle: WasmVm MissingValue), sending nothing", async () => {
    const { outcome, chain, sent } = await tickOne({
      readError: new Error('HostError: Error(WasmVm, MissingValue)\n\nEvent log (newest first):\n   0: [Diagnostic Event] ... data:["trying to invoke non-existent contract function", feed_source]'),
    })
    expect(outcome).toEqual({ ...run, status: "not_configured", message: "the oracle has no feed_source function: its code predates sync_from_feed (principal 665bb67 or older)." })
    expect(chain.simulate).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it("error #15 after feed_source() named a feed is the feed's error, not FeedNotConfigured: still not_configured, worded so", async () => {
    const { outcome, sent } = await tickOne({ simError: new Error("HostError: Error(Contract, #15)") })
    expect(outcome).toMatchObject({ status: "not_configured" })
    const message = (outcome as { message: string }).message
    expect(message).toMatch(/the feed answered an error \(#15\)/)
    expect(message).not.toMatch(/no feed source/)
    expect(sent).toEqual([])
  })

  it("any other read or simulation error is no config error: it fails as itself, sending nothing", async () => {
    const read = await tickOne({ readError: new TypeError("fetch failed") })
    expect(read.outcome).toEqual({ ...run, status: "failed", name: "TypeError" })
    const sim = await tickOne({ simError: new Error("HostError: Error(Contract, #8)") })
    expect(sim.outcome).toEqual({ ...run, status: "failed", name: "Error" })
    expect(sim.sent).toEqual([])
  })

  it("an unexpected return value (neither true nor false) fails, sending nothing", async () => {
    const { outcome, sent } = await tickOne({ sim: { retval: undefined, events: [] } })
    expect(outcome).toEqual({ ...run, status: "failed", name: "Error" })
    expect(sent).toEqual([])
  })

  it("runs on mainnet: the key holds no privilege (push mode keeps its refusal)", async () => {
    const mainnet = { ...manifest, network: "mainnet" } as Manifest
    const { outcome, sent } = await tickOne({ sim: { retval: true, events: [refSet(10_000_000n, 1n)] } }, { manifest: mainnet })
    expect(outcome).toMatchObject({ status: "synced", mode: "feed" })
    expect(sent).toHaveLength(1)
  })

  it("targets the oracles it is given", async () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 9))
    const net = fakeNetwork({ [other]: { sim: { retval: true, events: [refSet(10_000_000n, 1n, other)] } } })
    const runs = await runFeed(net, { oracles: [other] })
    expect(runs).toMatchObject([{ oracle: other, outcome: { status: "synced", value: "10000000" } }])
    expect(net.chainFor).toHaveBeenCalledWith(other)
    expect(net.chains[other].simulated[0].invocation.contractId).toBe(other)
    expect(callOf(net.sent[0]).contractId).toBe(other)
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

describe("the RPC keeper account", () => {
  function fakeRpc() {
    const server = {
      simulateTransaction: vi.fn(async () => ({})),
      getLatestLedger: vi.fn(async () => ({ sequence: 9, closeTime: "1700000000" })),
      getAccount: vi.fn(async () => ({ sequenceNumber: () => "70" })),
      prepareTransaction: vi.fn(async (tx: Transaction) => tx),
      sendTransaction: vi.fn(async (tx: Transaction): Promise<{ status: string; hash?: string; errorResult?: xdr.TransactionResult; errorResultXdr?: string }> => ({
        status: "PENDING",
        hash: bytesToHex(tx.hash()),
      })),
      getTransaction: vi.fn(async (): Promise<Record<string, unknown>> => ({ status: "NOT_FOUND" })),
    }
    return server as typeof server & OracleRpcServer
  }
  const tx = () => buildInvocationEnvelope({ source: keeper.publicKey(), sequence: "70", networkPassphrase: manifest.networkPassphrase, invocation: SYNC })

  it("reads the sequence number with getAccount and prepares with prepareTransaction", async () => {
    const server = fakeRpc()
    const account = createKeeperAccount(manifest, { server })
    expect(await account.sequence(keeper.publicKey())).toBe("70")
    expect(server.getAccount).toHaveBeenCalledWith(keeper.publicKey())
    const built = tx()
    expect(await account.prepare(built)).toBe(built)
  })

  it("sends with sendTransaction and hands back the network's status, and a refusal's result (parsed, or from its XDR)", async () => {
    const server = fakeRpc()
    const account = createKeeperAccount(manifest, { server })
    expect(await account.send(tx())).toEqual({ status: "PENDING" })
    server.sendTransaction.mockResolvedValueOnce({ status: "ERROR", errorResult: txResult("txBadSeq") })
    expect((await account.send(tx())).errorResult?.result.type).toBe("txBadSeq")
    server.sendTransaction.mockResolvedValueOnce({ status: "ERROR", errorResultXdr: txResult("txBadSeq").toXdr("base64") })
    expect((await account.send(tx())).errorResult?.result.type).toBe("txBadSeq")
    // An undecodable result is no result: the status stands.
    server.sendTransaction.mockResolvedValueOnce({ status: "ERROR", errorResultXdr: "not-xdr" })
    expect(await account.send(tx())).toEqual({ status: "ERROR" })
  })

  it("looks a hash up once: not found, or in a ledger with its return value and contract events, or failed with its result", async () => {
    const server = fakeRpc()
    const account = createKeeperAccount(manifest, { server })
    expect(await account.lookup("ab".repeat(32))).toMatchObject({ status: "NOT_FOUND" })
    expect(server.getTransaction).toHaveBeenCalledTimes(1)
    const landed = refRej(11_500_000n, 2n, "deviate").event
    server.getTransaction.mockResolvedValueOnce({ status: "SUCCESS", returnValue: xdr.ScVal.scvBool(false), events: { contractEventsXdr: [[landed]] } })
    expect(await account.lookup("ab".repeat(32))).toMatchObject({ status: "SUCCESS", returnValue: false, contractEvents: [landed] })
    const result = txResult("txBadSeq")
    server.getTransaction.mockResolvedValueOnce({ status: "FAILED", resultXdr: result })
    expect(await account.lookup("ab".repeat(32))).toMatchObject({ status: "FAILED", failure: { result } })
  })

  it("a whole run over RPC: one getAccount, two sends with consecutive numbers, each after the previous one is in a ledger", async () => {
    const server = fakeRpc()
    const sent: Transaction[] = []
    server.sendTransaction.mockImplementation(async (t: Transaction) => {
      sent.push(t)
      return { status: "PENDING", hash: bytesToHex(t.hash()) }
    })
    server.getTransaction.mockImplementation(async () => ({ status: "SUCCESS", returnValue: xdr.ScVal.scvBool(true) }))
    const net = fakeNetwork({ [A]: { sim: { retval: true, events: [] } }, [B]: { sim: { retval: true, events: [] } } })
    const runs = await runFeed(net, { account: createKeeperAccount(manifest, { server }) })
    expect(runs.map((r) => r.outcome.status)).toEqual(["synced", "synced"])
    expect(server.getAccount).toHaveBeenCalledTimes(1)
    expect(sent.map((t) => t.sequence)).toEqual(["71", "72"])
    expect(server.getTransaction.mock.invocationCallOrder[0]).toBeLessThan(server.sendTransaction.mock.invocationCallOrder[1])
  })
})
