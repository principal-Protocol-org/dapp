/**
 * Manager calls (spec 0002 §5): the administrative contract calls an issuer, the Permissioning
 * admin, the protocol admin or a contract admin signs in their own wallet. No manager key is held by
 * the app; each call goes through the same review → sign pipeline as a user action
 * (`prepareManagerReview`, `executeReview` in `review.ts`).
 *
 * One builder per call. Each takes its target contract from the manifest, never from the caller,
 * encodes the arguments exactly as the contract declares them, and puts the signer as the `caller`
 * argument where the contract has one. `rebuildManagerCall` reads a call back into its builder's
 * parameters and builds it again: a call is prepared, and signed, only if a builder here makes
 * exactly it for this manifest (R31).
 *
 * Signatures are those of `principal` `origin/feat/tranche-1-mvp` (ABI pin `be2a1a5`); the SAC's
 * `set_authorized(id, authorize)` is the host's Stellar Asset Contract interface. The MarketFactory
 * `create_*` calls (the creation wizard's step 3, R5-10) are those of 665bb67: their structs are
 * encoded in `factory.ts`, which takes the factory, the shared contracts and the Wasm hashes from the
 * manifest and derives the market's addresses from the salt.
 */
import { StrKey } from "@stellar/stellar-sdk"
import {
  createEngineInvocation,
  createPoolAndEscrowInvocation,
  createTokensInvocation,
  decodeEngineParams,
  decodePoolEscrowParams,
  decodeSalt,
  decodeTokenParams,
  knownUnderlyings,
  maturityText,
  type EngineParamsInput,
  type PoolParamsInput,
  type TokenParamsInput,
} from "./factory"
import { shorten } from "./format"
import { getMarket } from "./manifest"
import { scArgEquals, type ContractInvocation, type ScArg } from "./stellar"
import type { Manifest, Market, MarketContractName } from "./types"

export type ManagerCallKind =
  | "set_authorized"
  | "grant_account"
  | "grant_asset"
  | "claim_protocol_fees"
  | "claim_creator_fees"
  | "set_paused"
  | "register_market"
  | "add_consumer"
  | "create_tokens"
  | "create_engine"
  | "create_pool_and_escrow"

/** The MarketFactory's three deployment calls (spec 0002 §5 step 3). */
export const FACTORY_CALLS = ["create_tokens", "create_engine", "create_pool_and_escrow"] as const satisfies readonly ManagerCallKind[]
export type FactoryCallKind = (typeof FACTORY_CALLS)[number]

/** A manager call, ready for review: `source` signs it, `label` says what it does in plain words. */
export type ManagerCall = { kind: ManagerCallKind; source: string; invocation: ContractInvocation; label: string }

/** A market contract an admin can pause: `set_paused(caller, paused)`. */
export type PausableContract = "pool" | "sy" | "manager"

/** A market contract that accrues fees: the pool (swap fees) and the manager (tokenization and YT fees). */
export type FeeContract = "pool" | "manager"

/**
 * Who authorizes each call (R29). `caller`: the signer, once, for exactly this call and nothing
 * beneath it: each contract's `assert_admin` calls `caller.require_auth()` (permissioning:50,96;
 * market_pool:1013; sy_wrapper:581; principal_manager:918; router:504; risk_control:441), the SAC
 * its admin's, and none of them makes an authorized sub-call. `none`: the fee claims are
 * permissionless and pay a payee the config fixes (market_pool:606-613, principal_manager:557-565);
 * the SY moves out of the claiming contract's own balance, which needs no entry. `caller_tree`, for
 * the factory's calls (R5-10): the issuer, once, for exactly this call, with the factory's own calls
 * beneath it: each child contract's `initialize` and wiring calls `admin.require_auth()` again
 * (sy_wrapper:151, pt_token:141, yt_token:210, market_pool:275, ...), so the issuer's authorization of
 * the factory call carries them.
 */
export const MANAGER_CALL_AUTH: Record<ManagerCallKind, "caller" | "caller_tree" | "none"> = {
  set_authorized: "caller",
  grant_account: "caller",
  grant_asset: "caller",
  claim_protocol_fees: "none",
  claim_creator_fees: "none",
  set_paused: "caller",
  register_market: "caller",
  add_consumer: "caller",
  create_tokens: "caller_tree",
  create_engine: "caller_tree",
  create_pool_and_escrow: "caller_tree",
}

/** Contract type names, as call trees show them. */
const CONTRACT_TYPE: Record<PausableContract, string> = { pool: "MarketPool", sy: "SYWrapper", manager: "PrincipalManager" }

/** How labels name a market's contracts. */
const CONTRACT_LABEL: Record<MarketContractName, string> = {
  sy: "SY wrapper",
  pt: "PT",
  yt: "YT",
  config: "market config",
  manager: "PrincipalManager",
  pool: "pool",
  recoveryEscrow: "recovery escrow",
}
const MARKET_CONTRACTS = Object.keys(CONTRACT_LABEL) as MarketContractName[]

const address = (value: string): ScArg => ({ type: "address", value })
const bool = (value: boolean): ScArg => ({ type: "bool", value })

/** The signer: a wallet account. */
function signerOf(source: string): string {
  if (!StrKey.isValidEd25519PublicKey(source)) throw new Error(`The signer "${source}" is not a Stellar account address (G…).`)
  return source
}

/** An account or a contract (a grant, an authorization can be for either). */
function accountOrContract(value: string, what: string): string {
  if (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value)) return value
  throw new Error(`${what} "${value}" is not a Stellar account or contract address.`)
}

function contractOf(value: string, what: string): string {
  if (!StrKey.isValidContract(value)) throw new Error(`${what} "${value}" is not a contract address (C…).`)
  return value
}

function marketOf(manifest: Manifest, marketId: string): Market {
  const market = getMarket(manifest, marketId)
  if (!market) throw new Error(`Unknown market "${marketId}".`)
  return market
}

/** The asset code of every SAC this manifest knows: its markets' underlyings and the test asset. */
function knownSacs(manifest: Manifest): Map<string, string> {
  const sacs = new Map(manifest.markets.map((m) => [m.underlying.sac, m.underlying.code]))
  if (manifest.testAsset) sacs.set(manifest.testAsset.sac, manifest.testAsset.code)
  return sacs
}

/** An address in a label: the manifest's name for it, or the shortened address. */
function nameOf(manifest: Manifest, value: string): string {
  for (const market of manifest.markets) {
    const key = MARKET_CONTRACTS.find((k) => market.contracts[k] === value)
    if (key) return `the ${CONTRACT_LABEL[key]} of ${market.displayName}`
  }
  const { router, riskControl, permissioning } = manifest.shared
  if (value === router) return "the Router"
  if (value === riskControl) return "risk control"
  if (value === permissioning) return "Permissioning"
  const sac = knownSacs(manifest).get(value)
  return sac ? `the ${sac} asset contract` : shorten(value)
}

/** SAC `set_authorized(id: Address, authorize: bool)`, signed by the SAC's admin (the issuer). */
export function setAuthorizedCall(
  manifest: Manifest,
  p: { source: string; sac: string; account: string; authorize: boolean },
): ManagerCall {
  const code = knownSacs(manifest).get(p.sac)
  if (code === undefined) throw new Error(`${shorten(p.sac)} is not the asset contract of an asset on this network.`)
  const account = accountOrContract(p.account, "The account to authorize")
  const who = nameOf(manifest, account)
  return {
    kind: "set_authorized",
    source: signerOf(p.source),
    invocation: { contractId: p.sac, functionName: "set_authorized", args: [address(account), bool(p.authorize)] },
    label: p.authorize ? `Authorize ${who} to hold ${code}` : `Remove the authorization of ${who} to hold ${code}`,
  }
}

/** Permissioning `grant_account(caller: Address, account: Address)` (permissioning:50). */
export function grantAccountCall(manifest: Manifest, p: { source: string; account: string }): ManagerCall {
  const source = signerOf(p.source)
  const account = accountOrContract(p.account, "The account to grant")
  return {
    kind: "grant_account",
    source,
    invocation: { contractId: manifest.shared.permissioning, functionName: "grant_account", args: [address(source), address(account)] },
    label: `Grant ${nameOf(manifest, account)} Principal permissioning`,
  }
}

/** Permissioning `grant_asset(caller: Address, account: Address, asset: Address)` (permissioning:96). */
export function grantAssetCall(manifest: Manifest, p: { source: string; account: string; asset: string }): ManagerCall {
  const source = signerOf(p.source)
  const account = accountOrContract(p.account, "The account to grant")
  const asset = contractOf(p.asset, "The asset")
  return {
    kind: "grant_asset",
    source,
    invocation: {
      contractId: manifest.shared.permissioning,
      functionName: "grant_asset",
      args: [address(source), address(account), address(asset)],
    },
    label: `Grant ${nameOf(manifest, account)} permissioning for ${nameOf(manifest, asset)}`,
  }
}

function claimCall(
  manifest: Manifest,
  kind: "claim_protocol_fees" | "claim_creator_fees",
  p: { source: string; marketId: string; contract: FeeContract },
): ManagerCall {
  const market = marketOf(manifest, p.marketId)
  const contractId = market.contracts[p.contract]
  const [what, payee] = kind === "claim_protocol_fees" ? ["protocol", "the treasury"] : ["creator", "the creator"]
  return {
    kind,
    source: signerOf(p.source),
    invocation: { contractId, functionName: kind, args: [] },
    label: `Claim ${what} fees from ${nameOf(manifest, contractId)}, paid to ${payee}`,
  }
}

/** `claim_protocol_fees()` on the pool (market_pool:606) or the manager (principal_manager:557): pays the treasury. */
export function claimProtocolFeesCall(manifest: Manifest, p: { source: string; marketId: string; contract: FeeContract }): ManagerCall {
  return claimCall(manifest, "claim_protocol_fees", p)
}

/** `claim_creator_fees()` on the pool (market_pool:611) or the manager (principal_manager:563): pays the creator. */
export function claimCreatorFeesCall(manifest: Manifest, p: { source: string; marketId: string; contract: FeeContract }): ManagerCall {
  return claimCall(manifest, "claim_creator_fees", p)
}

/** `set_paused(caller: Address, paused: bool)` on the pool (market_pool:734), SY wrapper (sy_wrapper:421) or manager (principal_manager:662). */
export function setPausedCall(
  manifest: Manifest,
  p: { source: string; marketId: string; contract: PausableContract; paused: boolean },
): ManagerCall {
  const source = signerOf(p.source)
  const contractId = marketOf(manifest, p.marketId).contracts[p.contract]
  return {
    kind: "set_paused",
    source,
    invocation: { contractId, functionName: "set_paused", args: [address(source), bool(p.paused)] },
    label: `${p.paused ? "Pause" : "Unpause"} ${nameOf(manifest, contractId)}`,
  }
}

/** Router `register_market(caller: Address, pool: Address)` (router:187); the pool may be a market the manifest does not list yet. */
export function registerMarketCall(manifest: Manifest, p: { source: string; pool: string }): ManagerCall {
  const source = signerOf(p.source)
  const pool = contractOf(p.pool, "The pool")
  return {
    kind: "register_market",
    source,
    invocation: { contractId: manifest.shared.router, functionName: "register_market", args: [address(source), address(pool)] },
    label: `Register ${nameOf(manifest, pool)} on the Router`,
  }
}

/** RiskControl `add_consumer(caller: Address, consumer: Address)` (risk_control:190): lets the consumer report deposits. */
export function addConsumerCall(manifest: Manifest, p: { source: string; consumer: string }): ManagerCall {
  const source = signerOf(p.source)
  const consumer = contractOf(p.consumer, "The consumer")
  return {
    kind: "add_consumer",
    source,
    invocation: { contractId: manifest.shared.riskControl, functionName: "add_consumer", args: [address(source), address(consumer)] },
    label: `Let ${nameOf(manifest, consumer)} report deposits to risk control`,
  }
}

/** The asset code a factory call's label names. */
function codeOf(manifest: Manifest, sac: string): string {
  return knownUnderlyings(manifest).get(sac)?.code ?? shorten(sac)
}

type FactoryCallParams<P> = { source: string; salt: string; params: P }

/**
 * MarketFactory `create_tokens(issuer, salt, wasm, params)`: the SY wrapper, PT and YT. The signer is
 * the issuer, which the contracts check live against the underlying SAC's `admin()` (R5-10).
 */
export function createTokensCall(manifest: Manifest, p: FactoryCallParams<TokenParamsInput>): ManagerCall {
  const source = signerOf(p.source)
  return {
    kind: "create_tokens",
    source,
    invocation: createTokensInvocation(manifest, { issuer: source, salt: p.salt, params: p.params }),
    label: `Deploy the SY wrapper, ${p.params.ptSymbol} and ${p.params.ytSymbol} of a new ${codeOf(manifest, p.params.underlying)} market maturing ${maturityText(p.params.maturity)}`,
  }
}

/** MarketFactory `create_engine(issuer, salt, wasm, tokens, params)`: the market config and PrincipalManager. */
export function createEngineCall(manifest: Manifest, p: FactoryCallParams<EngineParamsInput>): ManagerCall {
  const source = signerOf(p.source)
  const q = p.params
  return {
    kind: "create_engine",
    source,
    invocation: createEngineInvocation(manifest, { issuer: source, salt: p.salt, params: q }),
    label:
      `Deploy the market config and PrincipalManager of the new ${codeOf(manifest, q.underlying)} market maturing ${maturityText(q.maturity)}: ` +
      `fees ${q.tokenizationFeeBps}, ${q.ytFeeBps} and ${q.swapFeeTierBps} bps (tokenization, YT, swap tier), protocol share ${q.protocolShareBps} bps, treasury ${nameOf(manifest, q.treasury)}`,
  }
}

/** MarketFactory `create_pool_and_escrow(issuer, salt, wasm, tokens, engine, params)`: the pool and the recovery escrow. */
export function createPoolAndEscrowCall(manifest: Manifest, p: FactoryCallParams<PoolParamsInput>): ManagerCall {
  const source = signerOf(p.source)
  const years = p.params.timeStretchYears
  return {
    kind: "create_pool_and_escrow",
    source,
    invocation: createPoolAndEscrowInvocation(manifest, { issuer: source, salt: p.salt, params: p.params }),
    label: `Deploy the pool (time stretch ${years} year${years === 1 ? "" : "s"}) and recovery escrow of the new ${codeOf(manifest, p.params.underlying)} market`,
  }
}

const isFactoryCall = (kind: ManagerCallKind): kind is FactoryCallKind => (FACTORY_CALLS as readonly string[]).includes(kind)

/** The asset a factory call deploys a market on (its params' `underlying`); undefined for any other call or an unreadable one. */
export function factoryCallUnderlying(call: ManagerCall): string | undefined {
  if (!isFactoryCall(call.kind)) return undefined
  const params = call.invocation.args[call.invocation.args.length - 1]
  if (params?.type !== "struct") return undefined
  const underlying = params.value.underlying
  return underlying?.type === "address" && typeof underlying.value === "string" ? underlying.value : undefined
}

/** The market and contract name of `contractId`, among `which` of every market; refuses any other contract. */
function marketContractOf<K extends PausableContract>(manifest: Manifest, contractId: string, which: readonly K[]): { marketId: string; contract: K } {
  for (const market of manifest.markets) {
    const contract = which.find((k) => market.contracts[k] === contractId)
    if (contract) return { marketId: market.marketId, contract }
  }
  const names = which.map((k) => CONTRACT_LABEL[k])
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names[0]
  throw new Error(`${shorten(contractId)} is not a ${list} of a market on this network.`)
}

const PAUSABLE: readonly PausableContract[] = ["pool", "sy", "manager"]
const FEE_CONTRACTS: readonly FeeContract[] = ["pool", "manager"]

/** The values of `args`, which must be exactly `types`, in order. */
function argValues(fn: string, args: ScArg[], types: readonly ("address" | "bool")[]): (string | boolean)[] {
  if (args.length !== types.length) throw new Error(`${fn} takes ${types.length} arguments, not ${args.length}.`)
  return types.map((type, i) => {
    const arg = args[i]
    const ok = arg.type === type && (type === "address" ? typeof arg.value === "string" : typeof arg.value === "boolean")
    if (!ok) throw new Error(`argument ${i + 1} of ${fn} must be ${type === "address" ? "an address" : "a bool"}.`)
    return arg.value as string | boolean
  })
}

/** A factory call's salt (argument 2) and params (its last argument), from exactly `count` arguments. */
function factoryArgs(fn: FactoryCallKind, args: ScArg[], count: number): [string, ScArg] {
  if (args.length !== count) throw new Error(`${fn} takes ${count} arguments, not ${args.length}.`)
  return [decodeSalt(args[1], `argument 2 of ${fn}`), args[count - 1]]
}

/** Reads `call` back into its builder's parameters and builds it again. */
function rebuild(manifest: Manifest, call: ManagerCall): ManagerCall {
  const { kind, source } = call
  const { contractId, args } = call.invocation
  switch (kind) {
    case "set_authorized": {
      const [account, authorize] = argValues(kind, args, ["address", "bool"]) as [string, boolean]
      return setAuthorizedCall(manifest, { source, sac: contractId, account, authorize })
    }
    case "grant_account": {
      const [, account] = argValues(kind, args, ["address", "address"]) as [string, string]
      return grantAccountCall(manifest, { source, account })
    }
    case "grant_asset": {
      const [, account, asset] = argValues(kind, args, ["address", "address", "address"]) as [string, string, string]
      return grantAssetCall(manifest, { source, account, asset })
    }
    case "claim_protocol_fees":
    case "claim_creator_fees": {
      argValues(kind, args, [])
      return claimCall(manifest, kind, { source, ...marketContractOf(manifest, contractId, FEE_CONTRACTS) })
    }
    case "set_paused": {
      const [, paused] = argValues(kind, args, ["address", "bool"]) as [string, boolean]
      return setPausedCall(manifest, { source, paused, ...marketContractOf(manifest, contractId, PAUSABLE) })
    }
    case "register_market": {
      const [, pool] = argValues(kind, args, ["address", "address"]) as [string, string]
      return registerMarketCall(manifest, { source, pool })
    }
    case "add_consumer": {
      const [, consumer] = argValues(kind, args, ["address", "address"]) as [string, string]
      return addConsumerCall(manifest, { source, consumer })
    }
    // The caller-chosen fields are read back; the factory, the Wasm hashes, the shared contracts and the
    // tokens and engine are not: the builder takes them from the manifest and the salt, and the
    // comparison below refuses any other value.
    case "create_tokens": {
      const [salt, params] = factoryArgs(kind, args, 4)
      return createTokensCall(manifest, { source, salt, params: decodeTokenParams(params) })
    }
    case "create_engine": {
      const [salt, params] = factoryArgs(kind, args, 5)
      return createEngineCall(manifest, { source, salt, params: decodeEngineParams(params) })
    }
    case "create_pool_and_escrow": {
      const [salt, params] = factoryArgs(kind, args, 6)
      return createPoolAndEscrowCall(manifest, { source, salt, params: decodePoolEscrowParams(params) })
    }
    default: {
      const unknown: never = kind
      throw new Error(`"${String(unknown)}" is not a manager call this app builds.`)
    }
  }
}

function sameCall(a: ManagerCall, b: ManagerCall): boolean {
  const x = a.invocation
  const y = b.invocation
  return (
    a.kind === b.kind &&
    a.source === b.source &&
    a.label === b.label &&
    x.contractId === y.contractId &&
    x.functionName === y.functionName &&
    x.args.length === y.args.length &&
    // Compared as encoded: a struct argument is equal field by field, as the transaction carries it.
    x.args.every((arg, i) => scArgEquals(arg, y.args[i]))
  )
}

/**
 * R31: `call` re-derived by its builder: a fresh copy when a builder makes exactly this call (same
 * signer, contract, function, arguments and label) for this manifest; otherwise it throws. The
 * contract comes from the manifest, so a call aimed anywhere else, or with any argument changed, is
 * refused; a caller argument must be the signer.
 */
export function rebuildManagerCall(manifest: Manifest, call: ManagerCall): ManagerCall {
  const rebuilt = rebuild(manifest, call)
  if (!sameCall(rebuilt, call)) {
    throw new Error("This manager call is not one this app builds for this network: its contract, function or arguments differ.")
  }
  return rebuilt
}

/** The contracts a call goes through, starting with the one invoked (for the review's technical details). */
export function managerCallTree(manifest: Manifest, call: ManagerCall): string[] {
  const { contractId, functionName } = call.invocation
  switch (call.kind) {
    case "set_authorized":
      return [`StellarAssetContract.${functionName}`]
    case "grant_account":
    case "grant_asset":
      return [`Permissioning.${functionName}`]
    case "register_market":
      return [`Router.${functionName}`]
    case "add_consumer":
      return [`RiskControl.${functionName}`]
    // The factory's own calls into the contracts it deploys, in the order it makes them (market_factory).
    case "create_tokens":
      return ["MarketFactory.create_tokens", "SYWrapper.initialize", "PTToken.initialize", "YTToken.initialize"]
    case "create_engine":
      return [
        "MarketFactory.create_engine",
        "MarketConfig.initialize",
        "PrincipalManager.initialize",
        "PTToken.set_minter",
        "YTToken.set_minter",
        "SYWrapper.set_risk_control",
        "PrincipalManager.set_risk_control",
      ]
    case "create_pool_and_escrow":
      return [
        "MarketFactory.create_pool_and_escrow",
        "MarketPool.initialize",
        "RecoveryEscrow.initialize",
        "SYWrapper.set_recovery_escrow",
        "PTToken.set_recovery_escrow",
        "YTToken.set_recovery_escrow",
        "MarketPool.set_recovery_escrow",
      ]
    case "set_paused":
      return [`${CONTRACT_TYPE[marketContractOf(manifest, contractId, PAUSABLE).contract]}.${functionName}`]
    case "claim_protocol_fees":
    case "claim_creator_fees":
      // The claim pays the payee in SY: SYWrapper.transfer from the claiming contract.
      return [`${CONTRACT_TYPE[marketContractOf(manifest, contractId, FEE_CONTRACTS).contract]}.${functionName}`, "SYWrapper.transfer"]
  }
}
