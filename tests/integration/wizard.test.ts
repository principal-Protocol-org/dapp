// @vitest-environment node
/**
 * The market-creation wizard end to end on the local stack (spec 0002 §5, R5-10; plan 0005 Task 10).
 * A fresh random salt goes through the wizard's seven steps, each signed the way the wizard signs it:
 * the step's own builders (`manager-calls.ts`, `seed.ts`), its gates (`evaluateManagerGates`, the
 * first-deposit gate), then `prepareManagerReview` and `executeReview`, as `ManagerSignFlow` runs them,
 * with the local admin key in Freighter's place. Nothing is hand-built: a call the builders do not
 * make, or an authorization other than the one each call's rule allows, is refused by the review.
 *
 * 1–2. The parameters from the current market's defaults (`readDefaults`, as the wizard drafts them),
 *      and `predict_market` against the salt's derivation.
 * 3.   `create_tokens`, then the flow stops (a closed review). The registry's discovery indexes the
 *      salt from the factory's event, and the manager view's Resume logic finds it for the asset's
 *      issuer only. Resumed from what the chain fixed: `create_engine` and `create_pool_and_escrow`.
 *      Their first live signatures: each review checks the exact authorization tree against the real
 *      simulation (R29, `caller_tree`).
 * 4.   RiskControl `add_consumer` (SY, manager) and Router `register_market`.
 * 5.   Every missing compliance grant (`requiredGrants`).
 * 6.   The seed from a starting APY: the refusals first (APY 0 or less, too small), then `wrap_and_mint`,
 *      `deposit` and `add_liquidity`, each floor from its own simulation; the seeded pool's
 *      `implied_rate()` compounds to the APY typed.
 * 7.   Publish: the wizard's own request to `POST /api/markets`; the registry lists the market and it
 *      passes validation.
 *
 * Then a fresh account, onboarded through the faucet with the faucet route's market list (it grants
 * the new market's PT and YT), trades the new market: a flash Buy YT and an LP only, both paid in USDY.
 *
 * It needs the local stack and its database (`DATABASE_URL` from `.env.local`, `pnpm db:migrate`).
 * Each run leaves one new market on the local chain, registered with the Router and published to the
 * registry (the recorder would list it anyway from the Router's event). The developer's market is
 * only read; `config/manifests/local.json` is not rewritten. Discovery runs under a test-only cursor,
 * removed after: the recorder's live cursor is never read or written. Secret keys are never printed.
 */
import { Keypair } from "@stellar/stellar-sdk"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// The faucet, the registry and the markets route are `server-only`; that guard throws outside a react-server bundle.
vi.mock("server-only", () => ({}))
// The markets route reads the active manifest: this network's.
process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK = "local"

import type { ManagerStep } from "@/components/app/manage/manager-sign-flow"
import { fetchAccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { impliedRate as curveImpliedRate, isqrt } from "@/lib/protocol/curve"
import { fetchAccountHistory } from "@/lib/protocol/events"
import {
  currentMarket,
  defaultMaturity,
  deriveMarketContracts,
  draftFromParams,
  paramsFromDefaults,
  paramsFromDraft,
  predictMarket,
  randomSalt,
  readContractAdmin,
  readDefaults,
  readFixedParams,
  readProtocolAdmin,
  readSacAdmin,
  type MarketParams,
  type ParamDraft,
} from "@/lib/protocol/factory"
import type { Blocker } from "@/lib/protocol/gates"
import { createHorizon } from "@/lib/protocol/horizon"
import {
  addConsumerCall,
  createEngineCall,
  createPoolAndEscrowCall,
  createTokensCall,
  FACTORY_CALLS,
  grantAccountCall,
  grantAssetCall,
  MANAGER_CALL_AUTH,
  managerCallAuthTree,
  registerMarketCall,
  setAuthorizedCall,
  type ManagerCall,
  type NewMarket,
} from "@/lib/protocol/manager-calls"
import { evaluateManagerGates, REQUIRED_ROLE } from "@/lib/protocol/manager-gates"
import { validateManifest } from "@/lib/protocol/manifest"
import { marketProgress, type MarketProgress } from "@/lib/protocol/market-progress"
import { fetchMarketState, parsePoolState } from "@/lib/protocol/market-state"
import { aprToApy, SCALE } from "@/lib/protocol/math"
import { previewDeposit } from "@/lib/protocol/previews"
import { createRpcReader, readLive, toBigint } from "@/lib/protocol/reader"
import { executeReview, prepareManagerReview } from "@/lib/protocol/review"
import type { Role } from "@/lib/protocol/roles"
import {
  firstDepositGate,
  readSeedState,
  seedAmounts,
  seedPair,
  simulatedSeedCall,
  type SeedPairResult,
  type SeedSimulate,
} from "@/lib/protocol/seed"
import { createRpcServer, getLedgerClock, simulateInvocation } from "@/lib/protocol/stellar"
import type { TradeRequest } from "@/lib/protocol/trade-adapter"
import type { Finding, Live, Manifest, Market, MarketContracts, WalletState } from "@/lib/protocol/types"
import { keypairSigner, type KeypairSigner } from "./keypair-signer"
import {
  balancesOf,
  complianceKind,
  createLog,
  HISTORY_KIND,
  json,
  ledgerClock,
  loadDatabaseUrl,
  MINUTE,
  onboardFreshAccount,
  oracleTick,
  readManifest,
  redact,
  run,
  showBalances,
  skipReason,
  U,
  units,
} from "./local-stack"
import { createRunner, live, runTrade, SLIPPAGE_BPS, type Runner, type StepRecord } from "./route-runner"

loadDatabaseUrl()

/** The dev stack's protocol admin; locally also the USDY issuer, SAC admin, Permissioning, RiskControl and Router admin. */
const ADMIN_KEY = "principal-localdev-admin"
/** Discovery's cursor is kept under this prefix, so the recorder's live cursor is never touched. */
const TEST_CURSOR = "test:wizard:"
/** The app's deadline setting (`hooks/use-settings.ts`). */
const DEADLINE_SECONDS = 300
/** The oracle is stale after 3,600 s; it is ticked when older than this, so it stays fresh for the run. */
const TICK_AFTER_SECONDS = 1_800
/** The starting fixed APY typed in step 6, at SCALE (5 %), and the USDY put in. */
const SEED_APY = 500_000n
const SEED_AMOUNT = 10_000n * U

async function databaseReason(): Promise<string | null> {
  if (!process.env.DATABASE_URL) return "no DATABASE_URL (.env.local)"
  try {
    const { sql } = await import("@/lib/server/db")
    await sql`select salt from market_salts limit 1`
    await sql`select pool from market_registry limit 1`
    return null
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "unknown"
    return `the database cannot be read (code ${code}); start principal-pg and run pnpm db:migrate`
  }
}

async function wizardReason(): Promise<string | null> {
  const down = await skipReason()
  if (down) return down
  const m = readManifest()
  if (!m.shared.factory) return "config/manifests/local.json lists no MarketFactory"
  if (!m.testAsset) return "config/manifests/local.json has no test asset"
  return databaseReason()
}

const skip = await wizardReason()
if (skip) console.info(`[wizard] skipped: ${skip}.`)

const out = createLog("wizard")
const log = out.log

describe.skipIf(skip !== null)("the market wizard on the local stack (spec 0002 §5, plan 0005 Task 10)", () => {
  let manifest: Manifest
  let findings: Finding[]
  let admin: KeypairSigner
  let wallet: WalletState
  let salt: string
  let predicted: MarketContracts
  let params: MarketParams
  /** The defaults' part of the draft (maturity, the current market's settings, the asset): what a resumed wizard starts from too. */
  let baseDraft: Partial<ParamDraft>
  let progress: MarketProgress
  let registry: Awaited<ReturnType<typeof setupRegistry>>
  /** Every manager transaction the wizard signed, in order. */
  const signed: { step: string; kind: ManagerCall["kind"]; hash: string; label: string }[] = []
  let seedAdd: SeedPairResult | undefined
  let resolved: Manifest
  let market: Market
  let kind: ComplianceKind
  let trader: Runner
  const trades: StepRecord[] = []

  const reader = () => createRpcReader(manifest)
  const rpc = () => createRpcServer(manifest.rpcUrl)

  async function setupRegistry() {
    const { sql } = await import("@/lib/server/db")
    const reg = await import("@/lib/server/registry")
    // The app's tables, with discovery's cursor kept under a test-only name.
    const tables = reg.sqlRegistryStore(sql)
    const store = {
      ...tables,
      cursor: (name: string) => tables.cursor(TEST_CURSOR + name),
      saveCursor: (name: string, ledger: number, cursor: string | null) => tables.saveCursor(TEST_CURSOR + name, ledger, cursor),
    }
    return { sql, reg, tables, store, deps: { store, reader: reader(), rpc: rpc(), manifest } }
  }

  const readProgress = async (): Promise<MarketProgress> => {
    progress = await marketProgress(reader(), rpc(), manifest, salt)
    return progress
  }

  /**
   * One manager call as `ManagerSignFlow` runs it: a deferred step is built at its turn, the step's
   * blockers are asked about the built call (expected none), then `prepareManagerReview` (the builder
   * re-derives the call; RPC prepares it; the authorization must be exactly what the call's rule
   * allows, R29) and `executeReview` on that very review (R31; sign, submit, poll).
   */
  async function sign(step: ManagerStep, blockersFor: (call: ManagerCall) => Blocker[], name: string): Promise<ManagerCall> {
    const call = "build" in step ? await step.build() : step
    expect(blockersFor(call), `${name}: blockers`).toEqual([])
    const review = await prepareManagerReview({ manifest, call })
    expect(review.origin.call.label).toBe(call.label)
    // A factory call's review passed only if the real simulation's authorization is exactly the
    // factory's tree beneath the call (R29, `caller_tree`): the calls it lists, in order, nothing else.
    const tree = MANAGER_CALL_AUTH[call.kind] === "caller_tree" ? managerCallAuthTree(manifest, call) : []
    if ((FACTORY_CALLS as readonly string[]).includes(call.kind)) expect(tree.length > 0, `${call.kind}: an exact tree`).toBe(true)
    const result = await executeReview({ review, manifest, sign: admin.sign })
    expect(result.status, `${name}: ${json(result)}`).toBe("SUCCESS")
    signed.push({ step: name, kind: call.kind, hash: result.hash, label: call.label })
    log(
      `${name}: ${call.kind} tx ${result.hash}: ${call.label}` +
        (tree.length > 0 ? ` | authorization tree matched exactly: ${tree.map((t) => t.functionName).join(", ")}` : "") +
        (review.summary.getAtLeast.length > 0 ? ` | at least ${review.summary.getAtLeast.join(", ")}` : ""),
    )
    return call
  }

  /** The roles `StepDeploy` and `StepSeed` hand the gates: the issuer role when the wallet is the SAC's admin. */
  const issuerRoles = (sacAdmin: string): Live<Role[]> => ({ status: "live", value: sacAdmin === admin.publicKey ? ["issuer"] : [], ledger: 0 })

  beforeAll(async () => {
    manifest = readManifest()
    findings = validateManifest(manifest)
    expect(findings.filter((f) => f.severity === "error")).toEqual([])
    try {
      const { stdout } = await run("stellar", ["keys", "secret", ADMIN_KEY])
      admin = keypairSigner(Keypair.fromSecret(stdout.trim()), manifest.networkPassphrase)
    } catch (error) {
      throw new Error(`NEEDS_CONTEXT: the ${ADMIN_KEY} key cannot be read (${redact(error instanceof Error ? error.message : error)})`)
    }
    wallet = { status: "connected", publicKey: admin.publicKey, networkPassphrase: manifest.networkPassphrase }

    // R5-10: the SAC's admin deploys and seeds; RiskControl, the Router and Permissioning sign the
    // wiring and the grants. Locally one key holds every role.
    const sac = manifest.testAsset!.sac
    const roles = {
      "USDY SAC admin()": await readSacAdmin(reader(), sac),
      "RiskControl get_admin()": await readContractAdmin(reader(), manifest.shared.riskControl),
      "Router get_admin()": await readContractAdmin(reader(), manifest.shared.router),
      "Permissioning get_admin()": await readContractAdmin(reader(), manifest.shared.permissioning),
    }
    for (const [what, r] of Object.entries(roles)) {
      if (r.status !== "live" || r.value !== admin.publicKey) {
        throw new Error(`NEEDS_CONTEXT: ${what} is ${r.status === "live" ? r.value : `unreadable (${r.error})`}, not ${ADMIN_KEY} (${admin.publicKey})`)
      }
    }
    log(`signer ${admin.publicKey} (${ADMIN_KEY}): ${Object.keys(roles).join(", ")}`)

    const clock = await ledgerClock(manifest)
    const ms0 = await fetchMarketState(reader(), manifest, manifest.markets[0].marketId)
    const age = clock.closeTime - Number(live(ms0.oracleTimestamp, "oracle timestamp"))
    if (age > TICK_AFTER_SECONDS) log(`oracle last set ${age} s ago: ${await oracleTick()}`)
    else log(`oracle last set ${age} s ago: not ticked`)

    // Discovery under a test cursor, primed at the tip: it reads only what this run does.
    registry = await setupRegistry()
    const server = rpc()
    const latest = await server.getLatestLedger()
    const factory = manifest.shared.factory as string
    const tip = await server.getEvents({ startLedger: latest.sequence, filters: [{ type: "contract", contractIds: [manifest.shared.router, factory] }], limit: 1 })
    await registry.store.saveCursor(registry.reg.cursorName(manifest), latest.sequence, tip.cursor)
  }, 3 * MINUTE)

  afterAll(async () => {
    if (registry) await registry.sql`delete from ingest_cursor where name = ${TEST_CURSOR + registry.reg.cursorName(manifest)}`
    if (salt) log(`salt ${salt}: ${signed.length} manager transactions signed: ${signed.map((s) => `${s.kind} ${s.hash.slice(0, 12)}`).join(", ")}`)
    if (market) log(`new market ${market.marketId} (pool ${market.contracts.pool}): ${trades.length} trades by a fresh account`)
    out.summary()
  }, MINUTE)

  it("steps 1–2: the parameters start from the current market's settings, and predict_market gives the salt's seven addresses", async () => {
    salt = randomSalt()
    expect((await readProgress()).step, "nothing is deployed at a fresh salt").toBe(1)

    // As `WizardSteps` drafts them: the maturity default, the current market's settings, the asset.
    const baseUnderlying = manifest.testAsset!.sac
    const source = currentMarket(manifest, baseUnderlying)
    if (!source) throw new Error("no current market")
    const defaults = await readDefaults(reader(), source)
    for (const [key, value] of Object.entries(defaults)) {
      if (key !== "market") expect((value as Live<unknown>).status, `default ${key}: ${json(value)}`).toBe("live")
    }
    const ledgerTime = (await ledgerClock(manifest)).now()
    baseDraft = {
      ...draftFromParams({ maturity: defaultMaturity(ledgerTime) }),
      ...draftFromParams(paramsFromDefaults(defaults)),
      underlying: baseUnderlying,
    }
    const read = paramsFromDraft(manifest, baseDraft, ledgerTime)
    expect(read.errors).toEqual({})
    params = read.params!
    log(`step 1: salt ${salt}; parameters ${json(params)} (defaults from ${source.marketId})`)

    predicted = await predictMarket(reader(), manifest, salt)
    expect(predicted).toEqual(deriveMarketContracts(manifest, salt))
    expect(progress.predicted).toEqual(predicted)
    log(`step 2: predict_market = the derivation: ${json(predicted)}`)
  }, 2 * MINUTE)

  it("step 3, interrupted: create_tokens alone; the registry indexes the salt and the Resume list shows it to the asset's issuer only", async () => {
    const sacAdmin = live(await readSacAdmin(reader(), params.underlying), "SAC admin")
    const blockersFor = (call: ManagerCall) => evaluateManagerGates(call, { wallet, roles: issuerRoles(sacAdmin), findings, listed: true })
    // StepDeploy's calls for the phases left; the flow is stopped after the first (its second review is cancelled).
    const c = { source: admin.publicKey, salt, params }
    const calls = [createTokensCall(manifest, c), createEngineCall(manifest, c), createPoolAndEscrowCall(manifest, c)]
    await sign(calls[0], blockersFor, "step 3 (1 of 3)")

    expect((await readProgress()).step).toBe(3)
    expect(progress.phases).toEqual({ tokens: true, engine: false, poolAndEscrow: false })

    // The recorder's discovery (`/api/cron/record`) indexes the salt from the factory's `mkt_tok`.
    const found = await registry.reg.discover(registry.deps)
    expect(found.complete).toBe(true)
    const rows = await registry.store.salts(manifest.shared.factory as string)
    const row = rows.find((r) => r.salt === salt)
    expect(row, `market_salts row for ${salt}`).toMatchObject({ underlying: manifest.testAsset!.sac, phase: "tokens" })
    const resumable = await registry.reg.resumableSalts({ store: registry.store, manifest })
    if (resumable.status !== "ok") throw new Error("resumableSalts: unavailable")
    expect(resumable.salts).toContainEqual({ salt, underlying: manifest.testAsset!.sac })

    // `useMarketsInProgress`: ownership first, one SAC admin() read per asset; then, for an account
    // that does not issue it, the protocol admin of the config the salt gives (none yet: not theirs).
    const owner = live(await readSacAdmin(reader(), row!.underlying), "SAC admin")
    expect(owner).toBe(admin.publicKey)
    const stranger = Keypair.random().publicKey()
    expect(owner).not.toBe(stranger)
    const protocolAdmin = await readProtocolAdmin(reader(), deriveMarketContracts(manifest, salt).config)
    expect(protocolAdmin.status, "no config yet: the stranger does not own it").toBe("unavailable")
    // Its progress, read for the owner: "Resume at step 3".
    expect((await marketProgress(reader(), rpc(), manifest, salt)).step).toBe(3)
    log(`step 3 interrupted after create_tokens: market_salts ${json(row)}; resumable for ${owner} at step 3, not for another account`)
  }, 4 * MINUTE)

  it("step 3, resumed from the chain: create_engine and create_pool_and_escrow, each with its exact authorization tree", async () => {
    // As the wizard resumes: what the deployed tokens fixed wins over the defaults.
    const fixed = await readFixedParams(reader(), predicted, progress.phases)
    expect(fixed).toEqual({
      underlying: params.underlying,
      maturity: params.maturity,
      ptName: params.ptName,
      ptSymbol: params.ptSymbol,
      ytName: params.ytName,
      ytSymbol: params.ytSymbol,
    })
    const ledgerTime = (await ledgerClock(manifest)).now()
    const draft = { ...baseDraft, ...draftFromParams(fixed) }
    const read = paramsFromDraft(manifest, draft, ledgerTime)
    expect(read.errors).toEqual({})
    const resumed = read.params!
    expect(resumed).toEqual(params)

    const sacAdmin = live(await readSacAdmin(reader(), resumed.underlying), "SAC admin")
    const blockersFor = (call: ManagerCall) => evaluateManagerGates(call, { wallet, roles: issuerRoles(sacAdmin), findings, listed: true })
    const c = { source: admin.publicKey, salt, params: resumed }
    const calls = [
      ...(progress.phases.tokens ? [] : [createTokensCall(manifest, c)]),
      ...(progress.phases.engine ? [] : [createEngineCall(manifest, c)]),
      ...(progress.phases.poolAndEscrow ? [] : [createPoolAndEscrowCall(manifest, c)]),
    ]
    expect(calls.map((call) => call.kind)).toEqual(["create_engine", "create_pool_and_escrow"])
    await sign(calls[0], blockersFor, "step 3 resumed (1 of 2)")
    expect((await readProgress()).phases).toEqual({ tokens: true, engine: true, poolAndEscrow: false })
    await sign(calls[1], blockersFor, "step 3 resumed (2 of 2)")

    expect((await readProgress()).step).toBe(4)
    expect(Object.values(progress.deployed).every(Boolean)).toBe(true)
    expect(progress.live).toMatchObject({ underlying: params.underlying, admin: admin.publicKey, treasury: params.treasury, lpTotalSupply: 0n })
  }, 4 * MINUTE)

  it("step 4: RiskControl lists the SY wrapper and the manager, and the Router registers the pool, each signed by that contract's admin", async () => {
    const live4 = progress.live!
    const rc = await readContractAdmin(reader(), manifest.shared.riskControl)
    const router = await readContractAdmin(reader(), manifest.shared.router)
    // StepWire's items; RoleCalls offers the missing ones whose admin is the connected wallet.
    const items = [
      { held: live4.wiring.syConsumer, admin: rc, build: (source: string) => addConsumerCall(manifest, { source, consumer: predicted.sy }) },
      { held: live4.wiring.managerConsumer, admin: rc, build: (source: string) => addConsumerCall(manifest, { source, consumer: predicted.manager }) },
      { held: live4.wiring.registered, admin: router, build: (source: string) => registerMarketCall(manifest, { source, pool: predicted.pool }) },
    ]
    const mine = items.filter((it) => !it.held && it.admin.status === "live" && it.admin.value === admin.publicKey)
    expect(mine.length).toBe(3)
    const blockersFor = (call: ManagerCall) => {
      const role = REQUIRED_ROLE[call.kind]?.role
      return evaluateManagerGates(call, { wallet, roles: { status: "live", value: role ? [role] : [], ledger: 0 }, findings, listed: true })
    }
    const calls = mine.map((it) => it.build(admin.publicKey))
    for (const [i, call] of calls.entries()) await sign(call, blockersFor, `step 4 (${i + 1} of ${calls.length})`)
    expect((await readProgress()).step).toBe(5)
    expect(progress.live!.wiring).toEqual({ syConsumer: true, managerConsumer: true, registered: true })
  }, 3 * MINUTE)

  it("step 5: every missing compliance grant, the SAC's authorizations by its admin and the Permissioning grants by its admin", async () => {
    const live5 = progress.live!
    const perm = await readContractAdmin(reader(), manifest.shared.permissioning)
    expect(live5.grants.length).toBe(17)
    // StepGrants' items.
    const items = live5.grants.map((g) => ({
      g,
      admin: g.kind === "authorized" ? ({ status: "live", value: live5.admin, ledger: 0 } as Live<string>) : perm,
      build: (source: string) =>
        g.kind === "authorized"
          ? setAuthorizedCall(manifest, { source, sac: live5.underlying, account: g.account, authorize: true })
          : g.kind === "account"
            ? grantAccountCall(manifest, { source, account: g.account })
            : grantAssetCall(manifest, { source, account: g.account, asset: g.asset as string }),
    }))
    const held = items.filter((it) => it.g.held).map((it) => `${it.g.kind}:${it.g.holder}`)
    const mine = items.filter((it) => !it.g.held && it.admin.status === "live" && it.admin.value === admin.publicKey)
    expect(mine.length).toBe(items.length - held.length)
    log(`step 5: ${held.length} grants already held (${held.join(", ")}); ${mine.length} to sign`)
    const blockersFor = (call: ManagerCall) => {
      const role = REQUIRED_ROLE[call.kind]?.role
      return evaluateManagerGates(call, { wallet, roles: { status: "live", value: role ? [role] : [], ledger: 0 }, findings, listed: true })
    }
    const calls = mine.map((it) => it.build(admin.publicKey))
    for (const [i, call] of calls.entries()) await sign(call, blockersFor, `step 5 (${i + 1} of ${calls.length})`)
    expect((await readProgress()).step).toBe(6)
    expect(progress.live!.grants.every((g) => g.held)).toBe(true)
  }, 5 * MINUTE)

  it("step 6: an APY of 0 or less and too small an amount are refused before anything is signed", async () => {
    const seed = await readSeedState(reader(), manifest, predicted, admin.publicKey)
    const pool = live(seed.poolState, "pool state")
    const s = { secondsToMaturity: pool.secondsToMaturity, exponent: pool.exponent }
    const base = { amountUnderlying: SEED_AMOUNT, s, oracleRate: pool.rate, exchangeRate: live(seed.exchangeRate, "exchange rate"), feeBps: live(seed.feeBps, "fee") }
    for (const apy of [0n, -100_000n]) {
      const refused = seedAmounts({ ...base, apy })
      expect("error" in refused, `APY ${apy}: ${json(refused)}`).toBe(true)
      const gate = firstDepositGate({ totalLp: { status: "live", value: 0n, ledger: 0 }, oracleFresh: seed.oracleFresh, amounts: refused })
      expect(gate.map((b) => b.code)).toContain("amount")
      log(`step 6 refusal, APY ${Number(apy) / 1e5} %: "${(refused as { error: string }).error}"`)
    }
    const tiny = seedAmounts({ ...base, apy: SEED_APY, amountUnderlying: 1_000n })
    expect("error" in tiny, `1000 raw USDY: ${json(tiny)}`).toBe(true)
    log(`step 6 refusal, 1000 raw USDY: "${(tiny as { error: string }).error}"`)
    // Nothing was signed: the pool is still empty.
    expect((await readProgress()).step).toBe(6)
  }, 2 * MINUTE)

  it("step 6: the seed signs wrap_and_mint, deposit and add_liquidity in order, floors from simulation; the pool's implied rate compounds to the APY typed", async () => {
    const live6 = progress.live!
    const isIssuer = live6.admin === admin.publicKey
    expect(isIssuer).toBe(true)
    const newMarket: NewMarket = { salt, underlying: live6.underlying }
    const source = admin.publicKey

    // StepSeed: the reads, the plan, and the first-deposit gate in place of poolGate.
    const data = await readSeedState(reader(), manifest, predicted, source)
    const pool = live(data.poolState, "pool state")
    expect(live(data.balances!.pt, "PT held"), "a fresh seed: no PT of this market held").toBe(0n)
    const plan = seedAmounts({
      apy: SEED_APY,
      amountUnderlying: SEED_AMOUNT,
      s: { secondsToMaturity: pool.secondsToMaturity, exponent: pool.exponent },
      oracleRate: pool.rate,
      exchangeRate: live(data.exchangeRate, "exchange rate"),
      feeBps: live(data.feeBps, "fee"),
    })
    if ("error" in plan) throw new Error(plan.error)
    const gate = firstDepositGate({ totalLp: { status: "live", value: live6.lpTotalSupply, ledger: 0 }, oracleFresh: data.oracleFresh, amounts: plan })
    expect(gate).toEqual([])
    log(
      `step 6 plan: ${units(plan.mintUnderlying)} USDY minted, ${units(plan.depositUnderlying)} deposited; pool takes ${units(plan.pt)} PT + ${units(plan.sy)} SY; ` +
        `implied rate ${plan.impliedRate} (APY ${(aprToApy(plan.impliedRate, pool.secondsToMaturity) * 100).toFixed(6)} %), PT price ${plan.ptPrice}, LP ${units(plan.lp)}`,
    )

    const simulate: SeedSimulate = (from, invocation) =>
      simulateInvocation({ rpcUrl: manifest.rpcUrl, networkPassphrase: manifest.networkPassphrase, source: from, invocation })
    const deadline = async () => BigInt((await getLedgerClock(rpc())).closeTime + DEADLINE_SECONDS)
    const built = (p: Parameters<typeof simulatedSeedCall>[0]["params"]) =>
      simulatedSeedCall({ manifest, source, market: newMarket, params: p, simulate, slippageBps: SLIPPAGE_BPS, pool: predicted.pool })
    // The fresh seed's three deferred steps, as StepSeed builds them: the first deposit is worked out
    // again once the mint and deposit have landed, from what the wallet holds, at most the plan's.
    const steps: ManagerStep[] = [
      { build: async () => built({ kind: "seed_mint", amount: plan.mintUnderlying, deadline: await deadline() }) },
      { build: () => built({ kind: "seed_deposit", amount: plan.depositUnderlying }) },
      {
        build: async () => {
          const now = await readSeedState(reader(), manifest, predicted, source)
          const st = live(now.poolState, "pool state")
          const pt = live(now.balances!.pt, "PT held")
          const sy = live(now.balances!.sy, "SY held")
          expect(st.totalLp, "nobody else seeded the pool meanwhile").toBe(0n)
          const pair = seedPair({
            apy: SEED_APY,
            maxPt: pt < plan.pt ? pt : plan.pt,
            maxSy: sy < plan.sy ? sy : plan.sy,
            s: { secondsToMaturity: st.secondsToMaturity, exponent: st.exponent },
            oracleRate: st.rate,
          })
          if ("error" in pair) throw new Error(pair.error)
          seedAdd = pair
          log(`step 6 first deposit worked out from ${units(pt)} PT and ${units(sy)} SY held: ${units(pair.pt)} PT + ${units(pair.sy)} SY`)
          return built({ kind: "seed_add_liquidity", pt: pair.pt, sy: pair.sy, deadline: await deadline() })
        },
      },
    ]
    const roles = issuerRoles(live6.admin)
    const blockersFor = (call: ManagerCall) => [...evaluateManagerGates(call, { wallet, roles, findings, listed: true }), ...gate]
    const calls: ManagerCall[] = []
    for (const [i, step] of steps.entries()) calls.push(await sign(step, blockersFor, `step 6 (${i + 1} of 3)`))
    expect(calls.map((c) => c.invocation.functionName)).toEqual(["wrap_and_mint", "deposit", "add_liquidity"])
    // Every floor came from the call's simulation and sits above zero.
    for (const c of calls) {
      const floor = c.invocation.args[c.kind === "seed_deposit" ? 2 : c.kind === "seed_mint" ? 3 : 4].value as bigint
      expect(floor > 0n, `${c.kind} floor ${floor}`).toBe(true)
    }

    expect((await readProgress()).step).toBe(7)
    const add = seedAdd!
    const big = (fn: string) => readLive(reader(), { contractId: predicted.pool, functionName: fn }, toBigint)
    const [st, rate, price, supply] = await Promise.all([
      readLive(reader(), { contractId: predicted.pool, functionName: "pool_state" }, parsePoolState).then((r) => live(r, "pool state")),
      big("implied_rate"),
      big("pt_price"),
      big("lp_total_supply"),
    ])
    const onChainRate = live(rate, "implied_rate")
    const lpSupply = live(supply, "lp_total_supply")
    const apy = aprToApy(onChainRate, st.secondsToMaturity)
    log(
      `step 6 seeded: pool ${units(st.ptReserve)} PT + ${units(st.syReserve)} SY, LP ${units(lpSupply)}; implied_rate ${onChainRate} (APY ${(apy * 100).toFixed(6)} %, typed ${Number(SEED_APY) / 1e5} %); ` +
        `pt_price ${live(price, "pt_price")}; worked out ${add.impliedRate} at the add's build`,
    )
    // The pool took exactly the signed pair, and the first deposit's LP is isqrt(pt·sy).
    expect(st.ptReserve).toBe(add.pt)
    expect(st.syReserve).toBe(add.sy)
    expect(lpSupply).toBe(isqrt(add.pt * add.sy))
    // R5-10: PT below par; the compounded APY the market list shows is the one typed.
    expect(onChainRate > 0n).toBe(true)
    expect(Math.abs(apy - Number(SEED_APY) / Number(SCALE)), `APY ${apy} vs typed ${Number(SEED_APY) / Number(SCALE)}`).toBeLessThan(1e-5)
    // The contract's view and the curve port agree on the seeded reserves (at this read's clock).
    const port = curveImpliedRate({ ...st })
    const close = (a: bigint, b: bigint, tol: bigint) => (a > b ? a - b : b - a) <= tol
    expect(close(port, onChainRate, onChainRate / 100_000n), `curve port ${port} vs implied_rate ${onChainRate}`).toBe(true)
    expect(close(add.impliedRate, onChainRate, onChainRate / 100_000n), `worked out ${add.impliedRate} vs implied_rate ${onChainRate}`).toBe(true)
    // The seeder holds the LP (less the 1,000 locked) and the YT; at most a few raw units of PT and SY are left.
    const held = await readSeedState(reader(), manifest, predicted, source)
    const ptLeft = live(held.balances!.pt, "PT held")
    const syLeft = live(held.balances!.sy, "SY held")
    expect(ptLeft + syLeft <= 10n, `left ${ptLeft} PT + ${syLeft} SY raw`).toBe(true)
    log(`step 6: the seeder keeps ${ptLeft} raw PT and ${syLeft} raw SY`)
  }, 5 * MINUTE)

  it("step 7: the wizard's POST /api/markets publishes the market; the registry lists it, it passes validation, and its salt leaves the Resume list", async () => {
    const { POST } = await import("@/app/api/markets/route")
    // StepPublish's request, as the browser sends it from this app's page.
    const response = await POST(
      new Request("http://localhost:3000/api/markets", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
        body: JSON.stringify({ pool: predicted.pool }),
      }),
    )
    const body = (await response.json()) as { market?: Market; reason?: string; message?: string }
    expect(response.status, json(body)).toBe(200)
    expect(body.market?.contracts.pool).toBe(predicted.pool)

    const markets = await registry.reg.resolvedMarkets({ store: registry.tables, manifest })
    const listed = markets.find((m) => m.contracts.pool === predicted.pool)
    if (!listed) throw new Error("the published market is not in the resolved list")
    market = listed
    expect(market.contracts).toMatchObject({
      sy: predicted.sy,
      pt: predicted.pt,
      yt: predicted.yt,
      config: predicted.config,
      manager: predicted.manager,
      recoveryEscrow: predicted.recoveryEscrow,
      router: manifest.shared.router,
      oracle: manifest.shared.oracle,
    })
    expect(market.maturity).toBe(Number(params.maturity))
    const verdict = await registry.reg.validateMarket(reader(), rpc(), manifest, market)
    expect(verdict).toEqual({ valid: true })
    const row = (await registry.tables.rows()).find((r) => r.pool === predicted.pool)
    expect(row).toMatchObject({ source: "published", valid: true })
    const resumable = await registry.reg.resumableSalts({ store: registry.store, manifest })
    if (resumable.status !== "ok") throw new Error("resumableSalts: unavailable")
    expect(resumable.salts.map((r) => r.salt)).not.toContain(salt)
    resolved = { ...manifest, markets }
    expect(validateManifest(resolved).filter((f) => f.severity === "error")).toEqual([])
    log(`step 7: published ${market.marketId} (${market.displayName}), pool ${market.contracts.pool}, maturing ${new Date(market.maturity * 1000).toISOString()}; verdict ${json(verdict)}`)
  }, 3 * MINUTE)

  it("a fresh account onboarded through the faucet holds the new market's PT and YT grants", async () => {
    kind = await complianceKind(resolved, market)
    // The faucet route's own list: the seeds and the registry markets.
    const signer = await onboardFreshAccount(resolved, market, kind, () => registry.reg.resolvedMarkets({ store: registry.tables, manifest }))
    trader = createRunner({ manifest: resolved, market, findings: validateManifest(resolved), kind, signer, log, record: (s) => trades.push(s) })
    const s = await trader.snapshot()
    expect(live(s.acc.permAllowed, "Permissioning account grant")).toBe(true)
    expect(live(s.acc.permPt, "PT grant on the new market")).toBe(true)
    expect(live(s.acc.permYt, "YT grant on the new market")).toBe(true)
    expect(live(s.acc.sacAuthorized, "USDY authorization")).toBe(true)
    expect(s.compliance.filter((c) => c.status !== "ok"), json(s.compliance)).toEqual([])
    log(`fresh account ${trader.account} onboarded: ${showBalances(balancesOf(s.acc))}`)
  }, 3 * MINUTE)

  it("the fresh account buys YT on the new market with USDY: one flash (flash_mint_yt_from_underlying), within its budget; the rate rises", async () => {
    const req: TradeRequest = { kind: "buy_yt", amount: 5n * U, pay: "underlying", receive: "underlying" }
    const t = await runTrade({ manifest: resolved, market, runner: trader, log, req, expectActions: ["buy_yt_flash_underlying"] })
    const [buy] = t.steps
    if (buy.decoded.kind !== "flash_yt_underlying") throw new Error("not a flash_yt_underlying output")
    const { yt_out, net_cost, underlying_back } = buy.decoded
    const s0 = (await trader.snapshot()).ms
    const budgetSy = previewDeposit(req.amount, live(s0.exchangeRate, "exchange rate"))
    expect(yt_out > 0n).toBe(true)
    expect(buy.guards.maxNetCost! <= budgetSy, `max_net_cost ${buy.guards.maxNetCost} vs budget ${budgetSy} SY`).toBe(true)
    expect(net_cost <= buy.guards.maxNetCost!).toBe(true)
    expect(t.bal1.underlying - t.bal0.underlying).toBe(underlying_back - req.amount)
    expect(t.bal1.yt - t.bal0.yt).toBe(yt_out)
    expect(t.bal1.sy - t.bal0.sy).toBe(0n)
    expect(t.bal1.pt - t.bal0.pt).toBe(0n)
    expect(t.quote.exactness).toBe("simulated")
    expect(t.rate.after > t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    log(`buy_yt (USDY flash) on ${market.marketId}: budget ${units(req.amount)} USDY, net cost ${units(net_cost)} SY, ${units(underlying_back)} USDY back, YT ${units(yt_out)}; tx ${buy.hash}`)
  }, 3 * MINUTE)

  it("the fresh account adds liquidity to the new market from USDY only: one transaction (add_liquidity_single_underlying); the rate falls", async () => {
    const req: TradeRequest = { kind: "lp_only", amount: 200n * U, pay: "underlying", receive: "underlying" }
    let syIn = 0n
    const t = await runTrade({
      manifest: resolved,
      market,
      runner: trader,
      log,
      req,
      expectActions: ["add_liquidity_underlying"],
      expectPlan: (plans, s) => {
        syIn = previewDeposit(req.amount, live(s.ms.exchangeRate, "exchange rate"))
        expect(plans[0].secondaryAmount).toEqual({ from: "value", value: syIn })
      },
    })
    const [add] = t.steps
    if (add.decoded.kind !== "add_liquidity") throw new Error("not an add_liquidity output")
    expect(add.decoded.lp > 0n).toBe(true)
    expect(t.bal1.underlying - t.bal0.underlying).toBe(-req.amount)
    expect(t.bal1.lp - t.bal0.lp).toBe(add.decoded.lp)
    expect(t.bal1.sy - t.bal0.sy).toBe(syIn - add.decoded.sy_used)
    expect(t.bal1.pt - t.bal0.pt).toBe(0n)
    expect(t.rate.after < t.rate.before, `implied rate ${t.rate.before} -> ${t.rate.after}`).toBe(true)
    log(`lp_only (USDY) on ${market.marketId}: ${units(req.amount)} USDY -> LP ${units(add.decoded.lp)}, ${units(syIn - add.decoded.sy_used)} SY back; tx ${add.hash}`)
  }, 3 * MINUTE)

  it("the new market's history lists both trades with their kinds", async () => {
    const history = await fetchAccountHistory({ manifest: resolved, marketId: market.marketId, account: trader.account })
    expect([...history.entries].reverse().map((e) => [e.hash, e.kind])).toEqual(trades.map((s) => [s.hash, HISTORY_KIND[s.action]]))
    const acc = await fetchAccountState(reader(), createHorizon(manifest.horizonUrl), resolved, market.marketId, trader.account, kind)
    log(`history on ${market.marketId}: ${history.entries.map((e) => e.kind).join(", ")}; account ${showBalances(balancesOf(acc))}`)
  }, 2 * MINUTE)
})
