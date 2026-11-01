import { describe, expect, it } from "vitest"
import { accountState, down, live, marketState } from "./fixtures"
import { safetyNeedsAttention } from "../market/attention"

describe("safetyNeedsAttention", () => {
  it("is false for a healthy market", () => {
    expect(safetyNeedsAttention(marketState(), undefined)).toBe(false)
  })
  it("is false while nothing is known: unavailable is not a warning", () => {
    expect(safetyNeedsAttention(undefined, undefined)).toBe(false)
    expect(safetyNeedsAttention(marketState({ syPaused: down(), oracleFresh: down() }), undefined)).toBe(false)
  })
  it.each([["syPaused"], ["poolPaused"], ["riskPaused"]])("is true when %s", (k) => {
    expect(safetyNeedsAttention(marketState({ [k]: live(true) }), undefined)).toBe(true)
  })
  it("is true for a stale oracle", () => {
    expect(safetyNeedsAttention(marketState({ oracleFresh: live(false) }), undefined)).toBe(true)
  })
  it("is true when a breaker window has no room left, but not when its limit is off", () => {
    const cb = (limit: bigint, volume: bigint) => ({ limit: live(limit), volume: live(volume), assetLimit: live(0n), assetVolume: live(0n) })
    expect(safetyNeedsAttention(marketState({ cb: cb(100n, 100n) }), undefined)).toBe(true)
    expect(safetyNeedsAttention(marketState({ cb: cb(100n, 90n) }), undefined)).toBe(false)
    expect(safetyNeedsAttention(marketState({ cb: cb(0n, 5n) }), undefined)).toBe(false)
  })
  it("is true when the account's deposit cap is used up", () => {
    const acc = accountState({ depositCap: live(10n), netDeposited: live(10n) })
    expect(safetyNeedsAttention(marketState(), acc)).toBe(true)
    expect(safetyNeedsAttention(marketState(), accountState({ depositCap: live(0n), netDeposited: live(5n) }))).toBe(false)
  })
})
