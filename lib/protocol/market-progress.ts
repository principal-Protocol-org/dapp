/**
 * Where a market's creation stands (spec 0002 §5 "Resuming", R5-10): the wizard's step, derived from
 * the chain and never from a saved draft. The salt (in the URL) gives the seven predicted addresses;
 * then, in order:
 *
 * 1–2. nothing is deployed at them (parameters, then the addresses preview: both before any signature);
 * 3.   some are, not all: the factory's `create_*` phases left to run (`phases`);
 * 4.   all are, but RiskControl does not list the SY wrapper or the manager as consumers, or the
 *      Router has not registered the pool (wire);
 * 5.   a compliance grant is missing (`requiredGrants`, deploy.sh's lists);
 * 6.   the pool holds no liquidity (`lp_total_supply` is 0: seed);
 * 7.   it does (publish).
 *
 * Every read must answer: an unreadable one refuses (throws) rather than guess a step. A contract at
 * a predicted address that runs code the manifest does not pin refuses too: such a market could
 * never be listed (spec §1 validation).
 *
 * Pure and reader-injected; the RPC's ledger entries tell whether a contract exists (`wasm.ts`).
 */
import { deriveMarketContracts } from "./factory"
import { shorten } from "./format"
import { isContractError, readLive, toAddress, toBigint, toBool, type ContractReader } from "./reader"
import type { ScArg } from "./stellar"
import type { Manifest, MarketContractName, MarketContracts } from "./types"
import { contractWasmHash, WasmReadError, type LedgerEntriesRpc } from "./wasm"

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Who holds a grant: one of the new market's contracts, its treasury, or its admin (the SAC admin, who seeds). */
export type GrantHolder = "sy" | "manager" | "pool" | "recoveryEscrow" | "treasury" | "admin"

/**
 * One compliance grant (step 5). `authorized`: SAC `authorized(account)` on the underlying (`asset`
 * unset). `account`: Permissioning `is_allowed(account)`. `asset`: Permissioning
 * `is_allowed_for_asset(account, asset)`, `asset` the new PT or YT.
 */
export type Grant = { kind: "authorized" | "account" | "asset"; holder: GrantHolder; account: string; asset?: string }
export type GrantState = Grant & { held: boolean }

export type MarketProgress = {
  step: WizardStep
  /** The seven addresses this salt gives on this network, with the manifest's Router and oracle. */
  predicted: MarketContracts
  deployed: Record<MarketContractName, boolean>
  /** The factory phases that have run: step 3 resumes at the first that has not. */
  phases: { tokens: boolean; engine: boolean; poolAndEscrow: boolean }
  /** Once every contract exists: what steps 4–7 read. */
  live?: {
    underlying: string
    /** The underlying SAC's `admin()`: the issuer, who deploys and seeds (R5-10). */
    admin: string
    treasury: string
    wiring: { syConsumer: boolean; managerConsumer: boolean; registered: boolean }
    grants: GrantState[]
    lpTotalSupply: bigint
  }
}

const KINDS: MarketContractName[] = ["sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow"]
const PHASES: { name: "tokens" | "engine" | "poolAndEscrow"; kinds: MarketContractName[] }[] = [
  { name: "tokens", kinds: ["sy", "pt", "yt"] },
  { name: "engine", kinds: ["config", "manager"] },
  { name: "poolAndEscrow", kinds: ["pool", "recoveryEscrow"] },
]
const NAME: Record<MarketContractName, string> = {
  sy: "SY wrapper",
  pt: "PT",
  yt: "YT",
  config: "market config",
  manager: "PrincipalManager",
  pool: "pool",
  recoveryEscrow: "recovery escrow",
}

const address = (value: string): ScArg => ({ type: "address", value })

/**
 * The grants a new market needs before it is seeded, as `scripts/dev-stack/deploy.sh` step 11 makes
 * them: SAC authorization and a Permissioning account grant for the SY wrapper, manager, pool,
 * recovery escrow and treasury; an account grant for the admin, who seeds; PT and YT grants for the
 * pool, the recovery escrow and the admin. Permissioning is shared, so the admin's account grant may
 * already hold from another market.
 */
export function requiredGrants(predicted: MarketContracts, who: { sac: string; treasury: string; admin: string }): Grant[] {
  const holders: Record<GrantHolder, string> = {
    sy: predicted.sy,
    manager: predicted.manager,
    pool: predicted.pool,
    recoveryEscrow: predicted.recoveryEscrow,
    treasury: who.treasury,
    admin: who.admin,
  }
  const standing: GrantHolder[] = ["sy", "manager", "pool", "recoveryEscrow", "treasury"]
  return [
    ...standing.map((holder): Grant => ({ kind: "authorized", holder, account: holders[holder] })),
    ...[...standing, "admin" as const].map((holder): Grant => ({ kind: "account", holder, account: holders[holder] })),
    ...(["pool", "recoveryEscrow", "admin"] as const).flatMap((holder) =>
      [predicted.pt, predicted.yt].map((asset): Grant => ({ kind: "asset", holder, account: holders[holder], asset })),
    ),
  ]
}

/** Whether the contract at `id` exists, refusing one that runs code other than `pin`. */
async function exists(rpc: LedgerEntriesRpc, id: string, kind: MarketContractName, pin: string | undefined): Promise<boolean> {
  let hash: string
  try {
    hash = await contractWasmHash(rpc, id)
  } catch (error) {
    if (error instanceof WasmReadError && error.kind === "missing") return false
    if (error instanceof WasmReadError) throw new Error(`The ${NAME[kind]} at ${shorten(id)} is not a contract this app can check: ${error.message}`)
    throw new Error(`Could not read whether the new market's ${NAME[kind]} exists: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (pin === undefined || hash !== pin.toLowerCase()) {
    throw new Error(
      `The ${NAME[kind]} at ${shorten(id)} runs code this network's manifest does not pin, so this market could never be listed. Start a new market.`,
    )
  }
  return true
}

/** One read that must answer; a failure refuses with what could not be read. */
async function must<T>(reader: ContractReader, contractId: string, functionName: string, map: (v: unknown) => T, args?: ScArg[]): Promise<T> {
  const r = await readLive<unknown, T>(reader, { contractId, functionName, args }, map)
  if (r.status === "unavailable") throw new Error(`Could not read ${functionName} on ${shorten(contractId)}: ${r.error}`)
  return r.value
}

/** SAC `authorized(id)`: a contract-level refusal (no trustline, no balance entry) is the answer "no", as the contracts read it. */
async function authorized(reader: ContractReader, sac: string, account: string): Promise<boolean> {
  const r = await readLive<unknown, boolean>(reader, { contractId: sac, functionName: "authorized", args: [address(account)] }, toBool)
  if (r.status === "live") return r.value
  if (isContractError(r.error)) return false
  throw new Error(`Could not read authorized on ${shorten(sac)}: ${r.error}`)
}

async function grantHeld(reader: ContractReader, manifest: Manifest, sac: string, g: Grant): Promise<boolean> {
  const perm = manifest.shared.permissioning
  switch (g.kind) {
    case "authorized":
      return authorized(reader, sac, g.account)
    case "account":
      return must(reader, perm, "is_allowed", toBool, [address(g.account)])
    case "asset":
      return must(reader, perm, "is_allowed_for_asset", toBool, [address(g.account), address(g.asset as string)])
  }
}

/**
 * The step `salt`'s market has reached on this network, and what decided it (spec 0002 §5
 * "Resuming"). `rpc` reads the ledger entries that say which predicted contracts exist.
 */
export async function marketProgress(reader: ContractReader, rpc: LedgerEntriesRpc, manifest: Manifest, salt: string): Promise<MarketProgress> {
  const predicted = deriveMarketContracts(manifest, salt)
  const found = await Promise.all(KINDS.map((kind) => exists(rpc, predicted[kind], kind, manifest.wasmHashes[kind])))
  const deployed = Object.fromEntries(KINDS.map((kind, i) => [kind, found[i]])) as Record<MarketContractName, boolean>

  // Each phase is atomic and needs the one before it (market_factory): anything else is not the factory's doing.
  const done = PHASES.map((ph) => ph.kinds.every((k) => deployed[k]))
  const partial = PHASES.some((ph, i) => (ph.kinds.some((k) => deployed[k]) && !done[i]) || (done[i] && i > 0 && !done[i - 1]))
  if (partial) {
    const yes = KINDS.filter((k) => deployed[k]).map((k) => NAME[k])
    const no = KINDS.filter((k) => !deployed[k]).map((k) => NAME[k])
    throw new Error(
      `The market at this salt is only partly deployed (${yes.join(", ")} exist; ${no.join(", ")} do not), which the factory never leaves. Start a new market.`,
    )
  }
  const phases = { tokens: done[0], engine: done[1], poolAndEscrow: done[2] }
  if (!phases.tokens) return { step: 1, predicted, deployed, phases }
  if (!phases.poolAndEscrow) return { step: 3, predicted, deployed, phases }

  const [underlying, treasury] = await Promise.all([
    must(reader, predicted.config, "underlying", toAddress),
    must(reader, predicted.config, "treasury", toAddress),
  ])
  const { riskControl, router } = manifest.shared
  const [admin, syConsumer, managerConsumer, registered, lpTotalSupply] = await Promise.all([
    must(reader, underlying, "admin", toAddress),
    must(reader, riskControl, "is_consumer", toBool, [address(predicted.sy)]),
    must(reader, riskControl, "is_consumer", toBool, [address(predicted.manager)]),
    must(reader, router, "is_registered", toBool, [address(predicted.pool)]),
    must(reader, predicted.pool, "lp_total_supply", toBigint),
  ])
  const grants = await Promise.all(
    requiredGrants(predicted, { sac: underlying, treasury, admin }).map(async (g): Promise<GrantState> => ({ ...g, held: await grantHeld(reader, manifest, underlying, g) })),
  )
  const wiring = { syConsumer, managerConsumer, registered }
  const step: WizardStep = !(syConsumer && managerConsumer && registered) ? 4 : grants.some((g) => !g.held) ? 5 : lpTotalSupply <= 0n ? 6 : 7
  return { step, predicted, deployed, phases, live: { underlying, admin, treasury, wiring, grants, lpTotalSupply } }
}
