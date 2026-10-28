// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { HistoryEntry } from "../events"
import { entryFor, lpShare, mintEntryRate } from "../position"

const AT = "2026-10-05T10:00:00Z"
const AT_SECONDS = Date.parse(AT) / 1000
const HALF_YEAR = 15_768_000n
const MATURITY = BigInt(AT_SECONDS) + HALF_YEAR

const mint = (ledger: number, at = AT): HistoryEntry => ({
  hash: `m${ledger}`,
  ledger,
  at,
  kind: "mint",
  lines: [],
  facts: { mint: { notional: 99_500_000n, syShares: 95_000_000n, feeShares: 500_000n } },
})
const buyPt = (ledger: number, at = AT): HistoryEntry => ({
  hash: `b${ledger}`,
  ledger,
  at,
  kind: "buy_pt",
  lines: [],
  facts: { buyPt: { syIn: 100_000_000n, ptOut: 105_000_000n } },
})
const updates = [
  { ledger: 100, value: 10_000_000n },
  { ledger: 200, value: 11_000_000n },
]

describe("mintEntryRate", () => {
  it("is notional * 1e7 / (sy_shares - fee_shares)", () => {
    // 99_500_000 * 1e7 / 94_500_000 = 10_529_100 (floored)
    expect(mintEntryRate({ notional: 99_500_000n, syShares: 95_000_000n, feeShares: 500_000n })).toBe(10_529_100n)
  })
  it("is null when no shares remain after the fee", () => {
    expect(mintEntryRate({ notional: 1n, syShares: 5n, feeShares: 5n })).toBeNull()
  })
})

describe("entryFor", () => {
  it("a mint entry gives the entry rate and its date", () => {
    expect(entryFor({ entries: [mint(150)], oracleUpdates: updates, maturity: MATURITY })).toEqual({
      kind: "mint",
      rate: 10_529_100n,
      at: AT,
    })
  })

  it("a buy_pt entry uses the last ref_set before its ledger and the time to maturity at its close", () => {
    // price = 100e6 * 10_000_000 / 105e6 = 9_523_809; implied APR = (1e14/9_523_809 - 1e7) * year / half-year = 1_000_000 (10%)
    const e = entryFor({ entries: [buyPt(150)], oracleUpdates: updates, maturity: MATURITY })
    expect(e).toMatchObject({ kind: "buy_pt", apr: 1_000_000n, at: AT })
    expect((e as { apy: number }).apy).toBeCloseTo(0.1025, 10)
  })

  it("a buy_pt entry is omitted when no ref_set precedes it", () => {
    expect(entryFor({ entries: [buyPt(99)], oracleUpdates: updates, maturity: MATURITY })).toBeNull()
    expect(entryFor({ entries: [buyPt(100)], oracleUpdates: updates, maturity: MATURITY })).toBeNull()
    expect(entryFor({ entries: [buyPt(150)], oracleUpdates: [], maturity: MATURITY })).toBeNull()
  })

  it("a buy_pt entry at or after maturity is omitted", () => {
    expect(entryFor({ entries: [buyPt(150)], oracleUpdates: updates, maturity: BigInt(AT_SECONDS) })).toBeNull()
  })

  it("picks the most recent qualifying entry, skipping a newer buy_pt without a ref_set", () => {
    // entries newest first: a buy_pt at ledger 90 (no ref_set before it) is skipped; the mint at 80 does not exist
    expect(entryFor({ entries: [buyPt(90), mint(70)], oracleUpdates: updates, maturity: MATURITY })).toMatchObject({ kind: "mint" })
    expect(entryFor({ entries: [mint(300), buyPt(150)], oracleUpdates: updates, maturity: MATURITY })).toMatchObject({ kind: "mint" })
    expect(entryFor({ entries: [buyPt(150), mint(120)], oracleUpdates: updates, maturity: MATURITY })).toMatchObject({ kind: "buy_pt" })
  })

  it("ignores other entry kinds and entries without facts", () => {
    const claim: HistoryEntry = { hash: "c", ledger: 150, at: AT, kind: "claim", lines: [] }
    const bare: HistoryEntry = { hash: "x", ledger: 160, at: AT, kind: "mint", lines: [] }
    expect(entryFor({ entries: [claim, bare], oracleUpdates: updates, maturity: MATURITY })).toBeNull()
  })
})

describe("lpShare", () => {
  it("is lp * reserve / total_lp for each reserve, floored", () => {
    expect(lpShare({ lp: 10n, totalLp: 40n, ptReserve: 1_001n, syReserve: 2_000n })).toEqual({ pt: 250n, sy: 500n })
  })
  it("is null on an empty pool", () => {
    expect(lpShare({ lp: 10n, totalLp: 0n, ptReserve: 1n, syReserve: 1n })).toBeNull()
  })
})
