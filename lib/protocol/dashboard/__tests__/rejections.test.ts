// @vitest-environment node
import { describe, expect, it } from "vitest"
import { isSignificantRejection, lastRejectionNote, rejectionText, ORACLE_WASM_LAST_REJECTION } from "../rejections"

// Our Testnet oracle: principal 665bb67, built by the app team (config/manifests/testnet.json wasmHashes.oracle).
const OURS = "adb87f76c1bafd93c67489645fe49df771ede639edc0d1919233563ffae86bce"

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
  ])("words %s", (reason, text) => {
    expect(rejectionText(reason)).toBe(text)
  })

  it("shows an unknown symbol raw", () => {
    expect(rejectionText("new_rsn")).toBe("new_rsn")
  })

  it("splits significant reasons as the contract does at 24d980d", () => {
    expect(["oob", "decrease", "deviate", "fb_value"].every(isSignificantRejection)).toBe(true)
    expect(["stale_ts", "no_data", "bad_price", "rescale", "future_ts", "x"].some(isSignificantRejection)).toBe(false)
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

  it("a 24d980d build keeps only significant reasons", () => {
    const note = lastRejectionNote("cf58bbd831957b817f8bfa7bf52313a8e9ba6256344ad34ab0c69916c8b1f85d")
    expect(note).toMatch(/only significant/)
    expect(note).not.toMatch(/may/)
  })

  it("an unknown hash may keep only significant reasons", () => {
    const note = lastRejectionNote("00".repeat(32))
    expect(note).toMatch(/may keep only significant/)
  })

  it("has no em dash", () => {
    for (const h of [...Object.keys(ORACLE_WASM_LAST_REJECTION), "ff"]) expect(lastRejectionNote(h)).not.toMatch(/—/)
  })
})
