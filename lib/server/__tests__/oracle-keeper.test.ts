// @vitest-environment node
import { Keypair, Transaction, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import localExample from "@/config/manifests/local.example.json"
import { bytesToHex } from "@/lib/protocol/bytes"
import { parseManifest } from "@/lib/protocol/manifest"
import { buildInvocationEnvelope, type ContractInvocation } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"

vi.mock("server-only", () => ({}))

import {
  ORACLE_APY_PERCENT,
  OracleKeeperConfigError,
  createOracleChain,
  nextReferenceValue,
  tickOracle,
  type OracleChain,
  type OracleRpcServer,
} from "../oracle-keeper"

const manifest = parseManifest(localExample)
const ORACLE = manifest.shared.oracle
const keeper = Keypair.random()
const YEAR = 31_536_000

/** A chain whose reads answer from `state` and whose sends are recorded. */
function fakeChain(state: { admin: string; value: bigint; timestamp: bigint; now: number }) {
  const sent: { signer: string; invocation: ContractInvocation }[] = []
  const chain: OracleChain = {
    read: vi.fn(async (fn) => (fn === "get_admin" ? state.admin : fn === "get_reference_value" ? state.value : state.timestamp)),
    ledgerTime: vi.fn(async () => state.now),
    send: vi.fn(async (signer, invocation) => {
      sent.push({ signer: signer.publicKey(), invocation })
      return "ab".repeat(32)
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
    expect(tick).toEqual({ status: "updated", value: "10000027", timestamp: 2_800, hash: "ab".repeat(32) })
    expect(sent).toEqual([
      {
        signer: keeper.publicKey(),
        invocation: {
          contractId: ORACLE,
          functionName: "set_reference_value",
          args: [
            { type: "address", value: keeper.publicKey() },
            { type: "i128", value: "10000027" },
            { type: "u64", value: "2800" },
          ],
        },
      },
    ])
  })

  it("sends nothing when the ledger clock has not moved", async () => {
    const { chain, sent } = fakeChain({ ...base, now: 1_000 })
    expect(await tickOracle({ manifest, secret: keeper.secret(), chain })).toEqual({ status: "unchanged", value: "10000000", timestamp: 1_000 })
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
    const hash = await chain.send(keeper, invocation)
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
        invocation: { ...invocation, args: [invocation.args[0], { type: "i128", value: "99999999" }, invocation.args[2]] },
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
})
