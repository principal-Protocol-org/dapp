import { describe, expect, it } from "vitest"
import { accountState, down, live, marketState } from "./fixtures"
import { complianceIssues, safetyIssues } from "../market/attention"

describe("safetyIssues", () => {
  it("is 0 for a healthy market", () => {
    expect(safetyIssues(marketState(), undefined)).toBe(0)
  })
  it("is undefined while the market state is unavailable, never a made-up 0", () => {
    expect(safetyIssues(undefined, undefined)).toBeUndefined()
  })
  it("is undefined, never 0, when a counted value is unreadable: its row says Unavailable (M3)", () => {
    expect(safetyIssues(marketState({ syPaused: down(), oracleFresh: down() }), undefined)).toBeUndefined()
    // Not even a known problem is counted beside an unreadable row: the count would be a guess.
    expect(safetyIssues(marketState({ poolPaused: live(true), riskPaused: down() }), undefined)).toBeUndefined()
  })
  it.each([["syPaused"], ["poolPaused"], ["riskPaused"], ["oracleFresh"]])("is undefined when %s is unreadable", (k) => {
    expect(safetyIssues(marketState({ [k]: down() }), undefined)).toBeUndefined()
  })
  it.each([["limit"], ["volume"], ["assetLimit"], ["assetVolume"]])("is undefined when the breaker's %s is unreadable, even with its limit off", (k) => {
    const cb = { limit: live(0n), volume: live(0n), assetLimit: live(0n), assetVolume: live(0n), [k]: down() }
    expect(safetyIssues(marketState({ cb }), undefined)).toBeUndefined()
  })
  it("is undefined when the account's deposit cap or net deposits are unreadable, or a connected account cannot be read", () => {
    expect(safetyIssues(marketState(), accountState({ depositCap: down() }))).toBeUndefined()
    expect(safetyIssues(marketState(), accountState({ netDeposited: down() }))).toBeUndefined()
    expect(safetyIssues(marketState(), null)).toBeUndefined()
    // No wallet: the deposit-cap row asks to connect one, and is not counted.
    expect(safetyIssues(marketState(), undefined)).toBe(0)
  })
  it.each([["syPaused"], ["poolPaused"], ["riskPaused"]])("counts 1 when %s", (k) => {
    expect(safetyIssues(marketState({ [k]: live(true) }), undefined)).toBe(1)
  })
  it("counts a stale oracle", () => {
    expect(safetyIssues(marketState({ oracleFresh: live(false) }), undefined)).toBe(1)
  })
  const cb = (limit: bigint, volume: bigint, assetLimit = 0n, assetVolume = 0n) => ({
    limit: live(limit),
    volume: live(volume),
    assetLimit: live(assetLimit),
    assetVolume: live(assetVolume),
  })
  it("counts a protocol-wide breaker window with no room left, but not when its limit is off", () => {
    expect(safetyIssues(marketState({ cb: cb(100n, 100n) }), undefined)).toBe(1)
    expect(safetyIssues(marketState({ cb: cb(100n, 90n) }), undefined)).toBe(0)
    expect(safetyIssues(marketState({ cb: cb(0n, 5n) }), undefined)).toBe(0)
  })
  it("counts the per-asset breaker separately", () => {
    expect(safetyIssues(marketState({ cb: cb(0n, 0n, 50n, 50n) }), undefined)).toBe(1)
    expect(safetyIssues(marketState({ cb: cb(100n, 100n, 50n, 50n) }), undefined)).toBe(2)
  })
  it("counts the account's deposit cap when it is used up", () => {
    const acc = accountState({ depositCap: live(10n), netDeposited: live(10n) })
    expect(safetyIssues(marketState(), acc)).toBe(1)
    expect(safetyIssues(marketState(), accountState({ depositCap: live(0n), netDeposited: live(5n) }))).toBe(0)
  })
  it("adds every condition up", () => {
    const acc = accountState({ depositCap: live(10n), netDeposited: live(10n) })
    const ms = marketState({
      syPaused: live(true),
      poolPaused: live(true),
      riskPaused: live(true),
      oracleFresh: live(false),
      cb: cb(100n, 100n, 50n, 50n),
    })
    expect(safetyIssues(ms, acc)).toBe(7)
  })
})

describe("complianceIssues", () => {
  const item = (status: "ok" | "missing" | "blocked" | "unavailable") => ({ id: "account" as const, status, message: "m" })
  it("is undefined when no wallet is connected", () => {
    expect(complianceIssues(false, [item("missing")])).toBeUndefined()
  })
  it("is undefined while the items are unavailable or stale", () => {
    expect(complianceIssues(true, null)).toBeUndefined()
  })
  it("is 0 when every item is OK", () => {
    expect(complianceIssues(true, [item("ok"), item("ok")])).toBe(0)
  })
  it("counts the items that are not OK", () => {
    expect(complianceIssues(true, [item("ok"), item("missing"), item("blocked"), item("unavailable")])).toBe(3)
  })
})
