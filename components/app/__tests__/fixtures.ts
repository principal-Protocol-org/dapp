import type { AccountState } from "@/lib/protocol/account-state"
import type { MarketState } from "@/lib/protocol/market-state"
import type { Live } from "@/lib/protocol/types"

export const live = <T,>(value: T): Live<T> => ({ status: "live", value, ledger: 100 })
export const down = (error = "rpc down"): Live<never> => ({ status: "unavailable", error })

export const MATURITY = 1_800_000_000n
export const LEDGER_TIME = Number(MATURITY) - 10 * 86400 // ten days before maturity

export function marketState(over: Partial<MarketState> = {}): MarketState {
  return {
    oracleRate: live(10_500_000n),
    oracleTimestamp: live(BigInt(LEDGER_TIME - 600)),
    oracleFresh: live(true),
    maturity: live(MATURITY),
    settledRate: live<bigint | null>(null),
    ytFrozen: live(false),
    ytAccruedIndex: live(10n ** 12n),
    totalPt: live(5_000_000_000n),
    totalYt: live(5_000_000_000n),
    poolState: live({
      ptReserve: 12_000_000_000n,
      syReserve: 34_000_000_000n,
      totalLp: 1n,
      rate: 1n,
      exponent: 1n,
      feeRate: 1n,
      secondsToMaturity: 864000n,
    }),
    poolSeeded: live(true),
    ptPrice: live(9_800_000n),
    impliedRate: live(500_000n),
    lpTotalSupply: live(1n),
    fees: { tokenizationBps: live(0n), ytBps: live(0n), swapTierBps: live(0n), protocolShareBps: live(0n) },
    swapFeeRate: live(0n),
    exchangeRate: live(10_000_000n),
    syPaused: live(false),
    poolPaused: live(false),
    riskPaused: live(false),
    cb: {
      limit: live(1_000_000_000_000n),
      volume: live(250_000_000_000n),
      assetLimit: live(0n),
      assetVolume: live(0n),
    },
    topology: live({ matches: true, mismatches: [] }),
    ...over,
  }
}

export function accountState(over: Partial<AccountState> = {}): AccountState {
  return {
    underlying: live(0n),
    sy: live(0n),
    pt: live(0n),
    yt: live(0n),
    lp: live(0n),
    ytLastClaimedIndex: live(0n),
    ytPendingClaim: live(0n),
    depositCap: live(100_000_000_000n),
    netDeposited: live(40_000_000_000n),
    sacAuthorized: live(true),
    sep57: null,
    permAllowed: live(true),
    permPt: live(true),
    permYt: live(false),
    trustline: live("authorized"),
    accountExists: live(true),
    ...over,
  }
}
