// @vitest-environment node
import { Keypair, StrKey, scValToNative, type Transaction } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import {
  createEngineInvocation,
  createPoolAndEscrowInvocation,
  createTokensInvocation,
  currentMarket,
  decodeEngineParams,
  decodePoolEscrowParams,
  decodeTokenParams,
  defaultMaturity,
  deriveMarketContracts,
  draftFromParams,
  engineAuthTree,
  engineParams,
  engineWasmHashes,
  marketEngine,
  marketTokens,
  paramErrors,
  paramsFromDraft,
  parseSalt,
  poolAuthTree,
  poolEscrowParams,
  poolEscrowWasmHashes,
  predictMarket,
  predictMarketInvocation,
  randomSalt,
  readDefaults,
  readFixedParams,
  tokenParams,
  tokenWasmHashes,
  tokensAuthTree,
  type MarketParams,
} from "../factory"
import { parseManifest } from "../manifest"
import type { ContractReader } from "../reader"
import { buildInvocationEnvelope, scArgToVal, type ContractInvocation, type ScArg } from "../stellar"
import type { Manifest, Market } from "../types"

/**
 * The MarketFactory at principal 665bb67 (`contracts/market_factory/src/lib.rs`): `predict_market`,
 * `create_tokens`, `create_engine`, `create_pool_and_escrow`, and their `contracttype` structs.
 */

const contractAt = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
const hex = (fill: string) => fill.repeat(32)

/** The local stack's factory and network, where the vector below was read with `predict_market`. */
const LOCAL_FACTORY = "CDBAJVM4JQFPSE2Z5CEVKPDWT5R3AVGC257ZINA3MZVZVBKUQPRHAJEA"
const LOCAL_PASSPHRASE = "Standalone Network ; February 2017"
const SALT = hex("11")
/** `MarketFactory.predict_market(0x11…11)` on the local stack (principal 665bb67). */
const VECTOR = {
  market_config: "CB3NRCEAVTB3DQR7W2VIEYW6EQLT7YBCTMX3X4N7VRBXHQES6WLLYVNN",
  market_pool: "CBN2G3RWRDM6UC7WLMYIL2MQPUDNOWYAHCGYP7XVCG62MC7WAZMDJJU5",
  principal_manager: "CBGHITYN6UFYYS7D2G7ECFW7YB5MMT5RHWSAIWVWFXXX4DRJ6PM5FHVG",
  pt_token: "CAUDRUUAAYELHQBF52ZZTYXS3WWDGLNYCZK7QPJDHGGSSKWSBPMCDOPI",
  recovery_escrow: "CBBQIUXUHFRVTUTHYX3I3G2CBXFLWQRTFHFF2J7DD7EONUV22MJZCKVZ",
  sy_wrapper: "CBJA6VLQIMDAI25LT6PGLLRYUZZ4CJ5SY6CETX3QQWF7VB6BM5HOJIDT",
  yt_token: "CD6UIVMUV5WL3X3GJHEBHIUVLIT2CG6B4KEAZQGUOQ7FCFVP7IG634H4",
}

const base = parseManifest(structuredClone(testnetJson))
const SAC = contractAt(7)
const WASM = {
  sy: hex("a1"),
  pt: hex("a2"),
  yt: hex("a3"),
  config: hex("a4"),
  manager: hex("a5"),
  pool: hex("a6"),
  recoveryEscrow: hex("a7"),
}
const manifest: Manifest = {
  ...base,
  networkPassphrase: LOCAL_PASSPHRASE,
  shared: { ...base.shared, router: contractAt(1), oracle: contractAt(2), factory: LOCAL_FACTORY },
  wasmHashes: { ...WASM, factory: hex("af") },
  testAsset: { code: "USDY", issuer: Keypair.random().publicKey(), sac: SAC, decimals: 7, displayName: "USDY (test)" },
}
const { permissioning, oracle, riskControl, router } = manifest.shared

const ISSUER = Keypair.random().publicKey()
const TREASURY = Keypair.random().publicKey()
const ADMIN = Keypair.random().publicKey()
const LEDGER = 1_800_000_000
const PARAMS: MarketParams = {
  underlying: SAC,
  maturity: BigInt(LEDGER + 90 * 86_400),
  ptName: "Principal Token USDY",
  ptSymbol: "PT-USDY",
  ytName: "Yield Token USDY",
  ytSymbol: "YT-USDY",
  protocolAdmin: ADMIN,
  treasury: TREASURY,
  tokenizationFeeBps: 5,
  ytFeeBps: 1000,
  swapFeeTierBps: 10,
  protocolShareBps: 2000,
  timeStretchYears: 4,
}

const native = (arg: ScArg) => scValToNative(scArgToVal(arg)) as Record<string, unknown>
const bytes = (h: string) => Buffer.from(h, "hex")

/** The Soroban type of each argument, as the transaction carries it. */
function encodedTypes(invocation: ContractInvocation): string[] {
  const tx: Transaction = buildInvocationEnvelope({ source: ISSUER, sequence: "1", networkPassphrase: manifest.networkPassphrase, invocation })
  const op = tx.operations[0]
  if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a call")
  return op.func.invokeContract.args.map((arg) => arg.type)
}

/** A reader answering `contract.function` from a table; anything else fails like an RPC error. */
function tableReader(table: Record<string, unknown>, calls: string[] = []): ContractReader {
  return (async (call: { contractId: string; functionName: string }) => {
    const key = `${call.contractId}.${call.functionName}`
    calls.push(key)
    if (!(key in table)) throw new Error(`no answer for ${key}`)
    const value = table[key]
    if (value instanceof Error) throw value
    return { value, latestLedger: 10, minResourceFee: "0" }
  }) as ContractReader
}

describe("salts: 32 random bytes, hex, kept in the URL (R5-10)", () => {
  it("parseSalt accepts 64 hex digits, lower-cases them, and refuses anything else", () => {
    expect(parseSalt(SALT)).toBe(SALT)
    expect(parseSalt("AB".repeat(32))).toBe("ab".repeat(32))
    for (const bad of [null, undefined, "", "11", "zz".repeat(32), `${SALT}00`, ` ${SALT}`]) expect(parseSalt(bad)).toBeUndefined()
  })

  it("randomSalt is 32 bytes from the random source, as hex", () => {
    expect(randomSalt((n) => new Uint8Array(n).fill(0xab))).toBe("ab".repeat(32))
    expect(parseSalt(randomSalt())).toBeDefined()
    expect(randomSalt()).not.toBe(randomSalt())
  })
})

describe("predicted addresses", () => {
  it("are derived from the factory, the network and the salt exactly as predict_market returns them", () => {
    expect(deriveMarketContracts(manifest, SALT)).toEqual({
      router,
      oracle,
      sy: VECTOR.sy_wrapper,
      pt: VECTOR.pt_token,
      yt: VECTOR.yt_token,
      config: VECTOR.market_config,
      manager: VECTOR.principal_manager,
      pool: VECTOR.market_pool,
      recoveryEscrow: VECTOR.recovery_escrow,
    })
    // Another network, another factory or another salt is another market.
    expect(deriveMarketContracts({ ...manifest, networkPassphrase: "Test SDF Network ; September 2015" }, SALT).sy).not.toBe(VECTOR.sy_wrapper)
    expect(deriveMarketContracts(manifest, hex("12")).sy).not.toBe(VECTOR.sy_wrapper)
  })

  it("predict_market(salt: BytesN<32>) on the manifest's factory", () => {
    const invocation = predictMarketInvocation(manifest, SALT)
    expect(invocation).toEqual({ contractId: LOCAL_FACTORY, functionName: "predict_market", args: [{ type: "bytes", value: SALT }] })
    expect(encodedTypes(invocation)).toEqual(["scvBytes"])
  })

  it("predictMarket reads predict_market and returns it when it matches the derivation", async () => {
    const calls: string[] = []
    const reader = tableReader({ [`${LOCAL_FACTORY}.predict_market`]: VECTOR }, calls)
    const predicted = await predictMarket(reader, manifest, SALT)
    expect(calls).toEqual([`${LOCAL_FACTORY}.predict_market`])
    expect(predicted).toEqual(deriveMarketContracts(manifest, SALT))
  })

  it("predictMarket refuses an answer that differs from the derivation (RPC is untrusted, R29), and an unreadable one", async () => {
    const swapped = { ...VECTOR, market_pool: contractAt(99) }
    await expect(predictMarket(tableReader({ [`${LOCAL_FACTORY}.predict_market`]: swapped }), manifest, SALT)).rejects.toThrow(
      "The network's predicted addresses differ from the ones this salt gives on this network",
    )
    await expect(predictMarket(tableReader({ [`${LOCAL_FACTORY}.predict_market`]: { sy_wrapper: "nope" } }), manifest, SALT)).rejects.toThrow()
    await expect(predictMarket(tableReader({}), manifest, SALT)).rejects.toThrow("no answer")
  })

  it("refuses a manifest without a factory, and a salt that is not 32 bytes", () => {
    const noFactory: Manifest = { ...manifest, shared: { ...manifest.shared, factory: undefined } }
    expect(() => deriveMarketContracts(noFactory, SALT)).toThrow("This network's manifest names no MarketFactory")
    expect(() => predictMarketInvocation(manifest, "11")).toThrow("is not a salt of 32 bytes")
  })
})

describe("struct encoders: each contracttype field by name, with its Soroban type", () => {
  const predicted = deriveMarketContracts(manifest, SALT)

  it("TokenWasmHashes, EngineWasmHashes, PoolEscrowWasmHashes come from the manifest's pins, read-only", () => {
    expect(native(tokenWasmHashes(manifest))).toEqual({ sy_wrapper: bytes(WASM.sy), pt_token: bytes(WASM.pt), yt_token: bytes(WASM.yt) })
    expect(native(engineWasmHashes(manifest))).toEqual({ market_config: bytes(WASM.config), principal_manager: bytes(WASM.manager) })
    expect(native(poolEscrowWasmHashes(manifest))).toEqual({ market_pool: bytes(WASM.pool), recovery_escrow: bytes(WASM.recoveryEscrow) })
    const missing: Manifest = { ...manifest, wasmHashes: { ...WASM, pool: undefined } }
    expect(() => poolEscrowWasmHashes(missing)).toThrow("pins no code for the pool")
  })

  it("TokenParams: the shared contracts from the manifest, decimals from the underlying, the rest from the parameters", () => {
    const arg = tokenParams(manifest, PARAMS)
    expect(native(arg)).toEqual({
      underlying: SAC,
      maturity: PARAMS.maturity,
      permissioning,
      oracle,
      pt_name: "Principal Token USDY",
      pt_symbol: "PT-USDY",
      yt_name: "Yield Token USDY",
      yt_symbol: "YT-USDY",
      decimals: 7,
    })
    const types = Object.fromEntries(Object.entries((arg as { value: Record<string, ScArg> }).value).map(([k, v]) => [k, v.type]))
    expect(types).toEqual({
      underlying: "address",
      maturity: "u64",
      permissioning: "address",
      oracle: "address",
      pt_name: "string",
      pt_symbol: "string",
      yt_name: "string",
      yt_symbol: "string",
      decimals: "u32",
    })
    expect(decodeTokenParams(arg)).toEqual({
      underlying: SAC,
      maturity: PARAMS.maturity,
      ptName: PARAMS.ptName,
      ptSymbol: PARAMS.ptSymbol,
      ytName: PARAMS.ytName,
      ytSymbol: PARAMS.ytSymbol,
    })
  })

  it("EngineParams: risk control from the manifest; protocol admin, treasury and the four fees from the parameters", () => {
    const arg = engineParams(manifest, PARAMS)
    expect(native(arg)).toEqual({
      underlying: SAC,
      maturity: PARAMS.maturity,
      permissioning,
      oracle,
      risk_control: riskControl,
      protocol_admin: ADMIN,
      treasury: TREASURY,
      tokenization_fee_bps: 5,
      yt_fee_bps: 1000,
      swap_fee_tier_bps: 10,
      protocol_share_bps: 2000,
    })
    const types = Object.fromEntries(Object.entries((arg as { value: Record<string, ScArg> }).value).map(([k, v]) => [k, v.type]))
    expect(types).toMatchObject({ maturity: "u64", risk_control: "address", tokenization_fee_bps: "u32", protocol_share_bps: "u32" })
    expect(decodeEngineParams(arg)).toEqual({
      underlying: SAC,
      maturity: PARAMS.maturity,
      protocolAdmin: ADMIN,
      treasury: TREASURY,
      tokenizationFeeBps: 5,
      ytFeeBps: 1000,
      swapFeeTierBps: 10,
      protocolShareBps: 2000,
    })
  })

  it("PoolEscrowParams, MarketTokens and MarketEngine", () => {
    const arg = poolEscrowParams(manifest, PARAMS)
    expect(native(arg)).toEqual({ underlying: SAC, time_stretch_years: 4 })
    expect((arg as { value: Record<string, ScArg> }).value.time_stretch_years.type).toBe("u32")
    expect(decodePoolEscrowParams(arg)).toEqual({ underlying: SAC, timeStretchYears: 4 })
    expect(native(marketTokens(predicted))).toEqual({ sy_wrapper: predicted.sy, pt_token: predicted.pt, yt_token: predicted.yt })
    expect(native(marketEngine(predicted))).toEqual({ market_config: predicted.config, principal_manager: predicted.manager })
  })

  it("decoders refuse a struct with a missing, extra or mistyped field", () => {
    const arg = tokenParams(manifest, PARAMS) as { type: "struct"; value: Record<string, ScArg> }
    const without = { type: "struct" as const, value: { ...arg.value } }
    delete without.value.pt_name
    expect(() => decodeTokenParams(without)).toThrow("TokenParams has no field pt_name")
    expect(() => decodeTokenParams({ type: "struct", value: { ...arg.value, extra: { type: "bool", value: true } } })).toThrow(
      "TokenParams has a field extra the contract does not declare",
    )
    expect(() => decodeTokenParams({ type: "struct", value: { ...arg.value, maturity: { type: "u32", value: 5 } } })).toThrow(
      "TokenParams.maturity must be a u64",
    )
    expect(() => decodeTokenParams({ type: "address", value: SAC })).toThrow("TokenParams must be a struct")
  })
})

describe("create_* invocations: one salt, the factory's own argument order", () => {
  const predicted = deriveMarketContracts(manifest, SALT)
  const salt: ScArg = { type: "bytes", value: SALT }
  const issuer: ScArg = { type: "address", value: ISSUER }

  it("create_tokens(issuer, salt, wasm: TokenWasmHashes, params: TokenParams)", () => {
    const invocation = createTokensInvocation(manifest, { issuer: ISSUER, salt: SALT, params: PARAMS })
    expect(invocation.contractId).toBe(LOCAL_FACTORY)
    expect(invocation.functionName).toBe("create_tokens")
    expect(invocation.args).toEqual([issuer, salt, tokenWasmHashes(manifest), tokenParams(manifest, PARAMS)])
    expect(encodedTypes(invocation)).toEqual(["scvAddress", "scvBytes", "scvMap", "scvMap"])
  })

  it("create_engine(issuer, salt, wasm: EngineWasmHashes, tokens: MarketTokens, params: EngineParams), tokens derived from the salt", () => {
    const invocation = createEngineInvocation(manifest, { issuer: ISSUER, salt: SALT, params: PARAMS })
    expect(invocation.functionName).toBe("create_engine")
    expect(invocation.args).toEqual([issuer, salt, engineWasmHashes(manifest), marketTokens(predicted), engineParams(manifest, PARAMS)])
    expect(encodedTypes(invocation)).toEqual(["scvAddress", "scvBytes", "scvMap", "scvMap", "scvMap"])
  })

  it("create_pool_and_escrow(issuer, salt, wasm, tokens, engine, params: PoolEscrowParams)", () => {
    const invocation = createPoolAndEscrowInvocation(manifest, { issuer: ISSUER, salt: SALT, params: PARAMS })
    expect(invocation.functionName).toBe("create_pool_and_escrow")
    expect(invocation.args).toEqual([
      issuer,
      salt,
      poolEscrowWasmHashes(manifest),
      marketTokens(predicted),
      marketEngine(predicted),
      poolEscrowParams(manifest, PARAMS),
    ])
    expect(encodedTypes(invocation)).toEqual(["scvAddress", "scvBytes", "scvMap", "scvMap", "scvMap", "scvMap"])
  })

  it("refuses parameters the contracts would refuse, or that name an asset this network does not know", () => {
    const tokens = (over: Partial<MarketParams>) => () => createTokensInvocation(manifest, { issuer: ISSUER, salt: SALT, params: { ...PARAMS, ...over } })
    const engine = (over: Partial<MarketParams>) => () => createEngineInvocation(manifest, { issuer: ISSUER, salt: SALT, params: { ...PARAMS, ...over } })
    const pool = (over: Partial<MarketParams>) => () =>
      createPoolAndEscrowInvocation(manifest, { issuer: ISSUER, salt: SALT, params: { ...PARAMS, ...over } })
    expect(tokens({ underlying: contractAt(66) })).toThrow("is not the asset contract of an asset on this network")
    expect(tokens({ ptSymbol: " " })).toThrow("PT symbol")
    expect(engine({ tokenizationFeeBps: 101 })).toThrow("Tokenization fee")
    expect(engine({ ytFeeBps: 5001 })).toThrow("YT fee")
    expect(engine({ swapFeeTierBps: 501 })).toThrow("Swap fee tier")
    expect(engine({ protocolShareBps: 10_001 })).toThrow("Protocol share")
    expect(engine({ treasury: "GNOPE" })).toThrow("Treasury")
    expect(pool({ timeStretchYears: 0 })).toThrow("Time stretch")
    expect(pool({ timeStretchYears: 21 })).toThrow("Time stretch")
    expect(() => createTokensInvocation(manifest, { issuer: contractAt(5), salt: SALT, params: PARAMS })).toThrow("is not a Stellar account address")
  })
})

describe("the issuer's authorization tree: exactly the calls the factory makes under it (R29, R5-10)", () => {
  const predicted = deriveMarketContracts(manifest, SALT)
  const issuer: ScArg = { type: "address", value: ISSUER }
  const addr = (value: string): ScArg => ({ type: "address", value })
  const c = { issuer: ISSUER, salt: SALT, params: PARAMS }

  it("create_tokens: SYWrapper, PTToken and YTToken initialize, each with the arguments the factory passes", () => {
    expect(tokensAuthTree(manifest, c)).toEqual([
      { contractId: predicted.sy, functionName: "initialize", args: [issuer, addr(SAC), addr(permissioning)] },
      {
        contractId: predicted.pt,
        functionName: "initialize",
        args: [
          issuer,
          addr(permissioning),
          addr(SAC),
          { type: "u64", value: PARAMS.maturity },
          { type: "string", value: PARAMS.ptName },
          { type: "string", value: PARAMS.ptSymbol },
          { type: "u32", value: 7 },
        ],
      },
      {
        contractId: predicted.yt,
        functionName: "initialize",
        args: [
          issuer,
          addr(permissioning),
          addr(SAC),
          addr(oracle),
          { type: "u64", value: PARAMS.maturity },
          { type: "string", value: PARAMS.ytName },
          { type: "string", value: PARAMS.ytSymbol },
          { type: "u32", value: 7 },
        ],
      },
    ])
  })

  it("create_engine: MarketConfig and PrincipalManager initialize, then the minter and risk-control wiring", () => {
    const u32 = (value: number): ScArg => ({ type: "u32", value })
    expect(engineAuthTree(manifest, c)).toEqual([
      {
        contractId: predicted.config,
        functionName: "initialize",
        args: [issuer, addr(SAC), { type: "u64", value: PARAMS.maturity }, addr(ADMIN), addr(TREASURY), u32(5), u32(1000), u32(10), u32(2000)],
      },
      {
        contractId: predicted.manager,
        functionName: "initialize",
        args: [
          issuer,
          addr(predicted.sy),
          addr(predicted.pt),
          addr(predicted.yt),
          addr(oracle),
          addr(permissioning),
          addr(SAC),
          { type: "u64", value: PARAMS.maturity },
          addr(predicted.config),
        ],
      },
      { contractId: predicted.pt, functionName: "set_minter", args: [issuer, addr(predicted.manager)] },
      { contractId: predicted.yt, functionName: "set_minter", args: [issuer, addr(predicted.manager)] },
      { contractId: predicted.sy, functionName: "set_risk_control", args: [issuer, addr(riskControl)] },
      { contractId: predicted.manager, functionName: "set_risk_control", args: [issuer, addr(riskControl)] },
    ])
  })

  it("create_pool_and_escrow: MarketPool initialize, then the recovery escrow on SY, PT, YT and the pool (RecoveryEscrow.initialize asks no authorization)", () => {
    const escrow = addr(predicted.recoveryEscrow)
    expect(poolAuthTree(manifest, c)).toEqual([
      { contractId: predicted.pool, functionName: "initialize", args: [issuer, addr(predicted.manager), { type: "u32", value: 4 }] },
      { contractId: predicted.sy, functionName: "set_recovery_escrow", args: [issuer, escrow] },
      { contractId: predicted.pt, functionName: "set_recovery_escrow", args: [issuer, escrow] },
      { contractId: predicted.yt, functionName: "set_recovery_escrow", args: [issuer, escrow] },
      { contractId: predicted.pool, functionName: "set_recovery_escrow", args: [issuer, escrow] },
    ])
  })
})

describe("parameters: the draft the form edits, checked as the contracts check them", () => {
  const draft = draftFromParams(PARAMS)

  it("a draft round-trips to the parameters; maturity is a UTC date and time", () => {
    expect(draft.maturity).toBe(new Date((LEDGER + 90 * 86_400) * 1000).toISOString().slice(0, 16))
    expect(paramsFromDraft(manifest, draft, LEDGER)).toEqual({ params: PARAMS, errors: {} })
  })

  it("a maturity with seconds (one the chain fixed) round-trips exactly", () => {
    const withSeconds = { ...PARAMS, maturity: 1_810_000_000n }
    const d = draftFromParams(withSeconds)
    expect(d.maturity).toBe("2027-05-11T01:46:40")
    expect(paramsFromDraft(manifest, d, LEDGER).params?.maturity).toBe(1_810_000_000n)
    // A date that does not exist is refused, never rolled over to another day.
    expect(paramsFromDraft(manifest, { ...d, maturity: "2027-02-30T00:00" }, LEDGER).errors.maturity).toBe("Enter a date and time (UTC).")
  })

  it("names each field the contracts would refuse, in plain words", () => {
    const { params, errors } = paramsFromDraft(
      manifest,
      { ...draft, tokenizationFeeBps: "1.5", ytFeeBps: "6000", protocolShareBps: "-1", timeStretchYears: "30", treasury: "", ptName: "" },
      LEDGER,
    )
    expect(params).toBeUndefined()
    expect(Object.keys(errors).sort()).toEqual(["protocolShareBps", "ptName", "timeStretchYears", "tokenizationFeeBps", "treasury", "ytFeeBps"])
    expect(errors.ytFeeBps).toBe("Enter a whole number of basis points from 0 to 5000, the contract's cap.")
  })

  it("maturity: after the ledger time, and within 75% of the time stretch (MaturityTooFar); no ledger time blocks", () => {
    expect(paramErrors(manifest, { ...PARAMS, maturity: BigInt(LEDGER) }, LEDGER).maturity).toBe("The maturity must be after the current ledger time.")
    // Three quarters of 1 year from now is the furthest a 1-year stretch allows.
    const limit = BigInt(LEDGER + (31_536_000 * 3) / 4)
    expect(paramErrors(manifest, { ...PARAMS, timeStretchYears: 1, maturity: limit }, LEDGER).maturity).toBeUndefined()
    expect(paramErrors(manifest, { ...PARAMS, timeStretchYears: 1, maturity: limit + 1n }, LEDGER).maturity).toMatch(
      /^With a time stretch of 1 year, the maturity must be on or before /,
    )
    expect(paramErrors(manifest, PARAMS, null).maturity).toBe("Waiting for the ledger time to check the maturity.")
  })
})

describe("defaultMaturity", () => {
  it("is the first 00:00 UTC at least 90 days after the ledger time", () => {
    // 2027-01-15 08:00 UTC + 90 days = 2027-04-15 08:00 UTC, so 2027-04-16 00:00 UTC.
    expect(defaultMaturity(LEDGER)).toBe(BigInt(Date.UTC(2027, 3, 16) / 1000))
    expect(paramErrors(manifest, { ...PARAMS, maturity: defaultMaturity(LEDGER) }, LEDGER).maturity).toBeUndefined()
  })
})

describe("defaults come from the current market's config", () => {
  const market: Market = { ...base.markets[0], underlying: { ...base.markets[0].underlying, sac: SAC } }
  const c = market.contracts
  const WAD = 10n ** 18n
  // 90 days left on a 4-year stretch: a = WAD − 90 d·WAD / 4 y.
  const poolState = {
    pt_reserve: 1n,
    sy_reserve: 1n,
    total_lp: 1n,
    rate: 10_000_000n,
    exponent: WAD - (7_776_000n * WAD) / (4n * 31_536_000n),
    fee_rate: 0n,
    seconds_to_maturity: 7_776_000n,
  }
  const answers: Record<string, unknown> = {
    [`${c.config}.tokenization_fee_bps`]: 5,
    [`${c.config}.yt_fee_bps`]: 1000,
    [`${c.config}.swap_fee_tier_bps`]: 10,
    [`${c.config}.protocol_share_bps`]: 2000,
    [`${c.config}.treasury`]: TREASURY,
    [`${c.config}.protocol_admin`]: ADMIN,
    [`${c.pt}.name`]: "Principal Token USDY",
    [`${c.pt}.symbol`]: "PT-USDY",
    [`${c.yt}.name`]: "Yield Token USDY",
    [`${c.yt}.symbol`]: "YT-USDY",
    [`${c.pool}.pool_state`]: poolState,
  }

  it("reads the fees, treasury, protocol admin, names and time stretch of the current market", async () => {
    const d = await readDefaults(tableReader(answers), market)
    expect(d.market).toBe(market)
    const values = Object.fromEntries(Object.entries(d).filter(([k]) => k !== "market").map(([k, v]) => [k, (v as { value?: unknown }).value]))
    expect(values).toEqual({
      tokenizationFeeBps: 5,
      ytFeeBps: 1000,
      swapFeeTierBps: 10,
      protocolShareBps: 2000,
      treasury: TREASURY,
      protocolAdmin: ADMIN,
      ptName: "Principal Token USDY",
      ptSymbol: "PT-USDY",
      ytName: "Yield Token USDY",
      ytSymbol: "YT-USDY",
      timeStretchYears: 4,
    })
  })

  it("a default that cannot be read is unavailable with its reason, never a guess", async () => {
    const d = await readDefaults(tableReader({ ...answers, [`${c.config}.yt_fee_bps`]: new Error("rpc 503") }), market)
    expect(d.ytFeeBps).toEqual({ status: "unavailable", error: "rpc 503" })
    const matured = { ...answers, [`${c.pool}.pool_state`]: { ...poolState, exponent: WAD, seconds_to_maturity: 0n } }
    expect((await readDefaults(tableReader(matured), market)).timeStretchYears.status).toBe("unavailable")
  })

  it("the current market is the latest maturity on the chosen asset, else the latest of all", () => {
    const a: Market = { ...market, marketId: "a", maturity: 100 }
    const b: Market = { ...market, marketId: "b", maturity: 300 }
    const other: Market = { ...market, marketId: "c", maturity: 500, underlying: { ...market.underlying, sac: contractAt(77) } }
    const m: Manifest = { ...manifest, markets: [a, b, other] }
    expect(currentMarket(m, SAC)?.marketId).toBe("b")
    expect(currentMarket(m, contractAt(78))?.marketId).toBe("c")
    expect(currentMarket({ ...manifest, markets: [] }, SAC)).toBeUndefined()
  })
})

describe("readFixedParams: what a half-deployed market already fixed on chain", () => {
  const predicted = deriveMarketContracts(manifest, SALT)
  const tokens = {
    [`${predicted.pt}.underlying_address`]: SAC,
    [`${predicted.pt}.maturity`]: PARAMS.maturity,
    [`${predicted.pt}.name`]: "Principal Token USDY",
    [`${predicted.pt}.symbol`]: "PT-USDY",
    [`${predicted.yt}.name`]: "Yield Token USDY",
    [`${predicted.yt}.symbol`]: "YT-USDY",
  }
  const engine = {
    [`${predicted.config}.protocol_admin`]: ADMIN,
    [`${predicted.config}.treasury`]: TREASURY,
    [`${predicted.config}.tokenization_fee_bps`]: 5,
    [`${predicted.config}.yt_fee_bps`]: 1000,
    [`${predicted.config}.swap_fee_tier_bps`]: 10,
    [`${predicted.config}.protocol_share_bps`]: 2000,
  }

  it("nothing deployed fixes nothing; the tokens fix the asset, maturity and names; the engine fixes the fees too", async () => {
    expect(await readFixedParams(tableReader({}), predicted, { tokens: false, engine: false })).toEqual({})
    expect(await readFixedParams(tableReader(tokens), predicted, { tokens: true, engine: false })).toEqual({
      underlying: SAC,
      maturity: PARAMS.maturity,
      ptName: PARAMS.ptName,
      ptSymbol: PARAMS.ptSymbol,
      ytName: PARAMS.ytName,
      ytSymbol: PARAMS.ytSymbol,
    })
    const { timeStretchYears, ...fixedByEngine } = PARAMS
    expect(timeStretchYears).toBe(4)
    expect(await readFixedParams(tableReader({ ...tokens, ...engine }), predicted, { tokens: true, engine: true })).toEqual(fixedByEngine)
  })

  it("an unreadable value refuses: a resumed deployment never guesses what is on chain", async () => {
    await expect(readFixedParams(tableReader({ ...tokens, [`${predicted.pt}.maturity`]: new Error("rpc 500") }), predicted, { tokens: true, engine: false })).rejects.toThrow(
      "rpc 500",
    )
  })
})
