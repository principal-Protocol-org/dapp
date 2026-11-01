"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { useAccountState } from "@/hooks/use-account-state"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useMarketState } from "@/hooks/use-market-state"
import type { HistoryData } from "@/hooks/use-history"
import type { AccountState } from "@/lib/protocol/account-state"
import { formatPercent, formatRate, formatTokenAmount } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { MarketState } from "@/lib/protocol/market-state"
import { lpShare, entryFor, pendingOf, settlementOf } from "@/lib/protocol/position"
import { previewRedeemPt } from "@/lib/protocol/previews"
import { allLive } from "@/lib/protocol/reader"
import { accruingSinceRate, poolValueInUnderlying, ptFixedReturn } from "@/lib/protocol/yield"
import type { Live, Market } from "@/lib/protocol/types"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatDuration, showLive, UNAVAILABLE } from "@/components/app/live"
import { Metric } from "@/components/app/market/metric"
import { groupedTokens as tokens } from "@/components/app/actions/panel-lines"
import { ActionPanel } from "@/components/app/actions/action-panel"
import { claimPanel } from "@/components/app/actions/redeem-tab"
import { RECOMBINE_TITLE, RecombineAction, recombineDescription } from "@/components/app/trade/recombine-action"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export const STALE = "Unavailable — last update failed"

export type CardStatus = "loading" | "empty" | "shown"
export type CardHistory = { data: HistoryData | undefined; pending: boolean; failed: boolean }

const BALANCES = ["underlying", "sy", "pt", "yt", "lp"] as const

/** Holds anything: some balance is above zero, or one cannot be read (then nothing is ruled out). */
function holdsAnything(a: AccountState): boolean {
  return BALANCES.some((k) => a[k].status === "unavailable" || a[k].value > 0n)
}

const liveBalance = (v: Live<bigint>): bigint => (v.status === "live" ? v.value : 0n)
const day = (iso: string) => iso.slice(0, 10)

/** A market page link that opens the given tab and side (read by `TradePanel`). */
const shortcut = (marketId: string, tab: "pt" | "yt" | "lp", side?: "buy" | "sell" | "deposit" | "withdraw") =>
  `/app/markets/${marketId}?tab=${tab}${side ? `&side=${side}` : ""}`

/** PT amounts are oracle units, which are US dollars: a fixed figure is shown as USD. */
const usd = (raw: bigint) => `$${formatTokenAmount(raw, 7, true)}`

function Tip({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="cursor-help underline decoration-dotted underline-offset-4">
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

export function PositionCard({
  marketId,
  history,
  onStatus,
}: {
  marketId: string
  history: CardHistory
  onStatus: (marketId: string, status: CardStatus) => void
}) {
  const market = getMarket(useManifest(), marketId)
  const marketQuery = useMarketState(marketId)
  const accountQuery = useAccountState(marketId)
  const { ledgerTime } = useLedgerClock()

  const stale = marketQuery.stale || accountQuery.stale
  const ms = stale ? undefined : marketQuery.data
  const account = stale ? undefined : accountQuery.data
  const loading = !stale && (!ms || !account)
  const empty = !!account && !stale && !holdsAnything(account)
  const status: CardStatus = loading ? "loading" : empty ? "empty" : "shown"
  useEffect(() => onStatus(marketId, status), [onStatus, marketId, status])

  if (!market || status === "empty") return null
  const title = <h2 className="font-serif text-2xl text-ink">{market.displayName}</h2>
  if (loading) {
    return (
      <section aria-label={market.displayName} className="grid gap-3 rounded-lg border border-line bg-surface p-5">
        {title}
        <Skeleton className="h-20 w-full" />
      </section>
    )
  }
  if (!ms || !account) {
    return (
      <section aria-label={market.displayName} className="grid gap-3 rounded-lg border border-line bg-surface p-5">
        {title}
        <p role="status" className="text-ink-muted">
          {STALE}
        </p>
      </section>
    )
  }
  return <Position market={market} ms={ms} account={account} ledgerTime={ledgerTime} history={history} />
}

function Position({
  market,
  ms,
  account,
  ledgerTime,
  history,
}: {
  market: Market
  ms: MarketState
  account: AccountState
  ledgerTime: number | null
  history: CardHistory
}) {
  const { marketId } = market
  const { code, decimals } = market.underlying
  const pt = liveBalance(account.pt)
  const yt = liveBalance(account.yt)
  const lp = liveBalance(account.lp)
  const unknownBalance = BALANCES.some((k) => account[k].status === "unavailable")
  const secondsToMaturity: bigint | null =
    ms.maturity.status === "live" && ledgerTime !== null ? ms.maturity.value - BigInt(Math.floor(ledgerTime)) : null
  const matured = secondsToMaturity === null ? null : secondsToMaturity <= 0n
  const [dialog, setDialog] = useState<"claim" | "recombine" | null>(null)
  // Built once per market: panel configs must stay stable (panel-config rule 1). Recombine is the
  // Quick action's route form (R2-72), to the underlying or SY, not 0001's single SY-paying step.
  const claim = useMemo(() => claimPanel(market), [market])
  const showClaim = yt > 0n || liveBalance(account.ytPendingClaim) > 0n || unknownBalance

  return (
    <section aria-label={market.displayName} className="grid gap-5 rounded-lg border border-line bg-surface p-5">
      <h2 className="font-serif text-2xl text-ink">{market.displayName}</h2>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-4 min-[600px]:grid-cols-5">
        <Metric label={code}>{showLive(account.underlying, (v) => tokens(v, code, decimals))}</Metric>
        <Metric label="SY">{showLive(account.sy, (v) => tokens(v, "SY"))}</Metric>
        <Metric label="PT">{showLive(account.pt, (v) => tokens(v, "PT"))}</Metric>
        <Metric label="YT">{showLive(account.yt, (v) => tokens(v, "YT"))}</Metric>
        <Metric label="LP">{showLive(account.lp, (v) => tokens(v, "LP"))}</Metric>
      </dl>

      {lp > 0n || account.lp.status === "unavailable" ? <LpShare ms={ms} account={account} market={market} /> : null}

      <OracleLine ms={ms} ledgerTime={ledgerTime} />

      {yt > 0n || account.yt.status === "unavailable" || liveBalance(account.ytPendingClaim) > 0n ? (
        <PendingYieldLine ms={ms} account={account} market={market} />
      ) : null}

      {pt > 0n || account.pt.status === "unavailable" ? (
        <FixedReturn ms={ms} pt={account.pt} market={market} secondsToMaturity={secondsToMaturity} />
      ) : null}

      {pt > 0n || yt > 0n ? <EntryLine marketId={marketId} ms={ms} account={account} history={history} /> : null}

      <nav aria-label={`${market.displayName} shortcuts`} className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {showClaim ? <ShortcutButton onClick={() => setDialog("claim")}>Claim yield</ShortcutButton> : null}
        {(pt > 0n && yt > 0n) || unknownBalance ? <ShortcutButton onClick={() => setDialog("recombine")}>Exit (recombine PT + YT)</ShortcutButton> : null}
        {matured === true ? (
          pt > 0n || yt > 0n || unknownBalance ? <ShortcutLink href={shortcut(marketId, "pt")}>Redeem at maturity</ShortcutLink> : null
        ) : (
          <>
            {pt > 0n || unknownBalance ? <ShortcutLink href={shortcut(marketId, "pt", "sell")}>Sell PT</ShortcutLink> : null}
            {yt > 0n || unknownBalance ? <ShortcutLink href={shortcut(marketId, "yt", "sell")}>Sell YT</ShortcutLink> : null}
          </>
        )}
        {lp > 0n || unknownBalance ? <ShortcutLink href={shortcut(marketId, "lp", "withdraw")}>Withdraw liquidity</ShortcutLink> : null}
        <ShortcutLink href={`/app/markets/${marketId}`}>Open market</ShortcutLink>
      </nav>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{dialog === "recombine" ? RECOMBINE_TITLE : "Claim yield"}</DialogTitle>
            <DialogDescription>
              {dialog === "recombine" ? recombineDescription(code) : `Collect the yield your YT has earned on ${market.displayName}.`}
            </DialogDescription>
          </DialogHeader>
          {dialog === "recombine" ? <RecombineAction marketId={marketId} /> : dialog === "claim" ? <ActionPanel config={claim} marketId={marketId} /> : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}

function ShortcutButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {children}
    </button>
  )
}

function ShortcutLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-ink underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
      {children}
    </Link>
  )
}

function LpShare({ ms, account, market }: { ms: MarketState; account: AccountState; market: Market }) {
  const { code, decimals } = market.underlying
  const share: Live<{ pt: bigint; sy: bigint }> = allLive(
    [account.lp, ms.poolState] as const,
    ([lp, pool]) => {
      const s = lpShare({ lp, totalLp: pool.totalLp, ptReserve: pool.ptReserve, syReserve: pool.syReserve })
      if (!s) throw new Error("The pool is empty")
      return s
    },
  )
  // R34 estimate of the whole pool, scaled by the account's share of the LP supply and floored.
  const value: Live<bigint> = allLive(
    [account.lp, ms.poolState, ms.exchangeRate, ms.ptPrice, ms.oracleRate] as const,
    ([lp, pool, exchangeRate, ptPrice, oracleRate]) => {
      const whole = poolValueInUnderlying({ syReserve: pool.syReserve, ptReserve: pool.ptReserve, exchangeRate, ptPrice, oracleRate })
      if (whole === null || pool.totalLp <= 0n) throw new Error("The pool value is not available")
      return (whole * lp) / pool.totalLp
    },
  )
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-4 min-[600px]:grid-cols-3">
      <Metric label="Your share of the pool: PT">{showLive(share, (v) => tokens(v.pt, "PT"))}</Metric>
      <Metric label="Your share of the pool: SY">{showLive(share, (v) => tokens(v.sy, "SY"))}</Metric>
      <Metric label="Estimated value of your share">
        {showLive(value, (v) => `≈ ${tokens(v, code, decimals)}`)}
      </Metric>
    </dl>
  )
}

function OracleLine({ ms, ledgerTime }: { ms: MarketState; ledgerTime: number | null }) {
  const age =
    ms.oracleTimestamp.status === "live" && ledgerTime !== null
      ? `updated ${formatDuration(ledgerTime - Number(ms.oracleTimestamp.value))} ago`
      : null
  const fresh = ms.oracleFresh.status === "unavailable" ? UNAVAILABLE : ms.oracleFresh.value ? "fresh" : "stale (older than 1 hour)"
  return (
    <dl>
      <Metric label="Oracle rate">
        {showLive(ms.oracleRate, formatRate)} · {fresh}
        {age ? ` · ${age}` : ""}
      </Metric>
    </dl>
  )
}

function PendingYieldLine({ ms, account, market }: { ms: MarketState; account: AccountState; market: Market }) {
  const { code, decimals } = market.underlying
  const y = pendingOf(ms, account)
  return (
    <dl>
      <Metric label="Pending yield (net of the YT fee)">
        {y.status === "live" ? (
          <Tip tip={`Gross ${tokens(y.value.gross, code, decimals)}, YT fee ${tokens(y.value.fee, code, decimals)}.`}>
            {tokens(y.value.net, code, decimals)}
          </Tip>
        ) : (
          UNAVAILABLE
        )}
      </Metric>
    </dl>
  )
}

/**
 * "Fixed return if held to maturity". Face and current value are PT-notional amounts (asset
 * value), not underlying tokens; the underlying paid at maturity is shown apart, in the
 * underlying's own code (T6 note).
 */
function FixedReturn({
  ms,
  pt,
  market,
  secondsToMaturity,
}: {
  ms: MarketState
  pt: Live<bigint>
  market: Market
  secondsToMaturity: bigint | null
}) {
  const { code, decimals } = market.underlying
  const matured = secondsToMaturity !== null && secondsToMaturity <= 0n
  const poolEmpty = ms.poolSeeded.status === "live" && !ms.poolSeeded.value
  const fixed = allLive([pt, ms.ptPrice] as const, ([amount, ptPrice]) => {
    if (secondsToMaturity === null) throw new Error("The network clock is not available")
    return ptFixedReturn({ pt: amount, ptPrice, secondsToMaturity })
  })
  const settlement = settlementOf(ms)
  const redeemable = allLive([pt, settlement, ms.exchangeRate] as const, ([amount, s, x]) => ({
    paid: previewRedeemPt(amount, s.rate, x),
    basis: s.basis,
  }))
  const noPrice = poolEmpty ? "No pool price yet (no liquidity)" : UNAVAILABLE
  const face = pt.status === "live" ? usd(pt.value) : UNAVAILABLE
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-4 min-[600px]:grid-cols-2">
      <div className="min-[600px]:col-span-2">
        <p className="label">Fixed return if held to maturity</p>
      </div>
      <Metric label="Face value at maturity (USD)">{face}</Metric>
      <Metric label="Current value (USD, at the pool price)">
        {matured ? "Matured" : fixed.status === "live" ? usd(fixed.value.valueNow) : ms.ptPrice.status === "unavailable" ? noPrice : UNAVAILABLE}
      </Metric>
      <Metric label="Projected fixed return at maturity">
        {matured ? "Matured" : fixed.status === "live" ? `+${usd(fixed.value.faceAtMaturity - fixed.value.valueNow)}` : ms.ptPrice.status === "unavailable" ? noPrice : UNAVAILABLE}
      </Metric>
      <Metric label="Fixed APY from now">
        {matured ? "Matured" : fixed.status === "live" ? <Tip tip="Negative when PT trades above par: holding to maturity returns less than the price now.">{formatPercent(fixed.value.apy)}</Tip> : ms.ptPrice.status === "unavailable" ? noPrice : UNAVAILABLE}
      </Metric>
      <Metric label={redeemable.status === "live" && redeemable.value.basis !== "oracle" ? `Redeems for (${code})` : `Redeems for (${code}, indicative until settlement)`}>
        {showLive(redeemable, (v) => tokens(v.paid, code, decimals))}
      </Metric>
    </dl>
  )
}

function EntryLine({ marketId, ms, account, history }: { marketId: string; ms: MarketState; account: AccountState; history: CardHistory }) {
  if (history.failed) return <EntryText>Entry: {STALE}</EntryText>
  if (history.pending || !history.data) return <EntryText>Entry: loading your history…</EntryText>
  if (ms.maturity.status === "unavailable") return <EntryText>Entry: {UNAVAILABLE}</EntryText>
  const entry = entryFor({
    entries: history.data.entries.filter((e) => e.marketId === marketId),
    oracleUpdates: history.data.oracleUpdates[marketId] ?? [],
    maturity: ms.maturity.value,
  })
  if (entry?.kind === "mint") {
    return (
      <EntryText note>
        Entry rate {formatRate(entry.rate)} (from your mint on {day(entry.at)})
      </EntryText>
    )
  }
  if (entry?.kind === "buy_pt") {
    return (
      <EntryText note>
        Fixed APY locked at purchase {formatPercent(entry.apy)} (from your PT purchase on {day(entry.at)})
      </EntryText>
    )
  }
  const last = account.ytLastClaimedIndex
  if (last.status === "unavailable") return <EntryText>Accruing since rate: {UNAVAILABLE}</EntryText>
  if (last.value <= 0n) return null
  return <EntryText>Accruing since rate {formatRate(accruingSinceRate(last.value))}</EntryText>
}

function EntryText({ children, note = false }: { children: React.ReactNode; note?: boolean }) {
  return (
    <div className="grid gap-1 text-sm text-ink">
      <p>{children}</p>
      {note ? <p className="text-ink-muted">From your most recent qualifying transaction in the history window.</p> : null}
    </div>
  )
}
