import type { ContractReader } from "../../reader"
import type { ScArg } from "../../stellar"
import type { Manifest, Market } from "../../types"
import { indexFor } from "../../yield"

export type Handler = unknown | ((args: ScArg[]) => unknown)
export type Calls = { key: string; args: ScArg[] }[]

export const RPC = "https://rpc.test"

/**
 * A reader answering from `table`, keyed `<contractId>.<fn>`. A handler may be a value, an Error (the
 * read fails with it) or a function of the call's arguments. Every read is at `ledger`.
 */
export function fakeReader(table: Record<string, Handler>, calls: Calls = [], ledger = 777): ContractReader {
  const read = async <T,>({ contractId, functionName, args = [] }: { contractId: string; functionName: string; args?: ScArg[] }) => {
    const key = `${contractId}.${functionName}`
    calls.push({ key, args })
    if (!(key in table)) throw new Error(`no fixture for ${key}`)
    const h = table[key]
    const value = typeof h === "function" ? (h as (a: ScArg[]) => unknown)(args) : h
    if (value instanceof Error) throw value
    return { value: value as T, latestLedger: ledger, minResourceFee: "100", rawXdr: `raw:${key}`, rpcUrl: RPC }
  }
  return Object.assign(read, { rpcUrl: RPC }) as ContractReader
}

export const TREASURY = "GBBPZ6KVXM72MVKSZMAPMM6O4UN6XID22ZO7EOEXGCKFCOZTNVY3JVXG"
export const CREATOR = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"

export const POOL_STATE = {
  pt_reserve: 500n,
  sy_reserve: 600n,
  total_lp: 400n,
  rate: 10_500_000n,
  exponent: 10n ** 18n,
  fee_rate: 3n,
  seconds_to_maturity: 86_400n,
}

/** Every view `fetchMarketState` and the dashboard read, for one market. */
export function marketTable(market: Market, m: Manifest, over: { totalUnderlying?: unknown; escrow?: unknown; reserves?: unknown } = {}): Record<string, Handler> {
  const c = market.contracts
  const risk = m.shared.riskControl
  const sac = market.underlying.sac
  return {
    [`${c.oracle}.get_reference_value`]: 10_500_000n,
    [`${c.oracle}.get_reference_timestamp`]: 1_790_000_000n,
    [`${c.oracle}.is_available`]: true,
    [`${c.oracle}.max_stale_seconds`]: 3600n,
    [`${c.oracle}.max_deviation_bps`]: 1000,
    [`${c.oracle}.get_primary_source`]: new Uint8Array(32).fill(0xab),
    [`${c.oracle}.get_fallback_source`]: null,
    [`${c.oracle}.last_rejection`]: null,
    [`${c.manager}.maturity`]: BigInt(market.maturity),
    [`${c.manager}.settled_rate`]: null,
    [`${c.yt}.is_frozen`]: false,
    [`${c.yt}.accrued_yield_index`]: indexFor(10_500_000n),
    [`${c.pt}.total_supply`]: 1000n,
    [`${c.yt}.total_supply`]: 1000n,
    [`${c.pool}.pool_state`]: POOL_STATE,
    [`${c.pool}.reserves`]: over.reserves ?? [500n, 600n],
    [`${c.pool}.pt_price`]: 9_500_000n,
    [`${c.pool}.implied_rate`]: 600_000n,
    [`${c.pool}.lp_total_supply`]: 400n,
    [`${c.pool}.is_paused`]: false,
    [`${c.manager}.is_paused`]: false,
    [`${c.config}.tokenization_fee_bps`]: 10,
    [`${c.config}.yt_fee_bps`]: 20,
    [`${c.config}.swap_fee_tier_bps`]: 30,
    [`${c.config}.protocol_share_bps`]: 40,
    [`${c.config}.swap_fee_rate`]: 123n,
    [`${c.config}.treasury`]: TREASURY,
    [`${c.config}.creator`]: CREATOR,
    [`${c.config}.protocol_admin`]: CREATOR,
    [`${c.sy}.exchange_rate`]: 10_000_000n,
    [`${c.sy}.is_paused`]: false,
    [`${c.sy}.total_underlying`]: over.totalUnderlying ?? 2_230_113_029_038n,
    [`${sac}.balance`]: over.escrow ?? 5_000_000n,
    [`${risk}.is_paused`]: false,
    [`${risk}.get_cb_limit`]: 1_000n,
    [`${risk}.get_cb_volume`]: 100n,
    [`${risk}.get_asset_limit`]: 2_000n,
    [`${risk}.get_asset_volume`]: 200n,
    [`${c.router}.market`]: { pool: c.pool, manager: c.manager, sy: c.sy, pt: c.pt, yt: c.yt, underlying: sac },
    // (protocol, creator) in SY shares: the pool's share of swap fees, and the manager's of tokenization and YT fees.
    [`${c.pool}.accrued_fees`]: [7_150_331n, 28_601_503n],
    [`${c.manager}.accrued_fees`]: [112_374_969n, 449_499_977n],
  }
}

/**
 * Market `i` of a sweep (Review Focus 5): its own SY, PT, YT, config, manager, pool and escrow, sharing
 * `base`'s oracle, Router, RiskControl and underlying SAC.
 */
export function ownMarket(base: Market, i: number): Market {
  return {
    ...base,
    marketId: `m${i}`,
    contracts: {
      ...base.contracts,
      sy: `SY${i}`,
      pt: `PT${i}`,
      yt: `YT${i}`,
      config: `CONFIG${i}`,
      manager: `MANAGER${i}`,
      pool: `POOL${i}`,
      recoveryEscrow: `ESCROW${i}`,
    },
  }
}

/** Every market's `marketTable`, with the Router answering each pool with that market's contracts (topology). */
export function sweepTable(markets: Market[], m: Manifest, over: Record<string, Handler> = {}): Record<string, Handler> {
  const t: Record<string, Handler> = {}
  for (const market of markets) Object.assign(t, marketTable(market, m))
  t[`${markets[0].contracts.router}.market`] = (args: ScArg[]) => {
    const market = markets.find((x) => x.contracts.pool === args[0]?.value)
    if (!market) throw new Error(`no market for pool ${String(args[0]?.value)}`)
    const c = market.contracts
    return { pool: c.pool, manager: c.manager, sy: c.sy, pt: c.pt, yt: c.yt, underlying: market.underlying.sac }
  }
  return { ...t, ...over }
}
