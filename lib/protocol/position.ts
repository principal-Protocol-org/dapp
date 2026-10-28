/**
 * Pure helpers for the portfolio (spec §7): the entry figures from history, the LP share of the
 * reserves, and the two live reads shared with the redeem panels (pending yield, settlement rate).
 * All amounts are bigint; only the APY is a `number`, for display.
 */
import type { AccountState } from "./account-state"
import type { EntryFacts, HistoryEntry, OracleUpdate } from "./events"
import type { MarketState } from "./market-state"
import { SCALE, aprToApy } from "./math"
import { allLive, liveValue } from "./reader"
import type { Live } from "./types"
import { impliedRateFromPrice, pendingYield, redemptionRate, type PendingYield, type RedemptionRate } from "./yield"

/**
 * The oracle rate at mint: `notional * 1e7 / (sy_shares - fee_shares)`, floored. Null when no SY
 * shares remain after the fee.
 */
export function mintEntryRate(f: NonNullable<EntryFacts["mint"]>): bigint | null {
  const shares = f.syShares - f.feeShares
  return shares > 0n ? (f.notional * SCALE) / shares : null
}

export type Entry =
  | { kind: "mint"; rate: bigint; at: string }
  | { kind: "buy_pt"; /** Simple annual rate at SCALE. */ apr: bigint; /** Compounded over the time left at purchase. */ apy: number; at: string }

const closeSeconds = (at: string): number => Date.parse(at) / 1000

/**
 * The entry figure of the account's most recent qualifying history entry (`entries` newest first):
 * - `mint`: the oracle rate at mint;
 * - `buy_pt`: the fixed APY locked at purchase. The effective price is `sy_in / pt_out` with SY
 *   converted to notional at the last oracle `ref_set` strictly before the event's ledger:
 *   `sy_in * oracle / pt_out` at SCALE, then `impliedRateFromPrice` over the seconds to maturity at
 *   the event's ledger close. Not qualifying (skipped) when no `ref_set` precedes it, when the
 *   price is not positive, or when the event closed at or after maturity.
 * Null when nothing qualifies: the card then says "Accruing since rate X".
 */
export function entryFor(p: { entries: HistoryEntry[]; oracleUpdates: OracleUpdate[]; maturity: bigint }): Entry | null {
  for (const e of p.entries) {
    if (e.kind === "mint" && e.facts?.mint) {
      const rate = mintEntryRate(e.facts.mint)
      if (rate !== null) return { kind: "mint", rate, at: e.at }
    }
    if (e.kind === "buy_pt" && e.facts?.buyPt) {
      const { syIn, ptOut } = e.facts.buyPt
      let ref: OracleUpdate | undefined
      for (const u of p.oracleUpdates) if (u.ledger < e.ledger && (!ref || u.ledger >= ref.ledger)) ref = u
      const seconds = p.maturity - BigInt(Math.floor(closeSeconds(e.at)))
      if (!ref || ptOut <= 0n || seconds <= 0n) continue
      const price = (syIn * ref.value) / ptOut // notional per PT, at SCALE
      if (price <= 0n) continue
      const apr = impliedRateFromPrice(price, seconds)
      return { kind: "buy_pt", apr, apy: aprToApy(apr, seconds), at: e.at }
    }
  }
  return null
}

/** The account's LP share of each reserve: `lp * reserve / total_lp`, floored. Null on an empty pool. */
export function lpShare(p: { lp: bigint; totalLp: bigint; ptReserve: bigint; syReserve: bigint }): { pt: bigint; sy: bigint } | null {
  if (p.totalLp <= 0n) return null
  return { pt: (p.lp * p.ptReserve) / p.totalLp, sy: (p.lp * p.syReserve) / p.totalLp }
}

/**
 * What a claim pays now — and what redeeming any YT pays, since burning YT settles and claims the
 * yield of the whole balance (`principal_manager:514-516`). Once the YT index is frozen the oracle
 * is not needed (nor read), as in the claim gate.
 */
export function pendingOf(ms: MarketState, account: AccountState): Live<PendingYield> {
  const frozen = ms.ytFrozen.status === "live" && ms.ytFrozen.value
  const oracle: Live<bigint> = frozen ? liveValue(SCALE, 0) : ms.oracleRate
  return allLive(
    [account.yt, account.ytLastClaimedIndex, account.ytPendingClaim, ms.ytFrozen, ms.ytAccruedIndex, ms.fees.ytBps, ms.exchangeRate, oracle] as const,
    ([balance, lastClaimedIndex, pendingClaim, ytFrozen, accruedYieldIndex, ytFeeBps, exchangeRate, liveOracleRate]) =>
      pendingYield({ balance, lastClaimedIndex, pendingClaim, liveOracleRate, ytFrozen, accruedYieldIndex, ytFeeBps, exchangeRate }),
  )
}

/** The rate PT redeems at, reading only what the market's state needs (`redemptionRate`). */
export function settlementOf(ms: MarketState): Live<RedemptionRate> {
  const { settledRate, ytFrozen, ytAccruedIndex, oracleRate } = ms
  if (settledRate.status === "unavailable") return settledRate
  if (settledRate.value !== null) return allLive([settledRate] as const, ([rate]) => redemptionRate({ settledRate: rate }))
  if (ytFrozen.status === "live" && ytFrozen.value) {
    return allLive([ytAccruedIndex] as const, ([index]) => redemptionRate({ settledRate: null, ytFrozen: true, accruedYieldIndex: index }))
  }
  return allLive([ytFrozen, ytAccruedIndex, oracleRate] as const, ([frozen, index, live]) =>
    redemptionRate({ settledRate: null, ytFrozen: frozen, accruedYieldIndex: index, liveOracleRate: live }),
  )
}
