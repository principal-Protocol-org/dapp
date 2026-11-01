/**
 * Who may do what on a market (spec 0002 §5, "My markets"): the roles an account holds, read on
 * the contracts themselves, and the fees a market has accrued.
 *
 * Roles are scoped. A wallet that administers market A's pool does not administer market B's, so
 * each market carries its own reads, one per contract that has an admin, and `rolesForCall` hands a
 * call's gates only the role that applies to the contract the call targets. Each read is its own
 * `Live`: a failed read is "unavailable" with its reason, never "no", and it blocks only the calls
 * that need it (R23).
 *
 * Views, from `principal` `origin/feat/tranche-1-mvp` (ABI pin `be2a1a5`): SAC `admin()`;
 * `MarketConfig.creator()` (the SAC's admin read live, so for a SAC asset the issuer is the
 * creator) and `protocol_admin()`; `get_admin()` on MarketPool, SYWrapper, PrincipalManager, Router,
 * RiskControl and Permissioning; `accrued_fees() -> (protocol, creator)` on MarketPool and
 * PrincipalManager, in SY shares.
 */
import type { ManagerCall } from "./manager-calls"
import { allLive, liveValue, readLive, toAddress, toBigint, unavailable, type ContractReader } from "./reader"
import type { Live, Manifest, Market } from "./types"

export type Role =
  | "issuer"
  | "creator"
  | "protocolAdmin"
  | "contractAdmin"
  | "routerAdmin"
  | "riskControlAdmin"
  | "permissioningAdmin"

/** A market contract that has an admin and a pause switch. */
export type AdminContract = "pool" | "sy" | "manager"
export const ADMIN_CONTRACTS: readonly AdminContract[] = ["pool", "sy", "manager"]

/** What one account holds on one market; every read is separate. */
export type MarketRoles = {
  /** The contracts these reads were made on: a role applies to a call only for these. */
  sac: string
  contracts: Record<AdminContract, string>
  issuer: Live<boolean>
  creator: Live<boolean>
  protocolAdmin: Live<boolean>
  contractAdmin: Record<AdminContract, Live<boolean>>
}

/** The admins of the contracts every market shares. */
export type SharedRoles = {
  routerAdmin: Live<boolean>
  riskControlAdmin: Live<boolean>
  permissioningAdmin: Live<boolean>
}

const isAccount = (account: string) => (address: string) => address === account

function holds(reader: ContractReader, contractId: string, functionName: string, account: string): Promise<Live<boolean>> {
  return readLive<unknown, boolean>(reader, { contractId, functionName }, (v) => isAccount(account)(toAddress(v)))
}

/** Every role `account` holds on `market`, read on the market's contracts. */
export async function rolesOf(reader: ContractReader, market: Market, account: string): Promise<MarketRoles> {
  const c = market.contracts
  const [issuer, creator, protocolAdmin, pool, sy, manager] = await Promise.all([
    holds(reader, market.underlying.sac, "admin", account),
    holds(reader, c.config, "creator", account),
    holds(reader, c.config, "protocol_admin", account),
    holds(reader, c.pool, "get_admin", account),
    holds(reader, c.sy, "get_admin", account),
    holds(reader, c.manager, "get_admin", account),
  ])
  return {
    sac: market.underlying.sac,
    contracts: { pool: c.pool, sy: c.sy, manager: c.manager },
    issuer,
    creator,
    protocolAdmin,
    contractAdmin: { pool, sy, manager },
  }
}

/** The Router, RiskControl and Permissioning admins: the same for every market, read once per account. */
export async function sharedRolesOf(reader: ContractReader, manifest: Manifest, account: string): Promise<SharedRoles> {
  const { router, riskControl, permissioning } = manifest.shared
  const [routerAdmin, riskControlAdmin, permissioningAdmin] = await Promise.all([
    holds(reader, router, "get_admin", account),
    holds(reader, riskControl, "get_admin", account),
    holds(reader, permissioning, "get_admin", account),
  ])
  return { routerAdmin, riskControlAdmin, permissioningAdmin }
}

/** The roles held on a market, for display; the reasons of the reads that failed are listed, not hidden. */
export type HeldRoles = {
  status: "live"
  held: Role[]
  contractAdminOf: AdminContract[]
  unavailable: string[]
}

export function heldRoles(roles: MarketRoles): HeldRoles {
  const held: Role[] = []
  const unavailableReads: string[] = []
  const check = (role: Role, what: string, read: Live<boolean>): boolean => {
    if (read.status === "unavailable") {
      unavailableReads.push(`${what}: ${read.error}`)
      return false
    }
    if (read.value && !held.includes(role)) held.push(role)
    return read.value
  }
  check("issuer", "issuer", roles.issuer)
  check("creator", "creator", roles.creator)
  check("protocolAdmin", "protocol admin", roles.protocolAdmin)
  const contractAdminOf = ADMIN_CONTRACTS.filter((k) => check("contractAdmin", `${k} admin`, roles.contractAdmin[k]))
  return { status: "live", held, contractAdminOf, unavailable: unavailableReads }
}

const NOTHING: Live<Role[]> = { status: "live", value: [], ledger: 0 }

function asRoles(role: Role, read: Live<boolean> | undefined, what: string): Live<Role[]> {
  if (!read) return unavailable(`${what} has not been read`)
  if (read.status === "unavailable") return read
  return liveValue(read.value ? [role] : [], read.ledger)
}

/**
 * The roles that apply to `call`'s target contract, for `evaluateManagerGates`: `market` holds the
 * reads of the market the button sits on, `shared` those of the shared contracts. A read that is
 * missing or failed is unavailable, which blocks a call that needs the role; a call that needs no
 * role never looks at the reads.
 */
export function rolesForCall(call: ManagerCall, market: MarketRoles | undefined, shared: SharedRoles | undefined): Live<Role[]> {
  const target = call.invocation.contractId
  switch (call.kind) {
    case "set_authorized":
      if (market && market.sac !== target) return NOTHING
      return asRoles("issuer", market?.issuer, "Your issuer role")
    case "set_paused": {
      if (!market) return unavailable("Your admin roles have not been read")
      const contract = ADMIN_CONTRACTS.find((k) => market.contracts[k] === target)
      return contract ? asRoles("contractAdmin", market.contractAdmin[contract], `Your ${contract} admin role`) : NOTHING
    }
    case "grant_account":
    case "grant_asset":
      return asRoles("permissioningAdmin", shared?.permissioningAdmin, "Your Permissioning admin role")
    case "register_market":
      return asRoles("routerAdmin", shared?.routerAdmin, "Your Router admin role")
    case "add_consumer":
      return asRoles("riskControlAdmin", shared?.riskControlAdmin, "Your RiskControl admin role")
    case "claim_protocol_fees":
    case "claim_creator_fees":
      return NOTHING
  }
}

/** Fees accrued and not yet claimed, in SY shares: `(protocol, creator)` on the pool and on the manager. */
export type AccruedFees = {
  protocol: bigint
  creator: bigint
  pool: { protocol: bigint; creator: bigint }
  manager: { protocol: bigint; creator: bigint }
}

function toPair(value: unknown): { protocol: bigint; creator: bigint } {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("accrued_fees did not return a pair")
  return { protocol: toBigint(value[0]), creator: toBigint(value[1]) }
}

/** The pool's `accrued_fees` plus the manager's; unavailable if either read is, never a partial sum. */
export async function accruedFees(reader: ContractReader, market: Market): Promise<Live<AccruedFees>> {
  const [pool, manager] = await Promise.all([
    readLive(reader, { contractId: market.contracts.pool, functionName: "accrued_fees" }, toPair),
    readLive(reader, { contractId: market.contracts.manager, functionName: "accrued_fees" }, toPair),
  ])
  return allLive([pool, manager] as const, ([p, m]) => ({
    protocol: p.protocol + m.protocol,
    creator: p.creator + m.creator,
    pool: p,
    manager: m,
  }))
}

/** `issuer` of a test asset: whether `account` is the admin of the SAC. */
export function issuerOfAsset(reader: ContractReader, sac: string, account: string): Promise<Live<boolean>> {
  return holds(reader, sac, "admin", account)
}

/** What `useMyRoles` reads for one account. */
export type AccountRoles = {
  markets: ReadonlyMap<string, MarketRoles>
  shared?: SharedRoles
  testAssetIssuer?: Live<boolean>
}

/**
 * Whether the account may see the manager view (spec 0002 §5): it holds a role on a listed market,
 * or it is the issuer of the manifest's test asset. Only a read that came back "yes" counts; an
 * unread role never shows the link.
 */
export function managesAnything(roles: AccountRoles): boolean {
  if (roles.testAssetIssuer?.status === "live" && roles.testAssetIssuer.value) return true
  return [...roles.markets.values()].some((m) => heldRoles(m).held.length > 0)
}
