"use client"

import { showLive } from "@/components/app/live"
import type { PanelConfig, PreviewLine } from "@/components/app/actions/panel-config"
import { PanelGroup, usePanels, type PanelEntry } from "@/components/app/actions/panel-group"
import { amountOf, max0, outputOf, plain, tokens } from "@/components/app/actions/panel-lines"
import type { AccountState } from "@/lib/protocol/account-state"
import { formatBps, formatRate } from "@/lib/protocol/format"
import type { MarketState } from "@/lib/protocol/market-state"
import { previewDeposit, previewMint, previewWithdraw } from "@/lib/protocol/previews"
import { allLive } from "@/lib/protocol/reader"
import type { Market } from "@/lib/protocol/types"

/**
 * The Mint tab (spec §6): deposit the underlying into SY, withdraw SY back to the underlying, and
 * mint PT + YT from the underlying. There is no mint from SY: `PrincipalManager.mint` takes no
 * floor and the fee can change before it lands, so the dApp does not offer it (spec §6).
 */

const SY_NOTE = "Use SY to buy PT or YT, add liquidity, or withdraw it."

const exchangeRateLine = (ms: MarketState, code: string): PreviewLine => ({
  label: "SY exchange rate",
  value: showLive(ms.exchangeRate, (r) => `${formatRate(r)} ${code} per SY`),
})

/** The connected account's room under the SY wrapper's cap: `deposit_cap − net_deposited`; 0 is off. */
function capLeftLine(account: AccountState | undefined, code: string, decimals: number): PreviewLine {
  const label = "Your deposit cap left"
  if (!account) return { label, value: "Connect a wallet to see it" }
  const left = allLive([account.depositCap, account.netDeposited] as const, ([cap, net]) => (cap <= 0n ? null : max0(cap - net)))
  return {
    label,
    value: showLive(left, (v) => (v === null ? "No cap" : tokens(v, code, decimals))),
    hint: "The SY wrapper caps each account's deposits, net of withdrawals.",
  }
}

/**
 * Room left in each enabled circuit-breaker window and what this action adds: the amount once for
 * a deposit, twice for a mint from the underlying (its deposit, then its mint) — the same `2 ×
 * amount` the gate counts. A limit of 0 means the window is off and is not shown.
 */
function breakerLines(ms: MarketState, amount: bigint | undefined, times: 1n | 2n, code: string, decimals: number): PreviewLine[] {
  const windows = [
    { label: "Circuit breaker, protocol-wide", limit: ms.cb.limit, volume: ms.cb.volume },
    { label: `Circuit breaker, ${code}`, limit: ms.cb.assetLimit, volume: ms.cb.assetVolume },
  ]
  const hint = times === 2n ? `Minting from ${code} counts twice: once for the deposit, once for the mint.` : undefined
  return windows.flatMap(({ label, limit, volume }) => {
    if (limit.status === "live" && limit.value <= 0n) return []
    const room = allLive([limit, volume] as const, ([l, v]) => max0(l - v))
    const value = showLive(room, (left) =>
      amount === undefined
        ? `${tokens(left, code, decimals)} left`
        : `${tokens(times * amount, code, decimals)} of ${tokens(left, code, decimals)} left`,
    )
    return [hint ? { label, value, hint } : { label, value }]
  })
}

export function depositPanel(market: Market): PanelConfig {
  const { code, decimals } = market.underlying
  return {
    action: "deposit",
    fields: [{ id: "amount", label: `${code} to deposit`, unit: code }],
    description: `Wrap ${code} into SY, the token the pool trades and PT + YT are minted from.`,
    indicative: (ms, { amount }) =>
      amount === undefined
        ? []
        : [{ label: "SY received", value: showLive(allLive([ms.exchangeRate] as const, ([r]) => previewDeposit(amount, r)), (v) => tokens(v, "SY")) }],
    market: (ms, { inputs, account }) => [
      exchangeRateLine(ms, code),
      capLeftLine(account, code, decimals),
      ...breakerLines(ms, inputs.amount, 1n, code, decimals),
    ],
    exact: (output) => [{ label: "SY received", value: tokens(amountOf(output), "SY") }],
    floors: { minOut: { label: "Minimum SY received", unit: "SY" } },
    result: (output, { input }) => `You deposited ${plain(input.amount, decimals)} ${code} and received ${plain(amountOf(output))} SY.`,
  }
}

export function withdrawPanel(market: Market): PanelConfig {
  const { code, decimals } = market.underlying
  return {
    action: "withdraw",
    fields: [{ id: "amount", label: "SY to withdraw", unit: "SY" }],
    description: `Unwrap SY back into ${code}.`,
    indicative: (ms, { amount }) =>
      amount === undefined
        ? []
        : [
            {
              label: `${code} received`,
              value: showLive(allLive([ms.exchangeRate] as const, ([r]) => previewWithdraw(amount, r)), (v) => tokens(v, code, decimals)),
            },
          ],
    market: (ms) => [exchangeRateLine(ms, code)],
    exact: (output) => [{ label: `${code} received`, value: tokens(amountOf(output), code, decimals) }],
    floors: { minOut: { label: `Minimum ${code} received`, unit: code } },
    result: (output, { input }) => `You withdrew ${plain(input.amount)} SY and received ${plain(amountOf(output), decimals)} ${code}.`,
  }
}

export function mintPanel(market: Market): PanelConfig {
  const { code, decimals } = market.underlying
  return {
    action: "mint",
    fields: [{ id: "amount", label: `${code} to mint with`, unit: code }],
    description: `Deposit ${code} and split it into PT, the fixed leg, and YT, the yield leg, in one transaction.`,
    indicative(ms, { amount }) {
      if (amount === undefined) return []
      // wrap_and_mint deposits first (SYWrapper.deposit), then mints PT + YT from those shares.
      const minted = allLive([ms.exchangeRate, ms.oracleRate, ms.fees.tokenizationBps] as const, ([rate, oracle, bps]) => {
        const shares = previewDeposit(amount, rate)
        return { shares, ...previewMint(shares, oracle, bps) }
      })
      return [
        { label: "You receive", value: showLive(minted, (m) => `${tokens(m.pt, "PT")} + ${tokens(m.yt, "YT")}`) },
        { label: "Tokenization fee", value: showLive(minted, (m) => tokens(m.feeShares, "SY")), hint: "Kept by the market from the SY, rounded up." },
        { label: "Deposited as SY first", value: showLive(minted, (m) => tokens(m.shares, "SY")) },
      ]
    },
    market: (ms, { inputs, account }) => [
      {
        label: "Oracle rate",
        value: showLive(ms.oracleRate, (r) => `${formatRate(r)} notional per ${code}`),
        hint: "PT and YT are counted in notional units: (SY − fee) × oracle rate.",
      },
      { label: "Tokenization fee rate", value: showLive(ms.fees.tokenizationBps, formatBps) },
      capLeftLine(account, code, decimals),
      ...breakerLines(ms, inputs.amount, 2n, code, decimals),
    ],
    exact(output) {
      const m = outputOf(output, "mint")
      return [
        { label: "You receive", value: `${tokens(m.pt_minted, "PT")} + ${tokens(m.yt_minted, "YT")}` },
        { label: "Tokenization fee", value: tokens(m.fee_shares, "SY") },
      ]
    },
    floors: { minOut: { label: "Minimum PT received (and as much YT)", unit: "PT" } },
    result(output, { input }) {
      const m = outputOf(output, "mint")
      return `You minted ${plain(m.pt_minted)} PT and ${plain(m.yt_minted)} YT from ${plain(input.amount, decimals)} ${code}.`
    },
    notes({ account }) {
      const sy = account?.sy
      if (sy?.status !== "live" || sy.value <= 0n) return []
      return [`You hold ${plain(sy.value)} SY. Minting starts from ${code}. ${SY_NOTE}`]
    },
  }
}

const mintPanels = (market: Market): PanelEntry[] => [
  { id: "deposit", label: "Deposit", config: depositPanel(market) },
  { id: "withdraw", label: "Withdraw", config: withdrawPanel(market) },
  { id: "mint", label: "Mint PT + YT", config: mintPanel(market) },
]

export function MintTab({ marketId }: { marketId: string }) {
  const panels = usePanels(marketId, mintPanels)
  return <PanelGroup label="Mint" marketId={marketId} panels={panels} />
}
