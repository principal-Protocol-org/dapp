// @vitest-environment node
import { Keypair, StrKey, type Transaction } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { parseManifest } from "../manifest"
import { createEngineInvocation, createPoolAndEscrowInvocation, createTokensInvocation, deriveMarketContracts, type MarketParams } from "../factory"
import {
  MANAGER_CALL_AUTH,
  addConsumerCall,
  claimCreatorFeesCall,
  createEngineCall,
  createPoolAndEscrowCall,
  createTokensCall,
  factoryCallUnderlying,
  claimProtocolFeesCall,
  grantAccountCall,
  grantAssetCall,
  managerCallAmounts,
  managerCallTree,
  rebuildManagerCall,
  seedCall,
  seedInvocation,
  registerMarketCall,
  setAuthorizedCall,
  setPausedCall,
  type ManagerCall,
  type ManagerCallKind,
} from "../manager-calls"
import { buildInvocationEnvelope, type ScArg } from "../stellar"
import type { Manifest } from "../types"

/**
 * Every builder is checked against the contract source at the ABI pin (`principal`
 * `origin/feat/tranche-1-mvp`, `be2a1a5`): function name, then each argument in order with its
 * Soroban type. The SAC's `set_authorized` is the host's Stellar Asset Contract interface.
 */

const contractAt = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
const TEST_SAC = contractAt(7)
const FACTORY = contractAt(40)
const base = parseManifest(structuredClone(testnetJson))
const pin = (fill: string) => fill.repeat(32)
/** The testnet manifest plus a test asset (whose SAC the issuer authorizes accounts on), a MarketFactory and its pins. */
const manifest: Manifest = {
  ...base,
  shared: { ...base.shared, factory: FACTORY },
  wasmHashes: { sy: pin("a1"), pt: pin("a2"), yt: pin("a3"), config: pin("a4"), manager: pin("a5"), pool: pin("a6"), recoveryEscrow: pin("a7") },
  testAsset: { code: "USDY", issuer: Keypair.random().publicKey(), sac: TEST_SAC, decimals: 7, displayName: "USDY (test)" },
}
const market = manifest.markets[0]
const { pool, sy, manager, pt } = market.contracts
const { permissioning, router, riskControl } = manifest.shared
const NAME = market.displayName

const SIGNER = Keypair.random().publicKey()
const ACCOUNT = Keypair.random().publicKey()
/** A contract of a market that is not in the manifest yet (the wizard's predicted addresses). */
const NEW_POOL = contractAt(9)
const NEW_SY = contractAt(10)
const FOREIGN = contractAt(5)

const short = (value: string) => `${value.slice(0, 6)}...${value.slice(-6)}`

/** A new market's parameters (the wizard's step 1) and its salt. */
const SALT = "11".repeat(32)
const TREASURY = Keypair.random().publicKey()
const PARAMS: MarketParams = {
  underlying: TEST_SAC,
  maturity: 1_807_776_000n, // 2027-04-15 08:00 UTC
  ptName: "Principal Token USDY",
  ptSymbol: "PT-USDY",
  ytName: "Yield Token USDY",
  ytSymbol: "YT-USDY",
  protocolAdmin: ACCOUNT,
  treasury: TREASURY,
  tokenizationFeeBps: 5,
  ytFeeBps: 1000,
  swapFeeTierBps: 10,
  protocolShareBps: 2000,
  timeStretchYears: 4,
}
const address = (value: string): ScArg => ({ type: "address", value })
const bool = (value: boolean): ScArg => ({ type: "bool", value })

/** The Soroban type of each argument, as the transaction carries it. */
function encodedTypes(call: ManagerCall): string[] {
  const tx: Transaction = buildInvocationEnvelope({
    source: SIGNER,
    sequence: "1",
    networkPassphrase: manifest.networkPassphrase,
    invocation: call.invocation,
  })
  const op = tx.operations[0]
  if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a call")
  return op.func.invokeContract.args.map((arg) => arg.type)
}

/** One call of every kind, as the manager view builds them. */
function everyCall(): ManagerCall[] {
  return [
    setAuthorizedCall(manifest, { source: SIGNER, sac: TEST_SAC, account: ACCOUNT, authorize: true }),
    grantAccountCall(manifest, { source: SIGNER, account: NEW_SY }),
    grantAssetCall(manifest, { source: SIGNER, account: ACCOUNT, asset: pt }),
    claimProtocolFeesCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "pool" }),
    claimCreatorFeesCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "manager" }),
    setPausedCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "sy", paused: true }),
    registerMarketCall(manifest, { source: SIGNER, pool: NEW_POOL }),
    addConsumerCall(manifest, { source: SIGNER, consumer: NEW_SY }),
    createTokensCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS }),
    createEngineCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS }),
    createPoolAndEscrowCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS }),
  ]
}

describe("manager call builders encode each call as the contract declares it", () => {
  it("SAC set_authorized(id: Address, authorize: bool), on a SAC the manifest knows; the admin is the signer", () => {
    const call = setAuthorizedCall(manifest, { source: SIGNER, sac: TEST_SAC, account: ACCOUNT, authorize: true })
    expect(call).toEqual({
      kind: "set_authorized",
      source: SIGNER,
      invocation: { contractId: TEST_SAC, functionName: "set_authorized", args: [address(ACCOUNT), bool(true)] },
      label: `Authorize ${short(ACCOUNT)} to hold USDY`,
    })
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvBool"])
    // A market's underlying SAC is known too; a contract is authorized like an account.
    const off = setAuthorizedCall(manifest, { source: SIGNER, sac: market.underlying.sac, account: sy, authorize: false })
    expect(off.invocation).toEqual({ contractId: market.underlying.sac, functionName: "set_authorized", args: [address(sy), bool(false)] })
    expect(off.label).toBe(`Remove the authorization of the SY wrapper of ${NAME} to hold STA`)
  })

  it("Permissioning grant_account(caller: Address, account: Address), caller = signer (permissioning:50)", () => {
    const call = grantAccountCall(manifest, { source: SIGNER, account: ACCOUNT })
    expect(call).toEqual({
      kind: "grant_account",
      source: SIGNER,
      invocation: { contractId: permissioning, functionName: "grant_account", args: [address(SIGNER), address(ACCOUNT)] },
      label: `Grant ${short(ACCOUNT)} Principal permissioning`,
    })
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvAddress"])
  })

  it("Permissioning grant_asset(caller: Address, account: Address, asset: Address) (permissioning:96)", () => {
    const call = grantAssetCall(manifest, { source: SIGNER, account: ACCOUNT, asset: pt })
    expect(call).toEqual({
      kind: "grant_asset",
      source: SIGNER,
      invocation: { contractId: permissioning, functionName: "grant_asset", args: [address(SIGNER), address(ACCOUNT), address(pt)] },
      label: `Grant ${short(ACCOUNT)} permissioning for the PT of ${NAME}`,
    })
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvAddress", "scvAddress"])
  })

  it("claim_protocol_fees() and claim_creator_fees() take no argument, on the pool and on the manager", () => {
    // market_pool:606,611 and principal_manager:557,563: permissionless, the payee fixed by config.
    const fromPool = claimProtocolFeesCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "pool" })
    expect(fromPool).toEqual({
      kind: "claim_protocol_fees",
      source: SIGNER,
      invocation: { contractId: pool, functionName: "claim_protocol_fees", args: [] },
      label: `Claim protocol fees from the pool of ${NAME}, paid to the treasury`,
    })
    const fromManager = claimProtocolFeesCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "manager" })
    expect(fromManager.invocation).toEqual({ contractId: manager, functionName: "claim_protocol_fees", args: [] })
    expect(fromManager.label).toBe(`Claim protocol fees from the PrincipalManager of ${NAME}, paid to the treasury`)

    const creator = claimCreatorFeesCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "manager" })
    expect(creator).toEqual({
      kind: "claim_creator_fees",
      source: SIGNER,
      invocation: { contractId: manager, functionName: "claim_creator_fees", args: [] },
      label: `Claim creator fees from the PrincipalManager of ${NAME}, paid to the creator`,
    })
    expect(claimCreatorFeesCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "pool" }).invocation.contractId).toBe(pool)
    expect(encodedTypes(creator)).toEqual([])
  })

  it("set_paused(caller: Address, paused: bool) on the pool, SY wrapper and manager (market_pool:734, sy_wrapper:421, principal_manager:662)", () => {
    const targets = { pool, sy, manager } as const
    for (const [contract, contractId] of Object.entries(targets) as ["pool" | "sy" | "manager", string][]) {
      const call = setPausedCall(manifest, { source: SIGNER, marketId: market.marketId, contract, paused: true })
      expect(call.kind).toBe("set_paused")
      expect(call.invocation).toEqual({ contractId, functionName: "set_paused", args: [address(SIGNER), bool(true)] })
      expect(encodedTypes(call)).toEqual(["scvAddress", "scvBool"])
    }
    expect(setPausedCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "pool", paused: true }).label).toBe(`Pause the pool of ${NAME}`)
    expect(setPausedCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "sy", paused: false }).label).toBe(
      `Unpause the SY wrapper of ${NAME}`,
    )
  })

  it("Router register_market(caller: Address, pool: Address) (router:187), for a pool not in the manifest yet", () => {
    const call = registerMarketCall(manifest, { source: SIGNER, pool: NEW_POOL })
    expect(call).toEqual({
      kind: "register_market",
      source: SIGNER,
      invocation: { contractId: router, functionName: "register_market", args: [address(SIGNER), address(NEW_POOL)] },
      label: `Register ${short(NEW_POOL)} on the Router`,
    })
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvAddress"])
  })

  it("RiskControl add_consumer(caller: Address, consumer: Address) (risk_control:190)", () => {
    const call = addConsumerCall(manifest, { source: SIGNER, consumer: NEW_SY })
    expect(call).toEqual({
      kind: "add_consumer",
      source: SIGNER,
      invocation: { contractId: riskControl, functionName: "add_consumer", args: [address(SIGNER), address(NEW_SY)] },
      label: `Let ${short(NEW_SY)} report deposits to risk control`,
    })
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvAddress"])
    expect(addConsumerCall(manifest, { source: SIGNER, consumer: sy }).label).toBe(`Let the SY wrapper of ${NAME} report deposits to risk control`)
  })

  it("names who authorizes each call: the signer once, the issuer over the factory's own calls, or nobody for the permissionless fee claims (R29)", () => {
    const expected: Record<ManagerCallKind, "caller" | "caller_tree" | "none" | "rooted"> = {
      set_authorized: "caller",
      grant_account: "caller",
      grant_asset: "caller",
      claim_protocol_fees: "none",
      claim_creator_fees: "none",
      set_paused: "caller",
      register_market: "caller",
      add_consumer: "caller",
      // R5-10: each child contract's initialize and wiring checks the issuer again, beneath the factory call.
      create_tokens: "caller_tree",
      create_engine: "caller_tree",
      create_pool_and_escrow: "caller_tree",
      // The seed moves the issuer's tokens: like the client's same calls, its transfers sit beneath the call.
      seed_mint: "rooted",
      seed_deposit: "rooted",
      seed_add_liquidity: "rooted",
    }
    expect(MANAGER_CALL_AUTH).toEqual(expected)
  })

  it("names the call tree, starting with the contract and function called", () => {
    const trees = everyCall().map((call) => managerCallTree(manifest, call))
    expect(trees).toEqual([
      ["StellarAssetContract.set_authorized"],
      ["Permissioning.grant_account"],
      ["Permissioning.grant_asset"],
      ["MarketPool.claim_protocol_fees", "SYWrapper.transfer"],
      ["PrincipalManager.claim_creator_fees", "SYWrapper.transfer"],
      ["SYWrapper.set_paused"],
      ["Router.register_market"],
      ["RiskControl.add_consumer"],
      ["MarketFactory.create_tokens", "SYWrapper.initialize", "PTToken.initialize", "YTToken.initialize"],
      [
        "MarketFactory.create_engine",
        "MarketConfig.initialize",
        "PrincipalManager.initialize",
        "PTToken.set_minter",
        "YTToken.set_minter",
        "SYWrapper.set_risk_control",
        "PrincipalManager.set_risk_control",
      ],
      // RecoveryEscrow.initialize takes no admin, so it is not beneath the issuer's authorization.
      [
        "MarketFactory.create_pool_and_escrow",
        "MarketPool.initialize",
        "SYWrapper.set_recovery_escrow",
        "PTToken.set_recovery_escrow",
        "YTToken.set_recovery_escrow",
        "MarketPool.set_recovery_escrow",
      ],
    ])
  })
})

describe("MarketFactory create_* calls (spec 0002 §5 step 3, R5-10): the issuer signs, one salt, everything else from the manifest", () => {
  const issuer = address(SIGNER)

  it("create_tokens: the factory's invocation, the signer as the issuer, and a label that says what it deploys", () => {
    const call = createTokensCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS })
    expect(call).toEqual({
      kind: "create_tokens",
      source: SIGNER,
      invocation: createTokensInvocation(manifest, { issuer: SIGNER, salt: SALT, params: PARAMS }),
      label: 'Deploy the SY wrapper, PT-USDY ("Principal Token USDY") and YT-USDY ("Yield Token USDY") of a new USDY market maturing 2027-04-15 08:00 UTC',
    })
    expect(call.invocation.contractId).toBe(FACTORY)
    expect(call.invocation.args[0]).toEqual(issuer)
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvBytes", "scvMap", "scvMap"])
  })

  it("create_engine: the fees, the protocol share, the protocol admin and the treasury in the label", () => {
    const call = createEngineCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS })
    expect(call.kind).toBe("create_engine")
    expect(call.invocation).toEqual(createEngineInvocation(manifest, { issuer: SIGNER, salt: SALT, params: PARAMS }))
    // The protocol admin and the treasury are addresses the issuer signs into the market: named in full.
    expect(call.label).toBe(
      `Deploy the market config and PrincipalManager of the new USDY market maturing 2027-04-15 08:00 UTC: fees 5, 1000 and 10 bps (tokenization, YT, swap tier), protocol share 2000 bps, protocol admin ${ACCOUNT}, treasury ${TREASURY}`,
    )
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvBytes", "scvMap", "scvMap", "scvMap"])
  })

  it("create_pool_and_escrow: the time stretch in the label", () => {
    const call = createPoolAndEscrowCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS })
    expect(call.kind).toBe("create_pool_and_escrow")
    expect(call.invocation).toEqual(createPoolAndEscrowInvocation(manifest, { issuer: SIGNER, salt: SALT, params: PARAMS }))
    expect(call.label).toBe("Deploy the pool (time stretch 4 years) and recovery escrow of the new USDY market")
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvBytes", "scvMap", "scvMap", "scvMap", "scvMap"])
  })

  it("factoryCallUnderlying names the asset a factory call deploys on, and nothing for another call", () => {
    for (const call of everyCall().slice(-3)) expect(factoryCallUnderlying(call)).toBe(TEST_SAC)
    expect(factoryCallUnderlying(grantAccountCall(manifest, { source: SIGNER, account: ACCOUNT }))).toBeUndefined()
  })

  const notOurs = "This manager call is not one this app builds for this network: its contract, function or arguments differ."
  const struct = (arg: ScArg) => (arg as { type: "struct"; value: Record<string, ScArg> }).value

  it("rebuild refuses code that is not the manifest's pin, tokens that are not the salt's, and shared contracts that are not the manifest's", () => {
    const tokens = () => createTokensCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS })
    const engine = () => createEngineCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS })
    const pool = () => createPoolAndEscrowCall(manifest, { source: SIGNER, salt: SALT, params: PARAMS })
    const tamper = (make: () => ManagerCall, change: (args: ScArg[]) => void) => {
      const call = make()
      change(call.invocation.args)
      return () => rebuildManagerCall(manifest, call)
    }
    // A Wasm hash other than the pin: the factory would deploy other code.
    expect(tamper(tokens, (a) => (struct(a[2]).sy_wrapper = { type: "bytes", value: pin("ee") }))).toThrow(notOurs)
    // Tokens or engine that are not the ones this salt derives.
    const other = deriveMarketContracts(manifest, "22".repeat(32))
    expect(tamper(engine, (a) => (struct(a[3]).sy_wrapper = address(other.sy)))).toThrow(notOurs)
    expect(tamper(pool, (a) => (struct(a[4]).market_config = address(other.config)))).toThrow(notOurs)
    // A shared contract that is not the manifest's.
    expect(tamper(tokens, (a) => (struct(a[3]).permissioning = address(FOREIGN)))).toThrow(notOurs)
    expect(tamper(engine, (a) => (struct(a[4]).risk_control = address(FOREIGN)))).toThrow(notOurs)
    // The issuer must be the signer; the salt must be 32 bytes.
    expect(tamper(tokens, (a) => (a[0] = address(ACCOUNT)))).toThrow(notOurs)
    expect(tamper(tokens, (a) => (a[1] = { type: "bytes", value: "11" }))).toThrow("argument 2 of create_tokens must be a salt of 32 bytes.")
    // A field the contract does not declare, a missing argument, a fee above the cap.
    expect(tamper(pool, (a) => (struct(a[5]).extra = bool(true)))).toThrow("PoolEscrowParams has a field extra the contract does not declare.")
    expect(tamper(engine, (a) => a.pop())).toThrow("create_engine takes 5 arguments, not 4.")
    expect(tamper(engine, (a) => (struct(a[4]).yt_fee_bps = { type: "u32", value: 9000 }))).toThrow("YT fee")
  })
})

describe("the seed's calls (spec 0002 §5 step 6, R5-10): the new market's pool and SY from the salt, floors never zero", () => {
  const predicted = deriveMarketContracts(manifest, SALT)
  const NEW = { salt: SALT, underlying: TEST_SAC }
  const DEADLINE = 1_800_000_300n
  const mint = () => seedCall(manifest, { source: SIGNER, market: NEW, kind: "seed_mint", amount: 4_000_000_001n, floor: 3_900_000_000n, deadline: DEADLINE })
  const deposit = () => seedCall(manifest, { source: SIGNER, market: NEW, kind: "seed_deposit", amount: 6_000_000_000n, floor: 5_812_345_678n })
  const add = () =>
    seedCall(manifest, { source: SIGNER, market: NEW, kind: "seed_add_liquidity", pt: 4_100_000_005n, sy: 3_500_000_000n, floor: 3_700_000_000n, deadline: DEADLINE })
  const i128 = (value: bigint): ScArg => ({ type: "i128", value })

  it("Router wrap_and_mint(from, pool, amount, min_pt_out, deadline) (router:483), with the label stating every amount signed", () => {
    const call = mint()
    expect(call).toMatchObject({ kind: "seed_mint", source: SIGNER, newMarket: NEW })
    expect(call.invocation).toEqual({
      contractId: router,
      functionName: "wrap_and_mint",
      args: [address(SIGNER), address(predicted.pool), i128(4_000_000_001n), i128(3_900_000_000n), { type: "u64", value: DEADLINE }],
    })
    expect(encodedTypes(call)).toEqual(["scvAddress", "scvAddress", "scvI128", "scvI128", "scvU64"])
    expect(call.label).toBe("Mint PT and YT of the new USDY market from 400.0000001 USDY: at least 390 PT, and as much YT")
  })

  it("SY deposit(from, amount, min_shares_out) on the new market's SY wrapper", () => {
    const call = deposit()
    expect(call.invocation).toEqual({ contractId: predicted.sy, functionName: "deposit", args: [address(SIGNER), i128(6_000_000_000n), i128(5_812_345_678n)] })
    expect(call.label).toBe("Deposit 600 USDY into the new USDY market's SY wrapper, for at least 581.2345678 SY")
  })

  it("Router add_liquidity(from, pool, pt_in, sy_in, min_lp_out, deadline) (router:803)", () => {
    const call = add()
    expect(call.invocation).toEqual({
      contractId: router,
      functionName: "add_liquidity",
      args: [address(SIGNER), address(predicted.pool), i128(4_100_000_005n), i128(3_500_000_000n), i128(3_700_000_000n), { type: "u64", value: DEADLINE }],
    })
    expect(call.label).toBe("Seed the pool of the new USDY market with 410.0000005 PT and 350 SY, for at least 370 LP")
    expect(managerCallTree(manifest, call)).toEqual(["Router.add_liquidity", "MarketPool.add_liquidity"])
    expect(managerCallTree(manifest, mint())).toEqual(["Router.wrap_and_mint", "SYWrapper.deposit", "PrincipalManager.mint"])
    expect(managerCallTree(manifest, deposit())).toEqual(["SYWrapper.deposit"])
  })

  it("the review lists what each call gives and the least it gets, as signed", () => {
    expect(managerCallAmounts(manifest, mint())).toEqual({ give: ["400.0000001 USDY"], getAtLeast: ["390 PT, and the same amount of YT"], deadline: Number(DEADLINE) })
    expect(managerCallAmounts(manifest, deposit())).toEqual({ give: ["600 USDY"], getAtLeast: ["581.2345678 SY"] })
    expect(managerCallAmounts(manifest, add())).toEqual({ give: ["410.0000005 PT", "350 SY"], getAtLeast: ["370 LP"], deadline: Number(DEADLINE) })
    expect(managerCallAmounts(manifest, registerMarketCall(manifest, { source: SIGNER, pool: NEW_POOL }))).toEqual({ give: [], getAtLeast: [] })
  })

  it("a zero or negative floor is refused: the floor comes from the call's simulation (0001's rule)", () => {
    for (const floor of [0n, -1n]) {
      expect(() => seedCall(manifest, { source: SIGNER, market: NEW, kind: "seed_deposit", amount: 6_000_000_000n, floor })).toThrow(/zero floor/)
    }
    // Simulated only: the invocation itself may carry the zero floor.
    expect(seedInvocation(manifest, SIGNER, NEW, { kind: "seed_deposit", amount: 1n, floor: 0n }).args[2]).toEqual(i128(0n))
  })

  it("an underlying this network does not know, and a non-positive amount, are refused", () => {
    expect(() => seedCall(manifest, { source: SIGNER, market: { salt: SALT, underlying: FOREIGN }, kind: "seed_deposit", amount: 1n, floor: 1n })).toThrow(
      /not the asset contract/,
    )
    expect(() => seedCall(manifest, { source: SIGNER, market: NEW, kind: "seed_deposit", amount: 0n, floor: 1n })).toThrow(/above 0/)
  })

  it("R31: rebuilt from the salt it carries; another pool or SY, another salt, a changed amount or no salt is refused", () => {
    for (const call of [mint(), deposit(), add()]) {
      const copy = rebuildManagerCall(manifest, call)
      expect(copy).toEqual(call)
      expect(copy).not.toBe(call)
    }
    const swapPool = { ...add(), invocation: { ...add().invocation, args: add().invocation.args.map((a, i) => (i === 1 ? address(FOREIGN) : a)) } }
    expect(() => rebuildManagerCall(manifest, swapPool)).toThrow(/differ/)
    const swapSy = { ...deposit(), invocation: { ...deposit().invocation, contractId: FOREIGN } }
    expect(() => rebuildManagerCall(manifest, swapSy)).toThrow(/differ/)
    expect(() => rebuildManagerCall(manifest, { ...deposit(), newMarket: { salt: "22".repeat(32), underlying: TEST_SAC } })).toThrow(/differ/)
    const more = { ...deposit(), invocation: { ...deposit().invocation, args: [address(SIGNER), i128(7_000_000_000n), i128(5_812_345_678n)] } }
    expect(() => rebuildManagerCall(manifest, more)).toThrow(/differ/)
    const zero = { ...deposit(), invocation: { ...deposit().invocation, args: [address(SIGNER), i128(6_000_000_000n), i128(0n)] } }
    expect(() => rebuildManagerCall(manifest, zero)).toThrow(/zero floor/)
    expect(() => rebuildManagerCall(manifest, { ...deposit(), newMarket: undefined })).toThrow(/names no new market/)
    const otherFrom = { ...deposit(), invocation: { ...deposit().invocation, args: [address(ACCOUNT), i128(6_000_000_000n), i128(5_812_345_678n)] } }
    expect(() => rebuildManagerCall(manifest, otherFrom)).toThrow(/differ/)
  })
})

describe("manager call builders refuse what the manifest does not know or the contract would not accept", () => {
  it("a SAC that is no asset of this network", () => {
    expect(() => setAuthorizedCall(manifest, { source: SIGNER, sac: FOREIGN, account: ACCOUNT, authorize: true })).toThrow(
      `${short(FOREIGN)} is not the asset contract of an asset on this network.`,
    )
  })

  it("an unknown market, for the fee claims and the pause", () => {
    expect(() => claimProtocolFeesCall(manifest, { source: SIGNER, marketId: "nope", contract: "pool" })).toThrow('Unknown market "nope".')
    expect(() => setPausedCall(manifest, { source: SIGNER, marketId: "nope", contract: "sy", paused: true })).toThrow('Unknown market "nope".')
  })

  it("a signer that is not an account, and an argument that is not an address", () => {
    expect(() => grantAccountCall(manifest, { source: NEW_POOL, account: ACCOUNT })).toThrow("is not a Stellar account address (G…)")
    expect(() => grantAccountCall(manifest, { source: SIGNER, account: "GNOTANADDRESS" })).toThrow(
      'The account to grant "GNOTANADDRESS" is not a Stellar account or contract address.',
    )
    // An asset, a pool and a consumer are contracts.
    expect(() => grantAssetCall(manifest, { source: SIGNER, account: ACCOUNT, asset: ACCOUNT })).toThrow("is not a contract address (C…)")
    expect(() => registerMarketCall(manifest, { source: SIGNER, pool: ACCOUNT })).toThrow("is not a contract address (C…)")
    expect(() => addConsumerCall(manifest, { source: SIGNER, consumer: ACCOUNT })).toThrow("is not a contract address (C…)")
  })
})

describe("rebuildManagerCall: a call is re-derived by its builder before it is prepared or signed (R31)", () => {
  it("returns an equal copy, not the object it was handed, for every call a builder makes", () => {
    for (const call of everyCall()) {
      const rebuilt = rebuildManagerCall(manifest, call)
      expect(rebuilt).toEqual(call)
      expect(rebuilt).not.toBe(call)
      expect(rebuilt.invocation).not.toBe(call.invocation)
    }
  })

  const notOurs = "This manager call is not one this app builds for this network: its contract, function or arguments differ."
  const tampered = (change: (call: ManagerCall) => void, make: () => ManagerCall = () => grantAccountCall(manifest, { source: SIGNER, account: ACCOUNT })) => {
    const call = make()
    change(call)
    return () => rebuildManagerCall(manifest, call)
  }

  it("refuses a call to another contract", () => {
    expect(tampered((c) => (c.invocation.contractId = FOREIGN))).toThrow(notOurs)
    // A pause aimed at a contract that is no pool, SY wrapper or manager of a market.
    expect(
      tampered(
        (c) => (c.invocation.contractId = pt),
        () => setPausedCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "pool", paused: true }),
      ),
    ).toThrow(`${short(pt)} is not a pool, SY wrapper or PrincipalManager of a market on this network.`)
  })

  it("refuses another function, an extra or a missing argument, and an argument of another type", () => {
    expect(tampered((c) => (c.invocation.functionName = "revoke_account"))).toThrow(notOurs)
    expect(tampered((c) => c.invocation.args.push(address(ACCOUNT)))).toThrow("grant_account takes 2 arguments, not 3.")
    expect(tampered((c) => c.invocation.args.pop())).toThrow("grant_account takes 2 arguments, not 1.")
    expect(tampered((c) => (c.invocation.args[1] = bool(true)))).toThrow("argument 2 of grant_account must be an address")
    expect(
      tampered(
        (c) => c.invocation.args.push(bool(true)),
        () => claimCreatorFeesCall(manifest, { source: SIGNER, marketId: market.marketId, contract: "pool" }),
      ),
    ).toThrow("claim_creator_fees takes 0 arguments, not 1.")
  })

  it("refuses a caller argument that is not the signer", () => {
    expect(tampered((c) => (c.invocation.args[0] = address(ACCOUNT)))).toThrow(notOurs)
    expect(tampered((c) => (c.source = ACCOUNT))).toThrow(notOurs)
  })

  it("refuses a changed kind or label", () => {
    expect(tampered((c) => (c.kind = "add_consumer"))).toThrow()
    expect(tampered((c) => (c.label = "Grant nothing"))).toThrow(notOurs)
  })
})
