// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AccountState } from "../account-state"
import { ACTION_META, type ActionId, type ActionInput } from "../actions"
import type { ComplianceItem } from "../compliance"
import { BLOCKER_ORDER, breakerReport, evaluateGates, withEarlierReports, type Blocker, type GateContext } from "../gates"
import type { MarketState } from "../market-state"
import { SCALE } from "../math"
import type { SimulationOutcome } from "../stellar"
import type { Live, WalletState } from "../types"
import { indexFor } from "../yield"

// ---------------------------------------------------------------- fixtures

const MANAGER = "CMANAGERCONTRACTID"
const ROUTER = "CROUTERCONTRACTID"
const USER = "GUSERACCOUNT"
const OTHER = "GOTHERACCOUNT"
const TESTNET = "Test SDF Network ; September 2015"

const MATURITY = 1_800_000_000
const BEFORE = MATURITY - 86_400
const AFTER = MATURITY + 86_400
const RATE = 10_500_000n // oracle rate 1.05 at SCALE
const UNIT = 10_000_000n // one token at 7 decimals
const BIG = 1_000_000n * UNIT

const ALL = Object.keys(ACTION_META) as ActionId[]
const TRADES: ActionId[] = ["buy_pt", "sell_pt", "buy_yt", "sell_yt"]
const ADDS: ActionId[] = ["add_liquidity", "add_liquidity_sy"]
/** R22b: actions that move PT / YT to or from the account need its per-asset grant. */
const NEEDS_PT: ActionId[] = ["mint", "buy_pt", "buy_yt", "sell_pt", "add_liquidity", "add_liquidity_sy", "remove_liquidity"]
const NEEDS_YT: ActionId[] = ["mint", "buy_yt", "sell_yt"]
const except = (...out: ActionId[]) => ALL.filter((a) => !out.includes(a))

const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 500 })
const down = (error = "RPC rate limited (429)"): Live<never> => ({ status: "unavailable", error })

function healthyMarket(): MarketState {
  return {
    oracleRate: live(RATE),
    oracleTimestamp: live(BigInt(BEFORE)),
    oracleFresh: live(true),
    maturity: live(BigInt(MATURITY)),
    settledRate: live(null),
    ytFrozen: live(false),
    ytAccruedIndex: live(indexFor(RATE)),
    totalPt: live(BIG),
    totalYt: live(BIG),
    poolState: live({
      ptReserve: BIG,
      syReserve: BIG,
      totalLp: BIG,
      rate: RATE,
      exponent: 10n ** 18n,
      feeRate: 3n,
      secondsToMaturity: 86_400n,
    }),
    poolSeeded: live(true),
    ptPrice: live(9_500_000n),
    impliedRate: live(600_000n),
    lpTotalSupply: live(BIG),
    fees: { tokenizationBps: live(10n), ytBps: live(20n), swapTierBps: live(30n), protocolShareBps: live(40n) },
    swapFeeRate: live(3n),
    exchangeRate: live(SCALE),
    managerSy: live(0n),
    syPaused: live(false),
    poolPaused: live(false),
    riskPaused: live(false),
    // A limit of 0 disables a breaker on-chain: the per-asset one is off in the healthy state.
    cb: { limit: live(BIG), volume: live(0n), assetLimit: live(0n), assetVolume: live(0n) },
    topology: live({ matches: true, mismatches: [] }),
  }
}

function healthyAccount(): AccountState {
  return {
    underlying: live(BIG),
    sy: live(BIG),
    pt: live(BIG),
    yt: live(BIG),
    lp: live(BIG),
    ytLastClaimedIndex: live(indexFor(RATE)),
    // One token of yield already settled into the account: claim has something to pay.
    ytPendingClaim: live(UNIT),
    depositCap: live(BIG),
    netDeposited: live(0n),
    sacAuthorized: live(true),
    sep57: null,
    permAllowed: live(true),
    permPt: live(true),
    permYt: live(true),
    trustline: live("authorized"),
    accountExists: live(true),
  }
}

function healthyCompliance(): ComplianceItem[] {
  return (["account", "trustline", "authorized", "permissioning", "perm_pt", "perm_yt"] as const).map((id) => ({
    id,
    status: "ok",
    message: `${id} is fine.`,
  }))
}

const okSimulation: SimulationOutcome = { ok: true, retval: 1n, latestLedger: 500, minResourceFee: "100" }

/**
 * A context in which `action` passes every gate. Redeem only opens at maturity, everything else
 * that the maturity gate touches only before it, so redeem's healthy state is post-maturity and
 * settled; every other action's is pre-maturity and unsettled.
 */
function healthyCtx(action: ActionId): GateContext {
  const market = healthyMarket()
  if (action === "redeem") {
    market.settledRate = live(RATE)
    market.ytFrozen = live(true)
  }
  return {
    findings: [],
    wallet: { status: "connected", publicKey: USER, networkPassphrase: TESTNET },
    market,
    account: healthyAccount(),
    compliance: healthyCompliance(),
    ledgerTime: action === "redeem" ? AFTER : BEFORE,
    simulation: okSimulation,
    managerId: MANAGER,
  }
}

function inputFor(action: ActionId, overrides: Partial<ActionInput> = {}): ActionInput {
  const twoSided = action === "add_liquidity" || action === "redeem"
  return {
    action,
    marketId: "testnet-sta",
    source: USER,
    amount: 10n * UNIT,
    secondaryAmount: twoSided ? 5n * UNIT : undefined,
    guards: { minOut: 1n, minOut2: 1n, maxNetCost: 1n },
    deadline: BigInt(BEFORE + 300),
    ...overrides,
  }
}

type Mutate = (ctx: GateContext, action: ActionId) => void

/** Actions this release does not offer (R47): `evaluateGates` refuses them with `disabled`. */
const DISABLED = ALL.filter((a) => ACTION_META[a].disabled !== undefined)

/**
 * The blockers of `action` in a healthy context changed by `mutate`. The `disabled` blocker of an
 * action that is not offered is left out here, so every rule below is still checked on it (they
 * apply again the day it is re-enabled); it is asserted on its own in "an action that is not offered".
 */
function gates(action: ActionId, mutate?: Mutate, input?: Partial<ActionInput>): Blocker[] {
  const ctx = healthyCtx(action)
  mutate?.(ctx, action)
  return evaluateGates(inputFor(action, input), ctx).filter((b) => b.code !== "disabled")
}

const codes = (blockers: Blocker[]) => blockers.map((b) => b.code)

const item = (id: ComplianceItem["id"], patch: Partial<ComplianceItem>): Mutate => (ctx) => {
  ctx.compliance = ctx.compliance.map((i) => (i.id === id ? { ...i, ...patch } : i))
}

const managerPaused: SimulationOutcome = {
  ok: false,
  kind: "contract_error",
  contractId: MANAGER,
  code: 9,
  message: "HostError: Error(Contract, #9)",
}

// ---------------------------------------------------------------- the matrix

type Row = {
  rule: string
  mutate?: Mutate
  input?: Partial<ActionInput>
  code: Blocker["code"]
  /** Each blocked action gets exactly one blocker, of `code`, whose message matches. */
  message?: RegExp
  fix?: ComplianceItem["fix"]
  blocks: ActionId[]
  /** Actions on which the same change leaves no blocker at all. */
  allows?: ActionId[]
}

const MATRIX: Row[] = [
  // §5 "Manifest valid, topology matches chain" → everything for that market.
  {
    rule: "an error finding in the manifest blocks everything",
    mutate: (c) => {
      c.findings = [{ severity: "error", message: "rpcUrl must use https:// on testnet." }]
    },
    code: "manifest",
    message: /manifest.*rpcUrl must use https/i,
    blocks: ALL,
  },
  {
    rule: "a manifest warning alone blocks nothing",
    mutate: (c) => {
      c.findings = [{ severity: "warning", message: "friendbotUrl is not set." }]
    },
    code: "manifest",
    blocks: [],
    allows: ALL,
  },
  {
    rule: "a topology mismatch blocks everything",
    mutate: (c) => {
      c.market.topology = live({ matches: false, mismatches: ["yt", "maturity"] })
    },
    code: "topology",
    message: /yt, maturity/,
    blocks: ALL,
  },

  // §5 "Wallet connected, network matches" → every write.
  {
    rule: "a disconnected wallet blocks every write",
    mutate: (c) => {
      c.wallet = { status: "disconnected" }
    },
    code: "wallet",
    message: /connect your wallet/i,
    blocks: ALL,
  },
  {
    rule: "a wrong network blocks every write",
    mutate: (c) => {
      c.wallet = { status: "wrong_network", publicKey: USER, actualPassphrase: "Public Global Stellar Network ; September 2015", expectedPassphrase: TESTNET }
    },
    code: "network",
    message: /switch it to the network/i,
    blocks: ALL,
  },
  {
    rule: "an action prepared for another account than the connected one",
    input: { source: OTHER },
    code: "wallet",
    message: /different account/i,
    blocks: ALL,
  },

  // Amount input.
  {
    rule: "an amount of 0n",
    input: { amount: 0n },
    code: "amount",
    message: /greater than zero/i,
    blocks: except("claim_yield", "redeem"),
    // Claim takes no amount; redeem accepts YT only (pt_amount 0, yt_amount > 0).
    allows: ["claim_yield", "redeem"],
  },
  {
    rule: "a negative amount",
    input: { amount: -1n },
    code: "amount",
    blocks: except("claim_yield"),
    allows: ["claim_yield"],
  },
  {
    rule: "redeem with neither PT nor YT",
    input: { amount: 0n, secondaryAmount: 0n },
    code: "amount",
    message: /PT or YT/,
    blocks: ["redeem"],
  },
  {
    rule: "two-sided add without an SY amount",
    input: { secondaryAmount: 0n },
    code: "amount",
    message: /SY amount/,
    blocks: ["add_liquidity"],
  },

  // §5 "Before maturity" → mint, every trade, add liquidity, recombine. "After maturity" → redeem.
  {
    rule: "after maturity, every trade, mint, add_* and recombine are blocked",
    mutate: (c) => {
      c.ledgerTime = AFTER
    },
    code: "maturity",
    message: /matured/i,
    blocks: ["mint", ...TRADES, ...ADDS, "recombine"],
    allows: ["deposit", "withdraw", "remove_liquidity", "claim_yield", "redeem"],
  },
  {
    rule: "after maturity, a trade is refused as \"Trading closed at maturity\" (T16)",
    mutate: (c) => {
      c.ledgerTime = AFTER
    },
    code: "maturity",
    message: /^Trading closed at maturity: this market has matured.*You can still redeem/,
    blocks: [...TRADES],
  },
  {
    rule: "after maturity, mint, adds and recombine keep the general maturity message",
    mutate: (c) => {
      c.ledgerTime = AFTER
    },
    code: "maturity",
    message: /^This market has matured: minting, trading, adding liquidity and recombining are closed/,
    blocks: ["mint", ...ADDS, "recombine"],
  },
  {
    rule: "at the maturity second itself the market counts as matured (timestamp >= maturity)",
    mutate: (c) => {
      c.ledgerTime = MATURITY
    },
    code: "maturity",
    blocks: ["buy_pt", "mint"],
    allows: ["redeem"],
  },
  {
    rule: "before maturity, redeem is blocked",
    mutate: (c) => {
      c.ledgerTime = BEFORE
    },
    code: "maturity",
    message: /opens at maturity/i,
    blocks: ["redeem"],
    allows: except("redeem"),
  },

  // §5 "Oracle fresh".
  {
    rule: "a stale oracle blocks mint, every trade, single-sided add and recombine — not deposit, withdraw, two-sided add or remove",
    mutate: (c) => {
      c.market.oracleFresh = live(false)
    },
    code: "oracle",
    message: /stale/i,
    blocks: ["buy_pt", "sell_pt", "buy_yt", "sell_yt", "mint", "add_liquidity_sy", "recombine", "claim_yield"],
    allows: ["deposit", "withdraw", "add_liquidity", "remove_liquidity", "redeem"],
  },
  {
    rule: "a stale oracle does not block claim_yield once the YT index is frozen (market settled)",
    mutate: (c) => {
      c.market.oracleFresh = live(false)
      c.market.ytFrozen = live(true)
      c.market.settledRate = live(RATE)
      c.ledgerTime = AFTER
    },
    code: "oracle",
    blocks: [],
    allows: ["claim_yield"],
  },
  {
    // assert_oracle_fresh_unless_frozen (principal_manager:858-863) skips only when SettledRate is
    // stored; a frozen YT index without settlement still needs a fresh oracle.
    rule: "a stale oracle still blocks claim_yield when the YT index is frozen but the market is unsettled",
    mutate: (c) => {
      c.market.oracleFresh = live(false)
      c.market.ytFrozen = live(true)
      c.market.settledRate = live(null)
      c.ledgerTime = AFTER
    },
    code: "oracle",
    blocks: ["claim_yield"],
  },
  {
    // R40: settle() checks freshness only while the YT index is not frozen (principal_manager:755-758).
    rule: "a stale oracle blocks redeem while the market is unsettled and the YT index not frozen (R40)",
    mutate: (c) => {
      c.market.oracleFresh = live(false)
      c.market.settledRate = live(null)
      c.market.ytFrozen = live(false)
    },
    code: "oracle",
    message: /stale.*The first redemption settles the market at the current oracle price, so that price must be fresh\./,
    blocks: ["redeem"],
  },
  {
    // R40: once frozen, settle() records last_oracle_rate without a freshness check, and the YT
    // leg's advance() returns before its own (yt_token:616-623): the contract accepts it.
    rule: "a stale oracle does not block redeem once the YT index is frozen, even unsettled (R40)",
    mutate: (c) => {
      c.market.oracleFresh = live(false)
      c.market.settledRate = live(null)
      c.market.ytFrozen = live(true)
    },
    code: "oracle",
    blocks: [],
    allows: ["redeem"],
  },

  // §5 "Pool seeded".
  {
    rule: "an unseeded pool blocks every trade and both adds",
    mutate: (c) => {
      c.market.poolSeeded = live(false)
    },
    code: "pool",
    message: /pool not seeded yet/i,
    blocks: [...TRADES, ...ADDS],
    allows: except(...TRADES, ...ADDS),
  },

  // §5 "Paused".
  {
    rule: "poolPaused blocks trades, adds, and remove_liquidity before maturity",
    mutate: (c) => {
      c.market.poolPaused = live(true)
    },
    code: "pause",
    message: /pool is paused/i,
    blocks: [...TRADES, ...ADDS, "remove_liquidity"],
    allows: ["deposit", "withdraw", "mint", "recombine", "claim_yield", "redeem"],
  },
  {
    rule: "poolPaused does not block remove_liquidity after maturity",
    mutate: (c) => {
      c.market.poolPaused = live(true)
      c.ledgerTime = AFTER
    },
    code: "pause",
    blocks: [],
    allows: ["remove_liquidity", "deposit", "withdraw", "claim_yield", "redeem"],
  },
  {
    // Spec: "SY pause: everything that moves SY". Every action moves SY on-chain: adds and
    // recombine transfer SY, claim and redeem pay through SYWrapper.withdraw.
    rule: "syPaused blocks everything that moves SY: every action",
    mutate: (c) => {
      c.market.syPaused = live(true)
    },
    code: "pause",
    message: /SY wrapper is paused/,
    blocks: ALL,
  },
  {
    rule: "syPaused blocks remove_liquidity after maturity too",
    mutate: (c) => {
      c.market.syPaused = live(true)
      c.ledgerTime = AFTER
    },
    code: "pause",
    message: /SY wrapper is paused/,
    blocks: ["remove_liquidity", "withdraw", "claim_yield"],
  },
  {
    rule: "riskPaused blocks deposit, mint and buy_yt",
    mutate: (c) => {
      c.market.riskPaused = live(true)
    },
    code: "pause",
    message: /risk control/i,
    blocks: ["deposit", "mint", "buy_yt"],
    allows: except("deposit", "mint", "buy_yt"),
  },
  {
    rule: "a manager contract_error #9 means PrincipalManager is paused for mint, buy_yt, sell_yt, recombine, claim_yield and redeem",
    mutate: (c) => {
      c.simulation = managerPaused
    },
    code: "pause",
    message: /PrincipalManager is paused/,
    blocks: ["mint", "buy_yt", "sell_yt", "recombine", "claim_yield", "redeem"],
  },
  {
    rule: "a manager contract_error #9 on an action the manager pause does not cover is a failed quote",
    mutate: (c) => {
      c.simulation = managerPaused
    },
    code: "quote",
    message: /#9/,
    blocks: ["deposit", "withdraw", "buy_pt", "sell_pt", "add_liquidity", "add_liquidity_sy", "remove_liquidity"],
  },
  {
    // Code 9 is NotAuthorizedOnSac on SYWrapper and InsufficientLiquidity on MarketPool: only the
    // manager's own #9 is a pause.
    rule: "a contract_error #9 from another contract is not a pause",
    mutate: (c) => {
      c.simulation = { ...managerPaused, contractId: ROUTER }
    },
    code: "quote",
    message: /#9/,
    blocks: ALL,
  },

  // §5 "Something to claim".
  {
    rule: "a net pending yield of 0 blocks claim_yield",
    mutate: (c) => {
      c.account!.ytPendingClaim = live(0n)
    },
    code: "claim",
    message: /nothing to claim yet/i,
    blocks: ["claim_yield"],
    allows: except("claim_yield"),
  },
  {
    rule: "a pending yield the YT fee eats entirely blocks claim_yield",
    mutate: (c) => {
      c.account!.ytPendingClaim = live(1n)
    },
    code: "claim",
    blocks: ["claim_yield"],
  },
  {
    rule: "yield accrued since the last claim (oracle rose) is claimable",
    mutate: (c) => {
      c.account!.ytPendingClaim = live(0n)
      c.account!.ytLastClaimedIndex = live(indexFor(SCALE))
    },
    code: "claim",
    blocks: [],
    allows: ["claim_yield"],
  },

  // §5 "Compliance" (R22).
  ...(["account", "trustline", "authorized", "permissioning"] as const).map(
    (id): Row => ({
      rule: `compliance item "${id}" not ok blocks every write, with its fix`,
      mutate: item(id, { status: "missing", message: `Fix ${id} first.`, fix: "onboarding" }),
      code: "compliance",
      message: new RegExp(`Fix ${id} first`),
      fix: "onboarding",
      blocks: ALL,
    }),
  ),
  {
    rule: "authorized blocked by the issuer blocks every write",
    mutate: item("authorized", { status: "blocked", message: "Blocked by the issuer.", fix: "issuer" }),
    code: "compliance",
    message: /Blocked by the issuer/,
    fix: "issuer",
    blocks: ALL,
  },
  {
    rule: "permPt not ok blocks every action that moves PT to or from the account (R22b)",
    mutate: item("perm_pt", { status: "missing", message: "PT is not allowed yet.", fix: "onboarding" }),
    code: "compliance",
    message: /PT is not allowed/,
    fix: "onboarding",
    blocks: NEEDS_PT,
    allows: except(...NEEDS_PT),
  },
  {
    rule: "permYt not ok blocks every action that moves YT to or from the account (R22b)",
    mutate: item("perm_yt", { status: "missing", message: "YT is not allowed yet.", fix: "onboarding" }),
    code: "compliance",
    message: /YT is not allowed/,
    fix: "onboarding",
    blocks: NEEDS_YT,
    allows: except(...NEEDS_YT),
  },
  {
    rule: "an unavailable compliance item blocks as unavailable",
    mutate: item("permissioning", { status: "unavailable", message: "Principal permissioning could not be checked right now." }),
    code: "unavailable",
    message: /permissioning could not be checked/,
    blocks: ALL,
  },
  {
    rule: "an unavailable perm_pt item blocks only the actions that need the PT grant",
    mutate: item("perm_pt", { status: "unavailable", message: "PT permissioning could not be checked right now." }),
    code: "unavailable",
    blocks: NEEDS_PT,
    allows: except(...NEEDS_PT),
  },
  {
    rule: "compliance that has not been evaluated blocks every write",
    mutate: (c) => {
      c.compliance = []
    },
    code: "unavailable",
    message: /compliance/i,
    blocks: ALL,
  },
  {
    rule: "a compliance list missing a needed item blocks the writes that need it",
    mutate: (c) => {
      c.compliance = c.compliance.filter((i) => i.id !== "perm_yt")
    },
    code: "unavailable",
    message: /YT permissioning/,
    blocks: NEEDS_YT,
    allows: except(...NEEDS_YT),
  },

  // §5 "Circuit breaker" (amounts are 10 tokens).
  {
    rule: "cb volume + 2·amount > limit blocks mint (wrap_and_mint counts twice)",
    mutate: (c) => {
      c.market.cb.limit = live(100n * UNIT)
      c.market.cb.volume = live(85n * UNIT) // 85 + 10 fits; 85 + 2·10 does not
    },
    code: "risk",
    message: /counts twice/i,
    blocks: ["mint"],
    allows: except("mint"),
  },
  {
    rule: "cb volume + amount > limit blocks deposit and buy_yt",
    mutate: (c) => {
      c.market.cb.limit = live(100n * UNIT)
      c.market.cb.volume = live(95n * UNIT)
    },
    code: "risk",
    message: /circuit breaker/i,
    blocks: ["deposit", "mint", "buy_yt"],
    allows: except("deposit", "mint", "buy_yt"),
  },
  {
    rule: "cb volume + amount exactly at the limit passes (the contract trips on total > limit)",
    mutate: (c) => {
      c.market.cb.limit = live(100n * UNIT)
      c.market.cb.volume = live(90n * UNIT)
    },
    code: "risk",
    blocks: ["mint"],
    allows: ["deposit", "buy_yt"],
  },
  {
    rule: "a cb limit of 0 disables the breaker",
    mutate: (c) => {
      c.market.cb.limit = live(0n)
      c.market.cb.volume = live(BIG * 10n)
    },
    code: "risk",
    blocks: [],
    allows: ALL,
  },
  {
    rule: "assetVolume + amount over assetLimit blocks deposit, mint and buy_yt",
    mutate: (c) => {
      c.market.cb.assetLimit = live(100n * UNIT)
      c.market.cb.assetVolume = live(95n * UNIT)
    },
    code: "risk",
    message: /per-asset/i,
    blocks: ["deposit", "mint", "buy_yt"],
    allows: except("deposit", "mint", "buy_yt"),
  },
  {
    rule: "assetVolume + 2·amount over assetLimit blocks mint",
    mutate: (c) => {
      c.market.cb.assetLimit = live(100n * UNIT)
      c.market.cb.assetVolume = live(85n * UNIT)
    },
    code: "risk",
    blocks: ["mint"],
    allows: ["deposit", "buy_yt"],
  },
  {
    // PrincipalManager.mint reports sy_shares·exchange_rate/SCALE (principal_manager:363-368).
    rule: "buy_yt counts its SY at the exchange rate: 10 SY at 2.0 is 20 underlying",
    mutate: (c) => {
      c.market.exchangeRate = live(2n * SCALE)
      c.market.cb.limit = live(100n * UNIT)
      c.market.cb.volume = live(85n * UNIT)
    },
    code: "risk",
    blocks: ["buy_yt", "mint"],
    allows: ["deposit"],
  },

  // §5 "Deposit cap" → deposit, mint from underlying.
  {
    rule: "netDeposited + amount > depositCap blocks deposit and mint",
    mutate: (c) => {
      c.account!.depositCap = live(100n * UNIT)
      c.account!.netDeposited = live(95n * UNIT)
    },
    code: "cap",
    message: /deposit cap/i,
    blocks: ["deposit", "mint"],
    allows: except("deposit", "mint"),
  },
  {
    rule: "netDeposited + amount exactly at the cap passes",
    mutate: (c) => {
      c.account!.depositCap = live(100n * UNIT)
      c.account!.netDeposited = live(90n * UNIT)
    },
    code: "cap",
    blocks: [],
    allows: ["deposit", "mint"],
  },
  {
    rule: "a deposit cap of 0 disables the cap",
    mutate: (c) => {
      c.account!.depositCap = live(0n)
      c.account!.netDeposited = live(BIG * 10n)
    },
    code: "cap",
    blocks: [],
    allows: ["deposit", "mint"],
  },

  // §5 "Exact quote available" and archived entries.
  {
    rule: "restore_required gives archived",
    mutate: (c) => {
      c.simulation = { ok: false, kind: "restore_required" }
    },
    code: "archived",
    message: /Some contract data has expired — restore it first/,
    blocks: ALL,
  },
  {
    // R28: claim and redeem too; the PrincipalManager pause and archived data are only known from
    // a simulation.
    rule: "a missing simulation blocks every action, claim_yield and redeem included",
    mutate: (c) => {
      c.simulation = undefined
    },
    code: "quote",
    message: /Waiting for an exact quote/,
    blocks: ALL,
  },
  {
    // The switch over failure kinds is exhaustive at compile time; at runtime a kind added later
    // still refuses.
    rule: "a simulation failure of an unknown kind blocks",
    mutate: (c) => {
      c.simulation = { ok: false, kind: "budget_exceeded" } as unknown as SimulationOutcome
    },
    code: "quote",
    message: /does not recognize \(budget_exceeded\)/,
    blocks: ALL,
  },
  {
    rule: "a failed simulation blocks with its contract error code",
    mutate: (c) => {
      c.simulation = { ok: false, kind: "contract_error", contractId: ROUTER, code: 6, message: "HostError: Error(Contract, #6)" }
    },
    code: "quote",
    message: /#6/,
    blocks: ALL,
  },
  {
    rule: "an RPC failure during simulation blocks",
    mutate: (c) => {
      c.simulation = { ok: false, kind: "rpc_error", message: "socket hang up" }
    },
    code: "quote",
    message: /socket hang up/,
    blocks: ALL,
  },
]

describe("healthy context", () => {
  it.each(ALL)("%s passes every gate", (action) => {
    expect(gates(action)).toEqual([])
  })
})

describe("an action that is not offered (R47)", () => {
  it("is add_liquidity_sy alone on this release", () => {
    expect(DISABLED).toEqual(["add_liquidity_sy"])
  })

  it.each(DISABLED)("%s is refused with exactly the metadata's reason, every other gate passing", (action) => {
    const blockers = evaluateGates(inputFor(action), healthyCtx(action))
    expect(blockers).toEqual([{ code: "disabled", message: ACTION_META[action].disabled!.reason }])
    expect(blockers[0].message).toMatch(/pool works out the SY it takes .* when the transaction runs/)
    expect(blockers[0].message).not.toMatch(/coming soon/i)
  })

  it.each(ALL.filter((a) => !DISABLED.includes(a)))("%s is never refused as disabled", (action) => {
    expect(codes(evaluateGates(inputFor(action), healthyCtx(action)))).not.toContain("disabled")
  })

  it("is refused even without a wallet, after the deployment checks and before everything else", () => {
    const ctx = healthyCtx("add_liquidity_sy")
    ctx.findings = [{ severity: "error", message: "Duplicate marketId." }]
    ctx.market.topology = live({ matches: false, mismatches: ["pool"] })
    ctx.wallet = { status: "disconnected" }
    ctx.simulation = undefined
    expect(codes(evaluateGates(inputFor("add_liquidity_sy"), ctx))).toEqual(["manifest", "topology", "disabled", "wallet", "quote"])
  })
})

describe("gate matrix", () => {
  for (const row of MATRIX) {
    describe(row.rule, () => {
      if (row.blocks.length > 0) {
        it.each(row.blocks)("blocks %s", (action) => {
          const blockers = gates(action, row.mutate, row.input)
          expect(blockers).toEqual([
            {
              code: row.code,
              message: row.message ? expect.stringMatching(row.message) : expect.any(String),
              ...(row.fix ? { fix: row.fix } : {}),
            },
          ])
        })
      }
      if (row.allows && row.allows.length > 0) {
        it.each(row.allows)("allows %s", (action) => {
          expect(gates(action, row.mutate, row.input)).toEqual([])
        })
      }
    })
  }

  describe("amount > balance gives balance, naming the token that is short (R24)", () => {
    const short = (pick: (a: AccountState) => void): Mutate => (c) => pick(c.account!)
    const rows: [ActionId, Mutate, RegExp][] = [
      ["deposit", short((a) => (a.underlying = live(UNIT))), /underlying/],
      ["mint", short((a) => (a.underlying = live(UNIT))), /underlying/],
      ["withdraw", short((a) => (a.sy = live(UNIT))), /SY/],
      ["buy_pt", short((a) => (a.sy = live(UNIT))), /SY/],
      ["buy_yt", short((a) => (a.sy = live(UNIT))), /SY/],
      ["add_liquidity_sy", short((a) => (a.sy = live(UNIT))), /SY/],
      ["sell_pt", short((a) => (a.pt = live(UNIT))), /PT/],
      ["sell_yt", short((a) => (a.yt = live(UNIT))), /YT/],
      ["add_liquidity", short((a) => (a.pt = live(UNIT))), /PT/],
      ["add_liquidity", short((a) => (a.sy = live(UNIT))), /SY/], // secondaryAmount (5) > 1
      ["remove_liquidity", short((a) => (a.lp = live(UNIT))), /LP/],
      ["recombine", short((a) => (a.pt = live(UNIT))), /PT/],
      ["recombine", short((a) => (a.yt = live(UNIT))), /YT/],
      ["redeem", short((a) => (a.pt = live(UNIT))), /PT/],
      ["redeem", short((a) => (a.yt = live(UNIT))), /YT/], // secondaryAmount (5) > 1
    ]
    it.each(rows)("%s short of %s", (action, mutate, token) => {
      const blockers = gates(action, mutate)
      expect(blockers).toEqual([{ code: "balance", message: expect.stringMatching(token) }])
      expect(blockers[0].message).toMatch(/you have 1 .* this needs/i)
    })

    it("a balance exactly equal to the amount passes", () => {
      expect(gates("sell_pt", short((a) => (a.pt = live(10n * UNIT))))).toEqual([])
    })
  })

  describe("wallet states: only connected passes", () => {
    const states: [string, WalletState, Blocker["code"]][] = [
      ["not_installed", { status: "not_installed" }, "wallet"],
      ["locked", { status: "locked" }, "wallet"],
      ["disconnected", { status: "disconnected" }, "wallet"],
      ["connecting", { status: "connecting" }, "wallet"],
      ["rejected", { status: "rejected", reason: "User declined" }, "wallet"],
      ["unverified_network", { status: "unverified_network", publicKey: USER, expectedPassphrase: TESTNET, reason: "timeout" }, "wallet"],
      ["wrong_network", { status: "wrong_network", publicKey: USER, actualPassphrase: "x", expectedPassphrase: TESTNET }, "network"],
    ]
    it.each(states)("%s blocks every action with %s", (_, wallet, code) => {
      for (const action of ALL) {
        const blockers = gates(action, (c) => {
          c.wallet = wallet
        })
        expect(codes(blockers)).toEqual([code])
        expect(blockers[0].message.length).toBeGreaterThan(20)
      }
    })

    it.each(states)("%s: the message names no retired wallet brand; only an install prompt names Varial", (status, wallet) => {
      const [blocker] = gates("deposit", (c) => {
        c.wallet = wallet
      })
      expect(blocker.message).not.toMatch(/freighter/i)
      if (status === "not_installed") expect(blocker.message).toMatch(/Varial/)
      else expect(blocker.message).not.toMatch(/Varial/)
    })

    it("without a connected wallet the account-dependent gates are not reported (no account to check)", () => {
      for (const action of ALL) {
        const blockers = gates(action, (c) => {
          c.wallet = { status: "disconnected" }
          c.account = undefined
          c.compliance = []
        })
        expect(codes(blockers)).toEqual(["wallet"])
      }
    })

    it("a connected wallet whose account state has not been read is refused", () => {
      for (const action of ALL) {
        const blockers = gates(action, (c) => {
          c.account = undefined
        })
        expect(blockers).toEqual([{ code: "unavailable", message: expect.stringMatching(/your account/i) }])
      }
    })
  })
})

// ---------------------------------------------------------------- Review Focus 1 (R23)

describe("Buy YT is gated on what it moves, not on what it spends (R2-57)", () => {
  // Today's Buy YT moves about 42x its spend (on curve.test.ts's state A, 100 SY spent mint from
  // about 4,216 SY), and its route carries those moved amounts as the step amounts: the deposit
  // step's is the USDY deposited, the buy step's the solver's sy_in. The gates read the step amount.
  const SPEND = 100n * UNIT
  const SY_IN = 42_156_518_764n

  it("a buy_yt step reports its sy_in, at the SY rate, to the circuit breaker", () => {
    const room200 = (c: GateContext) => {
      c.market.exchangeRate = live(SCALE)
      c.market.cb.limit = live(1_000n * UNIT)
      c.market.cb.volume = live(800n * UNIT)
    }
    // The spend alone would fit the 200 left in the window; what the step moves does not.
    expect(gates("buy_yt", room200, { amount: SPEND })).toEqual([])
    expect(gates("buy_yt", room200, { amount: SY_IN })).toEqual([{ code: "risk", message: expect.stringContaining("this adds 4215.6518764") }])
  })

  it("a USDY payer's deposit step is checked against the deposit cap with the deposit, not the spend", () => {
    // 6000 of the cap left: a 200 USDY spend fits, the 8431.30 USDY its deposit step moves does not.
    const room6000 = (c: GateContext) => {
      c.account!.depositCap = live(10_000n * UNIT)
      c.account!.netDeposited = live(4_000n * UNIT)
    }
    expect(gates("deposit", room6000, { amount: 2n * SPEND })).toEqual([])
    expect(codes(gates("deposit", room6000, { amount: 2n * SY_IN }))).toEqual(["cap"])
  })
})

describe("breakerReport — what one step adds to RiskControl's window (R2-61)", () => {
  const market = healthyMarket()
  it("a deposit reports its amount; wrap_and_mint reports twice; buy_yt its SY at the SY rate", () => {
    expect(breakerReport(inputFor("deposit"), { market })).toBe(10n * UNIT)
    expect(breakerReport(inputFor("mint"), { market })).toBe(20n * UNIT)
    const m2 = { ...market, exchangeRate: live(2n * SCALE) }
    expect(breakerReport(inputFor("buy_yt"), { market: m2 })).toBe(20n * UNIT)
  })

  it("an action that does not report, or no amount, adds nothing", () => {
    expect(breakerReport(inputFor("sell_pt"), { market })).toBe(0n)
    expect(breakerReport(inputFor("withdraw"), { market })).toBe(0n)
    expect(breakerReport(inputFor("deposit", { amount: 0n }), { market })).toBe(0n)
  })

  it("buy_yt's report is unknown while the SY exchange rate cannot be read", () => {
    expect(breakerReport(inputFor("buy_yt"), { market: { ...market, exchangeRate: down() } })).toBeUndefined()
  })
})

describe("withEarlierReports — a later route step is checked with the earlier steps counted (R2-61)", () => {
  const tight = (c: GateContext) => {
    c.market.cb.limit = live(100n * UNIT)
    c.market.cb.volume = live(85n * UNIT)
    c.market.cb.assetLimit = live(100n * UNIT)
    c.market.cb.assetVolume = live(81n * UNIT)
  }
  const ctxWith = (mutate: Mutate) => {
    const c = healthyCtx("deposit")
    mutate(c, "deposit")
    return c
  }

  it("adds what the earlier steps report to both windows: a step that fits alone is refused once they count", () => {
    const c = ctxWith(tight)
    expect(evaluateGates(inputFor("deposit"), c)).toEqual([])
    const later = withEarlierReports(c, 10n * UNIT, 2)
    expect(later.market.cb.volume).toEqual(live(95n * UNIT))
    expect(later.market.cb.assetVolume).toEqual(live(91n * UNIT))
    expect(codes(evaluateGates(inputFor("deposit"), later))).toEqual(["risk", "risk"])
    // The context passed in is not changed.
    expect(c.market.cb.volume).toEqual(live(85n * UNIT))
  })

  it("leaves an unreadable volume unreadable", () => {
    const c = ctxWith((x) => {
      tight(x)
      x.market.cb.assetVolume = down("rpc down")
    })
    expect(withEarlierReports(c, 10n * UNIT, 2).market.cb.assetVolume).toEqual(down("rpc down"))
  })

  it("an earlier step whose report is unknown makes the step's breaker check unverifiable, never a pass", () => {
    const later = withEarlierReports(ctxWith(tight), undefined, 2)
    const blockers = evaluateGates(inputFor("deposit"), later)
    // Both windows are on, and neither can be verified.
    expect(codes(blockers)).toEqual(["unavailable", "unavailable"])
    for (const b of blockers) expect(b.message).toMatch(/before step 2 of this route/)
    // With both breakers off there is nothing to verify.
    const off = withEarlierReports(
      ctxWith((x) => {
        x.market.cb.limit = live(0n)
        x.market.cb.assetLimit = live(0n)
      }),
      undefined,
      2,
    )
    expect(evaluateGates(inputFor("deposit"), off)).toEqual([])
  })
})

describe("unavailable read blocks", () => {
  type Dep = { field: string; set: Mutate; label: RegExp; needs: ActionId[] }
  const m = (set: (market: MarketState) => void): Mutate => (c) => set(c.market)
  const a = (set: (account: AccountState) => void): Mutate => (c) => set(c.account!)
  const BREAKER: ActionId[] = ["deposit", "mint", "buy_yt"]

  const DEPS: Dep[] = [
    { field: "topology", set: m((x) => (x.topology = down())), label: /contracts/, needs: ALL },
    { field: "maturity", set: m((x) => (x.maturity = down())), label: /maturity/, needs: ["mint", ...TRADES, ...ADDS, "recombine", "redeem"] },
    {
      field: "oracleFresh",
      set: m((x) => (x.oracleFresh = down())),
      label: /oracle.*fresh/i,
      needs: ["mint", ...TRADES, "add_liquidity_sy", "recombine", "claim_yield"],
    },
    { field: "settledRate", set: m((x) => (x.settledRate = down())), label: /settle/i, needs: ["claim_yield", "redeem"] },
    { field: "ytFrozen", set: m((x) => (x.ytFrozen = down())), label: /frozen/i, needs: ["claim_yield"] },
    { field: "ytAccruedIndex", set: m((x) => (x.ytAccruedIndex = down())), label: /yield index/i, needs: ["claim_yield"] },
    { field: "oracleRate", set: m((x) => (x.oracleRate = down())), label: /oracle rate/i, needs: ["claim_yield"] },
    { field: "fees.ytBps", set: m((x) => (x.fees.ytBps = down())), label: /YT fee/, needs: ["claim_yield"] },
    { field: "exchangeRate", set: m((x) => (x.exchangeRate = down())), label: /exchange rate/i, needs: ["claim_yield", "buy_yt"] },
    { field: "poolSeeded", set: m((x) => (x.poolSeeded = down())), label: /reserves/i, needs: [...TRADES, ...ADDS] },
    { field: "syPaused", set: m((x) => (x.syPaused = down())), label: /SY.*pause/i, needs: ALL },
    { field: "poolPaused", set: m((x) => (x.poolPaused = down())), label: /pool.*pause/i, needs: [...TRADES, ...ADDS, "remove_liquidity"] },
    { field: "riskPaused", set: m((x) => (x.riskPaused = down())), label: /risk.*pause/i, needs: BREAKER },
    { field: "cb.limit", set: m((x) => (x.cb.limit = down())), label: /protocol-wide.*limit/i, needs: BREAKER },
    { field: "cb.volume", set: m((x) => (x.cb.volume = down())), label: /protocol-wide.*volume/i, needs: BREAKER },
    { field: "cb.assetLimit", set: m((x) => (x.cb.assetLimit = down())), label: /per-asset.*limit/i, needs: BREAKER },
    {
      field: "cb.assetVolume (with a per-asset limit set)",
      set: m((x) => {
        x.cb.assetLimit = live(BIG * 10n)
        x.cb.assetVolume = down()
      }),
      label: /per-asset.*volume/i,
      needs: BREAKER,
    },
    { field: "account.underlying", set: a((x) => (x.underlying = down())), label: /underlying balance/i, needs: ["deposit", "mint"] },
    {
      field: "account.sy",
      set: a((x) => (x.sy = down())),
      label: /SY balance/,
      needs: ["withdraw", "buy_pt", "buy_yt", "add_liquidity", "add_liquidity_sy"],
    },
    { field: "account.pt", set: a((x) => (x.pt = down())), label: /PT balance/, needs: ["sell_pt", "add_liquidity", "recombine", "redeem"] },
    { field: "account.yt", set: a((x) => (x.yt = down())), label: /YT balance/, needs: ["sell_yt", "recombine", "redeem", "claim_yield"] },
    { field: "account.lp", set: a((x) => (x.lp = down())), label: /LP balance/, needs: ["remove_liquidity"] },
    { field: "account.ytLastClaimedIndex", set: a((x) => (x.ytLastClaimedIndex = down())), label: /last claim/i, needs: ["claim_yield"] },
    { field: "account.ytPendingClaim", set: a((x) => (x.ytPendingClaim = down())), label: /settled.*yield/i, needs: ["claim_yield"] },
    { field: "account.depositCap", set: a((x) => (x.depositCap = down())), label: /deposit cap/i, needs: ["deposit", "mint"] },
    { field: "account.netDeposited", set: a((x) => (x.netDeposited = down())), label: /net deposits/i, needs: ["deposit", "mint"] },
  ]

  for (const dep of DEPS) {
    describe(dep.field, () => {
      it.each(dep.needs)("blocks %s, naming the field and the cause", (action) => {
        const blockers = gates(action, dep.set)
        expect(blockers).toEqual([{ code: "unavailable", message: expect.stringMatching(dep.label) }])
        expect(blockers[0].message).toContain("RPC rate limited (429)")
      })
      const rest = except(...dep.needs)
      if (rest.length > 0) {
        it.each(rest)("does not block %s, which does not read it", (action) => {
          expect(gates(action, dep.set)).toEqual([])
        })
      }
    })
  }

  it.each([
    ["oracleTimestamp", m((x) => (x.oracleTimestamp = down()))],
    ["totalPt", m((x) => (x.totalPt = down()))],
    ["totalYt", m((x) => (x.totalYt = down()))],
    ["poolState", m((x) => (x.poolState = down()))],
    ["ptPrice", m((x) => (x.ptPrice = down()))],
    ["impliedRate", m((x) => (x.impliedRate = down()))],
    ["lpTotalSupply", m((x) => (x.lpTotalSupply = down()))],
    ["fees.tokenizationBps", m((x) => (x.fees.tokenizationBps = down()))],
    ["fees.swapTierBps", m((x) => (x.fees.swapTierBps = down()))],
    ["fees.protocolShareBps", m((x) => (x.fees.protocolShareBps = down()))],
    ["swapFeeRate", m((x) => (x.swapFeeRate = down()))],
    // Compliance inputs reach the gates through ComplianceItem, never directly.
    ["account.sacAuthorized", a((x) => (x.sacAuthorized = down()))],
    ["account.permAllowed", a((x) => (x.permAllowed = down()))],
    ["account.permPt", a((x) => (x.permPt = down()))],
    ["account.permYt", a((x) => (x.permYt = down()))],
    ["account.trustline", a((x) => (x.trustline = down()))],
    ["account.accountExists", a((x) => (x.accountExists = down()))],
  ] as [string, Mutate][])("an unrelated unavailable field (%s) never blocks", (_, set) => {
    for (const action of ALL) expect(gates(action, set)).toEqual([])
  })

  describe("conditional reads", () => {
    it("remove_liquidity reads maturity only when the pool is paused", () => {
      expect(gates("remove_liquidity", m((x) => (x.maturity = down())))).toEqual([])
      const blockers = gates(
        "remove_liquidity",
        m((x) => {
          x.maturity = down()
          x.poolPaused = live(true)
        }),
      )
      expect(blockers).toEqual([{ code: "unavailable", message: expect.stringMatching(/maturity/) }])
    })

    it("redeem reads oracle freshness only while unsettled and unfrozen (R40)", () => {
      // Settled: neither the freeze nor the freshness is read.
      expect(gates("redeem", m((x) => ((x.oracleFresh = down()), (x.ytFrozen = down()))))).toEqual([])
      // Unsettled but frozen: the freshness is not read.
      expect(gates("redeem", m((x) => ((x.settledRate = live(null)), (x.ytFrozen = live(true)), (x.oracleFresh = down()))))).toEqual([])
      const blockers = gates(
        "redeem",
        m((x) => {
          x.settledRate = live(null)
          x.ytFrozen = live(false)
          x.oracleFresh = down()
        }),
      )
      expect(blockers).toEqual([{ code: "unavailable", message: expect.stringMatching(/oracle.*fresh/i) }])
    })

    it("an unsettled redeem whose freeze cannot be read is refused, naming it (R40, R23)", () => {
      const blockers = gates("redeem", m((x) => ((x.settledRate = live(null)), (x.ytFrozen = down()))))
      expect(blockers).toEqual([{ code: "unavailable", message: expect.stringMatching(/frozen/i) }])
    })

    it("a frozen YT index does not need the live oracle rate to price the claim", () => {
      const set = m((x) => {
        x.ytFrozen = live(true)
        x.oracleRate = down()
      })
      expect(gates("claim_yield", set)).toEqual([])
    })

    it("buy_yt does not read the exchange rate while both breaker limits are 0", () => {
      const set = m((x) => {
        x.cb.limit = live(0n)
        x.cb.assetLimit = live(0n)
        x.exchangeRate = down()
      })
      expect(gates("buy_yt", set)).toEqual([])
    })

    it("the per-asset volume is not read while its limit is 0", () => {
      expect(gates("deposit", m((x) => (x.cb.assetVolume = down())))).toEqual([])
    })

    it("net deposits are not read while the deposit cap is 0", () => {
      const set = a((x) => {
        x.depositCap = live(0n)
        x.netDeposited = down()
      })
      expect(gates("deposit", set)).toEqual([])
      expect(gates("mint", set)).toEqual([])
    })

    it("one unavailable field is reported once even when two rules need it", () => {
      const blockers = gates(
        "remove_liquidity",
        m((x) => {
          x.poolPaused = live(true)
          x.maturity = down()
        }),
      )
      expect(blockers.filter((b) => /maturity/.test(b.message))).toHaveLength(1)
    })
  })

  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])("an unknown ledger time (%s) blocks every maturity-dependent action", (t) => {
    for (const action of ["mint", "buy_pt", "redeem"] as ActionId[]) {
      const blockers = gates(action, (c) => {
        c.ledgerTime = t
      })
      expect(blockers).toEqual([{ code: "unavailable", message: expect.stringMatching(/ledger time/i) }])
    }
    expect(gates("deposit", (c) => (c.ledgerTime = t))).toEqual([])
  })
})

// ---------------------------------------------------------------- Review Focus 4

describe("uses ledger time not browser time", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("blocks buy_pt on maturity when ledgerTime is past maturity though Date.now() is before it", () => {
    vi.useFakeTimers({ now: (MATURITY - 3_600) * 1000 })
    const now = vi.spyOn(Date, "now")
    const blockers = gates("buy_pt", (c) => {
      c.ledgerTime = MATURITY + 60
    })
    expect(codes(blockers)).toEqual(["maturity"])
    expect(now).not.toHaveBeenCalled()
  })

  it("blocks redeem when ledgerTime is before maturity though Date.now() is past it", () => {
    vi.useFakeTimers({ now: (MATURITY + 3_600) * 1000 })
    const now = vi.spyOn(Date, "now")
    const blockers = gates("redeem", (c) => {
      c.ledgerTime = MATURITY - 60
    })
    expect(codes(blockers)).toEqual(["maturity"])
    expect(now).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- order and purity

describe("several failing gates", () => {
  it("are all returned, in the documented order", () => {
    const blockers = gates(
      "mint",
      (c) => {
        c.findings = [{ severity: "error", message: "Duplicate marketId." }]
        c.market.topology = live({ matches: false, mismatches: ["pt"] })
        c.account!.underlying = live(UNIT)
        c.ledgerTime = AFTER
        c.market.oracleFresh = live(false)
        c.market.syPaused = live(true)
        c.compliance = c.compliance.map((i) => (i.id === "perm_yt" ? { ...i, status: "missing", fix: "onboarding" } : i))
        c.market.cb.volume = c.market.cb.limit
        c.account!.depositCap = live(UNIT)
        c.simulation = undefined
        c.market.riskPaused = down()
      },
      { source: OTHER },
    )
    expect(codes(blockers)).toEqual([
      "manifest",
      "topology",
      "wallet",
      "balance",
      "maturity",
      "oracle",
      "pause",
      "compliance",
      "risk",
      "cap",
      "quote",
      "unavailable",
    ])
  })

  it("covers network, amount, pool and archived in the same order", () => {
    const blockers = gates(
      "buy_pt",
      (c) => {
        c.wallet = { status: "wrong_network", publicKey: USER, actualPassphrase: "x", expectedPassphrase: TESTNET }
        c.market.poolSeeded = live(false)
        c.simulation = { ok: false, kind: "restore_required" }
      },
      { amount: 0n },
    )
    expect(codes(blockers)).toEqual(["network", "amount", "pool", "archived"])
  })

  it("puts claim after cap and before quote", () => {
    const blockers = gates("claim_yield", (c) => {
      c.account!.ytPendingClaim = live(0n)
      c.simulation = { ok: false, kind: "rpc_error", message: "timeout" }
    })
    expect(codes(blockers)).toEqual(["claim", "quote"])
  })

  it("BLOCKER_ORDER lists every code once", () => {
    expect(new Set(BLOCKER_ORDER).size).toBe(BLOCKER_ORDER.length)
    expect(BLOCKER_ORDER).toEqual([
      "manifest",
      "topology",
      "disabled",
      "wallet",
      "network",
      "amount",
      "balance",
      "maturity",
      "oracle",
      "pause",
      "pool",
      "compliance",
      "risk",
      "cap",
      "claim",
      "quote",
      "archived",
      "unavailable",
    ])
  })

  it("does not mutate its inputs", () => {
    for (const action of ALL) {
      const ctx = healthyCtx(action)
      ctx.market.oracleFresh = live(false)
      const input = inputFor(action)
      const before = structuredClone({ ctx, input })
      evaluateGates(input, ctx)
      expect({ ctx, input }).toEqual(before)
    }
  })
})
