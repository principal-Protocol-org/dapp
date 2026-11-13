/**
 * The seed of a new market's pool: the wizard's step 6 (spec 0002 §5, R5-10). Pure and
 * reader-injected, like the rest of `lib/protocol`.
 *
 * The manager types a starting fixed APY and an amount of the underlying. The seed mints part of it
 * into PT + YT (Router `wrap_and_mint`), deposits the rest as SY (`SYWrapper.deposit`), and offers
 * the pool PT and SY in the ratio whose spot price gives that APY (Router `add_liquidity`, the
 * pool's first deposit). The client pipeline refuses a first deposit (`poolGate`), so these three
 * calls are manager calls (`manager-calls.ts` `seedCall`), gated by `firstDepositGate` in its place.
 *
 * The APY is the one the market list shows: the pool's `implied_rate()` (an APR) compounded over the
 * time left (`aprToApy`). The pool prices PT at `(x/y)^(1−a)`, with `x = sy·rate/1e7` and `y = pt`
 * (`market_pool` `spot_price`), and its implied rate is `(1/price − 1)·year/τ`. So the spot price for
 * an APY is `(1 + APY)^(−τ/year)`, and the PT:SY ratio is that price to the power `1/(1−a)`. Both
 * are computed with the curve port's own `pow` (`curve.ts`, the contract's math), and the result is
 * checked with the port's `spotPrice` and `impliedRate`, which read what the pool's views will.
 *
 * The pool's first-deposit rules (`market_pool` `add_liquidity`, total_lp == 0) are checked on the
 * exact integers signed: `ceil(sy·rate/1e7) ≤ pt` (`InvalidInitialRatio`), `isqrt(pt·sy) > 1000`
 * (`MinimumLiquidity`) and a fresh oracle (`assert_fresh_oracle`). R5-10 adds one: PT must be priced
 * strictly below par, or YT can never be bought (the blockchain team's Testnet market m6), so an APY
 * of zero or less is refused, as is any pair whose spot price is at or above par.
 */
import { WAD, impliedRate, isqrt, MathError, MIN_EXPONENT, pow, spotPrice, type CurveState } from "./curve"
import { Gates, type Blocker } from "./gates"
import { minAfterSlippage, parseOutput } from "./guards"
import { seedCall, seedInvocation, type ManagerCall, type NewMarket, type SeedCallKind, type SeedCallParams } from "./manager-calls"
import { parsePoolState, type PoolStateView } from "./market-state"
import { BPS, ceilDiv, SCALE, YEAR_SECONDS } from "./math"
import { previewDeposit, previewMint } from "./previews"
import { readLive, toBigint, toBool, type ContractReader } from "./reader"
import type { ContractInvocation, ScArg, SimulationOutcome } from "./stellar"
import type { Live, Manifest, MarketContracts } from "./types"

/** The LP the pool locks to itself on its first deposit, forever (`market_pool` `MINIMUM_LIQUIDITY`). */
export const MINIMUM_LIQUIDITY = 1_000n

/** The time to maturity and curve exponent of the pool, as its `pool_state()` reports them. */
export type SeedCurve = Pick<CurveState, "secondsToMaturity" | "exponent">

export type SeedInput = {
  /** The starting fixed APY, compounded as the market list shows it, at SCALE (500_000n is 5 %). */
  apy: bigint
  /** The underlying the manager puts in, in its base units: all of it is minted or deposited. */
  amountUnderlying: bigint
  s: SeedCurve
  /** The oracle's reference value at SCALE: PT minted per SY share, and the pool's `rate`. */
  oracleRate: bigint
  /** The SY wrapper's exchange rate at SCALE: underlying per SY share. */
  exchangeRate: bigint
  /** The market's tokenization fee, withheld from the SY before PT and YT are minted. */
  feeBps: bigint
}

/** What the seeded pool's views will read, from the curve port: its spot price, implied rate and the seeder's LP. */
export type SeedOutcome = { ptPrice: bigint; impliedRate: bigint; lp: bigint }

export type SeedPairResult = SeedOutcome & { pt: bigint; sy: bigint }

export type SeedAmounts = SeedPairResult & {
  /** Underlying minted into PT + YT (`wrap_and_mint`); the YT stays with the seeder. */
  mintUnderlying: bigint
  /** Underlying deposited as SY (`deposit`). */
  depositUnderlying: bigint
}

export type SeedRefusal = { error: string }

const SCALE_TO_WAD = WAD / SCALE

const APY_REFUSAL =
  "Enter a starting APY above 0%. At 0% or less the pool prices PT at or above par, and then YT cannot be bought in this market."
const PAR_REFUSAL =
  "This PT and SY would price PT at or above par: the starting APY must be above 0%, or YT cannot be bought in this market. Enter a higher APY."
const SMALL_REFUSAL =
  "The amount is too small: the pool's first deposit must give more than 1,000 units of liquidity (the square root of PT × SY). Enter a larger amount."
const HIGH_REFUSAL = "This starting APY is too high for the pool's curve to price. Enter a lower one."

/** The curve's own checks on the time left: a matured pool cannot be seeded, and the exponent must be one the pool computes. */
function curveProblem(s: SeedCurve): string | undefined {
  if (s.secondsToMaturity <= 0n) return "The market has matured, so its pool cannot be seeded."
  if (s.exponent < MIN_EXPONENT || s.exponent >= WAD) return "The pool's curve cannot price this time to maturity, so the seed cannot be worked out."
  return undefined
}

/**
 * The PT:SY value ratio `x/y` at WAD whose spot price gives `apy` (see the module comment):
 * `(1 + APY)^(−τ/(year·(1−a)))`, the curve exponent `a` being the pool's own. Throws `MathError`
 * when the curve cannot price it.
 */
function targetRatio(apy: bigint, s: SeedCurve): bigint {
  const base = WAD + apy * SCALE_TO_WAD
  // −τ/year/(1−a) at WAD, in one division: the exponent `pow` takes.
  const exponent = -((s.secondsToMaturity * WAD * WAD) / (YEAR_SECONDS * (WAD - s.exponent)))
  return pow(base, exponent)
}

/**
 * The pool's first-deposit rules on exactly `pt` and `sy` at the oracle rate `oracleRate`, and what
 * its views will then read (R5-10: PT strictly below par). The same checks the contract runs, in its
 * order, then the price.
 */
export function firstDepositCheck(p: { pt: bigint; sy: bigint; s: SeedCurve; oracleRate: bigint }): ({ ok: true } & SeedOutcome) | { ok: false; reason: string } {
  const { pt, sy, s, oracleRate: rate } = p
  const curve = curveProblem(s)
  if (curve) return { ok: false, reason: curve }
  if (rate <= 0n) return { ok: false, reason: "The oracle rate is not available, so the seed cannot be checked." }
  if (pt <= 0n || sy <= 0n) return { ok: false, reason: "The pool must be offered both PT and SY." }
  // `InvalidInitialRatio`: the SY's value, rounded up, must not exceed the PT.
  if (ceilDiv(sy * rate, SCALE) > pt) return { ok: false, reason: PAR_REFUSAL }
  const root = isqrt(pt * sy)
  if (root <= MINIMUM_LIQUIDITY) return { ok: false, reason: SMALL_REFUSAL }
  const pool: CurveState = { ptReserve: pt, syReserve: sy, totalLp: root, rate, exponent: s.exponent, feeRate: 0n, secondsToMaturity: s.secondsToMaturity }
  let ptPrice: bigint
  let rateApr: bigint
  try {
    ptPrice = spotPrice(pool)
    rateApr = impliedRate(pool)
  } catch (error) {
    return { ok: false, reason: `The pool's curve cannot price this PT and SY (${error instanceof Error ? error.message : String(error)}).` }
  }
  if (ptPrice >= SCALE || rateApr <= 0n) return { ok: false, reason: PAR_REFUSAL }
  return { ok: true, ptPrice, impliedRate: rateApr, lp: root - MINIMUM_LIQUIDITY }
}

/**
 * The largest PT and SY, at most `maxPt` and `maxSy`, in the ratio whose spot price gives `apy`, and
 * checked by `firstDepositCheck`. Used for the plan (the mint's PT and the deposit's SY) and again
 * when the pool is offered them, at the oracle rate of that moment.
 */
export function seedPair(p: { apy: bigint; maxPt: bigint; maxSy: bigint; s: SeedCurve; oracleRate: bigint }): SeedPairResult | SeedRefusal {
  const { apy, maxPt, maxSy, s, oracleRate: rate } = p
  if (apy <= 0n) return { error: APY_REFUSAL }
  const curve = curveProblem(s)
  if (curve) return { error: curve }
  if (rate <= 0n) return { error: "The oracle rate is not available, so the seed cannot be worked out." }
  let ratio: bigint
  try {
    ratio = targetRatio(apy, s)
  } catch (error) {
    if (error instanceof MathError) return { error: HIGH_REFUSAL }
    throw error
  }
  if (ratio <= 0n) return { error: HIGH_REFUSAL }
  if (ratio >= WAD) return { error: PAR_REFUSAL }
  if (maxPt <= 0n || maxSy <= 0n) return { error: SMALL_REFUSAL }

  // All the PT, and the SY whose value is `ratio` of it (rounded up: its value must reach it).
  let pt = maxPt
  let sy = ceilDiv(((ratio * pt) / WAD) * SCALE, rate)
  if (sy > maxSy) {
    // The SY binds: all of it, and the PT its value prices at `ratio`.
    sy = maxSy
    pt = (((sy * rate) / SCALE) * WAD) / ratio
    if (pt > maxPt) pt = maxPt
  }
  const check = firstDepositCheck({ pt, sy, s, oracleRate: rate })
  if (!check.ok) return { error: check.reason }
  return { pt, sy, ptPrice: check.ptPrice, impliedRate: check.impliedRate, lp: check.lp }
}

/**
 * `seed computes PT and SY from a starting APY` (spec 0002 §5 step 6): how much of the amount is
 * minted and how much deposited, and the PT and SY the pool is offered, within the first-deposit
 * rules. The split puts `amount / (1 + ratio·(1 − fee))` into the mint, so the PT it makes and the SY
 * the rest makes are already in the ratio; the pair is then trimmed to it exactly, and the few raw
 * units left over stay in the wallet.
 */
export function seedAmounts(input: SeedInput): SeedAmounts | SeedRefusal {
  const { apy, amountUnderlying: amount, s, oracleRate: rate, exchangeRate: xr, feeBps } = input
  if (apy <= 0n) return { error: APY_REFUSAL }
  if (amount <= 0n) return { error: "Enter an amount above 0." }
  if (rate <= 0n) return { error: "The oracle rate is not available, so the seed cannot be worked out." }
  if (xr <= 0n) return { error: "The SY exchange rate is not available, so the seed cannot be worked out." }
  if (feeBps < 0n || feeBps >= BPS) return { error: "The market's tokenization fee is out of range, so the seed cannot be worked out." }
  const curve = curveProblem(s)
  if (curve) return { error: curve }

  let ratio: bigint
  try {
    ratio = targetRatio(apy, s)
  } catch (error) {
    if (error instanceof MathError) return { error: HIGH_REFUSAL }
    throw error
  }
  if (ratio <= 0n) return { error: HIGH_REFUSAL }

  // Deposited shares over minted shares: `ratio·(1 − fee)`, at WAD.
  const k = (ratio * (BPS - feeBps)) / BPS
  const mintUnderlying = (amount * WAD) / (WAD + k)
  const depositUnderlying = amount - mintUnderlying
  const minted = previewMint(previewDeposit(mintUnderlying, xr), rate, feeBps).pt
  const deposited = previewDeposit(depositUnderlying, xr)
  if (minted <= 0n || deposited <= 0n) return { error: SMALL_REFUSAL }
  const pair = seedPair({ apy, maxPt: minted, maxSy: deposited, s, oracleRate: rate })
  if ("error" in pair) return pair
  return { ...pair, mintUnderlying, depositUnderlying }
}

/**
 * A seed started before and not finished: the wallet already holds this new market's PT (only a seed
 * mints it before the pool has liquidity). It finishes with that PT: the pool is offered all of it
 * and the SY in the ratio for `apy`; what the SY held does not cover is deposited first, rounded up so
 * the deposit's shares cover it. No new PT is minted, so a retried seed never mints twice.
 */
export function seedResume(p: {
  apy: bigint
  heldPt: bigint
  heldSy: bigint
  s: SeedCurve
  oracleRate: bigint
  exchangeRate: bigint
}): (SeedPairResult & { depositUnderlying: bigint }) | SeedRefusal {
  const { apy, heldPt, heldSy, s, oracleRate, exchangeRate: xr } = p
  if (apy <= 0n) return { error: APY_REFUSAL }
  if (xr <= 0n) return { error: "The SY exchange rate is not available, so the seed cannot be worked out." }
  // The SY the held PT needs: the pair with no cap on the SY side.
  const want = seedPair({ apy, maxPt: heldPt, maxSy: I128_MAX, s, oracleRate })
  if ("error" in want) return want
  const missing = want.sy > heldSy ? want.sy - heldSy : 0n
  const depositUnderlying = missing > 0n ? ceilDiv(missing * xr, SCALE) : 0n
  return { ...want, depositUnderlying }
}

const I128_MAX = (1n << 127n) - 1n

// ---------------------------------------------------------------- the gate in place of poolGate

/** The gate's refusal while nothing has been typed yet: the form says it, not a red line. */
export const SEED_NOT_WORKED_OUT = "The seed has not been worked out yet. Enter a starting APY and an amount."

export type FirstDepositContext = {
  /** The pool's `lp_total_supply()`: a first deposit only while it is 0. */
  totalLp: Live<bigint>
  /** The oracle's `is_available()`: the pool refuses a first deposit without a fresh price. */
  oracleFresh: Live<boolean>
  /** The seed worked out for what the manager typed, or why it is refused; undefined while it is not. */
  amounts: SeedPairResult | SeedRefusal | undefined
}

/**
 * The first-deposit rule in place of `poolGate` (which refuses every pool action on an unseeded
 * pool): the pool is unseeded, the oracle is fresh, and the amounts meet the first-deposit rules
 * (R5-10: PT below par). Pure; an unreadable value blocks.
 */
export function firstDepositGate(ctx: FirstDepositContext): Blocker[] {
  const g = new Gates()
  const totalLp = g.need(ctx.totalLp, "the pool's liquidity supply")
  if (totalLp !== undefined && totalLp > 0n) {
    g.block("pool", "The pool is already seeded: its first deposit has been made, so there is nothing left to seed. Close this; the wizard moves on.")
  }
  const fresh = g.need(ctx.oracleFresh, "whether the oracle price is fresh")
  if (fresh === false) {
    g.block("oracle", "The oracle price is stale, and the pool takes no first deposit without a fresh one. Wait for the next oracle update, then try again.")
  }
  if (ctx.amounts === undefined) g.unverified("amounts", SEED_NOT_WORKED_OUT)
  else if ("error" in ctx.amounts) g.block("amount", ctx.amounts.error)
  return g.result()
}

// ---------------------------------------------------------------- reads

export type SeedReads = {
  /** The unseeded pool's `pool_state()`: time to maturity, exponent and the oracle rate (reserves 0). */
  poolState: Live<PoolStateView>
  oracleFresh: Live<boolean>
  exchangeRate: Live<bigint>
  /** `MarketConfig.tokenization_fee_bps()`. */
  feeBps: Live<bigint>
  /**
   * The signer's PT and SY of this market; absent without a connected wallet. PT held before the pool
   * has liquidity means a seed was started and not finished (`seedResume`). The underlying balance is
   * not read: the issuer's own asset contract mints what it transfers, so the simulation is the check.
   */
  balances?: { pt: Live<bigint>; sy: Live<bigint> }
}

const address = (value: string): ScArg => ({ type: "address", value })

/**
 * What the seed needs from the chain, for the new market's predicted contracts (not in the
 * manifest). `pool_state()` answers on an unseeded pool (it reads the reserves and the oracle, and
 * never asserts the pool is seeded).
 */
export async function readSeedState(
  reader: ContractReader,
  manifest: Manifest,
  predicted: MarketContracts,
  account: string | null,
): Promise<SeedReads> {
  const big = (contractId: string, functionName: string, args?: ScArg[]) => readLive<unknown, bigint>(reader, { contractId, functionName, args }, toBigint)
  const who = account ? [address(account)] : []
  const [poolState, oracleFresh, exchangeRate, feeBps, balances] = await Promise.all([
    readLive<unknown, PoolStateView>(reader, { contractId: predicted.pool, functionName: "pool_state" }, parsePoolState),
    readLive<unknown, boolean>(reader, { contractId: manifest.shared.oracle, functionName: "is_available" }, toBool),
    big(predicted.sy, "exchange_rate"),
    big(predicted.config, "tokenization_fee_bps"),
    account
      ? Promise.all([big(predicted.pt, "balance", who), big(predicted.sy, "balance_of", who)]).then(([pt, sy]) => ({ pt, sy }))
      : Promise.resolve(undefined),
  ])
  return { poolState, oracleFresh, exchangeRate, feeBps, ...(balances ? { balances } : {}) }
}

// ---------------------------------------------------------------- floors from simulation

/** Simulates `invocation` as `source` (`stellar.ts` `simulateInvocation`); injected. */
export type SeedSimulate = (source: string, invocation: ContractInvocation) => Promise<SimulationOutcome>

/** The client action whose return value each seed call shares (`guards.ts` `parseOutput`). */
const OUTPUT_OF: Record<SeedCallKind, "mint" | "deposit" | "add_liquidity"> = {
  seed_mint: "mint",
  seed_deposit: "deposit",
  seed_add_liquidity: "add_liquidity",
}

const WHAT: Record<SeedCallKind, string> = {
  seed_mint: "The mint of PT and YT",
  seed_deposit: "The deposit as SY",
  seed_add_liquidity: "The pool's first deposit",
}

/** The pool's errors a seed can meet (`market_pool` `Error`), in plain words. */
const POOL_ERRORS: Record<number, string> = {
  5: "the pool is paused",
  6: "the market has matured",
  11: "this wallet lacks the PT or SY permission step 5 gives",
  13: "the oracle price is stale",
  15: "the PT and SY would price PT at or above par",
  21: "the PT and SY are too small for the pool's minimum liquidity",
}

function simulationRefusal(kind: SeedCallKind, outcome: Exclude<SimulationOutcome, { ok: true }>, pool: string): string {
  const what = WHAT[kind]
  switch (outcome.kind) {
    case "contract_error": {
      const known = outcome.contractId === pool ? POOL_ERRORS[outcome.code] : undefined
      return known
        ? `${what} was refused by the simulation: ${known}. Nothing was signed.`
        : `${what} was refused by the simulation with contract error #${outcome.code}, so it would fail on chain. Nothing was signed.`
    }
    case "restore_required":
      return `${what} needs archived contract data restored first, which the wizard does not do. Nothing was signed.`
    case "rpc_error":
      return `${what} could not be simulated (${outcome.message}). Nothing was signed; try again in a moment.`
  }
}

/** A seed call's parameters before its floor is known (each variant without its `floor`). */
export type SeedCallInput = SeedCallParams extends infer P ? (P extends unknown ? Omit<P, "floor"> : never) : never

/**
 * A seed call with its floor from its own simulation, just before it is reviewed (0001: floors come
 * only from the exact simulation; never a zero floor). The call is simulated with a zero floor, its
 * return value read as the client action that makes the same call, and the floor is that output less
 * the slippage tolerance: the PT minted, the SY shares, or the LP. Throws in plain words when the
 * simulation refuses or the floor would be zero.
 */
export async function simulatedSeedCall(p: {
  manifest: Manifest
  source: string
  market: NewMarket
  params: SeedCallInput
  simulate: SeedSimulate
  slippageBps: bigint
  /** The new market's pool, to name its errors. */
  pool: string
}): Promise<ManagerCall> {
  const { manifest, source, market, params } = p
  const kind = params.kind
  const open = { ...params, floor: 0n } as SeedCallParams
  const outcome = await p.simulate(source, seedInvocation(manifest, source, market, open))
  if (!outcome.ok) throw new Error(simulationRefusal(kind, outcome, p.pool))
  let out: bigint
  try {
    const parsed = parseOutput(OUTPUT_OF[kind], outcome.retval)
    out = parsed.kind === "mint" ? parsed.pt_minted : parsed.kind === "add_liquidity" ? parsed.lp : parsed.kind === "amount" ? parsed.value : 0n
  } catch (error) {
    throw new Error(`${WHAT[kind]} returned a result this app cannot read (${error instanceof Error ? error.message : String(error)}). Nothing was signed.`)
  }
  const floor = out > 0n ? minAfterSlippage(out, p.slippageBps) : 0n
  if (floor <= 0n) throw new Error(`${WHAT[kind]} is too small for slippage protection, so it is not signed. Enter a larger amount.`)
  return seedCall(manifest, { source, market, ...({ ...params, floor } as SeedCallParams) })
}
