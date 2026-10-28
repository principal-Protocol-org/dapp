/**
 * The gates of spec §5: whether the user may sign an action, decided from already-fetched state.
 *
 * Pure: no I/O and no clock. Time is `ctx.ledgerTime` (the latest ledger close time, seconds), never
 * the browser's. Every refusal is a plain-words `Blocker`; an empty list is the only "yes".
 * Anything that cannot be verified refuses: an unavailable read the action needs becomes an
 * `unavailable` blocker naming it (R23); reads the action does not need are never looked at.
 *
 * Ported from `dapp-old/src/lib/safety.ts` (`fetchSafetyBlockers`) and
 * `dapp-old/src/lib/transactions.ts` (`getPreflightBlockers`), which did their own reads; here the
 * reads come in through `MarketState`, `AccountState` and the compliance items. Contract line
 * references are to `principal` `origin/feat/tranche-1-mvp` (ABI pin `6cf257a`).
 */
import type { AccountState } from "./account-state"
import type { ActionId, ActionInput } from "./actions"
import type { ComplianceItem } from "./compliance"
import { formatAmount } from "./format"
import type { MarketState } from "./market-state"
import { SCALE } from "./math"
import type { SimulationOutcome } from "./stellar"
import type { Finding, Live, WalletState } from "./types"
import { pendingYield } from "./yield"

/**
 * Blocker codes, in the order `evaluateGates` returns them. The UI shows the first prominently.
 * `pool` (unseeded pool) and `claim` (nothing to claim) extend the plan's list.
 */
export const BLOCKER_ORDER = [
  "manifest",
  "topology",
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
] as const

export type BlockerCode = (typeof BLOCKER_ORDER)[number]

export type Blocker = { code: BlockerCode; message: string; fix?: ComplianceItem["fix"] }

export type GateContext = {
  /** `validateManifest` output: any `error` blocks everything. */
  findings: Finding[]
  wallet: WalletState
  market: MarketState
  /** The connected account's state; absent until it has been read. */
  account?: AccountState
  /** `evaluateAccountCompliance(account, kind)` for this market (R7). */
  compliance: ComplianceItem[]
  /** Close time of the latest ledger, plus the seconds since it was read. Seconds. */
  ledgerTime: number
  /** The simulation of this exact input as the user; absent until it has run. */
  simulation?: SimulationOutcome
  /** The market's PrincipalManager: its `Error(Contract, #9)` is `Paused`. */
  managerId: string
}

/** Token decimals: every Principal token, and the release's underlying, use 7. */
const DECIMALS = 7

/** `PrincipalManager` `Error::Paused` (`principal_manager/src/lib.rs:203`). */
const MANAGER_PAUSED_CODE = 9

const TRADES: readonly ActionId[] = ["buy_pt", "sell_pt", "buy_yt", "sell_yt"]
const ADDS: readonly ActionId[] = ["add_liquidity", "add_liquidity_sy"]

/** Closed at maturity: `assert_not_mature` (manager) and `assert_active` (pool, :1032-1037). */
const BEFORE_MATURITY_ONLY = new Set<ActionId>(["mint", ...TRADES, ...ADDS, "recombine"])
/** Need `is_fresh(3600)` always. Claim and redeem need it only until settlement (see `oracleGate`). */
const NEEDS_FRESH_ORACLE = new Set<ActionId>(["mint", ...TRADES, "add_liquidity_sy", "recombine"])
/** Go through the pool's reserves: `assert_seeded` panics on an empty pool (`market_pool:930-935`). */
const USES_POOL = new Set<ActionId>([...TRADES, ...ADDS])
/** Call `RiskControl.check_deposit`, which refuses while RiskControl is paused. */
const RISK_CHECKED = new Set<ActionId>(["deposit", "mint", "buy_yt"])
/** Call `PrincipalManager` entry points that `assert_not_paused`: mint, recombine, redeem, claim. */
const MANAGER_PAUSABLE = new Set<ActionId>(["mint", "buy_yt", "sell_yt", "recombine", "claim_yield", "redeem"])
/** Charge `SYWrapper.deposit`'s per-address cap (wrap_and_mint deposits first). */
const DEPOSIT_CAPPED = new Set<ActionId>(["deposit", "mint"])
/** R22: compliance items every write needs (all protocol writes are SAC- and Permissioning-gated). */
const EVERY_WRITE_ITEMS: readonly ComplianceItem["id"][] = ["account", "trustline", "authorized", "permissioning"]
/**
 * R22b: actions that move PT / YT to or from the account need its per-asset grant. PT/YT `mint`
 * and `transfer` check `is_allowed_for_asset` on the recipient and the sender (pt_token:189-195,
 * :427; yt_token:282-285). Buy YT mints PT and sells it (router:347, market_pool:329); sell PT,
 * two-sided add (market_pool:446) and sell YT (:363) send PT/YT; the zap can refund PT
 * (:499-502). Recombine and redeem only burn, with no per-asset check.
 */
const NEEDS_PT_GRANT = new Set<ActionId>([
  "mint",
  "buy_pt",
  "buy_yt",
  "sell_pt",
  "add_liquidity",
  "add_liquidity_sy",
  "remove_liquidity",
])
const NEEDS_YT_GRANT = new Set<ActionId>(["mint", "buy_yt", "sell_yt"])

const ITEM_LABEL: Record<ComplianceItem["id"], string> = {
  account: "account",
  trustline: "trustline",
  authorized: "issuer authorization",
  permissioning: "Principal permissioning",
  perm_pt: "PT permissioning",
  perm_yt: "YT permissioning",
}

const fmt = (raw: bigint) => formatAmount(raw, DECIMALS, DECIMALS)
const max0 = (value: bigint) => (value > 0n ? value : 0n)

/** Collects blockers; `need` turns an unavailable read into one deduplicated `unavailable` blocker. */
class Gates {
  private readonly out: Blocker[] = []
  private readonly missing = new Set<string>()

  block(code: BlockerCode, message: string, fix?: ComplianceItem["fix"]): void {
    this.out.push(fix ? { code, message, fix } : { code, message })
  }

  /** Refuses once per `key` because something needed could not be verified. */
  unverified(key: string, message: string): void {
    if (this.missing.has(key)) return
    this.missing.add(key)
    this.block("unavailable", message)
  }

  /** The value of a read this action needs, or `undefined` after recording why it is missing. */
  need<T>(value: Live<T>, what: string): T | undefined {
    if (value.status === "live") return value.value
    this.unverified(what, `Could not read ${what} (${value.error}). Signing stays off until it can be checked; try again in a moment.`)
    return undefined
  }

  /** Stable sort: rule order within a code, `BLOCKER_ORDER` across codes. */
  result(): Blocker[] {
    const rank = (b: Blocker) => BLOCKER_ORDER.indexOf(b.code)
    return [...this.out].sort((a, b) => rank(a) - rank(b))
  }
}

/** Ledger time as whole seconds, or `undefined` (recorded) when it is not a usable time. */
function ledgerNow(ctx: GateContext, g: Gates): bigint | undefined {
  const t = ctx.ledgerTime
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
    g.unverified("ledger time", "Could not read the latest ledger time, so maturity cannot be checked. Signing stays off until it loads; try again in a moment.")
    return undefined
  }
  return BigInt(Math.floor(t))
}

/** On-chain maturity is `timestamp >= maturity` (`principal_manager:942,953`, `market_pool:1034`). */
function isMatured(ctx: GateContext, g: Gates): boolean | undefined {
  const maturity = g.need(ctx.market.maturity, "the market's maturity")
  const now = ledgerNow(ctx, g)
  if (maturity === undefined || now === undefined) return undefined
  return now >= maturity
}

function isManagerPause(action: ActionId, ctx: GateContext): boolean {
  const s = ctx.simulation
  return (
    MANAGER_PAUSABLE.has(action) &&
    s !== undefined &&
    !s.ok &&
    s.kind === "contract_error" &&
    s.code === MANAGER_PAUSED_CODE &&
    s.contractId === ctx.managerId
  )
}

function manifestGate(ctx: GateContext, g: Gates): void {
  const errors = ctx.findings.filter((f) => f.severity === "error")
  if (errors.length === 0) return
  g.block(
    "manifest",
    `The deployment manifest for this network is invalid, so signing is off until it is fixed: ${errors.map((e) => e.message).join("; ")}`,
  )
}

function topologyGate(ctx: GateContext, g: Gates): void {
  const topology = g.need(ctx.market.topology, "the on-chain check of this market's contracts")
  if (!topology || (topology.matches && topology.mismatches.length === 0)) return
  const which = topology.mismatches.length > 0 ? topology.mismatches.join(", ") : "unknown fields"
  g.block(
    "topology",
    `This market's contracts in the manifest do not match the chain (${which}). Signing is off for this market until the manifest is corrected.`,
  )
}

/** Returns true when a wallet is connected, i.e. there is an account to check. */
function walletGate(input: ActionInput, ctx: GateContext, g: Gates): boolean {
  const w = ctx.wallet
  switch (w.status) {
    case "connected":
      if (w.publicKey !== input.source) {
        g.block(
          "wallet",
          "This action was prepared for a different account than the one connected in Freighter. Enter it again so it is prepared for the connected account.",
        )
      }
      return true
    case "wrong_network":
      g.block(
        "network",
        `Freighter is on a different network from this market. Switch Freighter to the network "${w.expectedPassphrase}", then try again.`,
      )
      return false
    case "unverified_network":
      g.block("wallet", `Freighter's network could not be verified (${w.reason}). Reconnect Freighter to sign.`)
      return false
    case "not_installed":
      g.block("wallet", "Freighter is not installed. Install the Freighter browser extension, then connect it to sign.")
      return false
    case "locked":
      g.block("wallet", "Freighter is locked. Unlock it, then connect to sign.")
      return false
    case "connecting":
      g.block("wallet", "Freighter is still connecting. Approve the connection in Freighter to sign.")
      return false
    case "rejected":
      g.block("wallet", `Freighter did not connect (${w.reason}). Connect Freighter to sign.`)
      return false
    case "disconnected":
      g.block("wallet", "No wallet is connected. Connect Freighter to sign.")
      return false
  }
}

function amountGate(input: ActionInput, g: Gates): void {
  switch (input.action) {
    case "claim_yield":
      // Claim takes no amount; whether there is anything to claim is `claimGate`.
      return
    case "redeem": {
      // redeem(pt_amount, yt_amount): neither negative, not both zero (principal_manager:486-488).
      const pt = input.amount
      const yt = input.secondaryAmount ?? 0n
      if (pt < 0n || yt < 0n || pt + yt === 0n) g.block("amount", "Enter an amount of PT or YT to redeem, greater than zero.")
      return
    }
    case "add_liquidity":
      if (input.amount <= 0n) g.block("amount", "Enter a PT amount greater than zero.")
      if ((input.secondaryAmount ?? 0n) <= 0n) {
        g.block("amount", "Enter an SY amount greater than zero: adding liquidity takes both PT and SY.")
      }
      return
    default:
      if (input.amount <= 0n) g.block("amount", "Enter an amount greater than zero.")
  }
}

type Holding = { live: Live<bigint>; what: string; name: string; unit: string; need: bigint }

/** R24: which balance each action spends. */
function holdings(input: ActionInput, acc: AccountState): Holding[] {
  const amount = input.amount
  const second = input.secondaryAmount ?? 0n
  const underlying = (need: bigint): Holding => ({ live: acc.underlying, what: "your underlying balance", name: "the underlying asset", unit: "", need })
  const sy = (need: bigint): Holding => ({ live: acc.sy, what: "your SY balance", name: "SY", unit: " SY", need })
  const pt = (need: bigint): Holding => ({ live: acc.pt, what: "your PT balance", name: "PT", unit: " PT", need })
  const yt = (need: bigint): Holding => ({ live: acc.yt, what: "your YT balance", name: "YT", unit: " YT", need })
  const lp = (need: bigint): Holding => ({ live: acc.lp, what: "your LP balance", name: "LP tokens", unit: " LP", need })
  switch (input.action) {
    case "deposit":
    case "mint":
      return [underlying(amount)]
    case "withdraw":
    case "buy_pt":
    case "buy_yt":
    case "add_liquidity_sy":
      return [sy(amount)]
    case "sell_pt":
      return [pt(amount)]
    case "sell_yt":
      return [yt(amount)]
    case "add_liquidity":
      return [pt(amount), sy(second)]
    case "remove_liquidity":
      return [lp(amount)]
    case "recombine":
      return [pt(amount), yt(amount)]
    case "redeem":
      return [pt(amount), yt(second)]
    case "claim_yield":
      return []
  }
}

function balanceGate(input: ActionInput, acc: AccountState, g: Gates): void {
  for (const h of holdings(input, acc)) {
    // A non-positive amount is the amount gate's refusal, or (redeem) a side that is not spent.
    if (h.need <= 0n) continue
    const have = g.need(h.live, h.what)
    if (have !== undefined && have < h.need) {
      g.block(
        "balance",
        `Not enough ${h.name}: you have ${fmt(have)}${h.unit} and this needs ${fmt(h.need)}${h.unit}. Lower the amount.`,
      )
    }
  }
}

function maturityGate(input: ActionInput, ctx: GateContext, g: Gates): void {
  const closesAtMaturity = BEFORE_MATURITY_ONLY.has(input.action)
  const opensAtMaturity = input.action === "redeem"
  if (!closesAtMaturity && !opensAtMaturity) return
  const matured = isMatured(ctx, g)
  if (matured === undefined) return
  if (closesAtMaturity && matured) {
    g.block(
      "maturity",
      TRADES.includes(input.action)
        ? "Trading closed at maturity: this market has matured, so PT and YT can no longer be bought or sold in the pool. You can still redeem, claim yield, remove liquidity and withdraw SY."
        : "This market has matured: minting, trading, adding liquidity and recombining are closed. You can still redeem, claim yield, remove liquidity and withdraw SY.",
    )
  }
  if (opensAtMaturity && !matured) {
    g.block("maturity", "Redemption opens at maturity. Until then you can recombine PT with YT, or sell them in the pool.")
  }
}

function oracleGate(input: ActionInput, ctx: GateContext, g: Gates): void {
  const m = ctx.market
  const a = input.action
  let needsFresh = NEEDS_FRESH_ORACLE.has(a)
  let why = ""
  if (a === "claim_yield" || a === "redeem") {
    // claim: `assert_oracle_fresh_unless_frozen` (principal_manager:858-863) skips the check only
    // once the settlement rate is stored, which also freezes the YT index. A YT index frozen by an
    // `update_yield_index` without settlement still needs a fresh oracle. redeem: the first
    // redemption settles the market, which needs a fresh price (`settle`, :746, :851).
    const settled = g.need(m.settledRate, "whether the market is settled")
    if (settled === undefined) return
    needsFresh = settled === null
    why =
      a === "redeem"
        ? " The first redemption settles the market, which needs a fresh price."
        : " Claiming needs a fresh price until the market is settled."
  }
  if (!needsFresh) return
  const fresh = g.need(m.oracleFresh, "the oracle's freshness")
  if (fresh === false) {
    g.block(
      "oracle",
      `The oracle price is stale: it has not been updated in the last hour (the protocol accepts prices up to 3600 s old).${why} Wait for the next oracle update, then try again.`,
    )
  }
}

function pauseGate(input: ActionInput, ctx: GateContext, g: Gates): void {
  const m = ctx.market
  const a = input.action

  // Every action moves SY: deposit/withdraw directly; mint, trades, adds, remove and recombine
  // transfer it; claim and redeem pay through SYWrapper.withdraw (sy_wrapper:177-179, :284, :209).
  if (g.need(m.syPaused, "the SY wrapper's pause state") === true) {
    g.block(
      "pause",
      "The SY wrapper is paused, so nothing that moves SY can run: deposits, withdrawals, minting, trading, liquidity, recombining, claims and redemptions all wait until it is unpaused.",
    )
  }

  if (USES_POOL.has(a) || a === "remove_liquidity") {
    if (g.need(m.poolPaused, "the pool's pause state") === true) {
      if (a !== "remove_liquidity") {
        g.block("pause", "The pool is paused: trading and adding liquidity are stopped until it is unpaused.")
      } else if (isMatured(ctx, g) === false) {
        // The pool pause never holds LPs in after maturity (market_pool:522-526).
        g.block("pause", "The pool is paused: removing liquidity reopens at maturity, or sooner if the pool is unpaused.")
      }
    }
  }

  if (RISK_CHECKED.has(a) && g.need(m.riskPaused, "risk control's pause state") === true) {
    g.block("pause", "Risk control is paused: depositing, minting and buying YT are stopped until it is unpaused.")
  }

  if (isManagerPause(a, ctx)) {
    g.block(
      "pause",
      "PrincipalManager is paused: minting, buying and selling YT, recombining, claiming and redeeming are stopped until it is unpaused.",
    )
  }
}

function poolGate(input: ActionInput, ctx: GateContext, g: Gates): void {
  if (!USES_POOL.has(input.action)) return
  if (g.need(ctx.market.poolSeeded, "the pool reserves") === false) {
    g.block(
      "pool",
      "Pool not seeded yet: trading and adding liquidity open once the pool has its first liquidity. This app does not offer that first deposit.",
    )
  }
}

function complianceGate(input: ActionInput, ctx: GateContext, g: Gates): void {
  const items = ctx.compliance
  if (items.length === 0) {
    g.unverified("compliance", "Your compliance checks have not run yet, so this cannot be allowed. Wait for them to load.")
    return
  }
  const ids = [...EVERY_WRITE_ITEMS]
  if (NEEDS_PT_GRANT.has(input.action)) ids.push("perm_pt")
  if (NEEDS_YT_GRANT.has(input.action)) ids.push("perm_yt")
  for (const id of ids) {
    const found = items.find((i) => i.id === id)
    if (!found) {
      g.unverified(`compliance:${id}`, `The ${ITEM_LABEL[id]} check has not run yet, so this cannot be allowed. Wait for it to load.`)
    } else if (found.status === "unavailable") {
      g.unverified(`compliance:${id}`, found.message)
    } else if (found.status !== "ok") {
      g.block("compliance", found.message, found.fix)
    }
  }
}

/**
 * `RiskControl.check_deposit` (risk_control:233-290): each limit trips on `volume + amount > limit`;
 * a limit of 0 disables it. wrap_and_mint reports twice (SYWrapper.deposit, then
 * PrincipalManager.mint); swap_sy_for_yt once, from mint, at the SY's underlying value
 * (principal_manager:363-368). `2·amount` bounds the mint leg (`floor(floor(a/r)·r) <= a`) from above.
 */
function breakerGate(input: ActionInput, ctx: GateContext, g: Gates): void {
  const a = input.action
  if (!RISK_CHECKED.has(a) || input.amount <= 0n) return
  const cb = ctx.market.cb
  const amount = input.amount

  let reported: bigint | null | undefined = null // null: not computed yet; undefined: unavailable
  const report = (): bigint | undefined => {
    if (reported !== null) return reported
    if (a === "deposit") reported = amount
    else if (a === "mint") reported = 2n * amount
    else {
      const rate = g.need(ctx.market.exchangeRate, "the SY exchange rate")
      const value = rate === undefined ? undefined : (amount * rate) / SCALE
      reported = value === undefined ? undefined : value > 0n ? value : amount
    }
    return reported
  }

  const check = (limitLive: Live<bigint>, volumeLive: Live<bigint>, scope: "protocol-wide" | "per-asset") => {
    const limit = g.need(limitLive, `the ${scope} deposit limit`)
    if (limit === undefined || limit <= 0n) return
    const volume = g.need(volumeLive, `the ${scope} deposit volume`)
    if (volume === undefined) return
    const adds = report()
    if (adds === undefined || volume + adds <= limit) return
    const twice = a === "mint" ? " Minting from the underlying counts twice against it (the deposit and the mint)." : ""
    g.block(
      "risk",
      `This would trip the ${scope} circuit breaker: ${fmt(volume)} of its ${fmt(limit)} limit is already used in the current window and this adds ${fmt(adds)}.${twice} Room left: ${fmt(max0(limit - volume))}. Lower the amount or wait for the window to reset.`,
    )
  }

  check(cb.limit, cb.volume, "protocol-wide")
  check(cb.assetLimit, cb.assetVolume, "per-asset")
}

/** `SYWrapper.charge_deposit_cap` (sy_wrapper:636-650): `net + amount > cap`, a cap of 0 disables it. */
function capGate(input: ActionInput, acc: AccountState, g: Gates): void {
  if (!DEPOSIT_CAPPED.has(input.action) || input.amount <= 0n) return
  const cap = g.need(acc.depositCap, "the deposit cap")
  if (cap === undefined || cap <= 0n) return
  const net = g.need(acc.netDeposited, "your net deposits")
  if (net === undefined || net + input.amount <= cap) return
  g.block(
    "cap",
    `This would pass your deposit cap: you have ${fmt(net)} deposited (net of withdrawals) of the ${fmt(cap)} allowed, so at most ${fmt(max0(cap - net))} more fits. Lower the amount.`,
  )
}

/** The contract accepts a zero claim and pays nothing (principal_manager:769-771): refuse it here. */
function claimGate(input: ActionInput, ctx: GateContext, acc: AccountState, g: Gates): void {
  if (input.action !== "claim_yield") return
  const m = ctx.market
  const balance = g.need(acc.yt, "your YT balance")
  const lastClaimedIndex = g.need(acc.ytLastClaimedIndex, "your YT index at your last claim")
  const pendingClaim = g.need(acc.ytPendingClaim, "your settled, unclaimed yield")
  const ytFrozen = g.need(m.ytFrozen, "whether the YT yield index is frozen")
  const accruedYieldIndex = g.need(m.ytAccruedIndex, "the YT yield index")
  const ytFeeBps = g.need(m.fees.ytBps, "the YT fee")
  const exchangeRate = g.need(m.exchangeRate, "the SY exchange rate")
  // Once frozen the index ignores the oracle, so the live rate is not needed (and not read).
  const liveOracleRate = ytFrozen === false ? g.need(m.oracleRate, "the oracle rate") : SCALE
  if (
    balance === undefined ||
    lastClaimedIndex === undefined ||
    pendingClaim === undefined ||
    ytFrozen === undefined ||
    accruedYieldIndex === undefined ||
    ytFeeBps === undefined ||
    exchangeRate === undefined ||
    liveOracleRate === undefined
  ) {
    return
  }
  let net: bigint
  try {
    net = pendingYield({ balance, lastClaimedIndex, pendingClaim, liveOracleRate, ytFrozen, accruedYieldIndex, ytFeeBps, exchangeRate }).net
  } catch (error) {
    g.unverified("pending yield", `Could not work out your pending yield (${error instanceof Error ? error.message : String(error)}). Signing stays off.`)
    return
  }
  if (net <= 0n) {
    g.block(
      "claim",
      "Nothing to claim yet: your YT has not earned yield since your last claim, after the YT fee. Yield accrues as the oracle rate rises.",
    )
  }
}

/**
 * R28: every action needs an ok simulation, claim and redeem included: the PrincipalManager pause
 * and archived entries are only known from one.
 */
function simulationGate(input: ActionInput, ctx: GateContext, g: Gates): void {
  const s = ctx.simulation
  if (s === undefined) {
    g.block("quote", "Waiting for an exact quote: this transaction has not been simulated yet. Signing turns on once the simulation returns.")
    return
  }
  if (s.ok) return
  switch (s.kind) {
    case "restore_required":
      g.block("archived", "Some contract data has expired — restore it first. Sign the restore transaction, then this action is prepared again.")
      return
    case "contract_error":
      if (isManagerPause(input.action, ctx)) return // reported by pauseGate
      g.block(
        "quote",
        `The simulation was refused with contract error #${s.code}, so there is no exact quote and this would fail on-chain. Check the amount and any reason listed above, then try again.`,
      )
      return
    case "rpc_error":
      g.block("quote", `The simulation could not run (${s.message}), so there is no exact quote. Try again in a moment.`)
      return
    default: {
      // A new failure kind fails typecheck here and still refuses at runtime.
      const unknown: never = s
      g.block(
        "quote",
        `The simulation failed in a way this app does not recognize (${String((unknown as { kind?: unknown }).kind)}), so there is no exact quote. Try again in a moment.`,
      )
    }
  }
}

/**
 * Every reason the user may not sign `input` now, in `BLOCKER_ORDER`. Empty means every gate of
 * spec §5 passes. Without a connected wallet only the wallet refusal is reported for the
 * account-dependent gates (balance, compliance, cap, claim): there is no account to check.
 */
export function evaluateGates(input: ActionInput, ctx: GateContext): Blocker[] {
  const g = new Gates()
  manifestGate(ctx, g)
  topologyGate(ctx, g)
  const connected = walletGate(input, ctx, g)
  amountGate(input, g)
  maturityGate(input, ctx, g)
  oracleGate(input, ctx, g)
  pauseGate(input, ctx, g)
  poolGate(input, ctx, g)
  breakerGate(input, ctx, g)
  if (connected) {
    complianceGate(input, ctx, g)
    const acc = ctx.account
    if (acc === undefined) {
      g.unverified("account", "Your account (balances and deposit cap) has not been read yet, so this cannot be checked. Wait for it to load.")
    } else {
      balanceGate(input, acc, g)
      capGate(input, acc, g)
      claimGate(input, ctx, acc, g)
    }
  }
  simulationGate(input, ctx, g)
  return g.result()
}
