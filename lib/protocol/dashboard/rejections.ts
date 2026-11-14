/**
 * Oracle rejection wording (D-18). The reason symbols are the OracleAdapter's own: push
 * (`set_reference_value`) rejects with `oob`, `stale_ts`, `fb_value`, `decrease` and `deviate`; pull
 * (`sync_from_feed`, principal aae6cf8 and later) adds `no_data`, `bad_price`, `rescale` and
 * `future_ts` (principal 24d980d `oracle_adapter/src/lib.rs:355-540`).
 */

const WORDS: Record<string, string> = {
  deviate: "Moved more than the cap",
  decrease: "Lower than the current value",
  stale_ts: "Not newer than the current value",
  oob: "Outside the value bounds",
  fb_value: "Fallback tried to change the value",
  no_data: "The feed had no price",
  bad_price: "The feed's price was zero or negative",
  rescale: "The feed's price could not be converted to 7 decimals",
  future_ts: "Dated after the current ledger time",
}

/** A rejection reason in plain words; an unknown symbol is shown as it is. */
export function rejectionText(reason: string): string {
  return Object.hasOwn(WORDS, reason) ? WORDS[reason] : reason
}

/** Reasons that reflect an attempted disallowed value change: from 24d980d, the only ones `last_rejection()` keeps. */
const SIGNIFICANT = new Set(["oob", "decrease", "deviate", "fb_value"])

export function isSignificantRejection(reason: string): boolean {
  return SIGNIFICANT.has(reason)
}

/**
 * What `last_rejection()` holds, by the oracle's wasm hash (sha256 of the uploaded wasm, as in
 * `manifest.wasmHashes.oracle`). Before principal 24d980d the contract writes the slot on every
 * rejection; from 24d980d only on a significant one (`fn reject(…, significant)`, 24d980d
 * `oracle_adapter/src/lib.rs:716`). The `ref_rej` event is emitted either way.
 *
 * - `adb87f76…`: principal 665bb67 built by the app team (`scripts/dev-stack/deploy.sh`, rust 1.95,
 *   wasm32v1-none); the oracle of our Testnet market. A rebuild reproduces it byte for byte.
 * - `f5c8a129…`: principal aae6cf8 built by the contracts team; the TR2 Testnet oracle
 *   (principal 24d980d `deployments/testnet/deployment-manifest.json`).
 * - `cf58bbd8…`: principal 24d980d built with the same app-team toolchain as `adb87f76…`. No
 *   oracle runs it yet: it is the hash our deploy would produce at 24d980d. A build by another
 *   toolchain hashes differently and falls to the unknown-hash note.
 */
export const ORACLE_WASM_LAST_REJECTION: Record<string, { commit: string; keeps: "every" | "significant" }> = {
  adb87f76c1bafd93c67489645fe49df771ede639edc0d1919233563ffae86bce: { commit: "665bb67", keeps: "every" },
  f5c8a129c5aad53aff733b325a9949926a4fd4abf185a4dd0aec53476bf45253: { commit: "aae6cf8", keeps: "every" },
  cf58bbd831957b817f8bfa7bf52313a8e9ba6256344ad34ab0c69916c8b1f85d: { commit: "24d980d", keeps: "significant" },
}

const EVERY =
  "This oracle runs code from before principal 24d980d: its last rejection is the latest of every rejection, routine ones included (not newer, no feed data, a malformed feed price). A routine rejection can replace a significant one here; the rejection history keeps them all."
const SIGNIFICANT_ONLY =
  "This oracle runs principal 24d980d or later: its last rejection keeps only significant ones (outside the bounds, lower than the current value, moved more than the cap, a fallback changing the value). Routine rejections appear only in the rejection history."
const UNKNOWN =
  "This oracle's code is not one the dashboard recognizes. Code from principal 24d980d or later may keep only significant rejections here (outside the bounds, lower than the current value, moved more than the cap, a fallback changing the value); the rejection history keeps them all."

/** States whether `last_rejection()` keeps every reason or only significant ones, for the oracle's wasm hash. */
export function lastRejectionNote(oracleWasmHash: string): string {
  const known = ORACLE_WASM_LAST_REJECTION[oracleWasmHash.trim().toLowerCase()]
  if (!known) return UNKNOWN
  return known.keeps === "every" ? EVERY : SIGNIFICANT_ONLY
}
