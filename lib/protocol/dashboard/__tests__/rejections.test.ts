// @vitest-environment node
import { describe, expect, it } from "vitest"
import { BROKEN, isSignificantRejection, lastRejectionNote, rejectionText, ORACLE_WASM_LAST_REJECTION, ROUTINE, SIGNIFICANT } from "../rejections"

// Our Testnet oracle: principal 665bb67, built by the app team (config/manifests/testnet.json wasmHashes.oracle).
const OURS = "adb87f76c1bafd93c67489645fe49df771ede639edc0d1919233563ffae86bce"
// The Mainnet oracles: principal 3af9388 (config/manifests/mainnet.json wasmHashes.oracle).
const MAINNET = "8581bbba82bb57f5c5c9c00adf98b1691ad20821840e55a67ad8d7ecace0c1b0"

describe("rejectionText", () => {
  it.each([
    ["deviate", "Moved more than the cap"],
    ["decrease", "Lower than the current value"],
    ["stale_ts", "Not newer than the current value"],
    ["oob", "Outside the value bounds"],
    ["fb_value", "Fallback tried to change the value"],
    ["no_data", "The feed had no price"],
    ["bad_price", "The feed's price was zero or negative"],
    ["rescale", "The feed's price could not be converted to 7 decimals"],
    ["future_ts", "Dated after the current ledger time"],
    ["throttle", "Too soon after the last accepted feed update"],
    ["feed_err", "The feed could not be read"],
  ])("words %s", (reason, text) => {
    expect(rejectionText(reason)).toBe(text)
  })

  it("shows an unknown symbol raw", () => {
    expect(rejectionText("new_rsn")).toBe("new_rsn")
  })

  it("splits significant reasons as the contract does at 24d980d", () => {
    expect(["oob", "decrease", "deviate", "fb_value"].every(isSignificantRejection)).toBe(true)
    expect(["stale_ts", "no_data", "bad_price", "rescale", "future_ts", "throttle", "feed_err", "x"].some(isSignificantRejection)).toBe(false)
  })
})

describe("the rejection classes (D-21): one source, a partition of the eleven reasons", () => {
  // principal 3af9388 `oracle_adapter/src/lib.rs`: the nine of 24d980d, plus throttle and feed_err.
  const ELEVEN = ["bad_price", "decrease", "deviate", "fb_value", "feed_err", "future_ts", "no_data", "oob", "rescale", "stale_ts", "throttle"]

  it("the three classes are disjoint and their union is the contract's eleven reasons, each with words", () => {
    const classes = [SIGNIFICANT, ROUTINE, BROKEN] as readonly (readonly string[])[]
    const all = classes.flat()
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual(ELEVEN)
    for (const r of all) expect(rejectionText(r), r).not.toBe(r)
  })

  it("names each class as D-21 does: throttle is routine, feed_err a broken feed", () => {
    expect(SIGNIFICANT).toEqual(["oob", "decrease", "deviate", "fb_value"])
    expect(ROUTINE).toEqual(["stale_ts", "no_data", "throttle"])
    expect(BROKEN).toEqual(["bad_price", "rescale", "future_ts", "feed_err"])
  })

  it("isSignificantRejection and the pull oracles' routine reasons derive from the classes", () => {
    for (const r of ELEVEN) expect(isSignificantRejection(r), r).toBe((SIGNIFICANT as readonly string[]).includes(r))
    const pull = ORACLE_WASM_LAST_REJECTION.cf58bbd831957b817f8bfa7bf52313a8e9ba6256344ad34ab0c69916c8b1f85d.routine
    expect([...pull]).toEqual([...ROUTINE, ...BROKEN])
  })
})

describe("lastRejectionNote", () => {
  it("our Testnet oracle (manifest wasm hash) keeps every reason", () => {
    expect(ORACLE_WASM_LAST_REJECTION[OURS]).toMatchObject({ commit: "665bb67", keeps: "every" })
    const note = lastRejectionNote(OURS)
    expect(note).toMatch(/every rejection/)
    expect(note).toMatch(/routine/)
  })

  it("matches the hash case-insensitively", () => {
    expect(lastRejectionNote(OURS.toUpperCase())).toBe(lastRejectionNote(OURS))
  })

  it("the contracts team's aae6cf8 build keeps every reason", () => {
    const note = lastRejectionNote("f5c8a129c5aad53aff733b325a9949926a4fd4abf185a4dd0aec53476bf45253")
    expect(note).toMatch(/every rejection/)
  })

  // Lowercased words of the feed-only reasons (no_data, bad_price, rescale, future_ts).
  const FEED_WORDS = ["the feed had no price", "the feed's price was zero or negative", "converted to 7 decimals", "dated after the current ledger time"]

  it("the 665bb67 oracle (push only) names only the push routine reason, no feed reason", () => {
    const note = lastRejectionNote(OURS)
    expect(note).toContain("not newer than the current value")
    for (const w of FEED_WORDS) expect(note).not.toContain(w)
  })

  it("the aae6cf8 oracle (push and feed) names every routine reason, the feed ones included", () => {
    const note = lastRejectionNote("f5c8a129c5aad53aff733b325a9949926a4fd4abf185a4dd0aec53476bf45253")
    expect(note).toContain("not newer than the current value")
    for (const w of FEED_WORDS) expect(note).toContain(w)
  })

  it("the aae6cf8 oracle lists only the routine reasons its code gives: no throttle, no feed_err (both from 3af9388)", () => {
    const hash = "f5c8a129c5aad53aff733b325a9949926a4fd4abf185a4dd0aec53476bf45253"
    expect([...ORACLE_WASM_LAST_REJECTION[hash].routine]).toEqual(["stale_ts", "no_data", "bad_price", "rescale", "future_ts"])
    const note = lastRejectionNote(hash)
    expect(note).not.toContain("too soon after the last accepted feed update")
    expect(note).not.toContain("the feed could not be read")
  })

  it("a 24d980d build keeps only significant reasons", () => {
    const note = lastRejectionNote("cf58bbd831957b817f8bfa7bf52313a8e9ba6256344ad34ab0c69916c8b1f85d")
    expect(note).toMatch(/only significant/)
    expect(note).not.toMatch(/may/)
  })

  it("the contracts team's 24d980d build (their TR2 redeploy's oracle) keeps only significant reasons", () => {
    const hash = "93eb1ae6d6affd455d0878d1ce66849788eb34924f0f084a28e79b7c4eafee88"
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(ORACLE_WASM_LAST_REJECTION[hash]).toMatchObject({ commit: "24d980d", keeps: "significant" })
    expect([...ORACLE_WASM_LAST_REJECTION[hash].routine]).toEqual([...ROUTINE, ...BROKEN])
    expect(lastRejectionNote(hash)).toBe(lastRejectionNote("cf58bbd831957b817f8bfa7bf52313a8e9ba6256344ad34ab0c69916c8b1f85d"))
    expect(lastRejectionNote(hash)).not.toMatch(/may/)
  })

  it("the Mainnet oracles' 3af9388 build keeps only significant reasons, with every routine reason of its code", () => {
    expect(ORACLE_WASM_LAST_REJECTION[MAINNET]).toMatchObject({ commit: "3af9388", keeps: "significant" })
    expect([...ORACLE_WASM_LAST_REJECTION[MAINNET].routine]).toEqual([...ROUTINE, ...BROKEN])
    expect(ORACLE_WASM_LAST_REJECTION[MAINNET].routine).toEqual(expect.arrayContaining(["throttle", "feed_err"]))
    const note = lastRejectionNote(MAINNET)
    expect(note).toMatch(/keeps only significant/)
    expect(note).toMatch(/Routine rejections appear only in the rejection history/)
    expect(note).not.toMatch(/may/)
    expect(lastRejectionNote(MAINNET.toUpperCase())).toBe(note)
  })

  it("the app team's local build of 3af9388 (the local stack's oracles) reads as the Mainnet code: only significant reasons", () => {
    const local = "56786ca6a1b62c3ec7dd004a46b38d3121b8c4b26a3aafaf05ea55c3e137fad8"
    expect(ORACLE_WASM_LAST_REJECTION[local]).toEqual({ commit: "3af9388", keeps: "significant", routine: ORACLE_WASM_LAST_REJECTION[MAINNET].routine })
    expect(lastRejectionNote(local)).toBe(lastRejectionNote(MAINNET))
  })

  it("an unknown hash may keep only significant reasons", () => {
    const note = lastRejectionNote("00".repeat(32))
    expect(note).toMatch(/may keep only significant/)
  })

  it("has no em dash", () => {
    for (const h of [...Object.keys(ORACLE_WASM_LAST_REJECTION), "ff"]) expect(lastRejectionNote(h)).not.toMatch(/—/)
  })
})
