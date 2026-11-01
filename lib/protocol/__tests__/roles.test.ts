// @vitest-environment node
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { claimCreatorFeesCall, grantAccountCall, registerMarketCall, setAuthorizedCall, setPausedCall, addConsumerCall } from "../manager-calls"
import { parseManifest } from "../manifest"
import type { ContractReader } from "../reader"
import { accruedFees, heldRoles, rolesForCall, rolesOf, sharedRolesOf } from "../roles"
import type { Market } from "../types"

const manifest = parseManifest(structuredClone(testnetJson))
const contractAt = (fill: number) => StrKey.encodeContract(new Uint8Array(32).fill(fill))
const A = manifest.markets[0]
/** A second market with its own pool, SY wrapper and manager, on the same underlying. */
const B: Market = {
  ...A,
  marketId: "market-b",
  displayName: "B",
  contracts: { ...A.contracts, pool: contractAt(21), sy: contractAt(22), manager: contractAt(23), config: contractAt(24) },
}
const ME = Keypair.random().publicKey()
const OTHER = Keypair.random().publicKey()

type Table = Record<string, unknown>
/** A reader answering `contract.function` from a table; a missing entry is a failed read. */
function reader(table: Table): ContractReader {
  return (async ({ contractId, functionName }: { contractId: string; functionName: string }) => {
    const key = `${contractId}.${functionName}`
    if (!(key in table)) throw new Error(`no answer for ${key}`)
    const value = table[key]
    if (value instanceof Error) throw value
    return { value, latestLedger: 50 }
  }) as ContractReader
}

/** The views of a market: who holds each role. */
function market(m: Market, who: { issuer?: string; creator?: string; protocolAdmin?: string; pool?: string; sy?: string; manager?: string }): Table {
  return {
    [`${m.underlying.sac}.admin`]: who.issuer ?? OTHER,
    [`${m.contracts.config}.creator`]: who.creator ?? OTHER,
    [`${m.contracts.config}.protocol_admin`]: who.protocolAdmin ?? OTHER,
    [`${m.contracts.pool}.get_admin`]: who.pool ?? OTHER,
    [`${m.contracts.sy}.get_admin`]: who.sy ?? OTHER,
    [`${m.contracts.manager}.get_admin`]: who.manager ?? OTHER,
  }
}

describe("rolesOf", () => {
  it("issuer is also creator for a SAC asset", async () => {
    // MarketConfig.creator() reads the SAC admin live, so both views answer the issuer.
    const roles = await rolesOf(reader(market(A, { issuer: ME, creator: ME })), A, ME)
    expect(heldRoles(roles)).toEqual({ status: "live", held: ["issuer", "creator"], contractAdminOf: [], unavailable: [] })
  })

  it("names every role the account holds, and the contracts it administers", async () => {
    const roles = await rolesOf(reader(market(A, { protocolAdmin: ME, pool: ME, manager: ME })), A, ME)
    expect(heldRoles(roles)).toEqual({
      status: "live",
      held: ["protocolAdmin", "contractAdmin"],
      contractAdminOf: ["pool", "manager"],
      unavailable: [],
    })
  })

  it("scopes the contract admin to the market: admin of A's pool is not admin of B's pool", async () => {
    const table = { ...market(A, { pool: ME }), ...market(B, { pool: OTHER }) }
    const a = await rolesOf(reader(table), A, ME)
    const b = await rolesOf(reader(table), B, ME)
    expect(heldRoles(a)).toMatchObject({ contractAdminOf: ["pool"] })
    expect(heldRoles(b)).toMatchObject({ held: [], contractAdminOf: [] })
    expect(rolesForCall(setPausedCall(manifest, { source: ME, marketId: A.marketId, contract: "pool", paused: true }), a, undefined)).toMatchObject({
      status: "live",
      value: ["contractAdmin"],
    })
    // The same wallet is not the admin of A's SY wrapper.
    expect(rolesForCall(setPausedCall(manifest, { source: ME, marketId: A.marketId, contract: "sy", paused: true }), a, undefined)).toMatchObject({
      status: "live",
      value: [],
    })
  })

  it("a failed read is unavailable with its reason, and the other roles stay known", async () => {
    const table = market(A, { issuer: ME })
    delete table[`${A.contracts.pool}.get_admin`]
    const roles = await rolesOf(reader(table), A, ME)
    const held = heldRoles(roles)
    expect(held).toMatchObject({ status: "live", held: ["issuer"] })
    expect(held.status === "live" && held.unavailable[0]).toContain("pool")
    expect(rolesForCall(setPausedCall(manifest, { source: ME, marketId: A.marketId, contract: "pool", paused: true }), roles, undefined)).toMatchObject({
      status: "unavailable",
    })
  })
})

describe("sharedRolesOf and rolesForCall", () => {
  const { router, riskControl, permissioning } = manifest.shared
  it("reads the Router, RiskControl and Permissioning admins directly", async () => {
    const shared = await sharedRolesOf(
      reader({ [`${router}.get_admin`]: ME, [`${riskControl}.get_admin`]: OTHER, [`${permissioning}.get_admin`]: ME }),
      manifest,
      ME,
    )
    const pool = contractAt(30)
    expect(rolesForCall(registerMarketCall(manifest, { source: ME, pool }), undefined, shared)).toMatchObject({ status: "live", value: ["routerAdmin"] })
    expect(rolesForCall(addConsumerCall(manifest, { source: ME, consumer: pool }), undefined, shared)).toMatchObject({ status: "live", value: [] })
    expect(rolesForCall(grantAccountCall(manifest, { source: ME, account: OTHER }), undefined, shared)).toMatchObject({
      status: "live",
      value: ["permissioningAdmin"],
    })
  })

  it("the issuer role applies to the SAC of the market the button sits on", async () => {
    const roles = await rolesOf(reader(market(A, { issuer: ME })), A, ME)
    const call = setAuthorizedCall(manifest, { source: ME, sac: A.underlying.sac, account: OTHER, authorize: true })
    expect(rolesForCall(call, roles, undefined)).toMatchObject({ status: "live", value: ["issuer"] })
  })

  it("a call that needs no role never looks at the reads", () => {
    const claim = claimCreatorFeesCall(manifest, { source: ME, marketId: A.marketId, contract: "pool" })
    expect(rolesForCall(claim, undefined, undefined)).toMatchObject({ status: "live", value: [] })
  })

  it("a missing read blocks a call that needs a role", () => {
    const call = grantAccountCall(manifest, { source: ME, account: OTHER })
    expect(rolesForCall(call, undefined, undefined)).toMatchObject({ status: "unavailable" })
  })
})

describe("accruedFees", () => {
  it("fees sum pool and manager", async () => {
    const fees = await accruedFees(
      reader({ [`${A.contracts.pool}.accrued_fees`]: [5n, 7n], [`${A.contracts.manager}.accrued_fees`]: [11n, 13n] }),
      A,
    )
    expect(fees).toMatchObject({
      status: "live",
      value: { protocol: 16n, creator: 20n, pool: { protocol: 5n, creator: 7n }, manager: { protocol: 11n, creator: 13n } },
    })
  })

  it("is unavailable when either contract cannot be read, never a partial sum", async () => {
    const fees = await accruedFees(reader({ [`${A.contracts.pool}.accrued_fees`]: [5n, 7n] }), A)
    expect(fees.status).toBe("unavailable")
  })

  it("is unavailable for an answer that is not a pair", async () => {
    const fees = await accruedFees(reader({ [`${A.contracts.pool}.accrued_fees`]: 3n, [`${A.contracts.manager}.accrued_fees`]: [1n, 1n] }), A)
    expect(fees.status).toBe("unavailable")
  })
})
