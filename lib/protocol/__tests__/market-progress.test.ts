// @vitest-environment node
import { Address, Contract, Keypair, StrKey, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { deriveMarketContracts } from "../factory"
import { parseManifest } from "../manifest"
import { marketProgress, requiredGrants, type Grant } from "../market-progress"
import type { ContractReader } from "../reader"
import type { Manifest, MarketContractName } from "../types"
import type { LedgerEntriesRpc } from "../wasm"

/**
 * Spec 0002 §5 "Resuming": the wizard's step is derived from the chain, not from a saved draft:
 * which predicted contracts exist, what the Router and RiskControl report, which grants hold, and
 * whether the pool holds liquidity.
 */

const contractAt = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
const pin = (fill: string) => fill.repeat(32)
const SAC = contractAt(7)
const base = parseManifest(structuredClone(testnetJson))
const WASM: Record<MarketContractName, string> = {
  sy: pin("a1"),
  pt: pin("a2"),
  yt: pin("a3"),
  config: pin("a4"),
  manager: pin("a5"),
  pool: pin("a6"),
  recoveryEscrow: pin("a7"),
}
const manifest: Manifest = {
  ...base,
  shared: { ...base.shared, factory: contractAt(40) },
  wasmHashes: { ...WASM },
  testAsset: { code: "USDY", issuer: Keypair.random().publicKey(), sac: SAC, decimals: 7, displayName: "USDY (test)" },
}
const { permissioning, riskControl, router } = manifest.shared
const SALT = "11".repeat(32)
const p = deriveMarketContracts(manifest, SALT)
const TREASURY = Keypair.random().publicKey()
const ADMIN = Keypair.random().publicKey()

const KINDS: MarketContractName[] = ["sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow"]
const TOKENS: MarketContractName[] = ["sy", "pt", "yt"]
const ENGINE: MarketContractName[] = [...TOKENS, "config", "manager"]

/** Ledger entries: the instance of each deployed contract, running `code[kind]` (the pin by default). */
function chain(deployed: MarketContractName[], code: Partial<Record<MarketContractName, string>> = {}): LedgerEntriesRpc {
  return {
    async getLedgerEntries(...keys: xdr.LedgerKey[]) {
      const entries = deployed
        .map((kind) => {
          const id = p[kind]
          const key = new Contract(id).getFootprint()
          if (!keys.some((k) => k.toXDR("base64") === key.toXDR("base64"))) return null
          const executable = xdr.ContractExecutable.contractExecutableWasm(Buffer.from(code[kind] ?? WASM[kind], "hex"))
          const val = xdr.LedgerEntryData.contractData(
            new xdr.ContractDataEntry({
              ext: xdr.ExtensionPoint.v0(),
              contract: Address.fromString(id).toScAddress(),
              key: xdr.ScVal.scvLedgerKeyContractInstance(),
              durability: xdr.ContractDataDurability.persistent,
              val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
            }),
          )
          return { key, val }
        })
        .filter((e) => e !== null)
      return { entries }
    },
  }
}

const failingChain: LedgerEntriesRpc = {
  async getLedgerEntries() {
    throw new Error("rpc 503")
  },
}

/** A reader keyed by `contract.function(args…)`; anything not listed fails like an RPC error. */
function tableReader(table: Record<string, unknown>, calls: string[] = []): ContractReader {
  return (async (call: { contractId: string; functionName: string; args?: { value: unknown }[] }) => {
    const args = (call.args ?? []).map((a) => String(a.value)).join(",")
    const key = `${call.contractId}.${call.functionName}(${args})`
    calls.push(key)
    if (!(key in table)) throw new Error(`no answer for ${key}`)
    const value = table[key]
    if (value instanceof Error) throw value
    return { value, latestLedger: 10, minResourceFee: "0" }
  }) as ContractReader
}

/** Every read a fully deployed market answers, with each grant held unless `missing` lists it. */
function deployedMarket(over: { consumers?: boolean; registered?: boolean; missing?: Grant[]; lp?: bigint } = {}): Record<string, unknown> {
  const t: Record<string, unknown> = {
    [`${p.config}.underlying()`]: SAC,
    [`${p.config}.treasury()`]: TREASURY,
    [`${SAC}.admin()`]: ADMIN,
    [`${riskControl}.is_consumer(${p.sy})`]: over.consumers ?? true,
    [`${riskControl}.is_consumer(${p.manager})`]: over.consumers ?? true,
    [`${router}.is_registered(${p.pool})`]: over.registered ?? true,
    [`${p.pool}.lp_total_supply()`]: over.lp ?? 0n,
  }
  const missing = (g: Grant) => (over.missing ?? []).some((m) => m.kind === g.kind && m.account === g.account && m.asset === g.asset)
  for (const g of requiredGrants(p, { sac: SAC, treasury: TREASURY, admin: ADMIN })) {
    const held = !missing(g)
    if (g.kind === "authorized") t[`${SAC}.authorized(${g.account})`] = held
    if (g.kind === "account") t[`${permissioning}.is_allowed(${g.account})`] = held
    if (g.kind === "asset") t[`${permissioning}.is_allowed_for_asset(${g.account},${g.asset})`] = held
  }
  return t
}

describe("requiredGrants: deploy.sh's compliance lists (step 5)", () => {
  it("SAC authorization and Permissioning account grants for SY, manager, pool, escrow and treasury; the admin's account grant; PT and YT for pool, escrow and admin", () => {
    const grants = requiredGrants(p, { sac: SAC, treasury: TREASURY, admin: ADMIN })
    const holders = (kind: Grant["kind"]) => grants.filter((g) => g.kind === kind).map((g) => `${g.holder}${g.asset ? `:${g.asset === p.pt ? "pt" : "yt"}` : ""}`)
    expect(holders("authorized")).toEqual(["sy", "manager", "pool", "recoveryEscrow", "treasury"])
    expect(holders("account")).toEqual(["sy", "manager", "pool", "recoveryEscrow", "treasury", "admin"])
    expect(holders("asset")).toEqual(["pool:pt", "pool:yt", "recoveryEscrow:pt", "recoveryEscrow:yt", "admin:pt", "admin:yt"])
    const treasury = grants.find((g) => g.holder === "treasury" && g.kind === "authorized")
    expect(treasury?.account).toBe(TREASURY)
    expect(treasury?.asset).toBeUndefined()
    expect(grants.find((g) => g.holder === "admin" && g.kind === "account")).toMatchObject({ account: ADMIN })
  })
})

describe("marketProgress: the step, derived from the chain", () => {
  it("nothing deployed: step 1, the predicted addresses, and no contract read", async () => {
    const calls: string[] = []
    const r = await marketProgress(tableReader({}, calls), chain([]), manifest, SALT)
    expect(r.step).toBe(1)
    expect(r.predicted).toEqual(p)
    expect(r.deployed).toEqual(Object.fromEntries(KINDS.map((k) => [k, false])))
    expect(r.phases).toEqual({ tokens: false, engine: false, poolAndEscrow: false })
    expect(r.live).toBeUndefined()
    expect(calls).toEqual([])
  })

  it("progress resumes at step 3 when only the tokens exist", async () => {
    const r = await marketProgress(tableReader({}), chain(TOKENS), manifest, SALT)
    expect(r.step).toBe(3)
    expect(r.phases).toEqual({ tokens: true, engine: false, poolAndEscrow: false })
    expect(r.deployed).toMatchObject({ sy: true, pt: true, yt: true, config: false, pool: false })
  })

  it("step 3 with the tokens and the engine: only the pool and escrow are left", async () => {
    const r = await marketProgress(tableReader({}), chain(ENGINE), manifest, SALT)
    expect(r.step).toBe(3)
    expect(r.phases).toEqual({ tokens: true, engine: true, poolAndEscrow: false })
  })

  it("step 4 when every contract exists but RiskControl or the Router does not know it yet", async () => {
    const unwired = await marketProgress(tableReader(deployedMarket({ consumers: false })), chain(KINDS), manifest, SALT)
    expect(unwired.step).toBe(4)
    expect(unwired.live?.wiring).toEqual({ syConsumer: false, managerConsumer: false, registered: true })
    expect(unwired.live).toMatchObject({ underlying: SAC, admin: ADMIN, treasury: TREASURY })
    const unregistered = await marketProgress(tableReader(deployedMarket({ registered: false })), chain(KINDS), manifest, SALT)
    expect(unregistered.step).toBe(4)
  })

  it("step 5 while a grant is missing, each grant listed with its on-chain state", async () => {
    const missing: Grant = { kind: "asset", holder: "admin", account: ADMIN, asset: p.yt }
    const r = await marketProgress(tableReader(deployedMarket({ missing: [missing] })), chain(KINDS), manifest, SALT)
    expect(r.step).toBe(5)
    expect(r.live?.grants).toHaveLength(17)
    expect(r.live?.grants.filter((g) => !g.held)).toEqual([{ ...missing, held: false }])
  })

  it("a SAC authorization the asset contract refuses to report (no trustline) reads as not held", async () => {
    const t = deployedMarket()
    t[`${SAC}.authorized(${TREASURY})`] = new Error("HostError: Error(Contract, #13)")
    const r = await marketProgress(tableReader(t), chain(KINDS), manifest, SALT)
    expect(r.step).toBe(5)
    expect(r.live?.grants.filter((g) => !g.held).map((g) => `${g.kind}:${g.holder}`)).toEqual(["authorized:treasury"])
  })

  it("step 6 once wired and granted with an empty pool, step 7 once it holds liquidity", async () => {
    expect((await marketProgress(tableReader(deployedMarket({ lp: 0n })), chain(KINDS), manifest, SALT)).step).toBe(6)
    const seeded = await marketProgress(tableReader(deployedMarket({ lp: 1_000_000n })), chain(KINDS), manifest, SALT)
    expect(seeded.step).toBe(7)
    expect(seeded.live?.lpTotalSupply).toBe(1_000_000n)
  })

  it("an unreadable value refuses: no step is ever guessed (an unreadable value blocks)", async () => {
    await expect(marketProgress(tableReader({}), failingChain, manifest, SALT)).rejects.toThrow("rpc 503")
    const t = deployedMarket()
    t[`${router}.is_registered(${p.pool})`] = new Error("rpc 429")
    await expect(marketProgress(tableReader(t), chain(KINDS), manifest, SALT)).rejects.toThrow(/Could not read .*is_registered.*rpc 429/)
    const noAuth = deployedMarket()
    noAuth[`${SAC}.authorized(${p.sy})`] = new Error("rpc 500")
    await expect(marketProgress(tableReader(noAuth), chain(KINDS), manifest, SALT)).rejects.toThrow("rpc 500")
  })

  it("refuses a contract running code the manifest does not pin, and a half-deployed phase", async () => {
    await expect(marketProgress(tableReader({}), chain(TOKENS, { pt: pin("ee") }), manifest, SALT)).rejects.toThrow(
      /The PT at .* runs code this network's manifest does not pin/,
    )
    await expect(marketProgress(tableReader({}), chain(["sy", "pt"]), manifest, SALT)).rejects.toThrow(/only partly deployed/)
    await expect(marketProgress(tableReader({}), chain(["config", "manager"]), manifest, SALT)).rejects.toThrow(/only partly deployed/)
  })
})
