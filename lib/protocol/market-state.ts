import { allLive, readLive, toBigint, toBool, unavailable, type ContractReader } from "./reader"
import { getMarket } from "./manifest"
import type { Live, Manifest } from "./types"

/** The oracle freshness window the protocol hardcodes on-chain (seconds). */
export const ORACLE_MAX_STALE_SECONDS = 3600

export type PoolStateView = {
  ptReserve: bigint
  syReserve: bigint
  totalLp: bigint
  rate: bigint
  exponent: bigint
  feeRate: bigint
  secondsToMaturity: bigint
}

export type Topology = { matches: boolean; mismatches: string[] }

export type MarketState = {
  oracleRate: Live<bigint>
  oracleTimestamp: Live<bigint>
  oracleFresh: Live<boolean>
  maturity: Live<bigint>
  /** `null` while the market is unsettled (`Option::None`). */
  settledRate: Live<bigint | null>
  ytFrozen: Live<boolean>
  ytAccruedIndex: Live<bigint>
  totalPt: Live<bigint>
  totalYt: Live<bigint>
  poolState: Live<PoolStateView>
  /** Both reserves > 0. Unavailable if the reserves could not be read. */
  poolSeeded: Live<boolean>
  /** Unavailable (and not read) while the pool is unseeded: the view panics on an empty pool. */
  ptPrice: Live<bigint>
  impliedRate: Live<bigint>
  lpTotalSupply: Live<bigint>
  fees: {
    tokenizationBps: Live<bigint>
    ytBps: Live<bigint>
    swapTierBps: Live<bigint>
    protocolShareBps: Live<bigint>
  }
  swapFeeRate: Live<bigint>
  exchangeRate: Live<bigint>
  /** SY shares the PrincipalManager holds (`SYWrapper.balance_of(manager)`), for TVL. */
  managerSy: Live<bigint>
  syPaused: Live<boolean>
  poolPaused: Live<boolean>
  riskPaused: Live<boolean>
  cb: { limit: Live<bigint>; volume: Live<bigint>; assetLimit: Live<bigint>; assetVolume: Live<bigint> }
  topology: Live<Topology>
}

type MarketInfo = Record<"pool" | "manager" | "sy" | "pt" | "yt" | "underlying", unknown>
type RawPoolState = Record<string, unknown>

function asObject<T extends object>(value: unknown, what: string): T {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T
  throw new Error(`${what} did not return a struct`)
}

function parsePoolState(raw: unknown): PoolStateView {
  const s = asObject<RawPoolState>(raw, "pool_state")
  return {
    ptReserve: toBigint(s.pt_reserve),
    syReserve: toBigint(s.sy_reserve),
    totalLp: toBigint(s.total_lp),
    rate: toBigint(s.rate),
    exponent: toBigint(s.exponent),
    feeRate: toBigint(s.fee_rate),
    secondsToMaturity: toBigint(s.seconds_to_maturity),
  }
}

function parseReserves(raw: unknown): [bigint, bigint] {
  if (!Array.isArray(raw) || raw.length !== 2) throw new Error("reserves did not return a pair")
  return [toBigint(raw[0]), toBigint(raw[1])]
}

function parseSettledRate(raw: unknown): bigint | null {
  if (raw === null || raw === undefined) return null
  return toBigint(raw)
}

/** Router.market(pool) is the on-chain record of the market's contract set; compare it with the manifest. */
function compareTopology(
  market: ReturnType<typeof getMarketOrThrow>,
  info: Live<MarketInfo>,
  maturity: Live<bigint>,
): Live<Topology> {
  return allLive([info, maturity] as const, ([onChain, onChainMaturity]) => {
    const checks: [string, unknown, unknown][] = [
      ["pool", onChain.pool, market.contracts.pool],
      ["manager", onChain.manager, market.contracts.manager],
      ["sy", onChain.sy, market.contracts.sy],
      ["pt", onChain.pt, market.contracts.pt],
      ["yt", onChain.yt, market.contracts.yt],
      ["underlying", onChain.underlying, market.underlying.sac],
      ["maturity", onChainMaturity, BigInt(market.maturity)],
    ]
    const mismatches = checks.filter(([, chain, manifest]) => chain !== manifest).map(([name]) => name)
    return { matches: mismatches.length === 0, mismatches }
  })
}

function getMarketOrThrow(m: Manifest, marketId: string) {
  const market = getMarket(m, marketId)
  if (!market) throw new Error(`Unknown market "${marketId}"`)
  return market
}

export async function fetchMarketState(reader: ContractReader, m: Manifest, marketId: string): Promise<MarketState> {
  const market = getMarketOrThrow(m, marketId)
  const c = market.contracts
  const risk = m.shared.riskControl
  const asset = { type: "address", value: market.underlying.sac } as const

  const big = (contractId: string, functionName: string, args?: Parameters<ContractReader>[0]["args"]) =>
    readLive<unknown, bigint>(reader, { contractId, functionName, args }, toBigint)
  const bool = (contractId: string, functionName: string) =>
    readLive<unknown, boolean>(reader, { contractId, functionName }, toBool)

  const poolStateRead = readLive<unknown, PoolStateView>(reader, { contractId: c.pool, functionName: "pool_state" }, parsePoolState)
  const reservesRead = readLive<unknown, [bigint, bigint]>(reader, { contractId: c.pool, functionName: "reserves" }, parseReserves)
  const maturity = big(c.manager, "maturity")
  const routerInfo = readLive<unknown, MarketInfo>(
    reader,
    { contractId: c.router, functionName: "market", args: [{ type: "address", value: c.pool }] },
    (v) => asObject<MarketInfo>(v, "Router.market"),
  )

  // Price and implied rate panic on an empty pool, so they are read only once both reserves are > 0.
  const seededChain = reservesRead.then(async (reserves) => {
    const poolSeeded = allLive([reserves] as const, ([[pt, sy]]) => pt > 0n && sy > 0n)
    if (poolSeeded.status === "unavailable") {
      return { poolSeeded, ptPrice: poolSeeded, impliedRate: poolSeeded }
    }
    if (!poolSeeded.value) {
      const empty = unavailable("pool is not seeded (empty reserves); price is not read")
      return { poolSeeded, ptPrice: empty, impliedRate: empty }
    }
    const [ptPrice, impliedRate] = await Promise.all([big(c.pool, "pt_price"), big(c.pool, "implied_rate")])
    return { poolSeeded, ptPrice, impliedRate }
  })

  // R6: the swap fee depends on the time left, taken from pool_state, not from the browser clock.
  const swapFeeChain = poolStateRead.then((state) =>
    state.status === "unavailable"
      ? unavailable(`swap fee needs pool_state: ${state.error}`)
      : big(c.config, "swap_fee_rate", [{ type: "u64", value: state.value.secondsToMaturity }]),
  )

  const [
    oracleRate, oracleTimestamp, oracleFresh, settledRate, ytFrozen, ytAccruedIndex, totalPt, totalYt,
    lpTotalSupply, tokenizationBps, ytBps, swapTierBps, protocolShareBps, exchangeRate, syPaused, poolPaused,
    riskPaused, cbLimit, cbVolume, assetLimit, assetVolume, poolState, seeded, swapFeeRate, info, matured, managerSy,
  ] = await Promise.all([
    big(c.oracle, "get_reference_value"),
    big(c.oracle, "get_reference_timestamp"),
    readLive<unknown, boolean>(
      reader,
      { contractId: c.oracle, functionName: "is_fresh", args: [{ type: "u64", value: ORACLE_MAX_STALE_SECONDS }] },
      toBool,
    ),
    readLive<unknown, bigint | null>(reader, { contractId: c.manager, functionName: "settled_rate" }, parseSettledRate),
    bool(c.yt, "is_frozen"),
    big(c.yt, "accrued_yield_index"),
    big(c.pt, "total_supply"),
    big(c.yt, "total_supply"),
    big(c.pool, "lp_total_supply"),
    big(c.config, "tokenization_fee_bps"),
    big(c.config, "yt_fee_bps"),
    big(c.config, "swap_fee_tier_bps"),
    big(c.config, "protocol_share_bps"),
    big(c.sy, "exchange_rate"),
    bool(c.sy, "is_paused"),
    bool(c.pool, "is_paused"),
    bool(risk, "is_paused"),
    big(risk, "get_cb_limit"),
    big(risk, "get_cb_volume"),
    big(risk, "get_asset_limit", [asset]),
    big(risk, "get_asset_volume", [asset]),
    poolStateRead,
    seededChain,
    swapFeeChain,
    routerInfo,
    maturity,
    big(c.sy, "balance_of", [{ type: "address", value: c.manager }]),
  ])

  return {
    oracleRate,
    oracleTimestamp,
    oracleFresh,
    maturity: matured,
    settledRate,
    ytFrozen,
    ytAccruedIndex,
    totalPt,
    totalYt,
    poolState,
    poolSeeded: seeded.poolSeeded,
    ptPrice: seeded.ptPrice,
    impliedRate: seeded.impliedRate,
    lpTotalSupply,
    fees: { tokenizationBps, ytBps, swapTierBps, protocolShareBps },
    swapFeeRate,
    exchangeRate,
    managerSy,
    syPaused,
    poolPaused,
    riskPaused,
    cb: { limit: cbLimit, volume: cbVolume, assetLimit, assetVolume },
    topology: compareTopology(market, info, matured),
  }
}
