// @vitest-environment node
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { exitCode, summarize } from "../../../scripts/smoke.mjs"

const ROOT = join(__dirname, "..", "..", "..")

const ORACLE_A = "CCKXG4HSVH57AQTYJDNNXHQBCGNH6KRFNMCMATTMYFUX2TDQ7GD5K7IT"
const ORACLE_B = "CBHAWS6B4YCNRLYRP2HUP77P4IRP3PZYPSYVPV4OMZNU2ZNKSAQQ2GXU"
const POOL_A = "CAON3FAQU5W6SGZFWOM22GONNKZEIN4AGVTKMCWCC6PI43QWB27MGW4I"
const POOL_B = "CBJGWQ7BJ7AND2MNG4RCA626PPX4RTDKLJGNG6UVXFTOYF6GGQ7T5GZ6"
const ROUTER = "CCM4QQUKTD2CUTRSNNI6OO4JHYEF7MHKBMKSM5JYJNFLKSTAZBQD7QF5"
const ORACLE_HASH = "8581bbba82bb57f5c5c9c00adf98b1691ad20821840e55a67ad8d7ecace0c1b0"
const POOL_HASH = "52285a25bbf372d0e5d22ba565b76af6a7e832422df83b6a4809de8adf3aa112"
const ROUTER_HASH = "2a0997317651edb0f7e2bd753570b03a88462aa6d216c14b06ebec246bb3c1c2"

const matching = (kind: string, contract: string, hash: string) => ({ kind, contract, expected: hash, actual: hash })

/** A market row as the check builds it: topology matches, the oracle fresh, nothing paused, its code as pinned. */
function marketRow(market: string, asset: string, oracle: string, pool: string) {
  return {
    market,
    asset,
    topology: { status: "match" as const },
    oracle: { contract: oracle, state: "fresh" as "fresh" | "warning" | "stale" | "unavailable", ageSeconds: 120, maxStaleSeconds: 3600 },
    feed: "1.0000000",
    againstFeed: "Equal",
    paused: [] as string[],
    code: [matching("oracle", oracle, ORACLE_HASH), matching("pool", pool, POOL_HASH)],
    unread: [] as { call: string; reason: string; manifest: boolean }[],
  }
}

/** The shared contracts' row: no topology and no oracle of its own. */
function sharedRow() {
  return { ...marketRow("shared", "", ORACLE_A, POOL_A), market: null, asset: null, topology: null, oracle: null, feed: "", againstFeed: "", code: [matching("router", ROUTER, ROUTER_HASH)] }
}

const allGood = () => [marketRow("mainnet-a", "MOCKUSDY", ORACLE_A, POOL_A), marketRow("mainnet-b", "MOCKUSTRY", ORACLE_B, POOL_B), sharedRow()]

describe("the smoke check's verdict", () => {
  it("all good: exit 0, a PASS line that counts topologies, code hashes and oracles, no warning", () => {
    const rows = allGood()
    expect(exitCode(rows)).toBe(0)
    const lines = summarize(rows)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^PASS: /)
    expect(lines[0]).toContain("2 of 2 topologies match")
    // Five contracts checked against three distinct pins.
    expect(lines[0]).toContain("5 of 5 code hashes match (3 pinned hashes)")
    expect(lines[0]).toContain("0 failed reads")
    expect(lines[0]).toContain("2 oracles: 2 fresh")
  })

  it("one topology mismatch: exit 1, a FAIL line naming the market and the fields", () => {
    const rows = allGood()
    rows[1].topology = { status: "mismatch", fields: ["pool", "maturity"] } as never
    expect(exitCode(rows)).toBe(1)
    const lines = summarize(rows)
    expect(lines.some((l) => /^FAIL: topology of mainnet-b \(MOCKUSTRY\): pool, maturity differ/.test(l))).toBe(true)
    expect(lines.at(-1)).toMatch(/^FAIL: .*1 of 2 topologies match/)
    rows[1].topology = { status: "mismatch", fields: ["maturity"] } as never
    expect(summarize(rows)).toContain("FAIL: topology of mainnet-b (MOCKUSTRY): maturity differs from the manifest")
  })

  it("one stale oracle only: exit 0, with a warning line that says it does not fail the check", () => {
    const rows = allGood()
    rows[0].oracle = { contract: ORACLE_A, state: "stale", ageSeconds: 3 * 86_400, maxStaleSeconds: 3600 }
    expect(exitCode(rows)).toBe(0)
    const lines = summarize(rows)
    const warnings = lines.filter((l) => l.startsWith("warning: "))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/oracle CCKX…K7IT \(MOCKUSDY\) is stale: its value is 3d 0h old, 1h 0m allowed/)
    expect(warnings[0]).toMatch(/does not fail the check/)
    expect(lines.at(-1)).toMatch(/^PASS: .*2 oracles: 1 fresh, 1 stale/)
  })

  it("a code hash that differs from its pin: exit 1, naming the contract and both hashes", () => {
    const rows = allGood()
    rows[1].code[1] = { kind: "pool", contract: POOL_B, expected: POOL_HASH, actual: "ab".repeat(32) }
    expect(exitCode(rows)).toBe(1)
    expect(summarize(rows)).toContain(`FAIL: code of pool ${POOL_B} (mainnet-b): the chain runs ${"ab".repeat(32)}, the manifest pins ${POOL_HASH}`)
  })

  it("a code hash that cannot be read fails too; a contract with no pin is only a warning", () => {
    const missing = allGood()
    missing[0].code[1] = { kind: "pool", contract: POOL_A, expected: POOL_HASH, actual: null, reason: "There is no contract at it." } as never
    expect(exitCode(missing)).toBe(1)
    expect(summarize(missing)).toContain(`FAIL: code of pool ${POOL_A} (mainnet-a) could not be read: There is no contract at it.`)

    const unpinned = allGood()
    unpinned[0].code[1] = { kind: "pool", contract: POOL_A, expected: null, actual: POOL_HASH } as never
    expect(exitCode(unpinned)).toBe(0)
    expect(summarize(unpinned).some((l) => /^warning: pool .* has no pinned code hash/.test(l))).toBe(true)
  })

  it("a manifest contract that cannot be read fails; another contract's failed read (the feed) only warns", () => {
    const busy = allGood()
    busy[2].unread = [{ call: `${ROUTER} market`, reason: "The Stellar network is busy. Try again in a moment.", manifest: true }]
    expect(exitCode(busy)).toBe(1)
    expect(summarize(busy)).toContain(`FAIL: could not read ${ROUTER} market: The Stellar network is busy. Try again in a moment.`)
    expect(summarize(busy).at(-1)).toContain("1 failed read")

    const feed = allGood()
    feed[0].unread = [{ call: "CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF lastprice(CB3Y…GAGP)", reason: "The feed has no price for this asset.", manifest: false }]
    expect(exitCode(feed)).toBe(0)
    expect(summarize(feed)).toContain("warning: could not read CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF lastprice(CB3Y…GAGP) (not a manifest contract): The feed has no price for this asset.")
  })

  it("an oracle two markets share is counted once", () => {
    const rows = allGood()
    rows[1].oracle = marketRow("mainnet-a", "MOCKUSDY", ORACLE_A, POOL_A).oracle
    expect(summarize(rows).at(-1)).toContain("1 oracle: 1 fresh")
    // Both markets' assets name the one oracle once it is stale.
    rows[0].oracle = { contract: ORACLE_A, state: "stale", ageSeconds: 7200, maxStaleSeconds: 3600 }
    rows[1].oracle = rows[0].oracle
    expect(summarize(rows).filter((l) => l.startsWith("warning: "))).toEqual([
      "warning: oracle CCKX…K7IT (MOCKUSDY, MOCKUSTRY) is stale: its value is 2h 0m old, 1h 0m allowed; operations that need its price are blocked (reported; does not fail the check)",
    ])
  })

  it("a paused contract is reported, not a failure", () => {
    const rows = allGood()
    rows[0].paused = ["Market pool (mainnet-a)"]
    expect(exitCode(rows)).toBe(0)
    expect(summarize(rows)).toContain("warning: paused: Market pool (mainnet-a)")
  })
})

describe("how the check runs", () => {
  it("loads the app's TypeScript through the shared loader (scripts/lib/load-app-ts.mjs)", () => {
    const source = readFileSync(join(ROOT, "scripts", "smoke.mjs"), "utf8")
    expect(source).toMatch(/^import \{ loadAppTypeScript\b[^}]*\} from "\.\/lib\/load-app-ts\.mjs"$/m)
    expect(source).toContain("loadAppTypeScript(root)")
    expect(source).not.toContain("registerHooks")
  })

  it("pnpm smoke:mainnet runs the check on Mainnet with Node's TypeScript transform", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
    expect(pkg.scripts["smoke:mainnet"]).toMatch(/^node --experimental-transform-types .*scripts\/smoke\.mjs --network mainnet$/)
  })
})
