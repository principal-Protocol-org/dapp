// @vitest-environment node
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json"
import { ACTION_META, invocationFor, type ActionId, type ActionInput, type GuardValues } from "../actions"
import { hashLike } from "../hash"
import { deriveMarketContracts, type MarketParams } from "../factory"
import {
  addConsumerCall,
  claimCreatorFeesCall,
  claimProtocolFeesCall,
  createEngineCall,
  createTokensCall,
  grantAccountCall,
  grantAssetCall,
  registerMarketCall,
  setAuthorizedCall,
  setPausedCall,
  type ManagerCall,
} from "../manager-calls"
import { evaluateManagerGates } from "../manager-gates"
import type { Role } from "../roles"
import { parseManifest } from "../manifest"
import { AMOUNTS_MOVED_REASON, SubmissionRejectedError, createRpcServer, scArgToVal, transactionEnvelopeHash } from "../stellar"
import {
  MAX_TX_FEE_STROOPS,
  REVIEW_TTL_MS,
  executeRestore,
  executeReview,
  isExpired,
  prepareManagerReview,
  prepareRestore,
  prepareReview,
  type ManagerReview,
  type RestoreReview,
  type Review,
  type ReviewRpcServer,
  TX_TIMEOUT_SECONDS,
} from "../review"
import type { Finding, Live, Manifest, WalletState } from "../types"

const manifest = parseManifest(structuredClone(testnetJson))
const market = manifest.markets[0]
const passphrase = manifest.networkPassphrase
const wallet = Keypair.random()
const SOURCE = wallet.publicKey()
const SEQUENCE = "41"
const RESOURCE_FEE = 12_345n
/** `assembleTransaction` keeps the 100-stroop inclusion fee and adds the resource fee. */
const PREPARED_FEE = (BigInt(BASE_FEE) + RESOURCE_FEE).toString()
const DEADLINE = 1_900_000_000n
/** The hash the fake RPC claims for every submission; the pipeline must report the real one. */
const HASH = "abc123"
/** The transaction hash, computed locally (the same signed or unsigned). */
const hashOf = (unsignedXdr: string) => transactionEnvelopeHash(unsignedXdr, passphrase)
/** A valid contract address that is no contract of the manifest. */
const FOREIGN = StrKey.encodeContract(new Uint8Array(32).fill(5))

const input = (action: ActionId, extra: Partial<ActionInput> = {}): ActionInput => ({
  action,
  marketId: market.marketId,
  source: SOURCE,
  amount: 10_0000000n,
  guards: { minOut: 9_4525001n },
  deadline: DEADLINE,
  // Keep YT signs the PT and SY it offers the pool (R5-7); the other actions ignore it.
  ...(action === "add_liquidity_keep_yt" ? { desired: { pt: 3_0000000n, sy: 2_0000000n } } : {}),
  ...extra,
})

const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" })

function simulationSuccess(
  opts: { retval?: xdr.ScVal; auth?: xdr.SorobanAuthorizationEntry[]; resourceFee?: bigint } = {},
) {
  const resourceFee = (opts.resourceFee ?? RESOURCE_FEE).toString()
  return {
    id: "1",
    _parsed: true,
    latestLedger: 90,
    events: [],
    minResourceFee: resourceFee,
    transactionData: new SorobanDataBuilder().setResourceFee(resourceFee),
    result: { auth: opts.auth ?? [], retval: opts.retval ?? i128(1n) },
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse
}

/** A source-account authorization whose root invocation is `args` (what simulation records). */
function authFor(args: xdr.InvokeContractArgs): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args),
      subInvocations: [],
    }),
  })
}

function callOf(tx: Transaction): xdr.InvokeContractArgs {
  const op = tx.operations[0]
  if (op.type !== "invokeHostFunction" || op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not a call")
  return op.func.invokeContract
}

/** Prepares like the SDK: the user's own authorization for the call, and the resource fee. */
function assemble(tx: Transaction, opts: Parameters<typeof simulationSuccess>[0] = {}): Transaction {
  return rpc.assembleTransaction(tx, simulationSuccess({ auth: [authFor(callOf(tx))], ...opts })).build()
}

/** The Wasm hash the pinned manifest lists for the market's manager (R29b). */
const MARKET_WASM = new Uint8Array(32).fill(3)
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
/** The testnet manifest with `wasmHashes` pinned, in upper case: the comparison is on exact bytes. */
const pinnedManifest = parseManifest({
  ...structuredClone(testnetJson),
  markets: [{ ...structuredClone(testnetJson.markets[0]), wasmHashes: { manager: hex(MARKET_WASM).toUpperCase() } }],
})

type Calls = { getAccount: string[]; prepared: Transaction[]; sent: Transaction[]; polled: string[] }

/** An RPC that prepares like the SDK (`assembleTransaction`), accepts submissions and confirms them. */
function fakeRpc(overrides: Partial<ReviewRpcServer> = {}): ReviewRpcServer & { calls: Calls } {
  const calls: Calls = { getAccount: [], prepared: [], sent: [], polled: [] }
  return {
    calls,
    async getAccount(address) {
      calls.getAccount.push(address)
      return new Account(address, SEQUENCE)
    },
    async simulateTransaction() {
      return simulationSuccess()
    },
    async prepareTransaction(tx) {
      calls.prepared.push(tx)
      return assemble(tx)
    },
    async sendTransaction(tx) {
      calls.sent.push(tx)
      return { status: "PENDING", hash: HASH }
    },
    async getTransaction(hash) {
      calls.polled.push(hash)
      return { status: "SUCCESS", returnValue: i128(9_5000000n) }
    },
    ...overrides,
  }
}

/** The result of a transaction whose contract call trapped, as RPC returns it for a FAILED one. */
const failedResult = () =>
  new xdr.TransactionResult({
    feeCharged: 48_031n,
    result: xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped())),
    ]),
    ext: xdr.TransactionResultExt.v0(),
  })

/** The diagnostic event of the host refusing an authorization (`Error(Auth, InvalidAction)`). */
const authInvalidActionEvent = () =>
  new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: null,
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction))],
          data: xdr.ScVal.scvString("Unauthorized function call for address"),
        }),
      ),
    }),
  })

/** An RPC that fails the test if anything is called. */
const noIo: ReviewRpcServer = new Proxy({} as ReviewRpcServer, {
  get: (_target, name) => () => {
    throw new Error(`RPC ${String(name)} must not be called`)
  },
})

/** Freighter stand-in: signs exactly what it is given with `keypair`. */
function signWith(keypair = wallet) {
  const seen: [string, string, string][] = []
  const sign = async (unsignedXdr: string, networkPassphrase: string, expectedSigner: string) => {
    seen.push([unsignedXdr, networkPassphrase, expectedSigner])
    const tx = new Transaction(unsignedXdr, networkPassphrase)
    tx.sign(keypair)
    return tx.toXDR()
  }
  return Object.assign(sign, { seen })
}

function invokedArgs(unsignedXdr: string): unknown[] {
  return callOf(new Transaction(unsignedXdr, passphrase)).args.map((arg) => scValToNative(arg))
}

async function review(action: ActionId, extra: Partial<ActionInput> = {}, server = fakeRpc()): Promise<Review> {
  return prepareReview({ manifest, input: input(action, extra), rpc: server })
}

describe("prepareReview", () => {
  it("accepts the SDK's RPC server (compile-time check)", () => {
    const real: ReviewRpcServer = createRpcServer(manifest.rpcUrl)
    expect(typeof real.prepareTransaction).toBe("function")
  })

  it("prepares the exact transaction through RPC and reviews what RPC prepared", async () => {
    const server = fakeRpc()
    const before = Date.now()
    const r = await review("mint", {}, server)

    expect(server.calls.getAccount).toEqual([SOURCE])
    expect(server.calls.prepared).toHaveLength(1)
    expect(server.calls.prepared[0].source).toBe(SOURCE)
    expect(server.calls.prepared[0].sequence).toBe("42")

    const prepared = new Transaction(r.unsignedXdr, passphrase)
    expect(prepared.source).toBe(SOURCE)
    expect(prepared.sequence).toBe("42")
    expect(prepared.operations).toHaveLength(1)
    const op = prepared.operations[0]
    expect(op.type === "invokeHostFunction" && op.auth?.length).toBe(1)
    expect(prepared.timeBounds).toEqual(server.calls.prepared[0].timeBounds)
    expect(prepared.fee).toBe(PREPARED_FEE)
    expect(r.fee).toBe(PREPARED_FEE)
    expect(r.unsignedXdrHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(r.unsignedXdrHash).toBe(hashLike(r.unsignedXdr))
    expect(r.invocation).toEqual(invocationFor(manifest, input("mint")))
    expect(r.input).toEqual(input("mint"))
    expect(r.callTree).toEqual(["Router.wrap_and_mint", "SYWrapper.deposit", "PrincipalManager.mint"])
    expect(r.preparedAtMs).toBeGreaterThanOrEqual(before)
    expect(r.expiresAtMs - r.preparedAtMs).toBe(REVIEW_TTL_MS)
    expect(REVIEW_TTL_MS).toBe(60_000)
  })

  it("signs the quoted floor, not a zero (ported from dapp-old)", async () => {
    const r = await review("buy_pt", { guards: { minOut: 9_452_500n } })
    // swap_sy_for_pt(from, pool, sy_in, min_pt_out, deadline)
    expect(invokedArgs(r.unsignedXdr)).toEqual([SOURCE, market.contracts.pool, 10_0000000n, 9_452_500n, DEADLINE])
  })

  it("names the call tree of every action, starting with the invoked function", async () => {
    for (const action of Object.keys(ACTION_META) as ActionId[]) {
      const guards: GuardValues = { minOut: 1n, minOut2: 1n, maxNetCost: 1n }
      const r = await review(action, { guards, secondaryAmount: 1n })
      const { contractId, functionName } = r.invocation
      const contract = contractId === market.contracts.sy ? "SYWrapper" : "Router"
      expect(r.callTree[0]).toBe(`${contract}.${functionName}`)
    }
  })

  it("lists each one-transaction Router function, then its downstream calls in contract order", async () => {
    const trees: [ActionId, string[]][] = [
      ["buy_pt_underlying", ["Router.swap_underlying_for_pt", "SYWrapper.deposit", "MarketPool.swap_sy_for_pt"]],
      // The gain-based sales end with withdraw_gained (R5-4), and so does the exit to USDY below.
      ["sell_pt_underlying", ["Router.swap_pt_for_underlying", "MarketPool.swap_pt_for_sy", "SYWrapper.withdraw_gained"]],
      ["sell_yt_underlying", ["Router.swap_yt_for_underlying", "MarketPool.swap_yt_for_sy", "SYWrapper.withdraw_gained"]],
      ["add_liquidity_keep_yt", ["Router.add_liquidity_keep_yt", "SYWrapper.deposit", "PrincipalManager.mint", "MarketPool.add_liquidity"]],
      // R5-2: the pool mints from its own reserve, so the manager's `mint` follows the pool's call.
      ["buy_yt_flash", ["Router.flash_mint_yt", "MarketPool.flash_mint_yt", "PrincipalManager.mint"]],
      [
        "buy_yt_flash_underlying",
        ["Router.flash_mint_yt_from_underlying", "SYWrapper.deposit", "MarketPool.flash_mint_yt", "PrincipalManager.mint", "SYWrapper.withdraw_gained"],
      ],
      ["add_liquidity_underlying", ["Router.add_liquidity_single_underlying", "SYWrapper.deposit", "MarketPool.add_liquidity_single_sy"]],
      [
        "remove_liquidity_underlying",
        ["Router.remove_liquidity_to_underlying", "MarketPool.remove_liquidity", "MarketPool.swap_gained_pt_for_sy", "SYWrapper.withdraw_gained"],
      ],
    ]
    for (const [action, tree] of trees) {
      const r = await review(action, { guards: { minOut: 1n, minOut2: 1n, maxNetCost: 1n }, secondaryAmount: 1n })
      expect(r.callTree).toEqual(tree)
    }
  })

  describe("never prepares a zero floor (R5)", () => {
    const refuses = (action: ActionId, guards: GuardValues) =>
      expect(prepareReview({ manifest, input: input(action, { guards }), rpc: noIo })).rejects.toThrow("zero floor")

    it("min_out of a single-floor action", async () => {
      await refuses("buy_pt", { minOut: 0n })
      await refuses("deposit", { minOut: 0n })
      await refuses("sell_pt", { minOut: -1n })
    })
    it("a missing min_out", async () => {
      await refuses("withdraw", {})
    })
    it("min_sy_out of remove_liquidity", async () => {
      await refuses("remove_liquidity", { minOut: 5n, minOut2: 0n })
      await refuses("remove_liquidity", { minOut: 0n, minOut2: 5n })
    })
    it("max_net_cost of buy_yt", async () => {
      await refuses("buy_yt", { minOut: 5n, maxNetCost: 0n })
      await refuses("buy_yt", { minOut: 5n })
    })
    it("min_yt_out of buy_yt", async () => {
      await refuses("buy_yt", { minOut: 0n, maxNetCost: 5n })
    })
    it("max_net_cost and min_yt_out of the flash, and min_underlying_back of its USDY form unless it is 0 (R5-3)", async () => {
      const sy = (guards: GuardValues) => expect(prepareReview({ manifest, input: input("buy_yt_flash", { guards, secondaryAmount: 5n }), rpc: noIo })).rejects.toThrow("zero floor")
      const usdy = (guards: GuardValues) =>
        expect(prepareReview({ manifest, input: input("buy_yt_flash_underlying", { guards, secondaryAmount: 5n }), rpc: noIo })).rejects.toThrow("zero floor")
      await sy({ minOut: 5n, maxNetCost: 0n })
      await sy({ minOut: 5n })
      await sy({ minOut: 0n, maxNetCost: 5n })
      await usdy({ minOut: 5n, maxNetCost: 0n, minOut2: 0n })
      await usdy({ minOut: 0n, maxNetCost: 5n, minOut2: 0n })
      await usdy({ minOut: 5n, maxNetCost: 5n }) // min_underlying_back must be present, but may be 0
      await usdy({ minOut: 5n, maxNetCost: 5n, minOut2: -1n })
      await expect(review("buy_yt_flash", { guards: { minOut: 5n, maxNetCost: 5n }, secondaryAmount: 5n })).resolves.toMatchObject({ fee: PREPARED_FEE })
      await expect(review("buy_yt_flash_underlying", { guards: { minOut: 5n, maxNetCost: 5n, minOut2: 0n }, secondaryAmount: 5n })).resolves.toMatchObject({
        fee: PREPARED_FEE,
      })
    })
    it("min_out of the other one-step Router actions", async () => {
      await refuses("buy_pt_underlying", { minOut: 0n })
      await refuses("sell_pt_underlying", {})
      await refuses("sell_yt_underlying", { minOut: -1n })
      await refuses("add_liquidity_keep_yt", { minOut: 0n })
      await refuses("add_liquidity_underlying", { minOut: 0n })
      await refuses("remove_liquidity_underlying", {})
    })
    it("claim and redeem carry no floor and are prepared", async () => {
      await expect(review("claim_yield", { guards: {}, amount: 0n })).resolves.toMatchObject({ fee: PREPARED_FEE })
      await expect(review("redeem", { guards: {}, secondaryAmount: 0n })).resolves.toMatchObject({ fee: PREPARED_FEE })
    })
  })

  it("refuses an unknown market before any RPC call", async () => {
    await expect(prepareReview({ manifest, input: input("buy_pt", { marketId: "nope" }), rpc: noIo })).rejects.toThrow(
      'Unknown market "nope"',
    )
  })

  it("explains a preparation failure in plain words", async () => {
    const server = fakeRpc({
      async prepareTransaction() {
        throw new Error("HostError: Error(Contract, #9)")
      },
    })
    await expect(review("mint", {}, server)).rejects.toThrow(
      /could not be prepared \(HostError: Error\(Contract, #9\)\)\. Nothing was signed/,
    )
  })

  it("refuses a prepared transaction that calls something else", async () => {
    const server = fakeRpc({
      async prepareTransaction(tx) {
        const other = new TransactionBuilder(new Account(tx.source, "41"), { fee: BASE_FEE, networkPassphrase: passphrase })
          .addOperation(new Contract(market.contracts.router).call("claim_yield"))
          .setTimeout(300)
          .build()
        return assemble(other)
      },
    })
    await expect(review("mint", {}, server)).rejects.toThrow("not the transaction that was requested")
  })

  describe("treats what RPC prepares as untrusted (R29)", () => {
    const preparedBy = (prepare: (tx: Transaction) => Transaction) => review("mint", {}, fakeRpc({ prepareTransaction: async (tx) => prepare(tx) }))

    it("refuses changed time bounds", async () => {
      await expect(
        preparedBy((tx) => assemble(TransactionBuilder.cloneFrom(tx, { timebounds: { minTime: 0, maxTime: 4_102_444_800 } }).build())),
      ).rejects.toThrow("RPC changed the time bounds")
    })

    it("refuses a fee above the 10 XLM cap", async () => {
      expect(MAX_TX_FEE_STROOPS).toBe(100_000_000n)
      await expect(preparedBy((tx) => assemble(tx, { resourceFee: MAX_TX_FEE_STROOPS }))).rejects.toThrow(
        "asks for a network fee of 10.00001 XLM, above the 10 XLM this app signs",
      )
    })

    it("accepts a fee at the cap and shows it exactly", async () => {
      const r = await preparedBy((tx) => assemble(tx, { resourceFee: MAX_TX_FEE_STROOPS - BigInt(BASE_FEE) }))
      expect(r.fee).toBe(MAX_TX_FEE_STROOPS.toString())
      expect(r.summary.fees[0]).toBe("Network fee: up to 10 XLM")
    })

    it("refuses a fee the resource fee does not explain", async () => {
      // Same call and resource fee, but the inclusion fee was raised from 100 to 5000 stroops.
      await expect(preparedBy((tx) => assemble(TransactionBuilder.cloneFrom(tx, { fee: "5000" }).build()))).rejects.toThrow(
        "is more than the base fee plus the resource fee it declares",
      )
    })

    it("refuses a foreign authorization entry", async () => {
      const transfer = new xdr.InvokeContractArgs({
        contractAddress: new Address(market.underlying.sac).toScAddress(),
        functionName: "transfer",
        args: [],
      })
      await expect(preparedBy((tx) => assemble(tx, { auth: [authFor(transfer)] }))).rejects.toThrow(
        "RPC added an authorization for something other than this call",
      )
      // Alongside the genuine one, too.
      await expect(preparedBy((tx) => assemble(tx, { auth: [authFor(callOf(tx)), authFor(transfer)] }))).rejects.toThrow(
        "RPC added an authorization for something other than this call",
      )
    })

    it("refuses an authorization for the same function with other arguments", async () => {
      const other = (tx: Transaction) =>
        new xdr.InvokeContractArgs({
          contractAddress: callOf(tx).contractAddress,
          functionName: callOf(tx).functionName,
          args: [...callOf(tx).args.slice(0, -1), xdr.ScVal.scvU64(1n)],
        })
      await expect(preparedBy((tx) => assemble(tx, { auth: [authFor(other(tx))] }))).rejects.toThrow(
        "RPC added an authorization for something other than this call",
      )
    })
  })

  describe("summary", () => {
    it("summary shows the floor values", async () => {
      const r = await review("buy_pt")
      // 7 decimals: the exact floor being signed, not a rounded one.
      expect(r.summary.getAtLeast).toEqual(["9.4525001 PT"])
      expect(r.summary.give).toEqual(["10 SY"])
      expect(r.summary.fees[0]).toBe("Network fee: up to 0.0012445 XLM")
      expect(r.summary.deadline).toBe(Number(DEADLINE))
    })

    it("carries the transaction's own time bound, as signed (M3)", async () => {
      const r = await review("buy_pt")
      const maxTime = Number(new Transaction(r.unsignedXdr, passphrase).timeBounds?.maxTime)
      expect(r.summary.validUntil).toBe(maxTime)
      // 300 s after preparation, by the device clock; how it is computed is unchanged.
      expect(Math.abs(maxTime - (Math.floor(r.preparedAtMs / 1000) + TX_TIMEOUT_SECONDS))).toBeLessThanOrEqual(1)
      expect((await review("deposit")).summary.validUntil).toBeGreaterThan(0)
    })

    it("names the token on each side, with every signed floor", async () => {
      const g = { minOut: 1_2345678n, minOut2: 2_0000001n, maxNetCost: 3_5000000n }
      const lines = async (action: ActionId, extra: Partial<ActionInput> = {}) => {
        const { give, getAtLeast } = (await review(action, { guards: g, ...extra })).summary
        return { give, getAtLeast }
      }
      expect(await lines("deposit")).toEqual({ give: ["10 STA"], getAtLeast: ["1.2345678 SY"] })
      expect(await lines("withdraw")).toEqual({ give: ["10 SY"], getAtLeast: ["1.2345678 STA"] })
      expect(await lines("mint")).toEqual({
        give: ["10 STA"],
        getAtLeast: ["1.2345678 PT, and the same amount of YT"],
      })
      expect(await lines("sell_pt")).toEqual({ give: ["10 PT"], getAtLeast: ["1.2345678 SY"] })
      expect(await lines("buy_yt")).toEqual({
        give: ["10 SY, of which at most 3.5 SY is spent: the rest comes back to you"],
        getAtLeast: ["1.2345678 YT"],
      })
      // max_net_cost >= sy_in: the Router guarantees no SY back (min_sy_back = 0).
      expect((await lines("buy_yt", { guards: { ...g, maxNetCost: 10_0000000n } })).give).toEqual([
        "10 SY, all of which may be spent: no SY is guaranteed back",
      ])
      expect(await lines("sell_yt")).toEqual({ give: ["10 YT"], getAtLeast: ["1.2345678 SY"] })
      // Only pt_used / sy_used, in the pool's ratio, are taken (M4).
      expect(await lines("add_liquidity", { secondaryAmount: 4_0000000n })).toEqual({
        give: ["up to 10 PT", "up to 4 SY"],
        getAtLeast: ["1.2345678 LP"],
      })
      // R4-7: the pool takes the whole amount and sends back what it does not use.
      expect(await lines("add_liquidity_sy")).toEqual({
        give: ["up to 10 SY (the part the pool does not use is sent back to you)"],
        getAtLeast: ["1.2345678 LP"],
      })
      expect(await lines("remove_liquidity")).toEqual({ give: ["10 LP"], getAtLeast: ["1.2345678 PT", "2.0000001 SY"] })
      expect(await lines("recombine")).toEqual({ give: ["10 PT", "10 YT"], getAtLeast: ["1.2345678 SY"] })
    })

    it("one-step Router actions: what is given in the underlying or PT / YT, and the least received", async () => {
      const g: GuardValues = { minOut: 1_2345678n }
      const lines = async (action: ActionId, extra: Partial<ActionInput> = {}) => {
        const { give, getAtLeast } = (await review(action, { guards: g, ...extra })).summary
        return { give, getAtLeast }
      }
      expect(await lines("buy_pt_underlying")).toEqual({ give: ["10 STA"], getAtLeast: ["1.2345678 PT"] })
      // R5-4: the sales withdraw only what they produced, so the sweep sentence is gone.
      expect(await lines("sell_pt_underlying")).toEqual({ give: ["10 PT"], getAtLeast: ["1.2345678 STA"] })
      expect(await lines("sell_yt_underlying")).toEqual({ give: ["10 YT"], getAtLeast: ["1.2345678 STA"] })
      // Only min_lp_out is signed; the YT comes from minting `mint_amount` SY of the deposit.
      expect(await lines("add_liquidity_keep_yt", { secondaryAmount: 4_0000000n })).toEqual({
        give: ["10 STA"],
        getAtLeast: [
          "1.2345678 LP",
          "The YT minted from 4 SY of your deposit, which you keep. This call sets no minimum on it.",
          "Any PT or SY the pool does not take stays in your wallet.",
        ],
      })
    })

    it("flash Buy YT: the budget in, the bound as signed (SY) of it spent, the rest back in the token paid (R5-2, P4)", async () => {
      const g: GuardValues = { minOut: 1_2345678n, minOut2: 6_5000000n, maxNetCost: 3_5000000n }
      const lines = async (action: ActionId) => {
        const { give, getAtLeast } = (await review(action, { guards: g, secondaryAmount: 9_0000000n })).summary
        return { give, getAtLeast }
      }
      expect(await lines("buy_yt_flash")).toEqual({
        give: ["10 SY in; at most 3.5 SY of it is spent, the rest comes back as SY in the same transaction"],
        getAtLeast: ["1.2345678 YT"],
      })
      expect(await lines("buy_yt_flash_underlying")).toEqual({
        give: ["10 STA in; at most 3.5 SY of it is spent, the rest comes back as STA in the same transaction"],
        getAtLeast: ["1.2345678 YT"],
      })
    })

    it("LP only from USDY and the exit to USDY (R5-5, R5-6)", async () => {
      const g: GuardValues = { minOut: 1_2345678n }
      const lines = async (action: ActionId, extra: Partial<ActionInput> = {}) => {
        const { give, getAtLeast } = (await review(action, { guards: g, ...extra })).summary
        return { give, getAtLeast }
      }
      expect(await lines("add_liquidity_underlying", { secondaryAmount: 9_5000000n })).toEqual({
        give: ["10 STA, deposited as SY; 9.5 SY of it goes to the pool, and any SY it does not use is sent back to you as SY"],
        getAtLeast: ["1.2345678 LP"],
      })
      expect(await lines("remove_liquidity_underlying")).toEqual({ give: ["10 LP"], getAtLeast: ["1.2345678 STA"] })
    })

    it("one-step Router actions pay the fees of their components", async () => {
      const fees = async (action: ActionId) =>
        (await review(action, { guards: { minOut: 1n, minOut2: 1n, maxNetCost: 1n }, secondaryAmount: 1n })).summary.fees.slice(1)
      const swap = expect.stringMatching(/^Swap fee:/)
      const tokenization = expect.stringMatching(/^Tokenization fee:/)
      expect(await fees("buy_pt_underlying")).toEqual([swap])
      expect(await fees("sell_pt_underlying")).toEqual([swap])
      expect(await fees("sell_yt_underlying")).toEqual([swap])
      expect(await fees("buy_yt_flash")).toEqual([tokenization, swap])
      expect(await fees("buy_yt_flash_underlying")).toEqual([tokenization, swap])
      expect(await fees("add_liquidity_underlying")).toEqual([swap])
      expect(await fees("remove_liquidity_underlying")).toEqual([swap])
      // deposit + mint + proportional add_liquidity: no swap inside.
      expect(await fees("add_liquidity_keep_yt")).toEqual([tokenization])
      for (const action of [
        "buy_pt_underlying",
        "sell_pt_underlying",
        "sell_yt_underlying",
        "add_liquidity_keep_yt",
        "buy_yt_flash",
        "buy_yt_flash_underlying",
        "add_liquidity_underlying",
        "remove_liquidity_underlying",
      ] as const) {
        expect((await review(action, { guards: { minOut: 1n, minOut2: 1n, maxNetCost: 1n }, secondaryAmount: 1n })).summary.deadline).toBe(Number(DEADLINE))
      }
    })

    it("says plainly when no minimum is enforced", async () => {
      const claim = (await review("claim_yield", { guards: {}, amount: 0n })).summary
      expect(claim.give).toEqual([])
      expect(claim.getAtLeast).toEqual(["Your pending yield, paid in STA. This call sets no minimum."])
      const redeem = (await review("redeem", { guards: {}, secondaryAmount: 2_0000000n })).summary
      expect(redeem.give).toEqual(["10 PT", "2 YT"])
      // This redemption may be the one that settles the market: the rate is not claimed to be fixed (M4).
      expect(redeem.getAtLeast).toEqual([
        "STA for your PT, at the settlement rate. If the market has not settled yet, this redemption may be the one that settles it, at the rate in force when it lands.",
        "STA for your YT: the yield it has left, net of the YT fee.",
        "This call sets no minimum.",
      ])
      const ptOnly = (await review("redeem", { guards: {}, secondaryAmount: 0n })).summary
      expect(ptOnly.give).toEqual(["10 PT"])
      expect(ptOnly.getAtLeast).toHaveLength(2)
      expect(ptOnly.fees).toEqual(["Network fee: up to 0.0012445 XLM"])
      // A YT-only redeem lists no "0 PT" (M4).
      const ytOnly = (await review("redeem", { guards: {}, amount: 0n, secondaryAmount: 2_0000000n })).summary
      expect(ytOnly.give).toEqual(["2 YT"])
      expect(ytOnly.getAtLeast).toEqual(["STA for your YT: the yield it has left, net of the YT fee.", "This call sets no minimum."])
    })

    it("lists the protocol fee the action pays, after the network fee", async () => {
      const fees = async (action: ActionId) => (await review(action, { guards: { minOut: 1n, minOut2: 1n, maxNetCost: 1n } })).summary.fees
      expect(await fees("deposit")).toEqual(["Network fee: up to 0.0012445 XLM"])
      expect((await fees("mint"))[1]).toMatch(/^Tokenization fee:/)
      expect((await fees("buy_pt"))[1]).toMatch(/^Swap fee:/)
      expect(await fees("buy_yt")).toHaveLength(3)
      expect((await fees("claim_yield"))[1]).toMatch(/^YT fee:/)
    })

    it("has a deadline only when the call enforces one", async () => {
      expect((await review("deposit")).summary.deadline).toBeUndefined()
      expect((await review("claim_yield", { guards: {} })).summary.deadline).toBeUndefined()
      expect((await review("withdraw")).summary.deadline).toBe(Number(DEADLINE))
    })
  })
})

describe("isExpired", () => {
  const at = (preparedAtMs: number) => ({ preparedAtMs, expiresAtMs: preparedAtMs + REVIEW_TTL_MS }) as Review

  it("expires 60 s after preparation", () => {
    expect(isExpired(at(1_000), 1_000)).toBe(false)
    expect(isExpired(at(1_000), 1_000 + 59_999)).toBe(false)
    expect(isExpired(at(1_000), 1_000 + 60_000)).toBe(true)
  })

  it("fails closed on a clock that went backwards or is not a number", () => {
    expect(isExpired(at(1_000), 999)).toBe(true)
    expect(isExpired(at(1_000), Number.NaN)).toBe(true)
  })
})

describe("executeReview", () => {
  it("signs, checks, submits and polls the reviewed transaction (ported signAndSubmit)", async () => {
    const server = fakeRpc()
    const r = await review("buy_pt", {}, server)
    const sign = signWith()

    const result = await executeReview({ review: r, manifest, sign, rpc: server, nowMs: r.preparedAtMs + 1_000 })

    expect(sign.seen).toEqual([[r.unsignedXdr, passphrase, SOURCE]])
    expect(server.calls.sent).toHaveLength(1)
    expect(server.calls.sent[0].hash()).toEqual(new Transaction(r.unsignedXdr, passphrase).hash())
    // R30: the hash is computed locally from the signed envelope, not taken from RPC's answer.
    expect(server.calls.polled).toEqual([hashOf(r.unsignedXdr)])
    expect(result).toEqual({ hash: hashOf(r.unsignedXdr), status: "SUCCESS", output: { kind: "amount", value: 9_5000000n } })
    expect(result.hash).not.toBe(HASH)
  })

  it("refuses an expired review", async () => {
    const server = fakeRpc()
    const r = await review("buy_pt", {}, server)
    const sign = signWith()

    await expect(
      executeReview({ review: r, manifest, sign, rpc: server, nowMs: r.preparedAtMs + REVIEW_TTL_MS }),
    ).rejects.toThrow("This review is over a minute old")
    expect(sign.seen).toEqual([])
    expect(server.calls.sent).toEqual([])
  })

  it("refuses when the signed hash differs", async () => {
    const server = fakeRpc()
    const r = await review("buy_pt", {}, server)
    // The wallet signs another transaction (another call, at another sequence) with the right key.
    const swapped = async () => {
      const other = new TransactionBuilder(new Account(SOURCE, "99"), { fee: BASE_FEE, networkPassphrase: passphrase })
        .addOperation(new Contract(market.contracts.router).call("claim_yield"))
        .setTimeout(300)
        .build()
      other.sign(wallet)
      return other.toXDR()
    }

    await expect(executeReview({ review: r, manifest, sign: swapped, rpc: server })).rejects.toThrow(
      "does not match the reviewed unsigned transaction",
    )
    expect(server.calls.sent).toEqual([])
  })

  it("refuses a signature from another account", async () => {
    const server = fakeRpc()
    const r = await review("buy_pt", {}, server)
    await expect(executeReview({ review: r, manifest, sign: signWith(Keypair.random()), rpc: server })).rejects.toThrow(
      "not signed by the connected wallet account",
    )
    expect(server.calls.sent).toEqual([])
  })

  it("decodes the output on success", async () => {
    const server = fakeRpc({
      async getTransaction() {
        return {
          status: "SUCCESS",
          returnValue: nativeToScVal({ pt_minted: 9_9000000n, yt_minted: 9_9000000n, fee_shares: 1000n }),
        }
      },
    })
    const r = await review("mint", {}, server)
    const result = await executeReview({ review: r, manifest, sign: signWith(), rpc: server })
    expect(result.status).toBe("SUCCESS")
    expect(result.output).toEqual({ kind: "mint", pt_minted: 9_9000000n, yt_minted: 9_9000000n, fee_shares: 1000n })
    if (result.output?.kind !== "mint") throw new Error("expected a mint output")
    expect(result.output.pt_minted).toBe(9_9000000n)
  })

  it("keeps the hash and status when the return value cannot be decoded", async () => {
    const server = fakeRpc({
      async getTransaction() {
        return { status: "SUCCESS", returnValue: { type: "scvMap", map: [null], value: [null] } as unknown as xdr.ScVal }
      },
    })
    const r = await review("mint", {}, server)
    const result = await executeReview({ review: r, manifest, sign: signWith(), rpc: server })
    expect(result).toMatchObject({ status: "SUCCESS", output: undefined })
    expect(result.decodeError).toMatch(/could not be decoded/)
  })

  it("keeps the hash and status when the return value has the wrong shape", async () => {
    // mint returns a MintResult; an i128 is not one.
    const r = await review("mint")
    const result = await executeReview({ review: r, manifest, sign: signWith(), rpc: fakeRpc() })
    expect(result).toMatchObject({ status: "SUCCESS", output: undefined })
    expect(result.decodeError).toMatch(/Unexpected simulation result for mint/)
  })

  it("keeps the hash and status when a success returns no value", async () => {
    const server = fakeRpc({
      async getTransaction() {
        return { status: "SUCCESS" }
      },
    })
    const result = await executeReview({ review: await review("mint", {}, server), manifest, sign: signWith(), rpc: server })
    expect(result).toMatchObject({ status: "SUCCESS", output: undefined })
    expect(result.decodeError).toMatch(/returned no value/)
  })

  it("reports a failed transaction without an output, with the cause RPC gives (R49)", async () => {
    const failing = (failure: { resultXdr?: xdr.TransactionResult; diagnosticEventsXdr?: xdr.DiagnosticEvent[] }) =>
      fakeRpc({
        async getTransaction() {
          return { status: "FAILED", ...failure }
        },
      })
    const run = async (server: ReturnType<typeof fakeRpc>) =>
      executeReview({ review: await review("buy_pt", {}, server), manifest, sign: signWith(), rpc: server })

    expect(await run(failing({}))).toEqual({
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "FAILED",
      reason: "The network did not say why. Nothing was taken except the network fee.",
    })
    expect(await run(failing({ resultXdr: failedResult() }))).toMatchObject({
      status: "FAILED",
      reason: "Cause: the contract call failed. Nothing was taken except the network fee.",
    })
    // The host refused a nested transfer whose amount was worked out again at inclusion.
    const refused = await run(failing({ resultXdr: failedResult(), diagnosticEventsXdr: [authInvalidActionEvent()] }))
    expect(refused).toMatchObject({ status: "FAILED", reason: AMOUNTS_MOVED_REASON })
    expect(refused.output).toBeUndefined()
  })

  it("keeps the hash when polling fails after submission", async () => {
    const server = fakeRpc({
      async getTransaction() {
        throw new Error("rate limited")
      },
    })
    const r = await review("buy_pt", {}, server)
    const result = await executeReview({ review: r, manifest, sign: signWith(), rpc: server })
    expect(result).toMatchObject({ hash: hashOf(r.unsignedXdr), status: "NOT_FOUND" })
    expect(result.pollError).toMatch(/The transaction was submitted, but its status could not be read \(rate limited\)/)
  })

  it("polls a duplicate submission", async () => {
    const server = fakeRpc({
      async sendTransaction() {
        return { status: "DUPLICATE", hash: HASH }
      },
    })
    const r = await review("buy_pt", {}, server)
    const result = await executeReview({ review: r, manifest, sign: signWith(), rpc: server })
    expect(result.status).toBe("SUCCESS")
    expect(server.calls.polled).toEqual([hashOf(r.unsignedXdr)])
  })

  it("refuses a submission the network did not accept", async () => {
    const server = fakeRpc({
      async sendTransaction() {
        return { status: "TRY_AGAIN_LATER", hash: HASH }
      },
    })
    await expect(
      executeReview({ review: await review("buy_pt", {}, server), manifest, sign: signWith(), rpc: server }),
    ).rejects.toThrow("The network is busy and did not accept the transaction")
    expect(server.calls.polled).toEqual([])
  })

  describe("re-checks the review it is handed, before signing (R31)", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    async function refusedBeforeSigning(r: Review, server: ReturnType<typeof fakeRpc>, message: string, nowMs?: number) {
      const sign = signWith()
      await expect(executeReview({ review: r, manifest, sign, rpc: server, nowMs })).rejects.toThrow(message)
      expect(sign.seen).toEqual([])
      expect(server.calls.sent).toEqual([])
    }
    const changed = (detail: string) => `This review was changed after it was prepared (${detail}). Prepare it again before signing.`

    it("refuses a review whose floor was changed to 0", async () => {
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      r.input.guards.minOut = 0n
      await refusedBeforeSigning(r, server, "zero floor")
    })

    it("refuses a review whose call was changed", async () => {
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      r.invocation.args[2] = { type: "i128", value: 1n }
      await refusedBeforeSigning(r, server, changed("the call it describes"))

      // Input and description changed together: the transaction no longer makes that call.
      const r2 = await review("buy_pt", {}, server)
      r2.input.amount = 1n
      r2.invocation = invocationFor(manifest, r2.input)
      await refusedBeforeSigning(r2, server, changed("its transaction does not make the reviewed call"))
    })

    it("refuses a swapped XDR", async () => {
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      const other = await review("buy_pt", { amount: 5_0000000n }, server)
      r.unsignedXdr = other.unsignedXdr
      r.unsignedXdrHash = other.unsignedXdrHash
      await refusedBeforeSigning(r, server, changed("its transaction does not make the reviewed call"))
    })

    it("refuses an XDR for the same call that prepareReview did not issue for this review", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      vi.setSystemTime(Date.now() + 5_000)
      // Same call, source and fee; other time bounds.
      const twin = await review("buy_pt", {}, server)
      expect(twin.unsignedXdr).not.toBe(r.unsignedXdr)
      r.unsignedXdr = twin.unsignedXdr
      r.unsignedXdrHash = twin.unsignedXdrHash
      await refusedBeforeSigning(r, server, changed("its transaction is not the one that was prepared"))
    })

    it("refuses a changed hash or fee field", async () => {
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      r.unsignedXdrHash = hashLike("something else")
      await refusedBeforeSigning(r, server, changed("its transaction is not the one that was prepared"))

      const r2 = await review("buy_pt", {}, server)
      r2.fee = BASE_FEE
      await refusedBeforeSigning(r2, server, changed("its fee"))
    })

    it("refuses an object prepareReview did not return", async () => {
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      await refusedBeforeSigning({ ...r }, server, "This review was not prepared by this app. Prepare it again before signing.")
    })

    it("does not trust a self-reported preparation time or nowMs", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      const issuedAt = r.preparedAtMs
      vi.setSystemTime(issuedAt + REVIEW_TTL_MS)

      r.preparedAtMs = Date.now()
      r.expiresAtMs = Date.now() + REVIEW_TTL_MS
      await refusedBeforeSigning(r, server, changed("its preparation time"))

      r.preparedAtMs = issuedAt
      // nowMs cannot hold time back: the system clock says the review has expired.
      await refusedBeforeSigning(r, server, "This review is over a minute old", issuedAt + 1)
    })

    it("re-checks expiry once the wallet has signed, and then submits nothing", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      const slowWallet = async (unsignedXdr: string, networkPassphrase: string) => {
        vi.setSystemTime(Date.now() + REVIEW_TTL_MS) // the user took a minute to approve
        return signWith()(unsignedXdr, networkPassphrase, SOURCE)
      }
      await expect(executeReview({ review: r, manifest, sign: slowWallet, rpc: server })).rejects.toThrow(
        "This review is over a minute old",
      )
      expect(server.calls.sent).toEqual([])
    })

    it("an ERROR or TRY_AGAIN_LATER rejection carries the locally computed hash", async () => {
      const rejectedWith = async (response: Awaited<ReturnType<ReviewRpcServer["sendTransaction"]>>) => {
        const server = fakeRpc({ sendTransaction: async () => response })
        const r = await review("buy_pt", {}, server)
        const error = await executeReview({ review: r, manifest, sign: signWith(), rpc: server }).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(SubmissionRejectedError)
        expect((error as SubmissionRejectedError).hash).toBe(hashOf(r.unsignedXdr))
        expect(server.calls.polled).toEqual([])
      }
      await rejectedWith({
        status: "ERROR",
        errorResult: new xdr.TransactionResult({
          feeCharged: 100n,
          result: xdr.TransactionResultResult.txBadSeq(),
          ext: xdr.TransactionResultExt.v0(),
        }),
      })
      await rejectedWith({ status: "TRY_AGAIN_LATER", hash: HASH })
    })
  })

  describe("never loses the hash of a transaction that may have landed (R30)", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it("polls the locally computed hash when sendTransaction throws", async () => {
      const server = fakeRpc({
        async sendTransaction() {
          throw new Error("socket hang up")
        },
      })
      const r = await review("buy_pt", {}, server)
      const result = await executeReview({ review: r, manifest, sign: signWith(), rpc: server })
      // The send failed, but the transaction landed: the poll by the local hash finds it.
      expect(server.calls.polled).toEqual([hashOf(r.unsignedXdr)])
      expect(result).toEqual({ hash: hashOf(r.unsignedXdr), status: "SUCCESS", output: { kind: "amount", value: 9_5000000n } })
    })

    it("returns the hash with a pollError when the failed send is not found", async () => {
      const server = fakeRpc({
        async sendTransaction() {
          throw new Error("socket hang up")
        },
        async getTransaction(hash) {
          server.calls.polled.push(hash)
          return { status: "NOT_FOUND" }
        },
      })
      const r = await review("buy_pt", {}, server)
      vi.useFakeTimers({ toFake: ["setTimeout"] })
      const pending = executeReview({ review: r, manifest, sign: signWith(), rpc: server })
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result).toMatchObject({ hash: hashOf(r.unsignedXdr), status: "NOT_FOUND" })
      expect(result.pollError).toBe(
        "Sending the transaction failed (socket hang up), and the network does not show it yet. Look it up by its hash before trying again.",
      )
      expect(server.calls.polled.every((h) => h === hashOf(r.unsignedXdr))).toBe(true)
    })

    it("uses the local hash when RPC returns none", async () => {
      const server = fakeRpc({
        async sendTransaction() {
          return { status: "PENDING" }
        },
      })
      const r = await review("buy_pt", {}, server)
      const result = await executeReview({ review: r, manifest, sign: signWith(), rpc: server })
      expect(result).toMatchObject({ hash: hashOf(r.unsignedXdr), status: "SUCCESS" })
    })

    it("does not poll a submission the network rejected", async () => {
      const server = fakeRpc({
        async sendTransaction() {
          return {
            status: "ERROR",
            errorResult: new xdr.TransactionResult({
              feeCharged: 100n,
              result: xdr.TransactionResultResult.txBadSeq(),
              ext: xdr.TransactionResultExt.v0(),
            }),
          }
        },
      })
      await expect(
        executeReview({ review: await review("buy_pt", {}, server), manifest, sign: signWith(), rpc: server }),
      ).rejects.toThrow("the account's sequence number changed")
      expect(server.calls.polled).toEqual([])
    })
  })
})

describe("prepareRestore", () => {
  const RESTORE_FEE = 777n
  const { router, pool, manager } = market.contracts
  const instance = (id: string) => new Contract(id).getFootprint()
  const code = (hash: Uint8Array) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash }))

  function restoreSimulation(
    footprint: { readWrite?: xdr.LedgerKey[]; readOnly?: xdr.LedgerKey[] } = {},
    fee: bigint | string = RESTORE_FEE,
  ) {
    const transactionData = new SorobanDataBuilder()
      .setResourceFee(RESTORE_FEE.toString())
      .setReadWrite(footprint.readWrite ?? [instance(router), instance(pool)])
      .setReadOnly(footprint.readOnly ?? [])
      .build()
      .toXdr("base64")
    return rpc.parseRawSimulation({
      id: "1",
      latestLedger: 90,
      events: [],
      minResourceFee: "50",
      transactionData,
      results: [{ auth: [], xdr: i128(1n).toXdr("base64") }],
      restorePreamble: { minResourceFee: fee.toString(), transactionData },
    })
  }
  const invocation = () => invocationFor(manifest, input("buy_pt"))
  const restoreWith = (simulation: ReturnType<typeof restoreSimulation>, m = manifest) =>
    prepareRestore({ manifest: m, source: SOURCE, invocation: invocation(), rpc: fakeRpc({ simulateTransaction: async () => simulation }) })

  it("restore-required yields a restore transaction", async () => {
    const simulated: Transaction[] = []
    const server = fakeRpc({
      async simulateTransaction(tx) {
        simulated.push(tx)
        return restoreSimulation()
      },
    })
    const before = Date.now()
    const restore = await prepareRestore({ manifest, source: SOURCE, invocation: invocation(), rpc: server })

    // The archived entries are found by simulating the action itself, as the user.
    expect(simulated).toHaveLength(1)
    expect(simulated[0].source).toBe(SOURCE)

    const tx = new Transaction(restore.unsignedXdr, passphrase)
    expect(tx.operations).toHaveLength(1)
    expect(tx.operations[0].type).toBe("restoreFootprint")
    expect(tx.source).toBe(SOURCE)
    expect(tx.sequence).toBe("42")
    const fee = (BigInt(BASE_FEE) + RESTORE_FEE).toString()
    expect(tx.fee).toBe(fee)
    // R29: the fee is returned so it is shown before signing, and the restore expires like a review.
    expect(restore.fee).toBe(fee)
    expect(restore.source).toBe(SOURCE)
    expect(restore.unsignedXdrHash).toBe(hashLike(restore.unsignedXdr))
    expect(restore.preparedAtMs).toBeGreaterThanOrEqual(before)
    expect(restore.expiresAtMs - restore.preparedAtMs).toBe(REVIEW_TTL_MS)
  })

  it("refuses when nothing needs restoring", async () => {
    await expect(prepareRestore({ manifest, source: SOURCE, invocation: invocation(), rpc: fakeRpc() })).rejects.toThrow(
      "No contract data needs restoring",
    )
  })

  describe("treats the restore preamble as untrusted (R29)", () => {
    it("accepts the market's data, shared contracts, the SAC and contract code the manifest pins", async () => {
      const keys = [
        instance(manager),
        instance(manifest.shared.riskControl),
        instance(manifest.shared.permissioning),
        instance(market.underlying.sac),
        code(MARKET_WASM),
      ]
      const restore = await restoreWith(restoreSimulation({ readWrite: keys }), pinnedManifest)
      const tx = new Transaction(restore.unsignedXdr, passphrase)
      expect(tx.operations[0].type).toBe("restoreFootprint")
    })

    it("refuses a restore fee above the 10 XLM cap", async () => {
      await expect(restoreWith(restoreSimulation({}, MAX_TX_FEE_STROOPS))).rejects.toThrow(
        "The restore asks for a network fee of 10.00001 XLM, above the 10 XLM this app signs",
      )
      await expect(restoreWith(restoreSimulation({}, "-1"))).rejects.toThrow("no valid restore fee")
    })

    it("refuses a footprint key of a contract outside the market", async () => {
      await expect(restoreWith(restoreSimulation({ readWrite: [instance(router), instance(FOREIGN)] }))).rejects.toThrow(
        `data of a contract outside this market (${FOREIGN})`,
      )
    })

    it("refuses a non-contract ledger key", async () => {
      const account = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.random().xdrAccountId() }))
      await expect(restoreWith(restoreSimulation({ readWrite: [account] }))).rejects.toThrow("includes a account entry")
    })

    describe("contract code is restored only if the manifest pins its hash (R29b)", () => {
      it("accepts a pinned hash", async () => {
        const restore = await restoreWith(restoreSimulation({ readWrite: [code(MARKET_WASM)] }), pinnedManifest)
        expect(new Transaction(restore.unsignedXdr, passphrase).operations[0].type).toBe("restoreFootprint")
      })

      it("refuses an unpinned hash", async () => {
        const unpinned = new Uint8Array(32).fill(9)
        await expect(restoreWith(restoreSimulation({ readWrite: [code(unpinned)] }), pinnedManifest)).rejects.toThrow(
          `includes contract code the manifest does not pin (${hex(unpinned)}). Refusing to restore it; ask the operator`,
        )
      })

      it("refuses a hash that differs in one byte", async () => {
        const nearly = MARKET_WASM.slice()
        nearly[31] = 4
        await expect(restoreWith(restoreSimulation({ readWrite: [code(nearly)] }), pinnedManifest)).rejects.toThrow(
          "contract code the manifest does not pin",
        )
      })

      it("refuses any contract code when the manifest pins none", async () => {
        expect(manifest.markets[0].wasmHashes).toBeUndefined()
        await expect(restoreWith(restoreSimulation({ readWrite: [instance(router), code(MARKET_WASM)] }))).rejects.toThrow(
          "Restore needs contract code the manifest does not pin; ask the operator.",
        )
      })
    })

    it("refuses a read-only entry", async () => {
      await expect(restoreWith(restoreSimulation({ readWrite: [instance(router)], readOnly: [instance(pool)] }))).rejects.toThrow(
        "includes read-only entries",
      )
    })

    it("refuses an empty footprint and a call outside the manifest", async () => {
      await expect(restoreWith(restoreSimulation({ readWrite: [] }))).rejects.toThrow("names no ledger entry")
      const outside = { ...invocation(), contractId: FOREIGN }
      await expect(prepareRestore({ manifest, source: SOURCE, invocation: outside, rpc: noIo })).rejects.toThrow(
        "not to a contract of this network's markets",
      )
    })
  })
})

describe("executeRestore", () => {
  const restoreServer = () =>
    fakeRpc({
      async simulateTransaction() {
        const transactionData = new SorobanDataBuilder()
          .setReadWrite([new Contract(market.contracts.router).getFootprint()])
          .build()
          .toXdr("base64")
        return rpc.parseRawSimulation({
          id: "1",
          latestLedger: 90,
          events: [],
          minResourceFee: "50",
          transactionData,
          results: [{ auth: [], xdr: i128(1n).toXdr("base64") }],
          restorePreamble: { minResourceFee: "777", transactionData },
        })
      },
      async getTransaction() {
        return { status: "SUCCESS" }
      },
    })
  const prepare = (server: ReviewRpcServer) =>
    prepareRestore({ manifest, source: SOURCE, invocation: invocationFor(manifest, input("buy_pt")), rpc: server })

  it("signs and submits the restore through the same checks", async () => {
    const server = restoreServer()
    const restore = await prepare(server)

    await expect(executeRestore({ restore, manifest, sign: signWith(Keypair.random()), rpc: server })).rejects.toThrow(
      "not signed by the connected wallet account",
    )
    expect(server.calls.sent).toEqual([])

    const sign = signWith()
    const result = await executeRestore({ restore, manifest, sign, rpc: server })
    expect(sign.seen).toEqual([[restore.unsignedXdr, passphrase, SOURCE]])
    expect(result).toEqual({ hash: hashOf(restore.unsignedXdr), status: "SUCCESS" })
    expect(server.calls.sent[0].operations[0].type).toBe("restoreFootprint")
  })

  it("reports a failed restore with its cause (R49)", async () => {
    const server = restoreServer()
    // What a restore can actually fail with: a restoreFootprint result, never a contract-call one.
    const restoreFailed = new xdr.TransactionResult({
      feeCharged: 48_031n,
      result: xdr.TransactionResultResult.txFailed([
        xdr.OperationResult.opInner(xdr.OperationResultTr.restoreFootprint(xdr.RestoreFootprintResult.restoreFootprintResourceLimitExceeded())),
      ]),
      ext: xdr.TransactionResultExt.v0(),
    })
    server.getTransaction = async () => ({ status: "FAILED", resultXdr: restoreFailed })
    const restore = await prepare(server)
    expect(await executeRestore({ restore, manifest, sign: signWith(), rpc: server })).toEqual({
      hash: hashOf(restore.unsignedXdr),
      status: "FAILED",
      reason: "Cause: the restore ran out of the resources it declared; prepare it again. Nothing was taken except the network fee.",
    })
  })

  it("refuses an expired restore", async () => {
    const server = restoreServer()
    const restore = await prepare(server)
    const sign = signWith()
    await expect(
      executeRestore({ restore, manifest, sign, rpc: server, nowMs: restore.preparedAtMs + REVIEW_TTL_MS }),
    ).rejects.toThrow("This restore was prepared over a minute ago")
    expect(sign.seen).toEqual([])
    expect(server.calls.sent).toEqual([])
  })

  describe("re-checks the restore it is handed, before signing (R31)", () => {
    async function refusedBeforeSigning(restore: RestoreReview, server: ReturnType<typeof fakeRpc>, message: string) {
      const sign = signWith()
      await expect(executeRestore({ restore, manifest, sign, rpc: server })).rejects.toThrow(message)
      expect(sign.seen).toEqual([])
      expect(server.calls.sent).toEqual([])
    }
    const changed = (detail: string) => `This restore was changed after it was prepared (${detail}). Prepare it again before signing.`

    it("refuses a hand-built RestoreReview carrying an invoke XDR", async () => {
      const server = restoreServer()
      const r = await review("buy_pt", { guards: { minOut: 1n } }, server)
      const handBuilt: RestoreReview = {
        source: SOURCE,
        unsignedXdr: r.unsignedXdr,
        unsignedXdrHash: r.unsignedXdrHash,
        fee: r.fee,
        preparedAtMs: Date.now(),
        expiresAtMs: Date.now() + REVIEW_TTL_MS,
      }
      await refusedBeforeSigning(handBuilt, server, "This restore was not prepared by this app. Prepare it again before signing.")
    })

    it("refuses an issued restore whose XDR was swapped for an invoke", async () => {
      const server = restoreServer()
      const restore = await prepare(server)
      const r = await review("buy_pt", { guards: { minOut: 1n } }, server)
      restore.unsignedXdr = r.unsignedXdr
      restore.unsignedXdrHash = r.unsignedXdrHash
      restore.fee = r.fee
      await refusedBeforeSigning(restore, server, changed("its transaction is not a single restoreFootprint"))
    })

    it("refuses a restore whose source, fee or hash changed", async () => {
      const server = restoreServer()
      const bySource = await prepare(server)
      bySource.source = Keypair.random().publicKey()
      await refusedBeforeSigning(bySource, server, changed("its transaction has another source account"))

      const byFee = await prepare(server)
      byFee.fee = BASE_FEE
      await refusedBeforeSigning(byFee, server, changed("its fee"))

      const byHash = await prepare(server)
      byHash.unsignedXdrHash = hashLike("something else")
      await refusedBeforeSigning(byHash, server, changed("its transaction is not the one that was prepared"))
    })

    it("refuses a restore transaction with a fee above the cap", async () => {
      const server = restoreServer()
      const restore = await prepare(server)
      const costly = new TransactionBuilder(new Account(SOURCE, SEQUENCE), { fee: "200000000", networkPassphrase: passphrase })
        .setSorobanData(new SorobanDataBuilder().build())
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(300)
        .build()
      restore.unsignedXdr = costly.toXDR()
      restore.unsignedXdrHash = hashLike(restore.unsignedXdr)
      restore.fee = costly.fee
      await refusedBeforeSigning(restore, server, "The restore asks for a network fee of 20 XLM, above the 10 XLM this app signs")
    })
  })
})

// ------------------------------------------------------------------ manager calls (0002 §5)

describe("manager reviews (0002 §5): the same review → sign pipeline as an action", () => {
  const { permissioning } = manifest.shared
  const GRANTEE = Keypair.random().publicKey()
  const short = (value: string) => `${value.slice(0, 6)}...${value.slice(-6)}`
  const grant = (account = GRANTEE): ManagerCall => grantAccountCall(manifest, { source: SOURCE, account })
  const claim = (): ManagerCall => claimProtocolFeesCall(manifest, { source: SOURCE, marketId: market.marketId, contract: "pool" })
  const managerReview = (call: ManagerCall = grant(), server = fakeRpc()): Promise<ManagerReview> =>
    prepareManagerReview({ manifest, call, rpc: server })
  /** What a permissionless fee claim simulates to: the call, with no authorization at all. */
  const assembleNoAuth = (tx: Transaction) => rpc.assembleTransaction(tx, simulationSuccess({ auth: [] })).build()
  /** The `InvokeContractArgs` a call carries, as it appears in an authorization entry. */
  const argsOf = (call: ManagerCall) =>
    callOf(
      new TransactionBuilder(new Account(SOURCE, SEQUENCE), { fee: BASE_FEE, networkPassphrase: passphrase })
        .addOperation(new Contract(call.invocation.contractId).call(call.invocation.functionName, ...call.invocation.args.map(scArgToVal)))
        .setTimeout(300)
        .build(),
    )
  /** An authorization for `root`, by the source account, with `subInvocations` beneath it. */
  const authWith = (root: xdr.InvokeContractArgs, subInvocations: xdr.InvokeContractArgs[] = []) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(root),
        subInvocations: subInvocations.map(
          (sub) =>
            new xdr.SorobanAuthorizedInvocation({
              function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(sub),
              subInvocations: [],
            }),
        ),
      }),
    })
  /** An authorization for `root` that another account must sign (address credentials). */
  const authBy = (signer: string, root: xdr.InvokeContractArgs) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(signer).toScAddress(),
          nonce: 1n,
          signatureExpirationLedger: 100,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(root),
        subInvocations: [],
      }),
    })

  describe("prepareManagerReview", () => {
    it("prepares the exact manager call through RPC, with its origin, summary and call tree", async () => {
      const server = fakeRpc()
      const call = grant()
      const r = await managerReview(call, server)

      expect(server.calls.getAccount).toEqual([SOURCE])
      expect(server.calls.prepared).toHaveLength(1)
      const prepared = new Transaction(r.unsignedXdr, passphrase)
      expect(prepared.source).toBe(SOURCE)
      expect(prepared.sequence).toBe("42")
      expect(prepared.operations).toHaveLength(1)
      expect(Address.fromScAddress(callOf(prepared).contractAddress).toString()).toBe(permissioning)
      // grant_account(caller, account): the signer is the caller.
      expect(invokedArgs(r.unsignedXdr)).toEqual([SOURCE, GRANTEE])
      expect(prepared.timeBounds).toEqual(server.calls.prepared[0].timeBounds)
      expect(r.fee).toBe(PREPARED_FEE)
      expect(r.unsignedXdrHash).toBe(hashLike(r.unsignedXdr))

      expect(r.origin).toEqual({ type: "manager", call })
      expect(r.origin.call).not.toBe(call) // the review holds its own copy of what it was prepared from
      expect(r.invocation).toEqual(call.invocation)
      expect("input" in r).toBe(false)
      expect(r.callTree).toEqual(["Permissioning.grant_account"])
      // No amounts move from the signer, so there is nothing given and no floor: only the fee and the window.
      expect(r.summary).toEqual({
        give: [],
        getAtLeast: [],
        fees: ["Network fee: up to 0.0012445 XLM"],
        validUntil: Number(prepared.timeBounds?.maxTime),
      })
      expect(r.expiresAtMs - r.preparedAtMs).toBe(REVIEW_TTL_MS)
    })

    it("prepares every kind of manager call this release builds", async () => {
      const calls = [
        setAuthorizedCall(manifest, { source: SOURCE, sac: market.underlying.sac, account: GRANTEE, authorize: true }),
        grant(),
        grantAssetCall(manifest, { source: SOURCE, account: GRANTEE, asset: market.contracts.pt }),
        setPausedCall(manifest, { source: SOURCE, marketId: market.marketId, contract: "pool", paused: true }),
        registerMarketCall(manifest, { source: SOURCE, pool: FOREIGN }),
        addConsumerCall(manifest, { source: SOURCE, consumer: FOREIGN }),
      ]
      for (const call of calls) {
        const r = await managerReview(call)
        expect(r.origin.call).toEqual(call)
        expect(invokedArgs(r.unsignedXdr)).toEqual(call.invocation.args.map((a) => a.value))
      }
      for (const call of [claim(), claimCreatorFeesCall(manifest, { source: SOURCE, marketId: market.marketId, contract: "manager" })]) {
        const r = await managerReview(call, fakeRpc({ prepareTransaction: async (tx) => assembleNoAuth(tx) }))
        expect(invokedArgs(r.unsignedXdr)).toEqual([])
        expect(r.callTree[1]).toBe("SYWrapper.transfer")
      }
    })

    it("refuses a call its builder would not make, before any RPC call", async () => {
      const foreign = grant()
      foreign.invocation.contractId = FOREIGN
      await expect(prepareManagerReview({ manifest, call: foreign, rpc: noIo })).rejects.toThrow(
        "This manager call is not one this app builds for this network: its contract, function or arguments differ.",
      )
      const extra = grant()
      extra.invocation.args.push({ type: "address", value: GRANTEE })
      await expect(prepareManagerReview({ manifest, call: extra, rpc: noIo })).rejects.toThrow("grant_account takes 2 arguments, not 3.")
    })

    it("refuses a failed simulation in plain words: the simulation is the source of truth", async () => {
      const server = fakeRpc({
        async prepareTransaction() {
          throw new Error("HostError: Error(Contract, #2)")
        },
      })
      await expect(managerReview(grant(), server)).rejects.toThrow(/could not be prepared \(HostError: Error\(Contract, #2\)\)\. Nothing was signed/)
    })

    describe("a manager review rejects auth not rooted at the call (R29)", () => {
      const preparedBy = (prepare: (tx: Transaction) => Transaction, call = grant()) =>
        managerReview(call, fakeRpc({ prepareTransaction: async (tx) => prepare(tx) }))
      const foreignAuth = "RPC added an authorization for something other than this call. Refusing to review it; try again or use another RPC."

      it("refuses an authorization for another call", async () => {
        await expect(preparedBy((tx) => assemble(tx, { auth: [authFor(argsOf(grant(Keypair.random().publicKey())))] }))).rejects.toThrow(foreignAuth)
      })

      it("refuses the call's own authorization carrying a sub-invocation: an extra grant beneath it", async () => {
        const extraGrant = argsOf(grant(Keypair.random().publicKey()))
        await expect(preparedBy((tx) => assemble(tx, { auth: [authWith(callOf(tx), [extraGrant])] }))).rejects.toThrow(foreignAuth)
      })

      it("refuses a second authorization, even for the same call", async () => {
        await expect(preparedBy((tx) => assemble(tx, { auth: [authFor(callOf(tx)), authFor(callOf(tx))] }))).rejects.toThrow(foreignAuth)
      })

      it("refuses an authorization a permissionless claim does not need", async () => {
        await expect(preparedBy((tx) => assemble(tx), claim())).rejects.toThrow(foreignAuth)
      })

      it("refuses a call stripped of the signer's authorization", async () => {
        await expect(preparedBy((tx) => assembleNoAuth(tx))).rejects.toThrow(
          "RPC left out the authorization this call needs. Refusing to review it; try again or use another RPC.",
        )
      })

      it("refuses a call another account would have to authorize, naming it", async () => {
        const admin = Keypair.random().publicKey()
        await expect(preparedBy((tx) => assemble(tx, { auth: [authBy(admin, callOf(tx))] }))).rejects.toThrow(
          `This call needs an authorization from another account (${short(admin)}), which this app does not ask for. Connect that account's wallet, then try again.`,
        )
      })

      it("keeps the time bounds and fee checks of an action", async () => {
        await expect(
          preparedBy((tx) => assemble(TransactionBuilder.cloneFrom(tx, { timebounds: { minTime: 0, maxTime: 4_102_444_800 } }).build())),
        ).rejects.toThrow("RPC changed the time bounds")
        await expect(preparedBy((tx) => assemble(tx, { resourceFee: MAX_TX_FEE_STROOPS }))).rejects.toThrow(
          "asks for a network fee of 10.00001 XLM, above the 10 XLM this app signs",
        )
        await expect(preparedBy((tx) => assemble(TransactionBuilder.cloneFrom(tx, { fee: "5000" }).build()))).rejects.toThrow(
          "is more than the base fee plus the resource fee it declares",
        )
      })
    })
  })

  describe("a MarketFactory call (R5-10): the issuer's own authorization, with the factory's calls beneath it", () => {
    const at = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
    const pins = (fill: string) => fill.repeat(32)
    const factoryManifest: Manifest = {
      ...manifest,
      shared: { ...manifest.shared, factory: at(40) },
      wasmHashes: { sy: pins("a1"), pt: pins("a2"), yt: pins("a3"), config: pins("a4"), manager: pins("a5"), pool: pins("a6"), recoveryEscrow: pins("a7") },
    }
    const SALT = "11".repeat(32)
    const params: MarketParams = {
      underlying: market.underlying.sac,
      maturity: 1_807_776_000n,
      ptName: "Principal Token STA",
      ptSymbol: "PT-STA",
      ytName: "Yield Token STA",
      ytSymbol: "YT-STA",
      protocolAdmin: SOURCE,
      treasury: GRANTEE,
      tokenizationFeeBps: 5,
      ytFeeBps: 1000,
      swapFeeTierBps: 10,
      protocolShareBps: 2000,
      timeStretchYears: 4,
    }
    const predicted = deriveMarketContracts(factoryManifest, SALT)
    const tokens = () => createTokensCall(factoryManifest, { source: SOURCE, salt: SALT, params })
    const initialize = (contractId: string) =>
      new xdr.InvokeContractArgs({ contractAddress: new Address(contractId).toScAddress(), functionName: "initialize", args: [] })
    const childInits = () => [initialize(predicted.sy), initialize(predicted.pt), initialize(predicted.yt)]
    const preparedBy = (prepare: (tx: Transaction) => Transaction, call = tokens()) =>
      prepareManagerReview({ manifest: factoryManifest, call, rpc: fakeRpc({ prepareTransaction: async (tx) => prepare(tx) }) })
    const foreignAuth = "RPC added an authorization for something other than this call. Refusing to review it; try again or use another RPC."

    it("prepares, re-verifies and signs it: one entry, the source account's, rooted at exactly the call, the children's initialize beneath", async () => {
      const server = fakeRpc({ prepareTransaction: async (tx) => assemble(tx, { auth: [authWith(callOf(tx), childInits())] }) })
      const r = await prepareManagerReview({ manifest: factoryManifest, call: tokens(), rpc: server })
      expect(r.callTree).toEqual(["MarketFactory.create_tokens", "SYWrapper.initialize", "PTToken.initialize", "YTToken.initialize"])
      expect(r.summary.give).toEqual([])
      const sign = signWith()
      const result = await executeReview({ review: r, manifest: factoryManifest, sign, rpc: server, nowMs: r.preparedAtMs + 1_000 })
      expect(result.status).toBe("SUCCESS")
      expect(sign.seen).toHaveLength(1)
      // create_engine carries more calls beneath it; their number is the factory's, not pinned here.
      const engine = createEngineCall(factoryManifest, { source: SOURCE, salt: SALT, params })
      await expect(preparedBy((tx) => assemble(tx, { auth: [authWith(callOf(tx), [...childInits(), ...childInits()])] }), engine)).resolves.toBeTruthy()
    })

    it("refuses a create-contract authorization beneath the call: the issuer authorizes only contract calls under it", async () => {
      const create = new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
          new xdr.CreateContractArgs({
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
              new xdr.ContractIdPreimageFromAddress({ address: new Address(SOURCE).toScAddress(), salt: Buffer.alloc(32) }),
            ),
            executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32)),
          }),
        ),
        subInvocations: [],
      })
      await expect(
        preparedBy((tx) => {
          const entry = authWith(callOf(tx), childInits())
          entry.rootInvocation.subInvocations.push(create)
          return assemble(tx, { auth: [entry] })
        }),
      ).rejects.toThrow(foreignAuth)
    })

    it("refuses another root, a second entry, and another account's authorization (naming it)", async () => {
      await expect(preparedBy((tx) => assemble(tx, { auth: [authWith(argsOf(grant()), childInits())] }))).rejects.toThrow(foreignAuth)
      await expect(preparedBy((tx) => assemble(tx, { auth: [authWith(callOf(tx), childInits()), authFor(callOf(tx))] }))).rejects.toThrow(foreignAuth)
      const issuer = Keypair.random().publicKey()
      await expect(preparedBy((tx) => assemble(tx, { auth: [authBy(issuer, callOf(tx))] }))).rejects.toThrow(
        `This call needs an authorization from another account (${short(issuer)})`,
      )
      await expect(preparedBy((tx) => rpc.assembleTransaction(tx, simulationSuccess({ auth: [] })).build())).rejects.toThrow(
        "RPC left out the authorization this call needs.",
      )
    })

    it("only the asset's issuer may sign it (R5-10): a wallet without the role is told so", () => {
      const connected: WalletState = { status: "connected", publicKey: SOURCE, networkPassphrase: passphrase }
      const roles = (...value: Role[]): Live<Role[]> => ({ status: "live", value, ledger: 90 })
      expect(evaluateManagerGates(tokens(), { wallet: connected, roles: roles("issuer"), findings: [], listed: true })).toEqual([])
      expect(evaluateManagerGates(tokens(), { wallet: connected, roles: roles(), findings: [], listed: true })).toEqual([
        {
          code: "wallet",
          message: `Only the asset's issuer can deploy a market on it. You are connected as ${short(SOURCE)}, which is not the asset's issuer. Connect the asset's issuer's wallet to sign this.`,
        },
      ])
    })
  })

  describe("execute re-verifies a manager review (R31)", () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    async function refusedBeforeSigning(r: Review | ManagerReview, server: ReturnType<typeof fakeRpc>, message: string, nowMs?: number) {
      const sign = signWith()
      await expect(executeReview({ review: r, manifest, sign, rpc: server, nowMs })).rejects.toThrow(message)
      expect(sign.seen).toEqual([])
      expect(server.calls.sent).toEqual([])
    }
    const changed = (detail: string) => `This review was changed after it was prepared (${detail}). Prepare it again before signing.`
    /** The same transaction as `unsignedXdr` (sequence, time bounds, call and fee), authorized by `auth`. */
    function withAuth(unsignedXdr: string, call: ManagerCall, auth: xdr.SorobanAuthorizationEntry[]): Transaction {
      const tx = new Transaction(unsignedXdr, passphrase)
      const { minTime, maxTime } = tx.timeBounds!
      const built = new TransactionBuilder(new Account(tx.source, (BigInt(tx.sequence) - 1n).toString()), {
        fee: BASE_FEE,
        networkPassphrase: passphrase,
        timebounds: { minTime, maxTime },
      })
        .addOperation(new Contract(call.invocation.contractId).call(call.invocation.functionName, ...callOf(tx).args))
        .build()
      return rpc.assembleTransaction(built, simulationSuccess({ auth })).build()
    }

    it("signs, checks, submits and polls a manager review; there is no action output to decode", async () => {
      const server = fakeRpc()
      const r = await managerReview(grant(), server)
      const sign = signWith()
      const result = await executeReview({ review: r, manifest, sign, rpc: server, nowMs: r.preparedAtMs + 1_000 })

      // The expected signer is the call's source, the connected wallet the gates checked.
      expect(sign.seen).toEqual([[r.unsignedXdr, passphrase, SOURCE]])
      expect(server.calls.sent).toHaveLength(1)
      expect(server.calls.sent[0].hash()).toEqual(new Transaction(r.unsignedXdr, passphrase).hash())
      expect(server.calls.polled).toEqual([hashOf(r.unsignedXdr)])
      expect(result).toEqual({ hash: hashOf(r.unsignedXdr), status: "SUCCESS" })
    })

    it("reports a failed manager call with its cause (R49)", async () => {
      const server = fakeRpc({
        async getTransaction() {
          return { status: "FAILED", resultXdr: failedResult() }
        },
      })
      const r = await managerReview(grant(), server)
      expect(await executeReview({ review: r, manifest, sign: signWith(), rpc: server })).toEqual({
        hash: hashOf(r.unsignedXdr),
        status: "FAILED",
        reason: "Cause: the contract call failed. Nothing was taken except the network fee.",
      })
    })

    it("refuses an expired manager review, one from another account, and one prepareManagerReview did not return", async () => {
      const server = fakeRpc()
      const r = await managerReview(grant(), server)
      await refusedBeforeSigning(r, server, "This review is over a minute old", r.preparedAtMs + REVIEW_TTL_MS)
      await refusedBeforeSigning({ ...r }, server, "This review was not prepared by this app. Prepare it again before signing.")
      await expect(executeReview({ review: r, manifest, sign: signWith(Keypair.random()), rpc: server })).rejects.toThrow(
        "not signed by the connected wallet account",
      )
      expect(server.calls.sent).toEqual([])
    })

    it("re-derives the call from its origin: a changed contract, argument or label is refused", async () => {
      const server = fakeRpc()
      const byContract = await managerReview(grant(), server)
      byContract.origin.call.invocation.contractId = FOREIGN
      await refusedBeforeSigning(byContract, server, changed("the call it describes"))

      // Still a well-formed grant, but to someone else than the reviewed one.
      const byArgument = await managerReview(grant(), server)
      byArgument.origin.call.invocation.args[1] = { type: "address", value: Keypair.random().publicKey() }
      await refusedBeforeSigning(byArgument, server, changed("the call it describes"))

      const byLabel = await managerReview(grant(), server)
      byLabel.origin.call.label = "Grant nothing"
      await refusedBeforeSigning(byLabel, server, changed("the call it describes"))

      const byInvocation = await managerReview(grant(), server)
      byInvocation.invocation.args[1] = { type: "address", value: Keypair.random().publicKey() }
      await refusedBeforeSigning(byInvocation, server, changed("the call it describes"))
    })

    it("refuses a call and description changed together: the transaction no longer makes that call", async () => {
      const server = fakeRpc()
      const r = await managerReview(grant(), server)
      const other = grant(Keypair.random().publicKey())
      r.origin.call.invocation = other.invocation
      r.origin.call.label = other.label
      r.invocation = { ...other.invocation, args: other.invocation.args.map((a) => ({ ...a })) }
      await refusedBeforeSigning(r, server, changed("its transaction does not make the reviewed call"))
    })

    it("refuses an XDR swapped for another manager review's", async () => {
      const server = fakeRpc()
      const r = await managerReview(grant(), server)
      const other = await managerReview(setPausedCall(manifest, { source: SOURCE, marketId: market.marketId, contract: "pool", paused: true }), server)
      r.unsignedXdr = other.unsignedXdr
      r.unsignedXdrHash = other.unsignedXdrHash
      await refusedBeforeSigning(r, server, changed("its transaction does not make the reviewed call"))
    })

    it("refuses a transaction whose authorization gained a sub-invocation, or lost the signer's (R29 again)", async () => {
      const server = fakeRpc()
      const r = await managerReview(grant(), server)
      const call = r.origin.call
      const withExtraGrant = withAuth(r.unsignedXdr, call, [authWith(argsOf(call), [argsOf(grant(Keypair.random().publicKey()))])])
      expect(withExtraGrant.fee).toBe(r.fee)
      r.unsignedXdr = withExtraGrant.toXDR()
      r.unsignedXdrHash = hashLike(r.unsignedXdr)
      await refusedBeforeSigning(r, server, changed("its transaction authorizes another call"))

      const stripped = await managerReview(grant(), server)
      stripped.unsignedXdr = withAuth(stripped.unsignedXdr, stripped.origin.call, []).toXDR()
      stripped.unsignedXdrHash = hashLike(stripped.unsignedXdr)
      await refusedBeforeSigning(stripped, server, changed("its transaction lacks the authorization the call needs"))
    })

    it("refuses a swapped origin: an action review passed off as a manager call, or a manager origin replaced", async () => {
      const server = fakeRpc()
      const action = await review("buy_pt", {}, server)
      ;(action as unknown as ManagerReview).origin = { type: "manager", call: grant() }
      await refusedBeforeSigning(action, server, changed("what it was prepared from"))

      const m = await managerReview(grant(), server)
      m.origin = { type: "manager", call: m.origin.call }
      await refusedBeforeSigning(m, server, changed("what it was prepared from"))
    })

    it("an action review carries its input as its origin, and refuses an input that is no longer it", async () => {
      const server = fakeRpc()
      const r = await review("buy_pt", {}, server)
      expect(r.origin).toEqual({ type: "action", input: input("buy_pt") })
      expect(r.origin.input).toBe(r.input)
      r.input = { ...r.input }
      await refusedBeforeSigning(r, server, changed("the action it describes"))
    })
  })

  describe("evaluateManagerGates", () => {
    const connected = (publicKey = SOURCE): WalletState => ({ status: "connected", publicKey, networkPassphrase: passphrase })
    const holds = (...roles: Role[]): Live<Role[]> => ({ status: "live", value: roles, ledger: 90 })
    const unreadable: Live<Role[]> = { status: "unavailable", error: "RPC rate limited (429)" }
    const ok = { findings: [] as Finding[], listed: true }
    const pause = () => setPausedCall(manifest, { source: SOURCE, marketId: market.marketId, contract: "pool", paused: true })
    const authorize = () => setAuthorizedCall(manifest, { source: SOURCE, sac: market.underlying.sac, account: GRANTEE, authorize: true })
    const register = () => registerMarketCall(manifest, { source: SOURCE, pool: FOREIGN })
    const consumer = () => addConsumerCall(manifest, { source: SOURCE, consumer: FOREIGN })

    it("wrong role blocks with the role named", () => {
      expect(evaluateManagerGates(grant(), { ...ok, wallet: connected(), roles: holds("issuer", "creator") })).toEqual([
        {
          code: "wallet",
          message: `Only the Permissioning admin can grant this. You are connected as ${short(SOURCE)}, which is not the Permissioning admin. Connect the Permissioning admin's wallet to sign this.`,
        },
      ])
      const messageFor = (call: ManagerCall) => evaluateManagerGates(call, { ...ok, wallet: connected(), roles: holds() }).map((b) => b.message)
      expect(messageFor(authorize())).toEqual([expect.stringMatching(/^Only the asset's issuer can change who is authorized to hold it\. /)])
      expect(messageFor(pause())).toEqual([expect.stringMatching(/^Only this contract's admin can pause or unpause it\. /)])
      expect(messageFor(register())).toEqual([expect.stringMatching(/^Only the Router admin can register a market on the Router\. /)])
      expect(messageFor(consumer())).toEqual([expect.stringMatching(/^Only the RiskControl admin can add a risk control consumer\. /)])
    })

    it("the role each call needs lets it through", () => {
      const pass = (call: ManagerCall, role: Role) => expect(evaluateManagerGates(call, { ...ok, wallet: connected(), roles: holds(role) })).toEqual([])
      pass(authorize(), "issuer")
      pass(grant(), "permissioningAdmin")
      pass(grantAssetCall(manifest, { source: SOURCE, account: GRANTEE, asset: market.contracts.yt }), "permissioningAdmin")
      pass(pause(), "contractAdmin")
      pass(register(), "routerAdmin")
      pass(consumer(), "riskControlAdmin")
    })

    it("an unavailable roles read blocks a call that needs a role", () => {
      expect(evaluateManagerGates(grant(), { ...ok, wallet: connected(), roles: unreadable })).toEqual([
        {
          code: "unavailable",
          message: "Could not read your roles (RPC rate limited (429)). Signing stays off until it can be checked; try again in a moment.",
        },
      ])
    })

    it("R2-53: a manifest error finding turns off every call but set_paused", () => {
      const broken = { ...ok, findings: [{ severity: "error", message: "The Router address is not valid." }] as Finding[] }
      const gates = (call: ManagerCall, role: Role) => evaluateManagerGates(call, { ...broken, wallet: connected(), roles: holds(role) })
      expect(gates(pause(), "contractAdmin")).toEqual([])
      expect(gates(grant(), "permissioningAdmin")).toEqual([
        { code: "manifest", message: expect.stringContaining("The Router address is not valid.") },
      ])
      expect(gates(claim(), "issuer")).toHaveLength(1)
      // A warning does not block.
      const warned = { ...ok, findings: [{ severity: "warning", message: "x" }] as Finding[] }
      expect(evaluateManagerGates(grant(), { ...warned, wallet: connected(), roles: holds("permissioningAdmin") })).toEqual([])
    })

    it("R2-53: a market that is not listed valid turns off every call but set_paused", () => {
      const unlisted = { ...ok, listed: false }
      expect(evaluateManagerGates(pause(), { ...unlisted, wallet: connected(), roles: holds("contractAdmin") })).toEqual([])
      expect(evaluateManagerGates(claim(), { ...unlisted, wallet: connected(), roles: holds() })).toEqual([
        { code: "manifest", message: expect.stringContaining("not listed as valid") },
      ])
    })

    it("the fee claims are permissionless: no role is needed and the roles are not read", () => {
      expect(evaluateManagerGates(claim(), { ...ok, wallet: connected(), roles: unreadable })).toEqual([])
      expect(evaluateManagerGates(claim(), { ...ok, wallet: connected(), roles: holds() })).toEqual([])
    })

    it("checks the wallet and network first, as for an action, and the role only for the connected signer", () => {
      expect(evaluateManagerGates(grant(), { ...ok, wallet: { status: "disconnected" }, roles: unreadable })).toEqual([
        { code: "wallet", message: "No wallet is connected. Connect your wallet to sign." },
      ])
      expect(
        evaluateManagerGates(grant(), {
          ...ok,
          wallet: { status: "wrong_network", publicKey: SOURCE, actualPassphrase: "Public Global Stellar Network ; September 2015", expectedPassphrase: passphrase },
          roles: holds("permissioningAdmin"),
        }),
      ).toEqual([{ code: "network", message: `Your wallet is on a different network from this market. Switch it to the network "${passphrase}", then try again.` }])
      expect(evaluateManagerGates(grant(), { ...ok, wallet: connected(Keypair.random().publicKey()), roles: holds() })).toEqual([
        {
          code: "wallet",
          message:
            "This action was prepared for a different account than the one connected in your wallet. Enter it again so it is prepared for the connected account.",
        },
      ])
    })
  })
})
