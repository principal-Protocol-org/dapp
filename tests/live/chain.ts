/**
 * Chain helpers every live suite shares, on any network, with no dependency on the server code
 * (`tests/integration/local-stack.ts` re-exports them): token units, balances, the ledger clock, the
 * market's compliance model, the history kind of each action, and the suite log.
 */
import type { AccountState, ComplianceKind } from "@/lib/protocol/account-state"
import type { ActionId } from "@/lib/protocol/actions"
import { fetchMarketCompliance } from "@/lib/protocol/compliance"
import type { HistoryKind } from "@/lib/protocol/events"
import { createHorizon } from "@/lib/protocol/horizon"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer, getLedgerClock } from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"
import { redact } from "./util"

/** One whole token at 7 decimals. */
export const U = 10_000_000n
export const MINUTE = 60_000

/** A log whose lines are printed as they come and again, all together, at the end of the suite. */
export function createLog(prefix = "integration") {
  const lines: string[] = []
  return {
    lines,
    log(line: string) {
      const safe = redact(line)
      lines.push(safe)
      console.info(`[${prefix}] ${safe}`)
    },
    summary() {
      console.info(`[${prefix}] summary\n${lines.join("\n")}`)
    },
  }
}

/** History kind each action's transaction is listed as (T19; R4-10 for the one-transaction Router actions). */
export const HISTORY_KIND: Record<ActionId, HistoryKind> = {
  deposit: "deposit",
  withdraw: "withdraw",
  mint: "mint",
  buy_pt: "buy_pt",
  sell_pt: "sell_pt",
  buy_yt: "buy_yt",
  sell_yt: "sell_yt",
  add_liquidity: "add_liquidity",
  add_liquidity_sy: "add_liquidity",
  remove_liquidity: "remove_liquidity",
  recombine: "recombine",
  claim_yield: "claim",
  redeem: "redeem",
  // R4-10: deposit + buy_pt, sell_pt + withdraw, deposit + mint + sell_pt + withdraw, sell_yt +
  // withdraw, deposit + mint + add_liq, each in one transaction.
  buy_pt_underlying: "buy_pt",
  sell_pt_underlying: "sell_pt",
  // R5: the flash is a Buy YT; LP in and out of USDY are one transaction each.
  buy_yt_flash: "buy_yt",
  buy_yt_flash_underlying: "buy_yt",
  add_liquidity_underlying: "add_liquidity",
  remove_liquidity_underlying: "remove_liquidity",
  sell_yt_underlying: "sell_yt",
  add_liquidity_keep_yt: "add_liquidity",
}

/** The live ledger clock, interpolated between reads. */
export async function ledgerClock(manifest: Manifest) {
  const clock = await getLedgerClock(createRpcServer(manifest.rpcUrl))
  return { ...clock, now: () => clock.closeTime + (Date.now() - clock.readAtMs) / 1000 }
}

/** The market's compliance model kind (`sac` for the dev stack's and the Testnet USDY). */
export async function complianceKind(manifest: Manifest, market: Market): Promise<ComplianceKind> {
  const model = await fetchMarketCompliance(createHorizon(manifest.horizonUrl), createRpcReader(manifest), market)
  if (model.status !== "live") throw new Error(`compliance model: ${model.error}`)
  return model.value.kind
}

/** Balances of `account` in this market, raw: USDY, SY, PT, YT, LP. */
export type Balances = Record<"underlying" | "sy" | "pt" | "yt" | "lp", bigint>

export function balancesOf(acc: AccountState): Balances {
  const v = (l: AccountState["underlying"], what: string) => {
    if (l.status !== "live") throw new Error(`${what}: ${l.error}`)
    return l.value
  }
  return { underlying: v(acc.underlying, "USDY"), sy: v(acc.sy, "SY"), pt: v(acc.pt, "PT"), yt: v(acc.yt, "YT"), lp: v(acc.lp, "LP") }
}

/** `1234567890n` at 7 decimals as "123.4567890". */
export function units(v: bigint, decimals = 7): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  return `${neg ? "-" : ""}${a / base}.${(a % base).toString().padStart(decimals, "0")}`
}

export const showBalances = (b: Balances) =>
  `USDY ${units(b.underlying)}, SY ${units(b.sy)}, PT ${units(b.pt)}, YT ${units(b.yt)}, LP ${units(b.lp)}`
