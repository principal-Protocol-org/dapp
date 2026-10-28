// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { Keypair, StrKey, Transaction, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { beforeEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { bytesToHex } from "@/lib/protocol/bytes"
import { parseManifest } from "@/lib/protocol/manifest"
import { buildInvocationEnvelope, type ContractInvocation } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"

// `server-only` throws outside a react-server bundle; the guard itself is checked statically below.
vi.mock("server-only", () => ({}))

import {
  BadSequenceError,
  FAUCET_AMOUNT,
  FaucetConfigError,
  FaucetTxError,
  createStellarFaucetChain,
  resetFaucetStateForTests,
  runFaucet,
  type FaucetAccount,
  type FaucetChain,
} from "../faucet"

const manifest = parseManifest(testnetJson)
const market = manifest.markets[0]
const UNITS = 10n ** BigInt(market.underlying.decimals)
const T0 = 1_800_000_000_000

const contract = () => StrKey.encodeContract(Keypair.random().rawPublicKey())
const user = () => Keypair.random().publicKey()

/** A second market with its own PT and YT, on the same test asset. */
const twoMarkets: Manifest = {
  ...manifest,
  markets: [
    market,
    { ...market, marketId: "second", contracts: { ...market.contracts, pt: contract(), yt: contract() } },
  ],
}

type Account = { account: FaucetAccount; allowed: boolean; assets: Set<string> }

/** A fake chain recording every call, with per-account state; writes update it like the chain would. */
function fakeChain(initial: Partial<Account> = {}) {
  const accounts = new Map<string, Account>()
  const of = (address: string): Account => {
    let a = accounts.get(address)
    if (!a) {
      a = {
        account: initial.account ?? { exists: true, trustline: { authorized: false, balance: 0n } },
        allowed: initial.allowed ?? false,
        assets: new Set(initial.assets ?? []),
      }
      accounts.set(address, a)
    }
    return a
  }
  const calls: string[] = []
  const chain = {
    readAccount: vi.fn(async (address: string) => of(address).account),
    isAllowed: vi.fn(async (address: string) => of(address).allowed),
    isAllowedForAsset: vi.fn(async (address: string, asset: string) => of(address).assets.has(asset)),
    setAuthorized: vi.fn(async (address: string) => {
      calls.push(`set_authorized ${address}`)
      const a = of(address)
      if (a.account.exists && a.account.trustline) a.account = { exists: true, trustline: { ...a.account.trustline, authorized: true } }
    }),
    grantAccount: vi.fn(async (address: string) => {
      calls.push(`grant_account ${address}`)
      of(address).allowed = true
    }),
    grantAsset: vi.fn(async (address: string, asset: string) => {
      calls.push(`grant_asset ${address} ${asset}`)
      of(address).assets.add(asset)
    }),
    pay: vi.fn(async (address: string, _asset: unknown, amount: bigint) => {
      calls.push(`pay ${address} ${amount}`)
    }),
  } satisfies FaucetChain
  return { chain, calls, of }
}

const granted = (m: Manifest) => new Set(m.markets.flatMap((x) => [x.contracts.pt, x.contracts.yt]))

beforeEach(() => {
  resetFaucetStateForTests()
})

describe("runFaucet", () => {
  it("refuses on mainnet", async () => {
    const { chain, calls } = fakeChain()
    const mainnet: Manifest = { ...manifest, network: "mainnet", networkPassphrase: "Public Global Stellar Network ; September 2015" }
    await expect(runFaucet({ account: user(), manifest: mainnet, ip: "1.1.1.1", now: T0, chain })).resolves.toEqual({ error: "network" })
    expect(chain.readAccount).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it("refuses a testnet manifest carrying another network's passphrase", async () => {
    const { chain } = fakeChain()
    const forged: Manifest = { ...manifest, networkPassphrase: "Public Global Stellar Network ; September 2015" }
    await expect(runFaucet({ account: user(), manifest: forged, ip: "1.1.1.1", now: T0, chain })).resolves.toEqual({ error: "network" })
    expect(chain.readAccount).not.toHaveBeenCalled()
  })

  it("rate limits per address and ip", async () => {
    const { chain } = fakeChain()
    const a = user()
    const b = user()
    await expect(runFaucet({ account: a, manifest, ip: "1.1.1.1", now: T0, chain })).resolves.toHaveProperty("performed")
    // Same address from another IP, and another address from the same IP, within 60 s.
    await expect(runFaucet({ account: a, manifest, ip: "2.2.2.2", now: T0 + 59_999, chain })).resolves.toEqual({ error: "rate_limited" })
    await expect(runFaucet({ account: b, manifest, ip: "1.1.1.1", now: T0 + 30_000, chain })).resolves.toEqual({ error: "rate_limited" })
    // A refused request reads nothing from the chain.
    expect(chain.readAccount).toHaveBeenCalledTimes(1)
    // 60 s later both are free again.
    await expect(runFaucet({ account: b, manifest, ip: "1.1.1.1", now: T0 + 60_000, chain })).resolves.toHaveProperty("performed")
  })

  it("performs every missing step for a fresh trustline, in order", async () => {
    const { chain, calls } = fakeChain()
    const a = user()
    await expect(runFaucet({ account: a, manifest, ip: "1.1.1.1", now: T0, chain })).resolves.toEqual({
      performed: ["authorize", "grant_account", "grant_pt", "grant_yt", "pay"],
    })
    expect(calls).toEqual([
      `set_authorized ${a}`,
      `grant_account ${a}`,
      `grant_asset ${a} ${market.contracts.pt}`,
      `grant_asset ${a} ${market.contracts.yt}`,
      `pay ${a} ${FAUCET_AMOUNT * UNITS}`,
    ])
    expect(chain.setAuthorized).toHaveBeenCalledWith(a, market.underlying)
    expect(chain.pay).toHaveBeenCalledWith(a, market.underlying, 10_000n * UNITS)
  })

  it("is idempotent", async () => {
    const authorized = (balance: bigint): FaucetAccount => ({ exists: true, trustline: { authorized: true, balance } })
    const empty = fakeChain({ account: authorized(0n), allowed: true, assets: granted(manifest) })
    await expect(runFaucet({ account: user(), manifest, ip: "1.1.1.1", now: T0, chain: empty.chain })).resolves.toEqual({ performed: ["pay"] })

    const below = fakeChain({ account: authorized(1_000n * UNITS - 1n), allowed: true, assets: granted(manifest) })
    await expect(runFaucet({ account: user(), manifest, ip: "2.2.2.2", now: T0, chain: below.chain })).resolves.toEqual({ performed: ["pay"] })

    const funded = fakeChain({ account: authorized(1_000n * UNITS), allowed: true, assets: granted(manifest) })
    await expect(runFaucet({ account: user(), manifest, ip: "3.3.3.3", now: T0, chain: funded.chain })).resolves.toEqual({ performed: [] })
    expect(funded.calls).toEqual([])
  })

  it("grants PT and YT for every market", async () => {
    const { chain, calls } = fakeChain({ account: { exists: true, trustline: { authorized: true, balance: 5_000n * UNITS } }, allowed: true })
    const a = user()
    await expect(runFaucet({ account: a, manifest: twoMarkets, ip: "1.1.1.1", now: T0, chain })).resolves.toEqual({
      performed: ["grant_pt", "grant_yt", "grant_pt", "grant_yt"],
    })
    expect(calls).toEqual(twoMarkets.markets.flatMap((m) => [`grant_asset ${a} ${m.contracts.pt}`, `grant_asset ${a} ${m.contracts.yt}`]))
    // Grants already present are read first and skipped.
    for (const m of twoMarkets.markets) {
      expect(chain.isAllowedForAsset).toHaveBeenCalledWith(a, m.contracts.pt)
      expect(chain.isAllowedForAsset).toHaveBeenCalledWith(a, m.contracts.yt)
    }
  })

  it("skips a grant already present on one market only", async () => {
    const second = twoMarkets.markets[1].contracts
    const { chain } = fakeChain({
      account: { exists: true, trustline: { authorized: true, balance: 5_000n * UNITS } },
      allowed: true,
      assets: new Set([market.contracts.pt, market.contracts.yt, second.pt]),
    })
    await expect(runFaucet({ account: user(), manifest: twoMarkets, ip: "1.1.1.1", now: T0, chain })).resolves.toEqual({ performed: ["grant_yt"] })
    expect(chain.grantAsset).toHaveBeenCalledWith(expect.any(String), second.yt)
  })

  it("refuses without trustline", async () => {
    const none = fakeChain({ account: { exists: true, trustline: null } })
    await expect(runFaucet({ account: user(), manifest, ip: "1.1.1.1", now: T0, chain: none.chain })).resolves.toEqual({ error: "no_trustline" })
    expect(none.calls).toEqual([])

    const missing = fakeChain({ account: { exists: false } })
    await expect(runFaucet({ account: user(), manifest, ip: "2.2.2.2", now: T0, chain: missing.chain })).resolves.toEqual({ error: "no_trustline" })
    expect(missing.calls).toEqual([])
  })

  it("serialises issuer transactions and retries a bad sequence once", async () => {
    const { chain, calls } = fakeChain()
    let inFlight = 0
    let maxInFlight = 0
    let badSeqs = 1
    const slow = <A extends unknown[]>(inner: (...args: A) => Promise<void>, name: string) =>
      vi.fn(async (...args: A) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 3))
        inFlight -= 1
        if (name === "set_authorized" && badSeqs > 0) {
          badSeqs -= 1
          calls.push(`bad_seq ${String(args[0])}`)
          throw new BadSequenceError()
        }
        await inner(...args)
      })
    chain.setAuthorized = slow(chain.setAuthorized, "set_authorized")
    chain.grantAccount = slow(chain.grantAccount, "grant_account")
    chain.grantAsset = slow(chain.grantAsset, "grant_asset")
    chain.pay = slow(chain.pay, "pay")

    const a = user()
    const b = user()
    const [ra, rb] = await Promise.all([
      runFaucet({ account: a, manifest, ip: "1.1.1.1", now: T0, chain }),
      runFaucet({ account: b, manifest, ip: "2.2.2.2", now: T0, chain }),
    ])
    const all = ["authorize", "grant_account", "grant_pt", "grant_yt", "pay"]
    expect(ra).toEqual({ performed: all })
    expect(rb).toEqual({ performed: all })
    // Never two transactions at once, across both requests.
    expect(maxInFlight).toBe(1)
    // The first transaction hit a stale sequence and was sent again, once.
    expect(calls[0]).toBe(`bad_seq ${a}`)
    expect(calls[1]).toBe(`set_authorized ${a}`)
    expect(chain.setAuthorized).toHaveBeenCalledTimes(3)
    expect(calls.filter((c) => c.startsWith("bad_seq"))).toHaveLength(1)
  })

  it("retries a bad sequence only once, then fails naming the step", async () => {
    const { chain } = fakeChain()
    chain.setAuthorized = vi.fn(async () => {
      throw new BadSequenceError()
    })
    await expect(runFaucet({ account: user(), manifest, ip: "1.1.1.1", now: T0, chain })).rejects.toMatchObject({
      name: "FaucetStepError",
      step: "authorize",
    })
    expect(chain.setAuthorized).toHaveBeenCalledTimes(2)
    expect(chain.grantAccount).not.toHaveBeenCalled()
  })

  it("does not retry any other failure, and keeps the queue usable after it", async () => {
    const { chain } = fakeChain()
    chain.grantAccount = vi.fn(async () => {
      throw new FaucetTxError("the network rejected it")
    })
    await expect(runFaucet({ account: user(), manifest, ip: "1.1.1.1", now: T0, chain })).rejects.toMatchObject({ step: "grant_account" })
    expect(chain.grantAccount).toHaveBeenCalledTimes(1)
    // The next request is not blocked behind the failed one.
    const next = fakeChain({ account: { exists: true, trustline: { authorized: true, balance: 0n } }, allowed: true, assets: granted(manifest) })
    await expect(runFaucet({ account: user(), manifest, ip: "2.2.2.2", now: T0, chain: next.chain })).resolves.toEqual({ performed: ["pay"] })
  })
})

// ---------------------------------------------------------------- the real Stellar chain

const issuer = Keypair.random()
const admin = Keypair.random()
const onIssuer: Manifest = {
  ...manifest,
  markets: [{ ...market, underlying: { ...market.underlying, issuer: issuer.publicKey() } }],
}
const asset = onIssuer.markets[0].underlying

type Sent = Transaction
function fakeRpc() {
  const sent: Sent[] = []
  const server = {
    getAccount: vi.fn<(address: string) => Promise<{ sequenceNumber(): string }>>(async () => ({ sequenceNumber: () => "70" })),
    prepareTransaction: vi.fn(async (tx: Transaction) => tx),
    sendTransaction: vi.fn(async (tx: Transaction): Promise<{ status: string; hash?: string; errorResult?: xdr.TransactionResult }> => {
      sent.push(tx)
      return { status: "PENDING", hash: bytesToHex(tx.hash()) }
    }),
    getTransaction: vi.fn<(hash: string) => Promise<{ status: string }>>(async () => ({ status: "SUCCESS" })),
    simulateTransaction: vi.fn(),
    getLedgerEntries: vi.fn(),
  }
  return { server, sent }
}

const callXdr = (tx: Transaction) => {
  const [op] = tx.operations
  if (op?.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") return undefined
  return op.func.invokeContract.toXdr("base64")
}
const expectedCall = (invocation: ContractInvocation) =>
  callXdr(buildInvocationEnvelope({ source: issuer.publicKey(), sequence: "0", networkPassphrase: manifest.networkPassphrase, invocation }))
const signedBy = (tx: Transaction, kp: Keypair) =>
  tx.signatures.some((s) => bytesToHex(s.hint.value) === bytesToHex(kp.rawPublicKey().slice(-4)))

const env = { FAUCET_ISSUER_SECRET: issuer.secret(), FAUCET_PERMISSIONING_ADMIN_SECRET: admin.secret() }

describe("the Stellar faucet chain", () => {
  it("needs the issuer key, and never puts a key in its errors", () => {
    expect(() => createStellarFaucetChain(onIssuer, { env: {} })).toThrow(FaucetConfigError)
    const bad = "SNOTAVALIDSECRETKEYATALL"
    try {
      createStellarFaucetChain(onIssuer, { env: { FAUCET_ISSUER_SECRET: bad } })
      throw new Error("expected a FaucetConfigError")
    } catch (error) {
      expect(error).toBeInstanceOf(FaucetConfigError)
      expect((error as Error).message).not.toContain(bad)
    }
    try {
      createStellarFaucetChain(onIssuer, { env: { FAUCET_ISSUER_SECRET: issuer.secret(), FAUCET_PERMISSIONING_ADMIN_SECRET: "SBAD" } })
      throw new Error("expected a FaucetConfigError")
    } catch (error) {
      expect(error).toBeInstanceOf(FaucetConfigError)
      expect((error as Error).message).not.toContain("SBAD")
    }
  })

  it("refuses an issuer key that is not the test asset's issuer", () => {
    const other = Keypair.random()
    expect(() => createStellarFaucetChain(onIssuer, { env: { FAUCET_ISSUER_SECRET: other.secret() } })).toThrow(FaucetConfigError)
    try {
      createStellarFaucetChain(onIssuer, { env: { FAUCET_ISSUER_SECRET: other.secret() } })
    } catch (error) {
      expect((error as Error).message).not.toContain(other.secret())
    }
  })

  it("authorizes with SAC set_authorized(account, true), signed by the issuer", async () => {
    const { server, sent } = fakeRpc()
    const chain = createStellarFaucetChain(onIssuer, { env, server })
    const a = user()
    await chain.setAuthorized(a, asset)
    expect(sent).toHaveLength(1)
    const [tx] = sent
    expect(tx.source).toBe(issuer.publicKey())
    expect(tx.sequence).toBe("71")
    expect(callXdr(tx)).toBe(
      expectedCall({ contractId: asset.sac, functionName: "set_authorized", args: [{ type: "address", value: a }, { type: "bool", value: true }] }),
    )
    expect(signedBy(tx, issuer)).toBe(true)
    expect(server.prepareTransaction).toHaveBeenCalledTimes(1)
    expect(server.getTransaction).toHaveBeenCalledWith(bytesToHex(tx.hash()))
  })

  it("grants with Permissioning grant_account and grant_asset, signed by the permissioning admin", async () => {
    const { server, sent } = fakeRpc()
    const chain = createStellarFaucetChain(onIssuer, { env, server })
    const a = user()
    const perm = onIssuer.shared.permissioning
    await chain.grantAccount(a)
    await chain.grantAsset(a, market.contracts.pt)
    expect(sent.map((tx) => tx.source)).toEqual([admin.publicKey(), admin.publicKey()])
    expect(callXdr(sent[0])).toBe(
      expectedCall({ contractId: perm, functionName: "grant_account", args: [{ type: "address", value: admin.publicKey() }, { type: "address", value: a }] }),
    )
    expect(callXdr(sent[1])).toBe(
      expectedCall({
        contractId: perm,
        functionName: "grant_asset",
        args: [
          { type: "address", value: admin.publicKey() },
          { type: "address", value: a },
          { type: "address", value: market.contracts.pt },
        ],
      }),
    )
    expect(sent.every((tx) => signedBy(tx, admin) && !signedBy(tx, issuer))).toBe(true)
  })

  it("uses the issuer as permissioning admin when no admin key is set", async () => {
    const { server, sent } = fakeRpc()
    const chain = createStellarFaucetChain(onIssuer, { env: { FAUCET_ISSUER_SECRET: issuer.secret() }, server })
    await chain.grantAccount(user())
    expect(sent[0].source).toBe(issuer.publicKey())
    expect(signedBy(sent[0], issuer)).toBe(true)
  })

  it("pays with one classic payment of the raw amount, from the issuer", async () => {
    const { server, sent } = fakeRpc()
    const chain = createStellarFaucetChain(onIssuer, { env, server })
    const a = user()
    await chain.pay(a, asset, FAUCET_AMOUNT * UNITS)
    expect(sent).toHaveLength(1)
    const [tx] = sent
    expect(tx.source).toBe(issuer.publicKey())
    expect(tx.operations).toHaveLength(1)
    expect(tx.operations[0]).toMatchObject({
      type: "payment",
      destination: a,
      asset: { code: asset.code, issuer: asset.issuer },
      amount: "10000.0000000",
    })
    expect(server.prepareTransaction).not.toHaveBeenCalled()
    expect(signedBy(tx, issuer)).toBe(true)
  })

  it("turns a txBadSeq refusal into BadSequenceError, and any other refusal into FaucetTxError", async () => {
    const { server } = fakeRpc()
    const refusal = (result: xdr.TransactionResultResult) => ({
      status: "ERROR",
      errorResult: new xdr.TransactionResult({ feeCharged: 100n, result, ext: xdr.TransactionResultExt.v0() }),
    })
    server.sendTransaction.mockResolvedValueOnce(refusal(xdr.TransactionResultResult.txBadSeq()))
    const chain = createStellarFaucetChain(onIssuer, { env, server })
    await expect(chain.pay(user(), asset, 1n)).rejects.toBeInstanceOf(BadSequenceError)
    server.sendTransaction.mockResolvedValueOnce(refusal(xdr.TransactionResultResult.txInsufficientBalance()))
    await expect(chain.pay(user(), asset, 1n)).rejects.toBeInstanceOf(FaucetTxError)
    server.getTransaction.mockResolvedValueOnce({ status: "FAILED" })
    await expect(chain.grantAccount(user())).rejects.toBeInstanceOf(FaucetTxError)
  })

  it("refuses a prepared transaction that is not the requested call, before signing it", async () => {
    const { server, sent } = fakeRpc()
    server.prepareTransaction.mockImplementation(async (tx: Transaction) =>
      buildInvocationEnvelope({
        source: tx.source,
        sequence: "70",
        networkPassphrase: manifest.networkPassphrase,
        invocation: { contractId: onIssuer.shared.permissioning, functionName: "transfer_admin", args: [] },
      }),
    )
    const chain = createStellarFaucetChain(onIssuer, { env, server })
    await expect(chain.grantAccount(user())).rejects.toThrow(/not the transaction that was requested/)
    expect(sent).toHaveLength(0)
  })

  it("reads the account and its trustline from RPC ledger entries", async () => {
    const { server } = fakeRpc()
    const chain = createStellarFaucetChain(onIssuer, { env, server })
    const a = user()
    server.getLedgerEntries.mockResolvedValueOnce({ entries: [] })
    await expect(chain.readAccount(a, asset)).resolves.toEqual({ exists: false })
    server.getLedgerEntries.mockResolvedValueOnce({ entries: [{ val: { type: "account", value: {} } }] })
    await expect(chain.readAccount(a, asset)).resolves.toEqual({ exists: true, trustline: null })
    server.getLedgerEntries.mockResolvedValueOnce({
      entries: [
        { val: { type: "account", value: {} } },
        { val: { type: "trustline", value: { balance: 25n, flags: 1 } } },
      ],
    })
    await expect(chain.readAccount(a, asset)).resolves.toEqual({ exists: true, trustline: { authorized: true, balance: 25n } })
    server.getLedgerEntries.mockResolvedValueOnce({
      entries: [
        { val: { type: "account", value: {} } },
        { val: { type: "trustline", value: { balance: 0n, flags: 2 } } },
      ],
    })
    await expect(chain.readAccount(a, asset)).resolves.toEqual({ exists: true, trustline: { authorized: false, balance: 0n } })
    // Both keys in one request: the account, and its trustline to the test asset.
    const keys = server.getLedgerEntries.mock.calls[0] as xdr.LedgerKey[]
    expect(keys.map((k) => k.type)).toEqual(["account", "trustline"])
  })

  it("reads Permissioning is_allowed and is_allowed_for_asset strictly", async () => {
    const { server } = fakeRpc()
    const sim = (value: unknown) => ({ latestLedger: 9, minResourceFee: "0", result: { auth: [], retval: nativeToScVal(value) } })
    server.simulateTransaction.mockResolvedValueOnce(sim(true)).mockResolvedValueOnce(sim(false)).mockResolvedValueOnce(sim(1))
    const chain = createStellarFaucetChain(onIssuer, { env, server })
    const a = user()
    await expect(chain.isAllowed(a)).resolves.toBe(true)
    await expect(chain.isAllowedForAsset(a, market.contracts.pt)).resolves.toBe(false)
    // A value that is not a boolean is an error, never a guess.
    await expect(chain.isAllowed(a)).rejects.toThrow()
    const [first] = server.simulateTransaction.mock.calls[1] as [Transaction]
    expect(callXdr(first)).toBe(
      expectedCall({
        contractId: onIssuer.shared.permissioning,
        functionName: "is_allowed_for_asset",
        args: [{ type: "address", value: a }, { type: "address", value: market.contracts.pt }],
      }),
    )
  })
})

// ---------------------------------------------------------------- the secret guard

const ROOT = join(__dirname, "..", "..", "..")
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : []
  })
}

describe("server secrets", () => {
  it("appear only in files that start with import \"server-only\"", () => {
    const files = ["app", "components", "hooks", "lib"].flatMap((d) => sourceFiles(join(ROOT, d)))
    const offenders = files
      .filter((f) => readFileSync(f, "utf8").includes("FAUCET_"))
      .filter((f) => !readFileSync(f, "utf8").startsWith('import "server-only"'))
      .map((f) => relative(ROOT, f))
    expect(offenders).toEqual([])
    expect(files.some((f) => f.endsWith(join("lib", "server", "faucet.ts")))).toBe(true)
  })
})
