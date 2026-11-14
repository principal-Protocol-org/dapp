/**
 * The protocol overview's read model (D-8, D-9): every market's `MarketState` (reused from
 * `fetchMarketState`) plus TVL from `SYWrapper.total_underlying()`, the underlying held by
 * RecoveryEscrow, the fee recipients, and the protocol totals.
 */
import { getMarket } from "../manifest"
import { fetchMarketState, type MarketState } from "../market-state"
import { SCALE } from "../math"
import { pendingOf } from "../position"
import { tvlOf } from "../rates"
import { allLive, dedupeReads, readLive, toAddress, toBigint, unavailable, type ContractReader } from "../reader"
import { accruedFees } from "../roles"
import type { Live, Manifest, Market } from "../types"
import { poolValueInUnderlying } from "../yield"
import { nameArgs } from "./verify"

/** How the dashboard labels TVL: what it counts, and that escrowed underlying is included. */
export const TVL_LABEL = "Underlying held by the SY wrapper, plus underlying held by RecoveryEscrow (included)"

/** One fee bucket: unclaimed SY shares, and what they are worth in underlying at the SY exchange rate. */
export type FeeBucket = { sy: Live<bigint>; underlying: Live<bigint> }

/**
 * A market's dashboard figures. `syUnderlying` (`SYWrapper.total_underlying()`) and `escrowUnderlying`
 * (the underlying SAC's `balance(escrow)`) come from its `MarketState`: `/app` reads the same two views.
 */
export type MarketDashboard = MarketState & {
  /** TVL (`TVL_LABEL`): `tvlOf`, `syUnderlying + escrowUnderlying`, underlying units; `/app` shows the same figure. Equals `total_underlying` while the escrow is empty. */
  tvl: Live<bigint>
  /** TVL in reference units: `tvl × oracle value / SCALE`. */
  tvlReference: Live<bigint>
  /**
   * Estimated pool value in underlying (`poolValueInUnderlying`, PT at the pool price); 0 while the pool is
   * unseeded, so totals still add up. A view shows an unseeded pool (`poolSeeded` false) as "No liquidity yet".
   */
  liquidity: Live<bigint>
  /**
   * Swap, tokenization and YT fees accrued and not yet claimed: the pool's `accrued_fees` plus the
   * manager's, per bucket. Protocol is paid to the treasury, creator to the creator.
   */
  feeBuckets: { protocol: FeeBucket; creator: FeeBucket }
  feeRecipients: { treasury: Live<string>; creator: Live<string>; protocolAdmin: Live<string> }
}

export type ProtocolState = {
  markets: Record<string, MarketDashboard>
  /** Each total is unavailable when any market's figure is: never a partial sum. */
  totals: { tvl: Live<bigint>; tvlReference: Live<bigint>; liquidity: Live<bigint>; escrowUnderlying: Live<bigint> }
}

function liquidityOf(ms: MarketState): Live<bigint> {
  const { poolSeeded } = ms
  if (poolSeeded.status === "unavailable") return poolSeeded
  if (!poolSeeded.value) return allLive([poolSeeded] as const, () => 0n)
  return allLive([ms.poolState, ms.exchangeRate, ms.ptPrice, ms.oracleRate] as const, ([pool, exchangeRate, ptPrice, oracleRate]) => {
    const value = poolValueInUnderlying({ syReserve: pool.syReserve, ptReserve: pool.ptReserve, exchangeRate, ptPrice, oracleRate })
    if (value === null) throw new Error("the pool value needs a positive exchange rate, PT price and oracle value")
    return value
  })
}

/**
 * One market's dashboard figures: its `MarketState` (`fetchMarketState`, as `/app` reads it), plus the
 * fee buckets and recipients. One batch of parallel reads; a failed read is that figure's Unavailable.
 */
export async function fetchMarketDashboard(reader: ContractReader, manifest: Manifest, market: Market): Promise<MarketDashboard> {
  const c = market.contracts
  const address = (fn: string) => readLive<unknown, string>(reader, { contractId: c.config, functionName: fn }, toAddress)
  const [ms, fees, treasury, creator, protocolAdmin] = await Promise.all([
    fetchMarketState(reader, manifest, market.marketId),
    accruedFees(reader, market),
    address("treasury"),
    address("creator"),
    address("protocol_admin"),
  ])
  const tvl = tvlOf(ms)
  const bucket = (pick: (f: { protocol: bigint; creator: bigint }) => bigint): FeeBucket => {
    const sy = allLive([fees] as const, ([f]) => pick(f))
    // What SYWrapper.withdraw pays for these shares: shares × exchange rate / SCALE, floored.
    return { sy, underlying: allLive([sy, ms.exchangeRate] as const, ([shares, rate]) => (shares * rate) / SCALE) }
  }
  return {
    ...ms,
    tvl,
    tvlReference: allLive([tvl, ms.oracleRate] as const, ([amount, rate]) => (amount * rate) / SCALE),
    liquidity: liquidityOf(ms),
    feeBuckets: { protocol: bucket((f) => f.protocol), creator: bucket((f) => f.creator) },
    feeRecipients: { treasury, creator, protocolAdmin },
  }
}

/**
 * Sums one figure over the markets; unavailable, naming the market, when any is. No markets is
 * unavailable too: an empty sum has no read behind it, so it is no live 0.
 */
function total(markets: [string, Live<bigint>][], refuse?: string): Live<bigint> {
  if (markets.length === 0) return unavailable("no markets")
  if (refuse) return unavailable(refuse)
  for (const [id, live] of markets) if (live.status === "unavailable") return unavailable(`${id}: ${live.error}`)
  return allLive(
    markets.map(([, live]) => live),
    (values) => values.reduce((sum: bigint, v) => sum + v, 0n),
  )
}

/**
 * The dashboard's figures for `marketIds` (manifest market ids; an unknown id throws, as in
 * `fetchMarketState`). Amount totals add underlying units, so they are unavailable when the
 * markets hold different underlyings; the reference total needs only equal decimals.
 */
export async function fetchProtocolState(reader: ContractReader, manifest: Manifest, marketIds: readonly string[]): Promise<ProtocolState> {
  const markets = marketIds.map((id) => {
    const market = getMarket(manifest, id)
    if (!market) throw new Error(`Unknown market "${id}"`)
    return market
  })
  // One sweep per refresh: each market's views once, and the views of contracts the markets share
  // (oracle, RiskControl) once in all, not once per market (Review Focus 5).
  const sweep = dedupeReads(reader)
  const dashboards = await Promise.all(markets.map((market) => fetchMarketDashboard(sweep, manifest, market)))
  const byId = Object.fromEntries(markets.map((market, i) => [market.marketId, dashboards[i]]))

  const pick = (f: (d: MarketDashboard) => Live<bigint>): [string, Live<bigint>][] =>
    markets.map((market, i) => [market.marketId, f(dashboards[i])])
  const mixedUnderlying =
    new Set(markets.map((m) => m.underlying.sac)).size > 1
      ? "the markets hold different underlying assets, so their amounts do not add up; see the reference value"
      : undefined
  const mixedDecimals =
    new Set(markets.map((m) => m.underlying.decimals)).size > 1 ? "the markets' underlying assets use different decimals" : undefined

  return {
    markets: byId,
    totals: {
      tvl: total(pick((d) => d.tvl), mixedUnderlying),
      tvlReference: total(pick((d) => d.tvlReference), mixedDecimals),
      liquidity: total(pick((d) => d.liquidity), mixedUnderlying),
      escrowUnderlying: total(pick((d) => d.escrowUnderlying), mixedUnderlying),
    },
  }
}

/**
 * What `account` (any `G…` or `C…` address) would be paid by claiming its YT yield now, net of the
 * YT fee: the figure `/app` shows (`pendingOf`, `pendingYield`), from the account's three YT reads
 * and the market's state. Unavailable for an invalid address (nothing is read) or when any input is.
 *
 * Takes the market and its state rather than the YT id alone: the net needs the YT fee, the SY
 * exchange rate and the oracle value, which the YT contract does not expose.
 */
export async function pendingClaim(
  reader: ContractReader,
  market: Market,
  account: string,
  ms: Pick<MarketState, "ytFrozen" | "ytAccruedIndex" | "fees" | "exchangeRate" | "oracleRate">,
): Promise<Live<bigint>> {
  try {
    toAddress(account)
  } catch {
    return unavailable(`"${account}" is not a valid Stellar address (G… or C…)`)
  }
  const yt = market.contracts.yt
  const read = (fn: string) =>
    readLive<unknown, bigint>(reader, { contractId: yt, functionName: fn, args: [{ type: "address", value: account }] }, toBigint).then(
      (live) => nameArgs(live, ["account"]),
    )
  const [balance, ytLastClaimedIndex, ytPendingClaim] = await Promise.all([read("balance"), read("last_claimed_index"), read("pending_claim")])
  const pending = pendingOf(ms, { yt: balance, ytLastClaimedIndex, ytPendingClaim })
  return allLive([pending] as const, ([p]) => p.net)
}
