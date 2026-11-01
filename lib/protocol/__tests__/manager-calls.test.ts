// @vitest-environment node
import { Keypair, StrKey, type Transaction } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../manifest"
import {
  MANAGER_CALL_AUTH,
  addConsumerCall,
  claimCreatorFeesCall,
  claimProtocolFeesCall,
  grantAccountCall,
  grantAssetCall,
  managerCallTree,
  rebuildManagerCall,
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
const base = parseManifest(structuredClone(testnetJson))
/** The testnet manifest plus a test asset, whose SAC the issuer authorizes accounts on. */
const manifest: Manifest = {
  ...base,
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

  it("names who authorizes each call: the signer once, or nobody for the permissionless fee claims (R29)", () => {
    const expected: Record<ManagerCallKind, "caller" | "none"> = {
      set_authorized: "caller",
      grant_account: "caller",
      grant_asset: "caller",
      claim_protocol_fees: "none",
      claim_creator_fees: "none",
      set_paused: "caller",
      register_market: "caller",
      add_consumer: "caller",
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
    ])
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
