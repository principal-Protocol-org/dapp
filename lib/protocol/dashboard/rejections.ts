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

/**
 * The OracleAdapter's nine rejection reasons, in the three classes of spec 0004 D-21. This is their
 * one source: the feed keeper, the alert check and the dashboard read them from here.
 * - Significant: an attempted disallowed value change, the contract's own split (24d980d
 *   `reject(…, significant: true)`), so from 24d980d the only ones `last_rejection()` keeps.
 * - Routine: no new data (push `stale_ts`; pull `stale_ts`, `no_data`).
 * - Broken feed: a pull feed's own data is unusable; the contract counts these as not significant.
 */
export const SIGNIFICANT = ["oob", "decrease", "deviate", "fb_value"] as const
export const ROUTINE = ["stale_ts", "no_data"] as const
export const BROKEN = ["bad_price", "rescale", "future_ts"] as const

const SIGNIFICANT_SET: ReadonlySet<string> = new Set(SIGNIFICANT)

export function isSignificantRejection(reason: string): boolean {
  return SIGNIFICANT_SET.has(reason)
}

export type OracleWasmRejections = {
  commit: string
  keeps: "every" | "significant"
  /** The routine (not significant) reasons this code can record; the note names them. */
  routine: readonly string[]
}

const PUSH_ROUTINE = ["stale_ts"] as const
/** Every pull reason that is not significant: the routine ones and the broken-feed ones. */
const PULL_ROUTINE = [...ROUTINE, ...BROKEN] as const

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
 *   oracle runs it yet: it is the hash our deploy would produce at 24d980d.
 * - `93eb1ae6…`: principal 24d980d built by the contracts team (their toolchain); the oracle of
 *   their fresh TR2 Testnet redeploy (`CDE77D…`, principal dcb957b
 *   `deployments/testnet/deployment-manifest.json`, whose oracle source equals 24d980d's).
 *
 * A build by another toolchain hashes differently and falls to the unknown-hash note.
 *
 * 665bb67 is push only (`set_reference_value`: `oob`, `stale_ts`, `fb_value`, `decrease`,
 * `deviate`); aae6cf8 adds the feed path (`sync_from_feed`) and its four reasons.
 */
export const ORACLE_WASM_LAST_REJECTION: Record<string, OracleWasmRejections> = {
  adb87f76c1bafd93c67489645fe49df771ede639edc0d1919233563ffae86bce: { commit: "665bb67", keeps: "every", routine: PUSH_ROUTINE },
  f5c8a129c5aad53aff733b325a9949926a4fd4abf185a4dd0aec53476bf45253: { commit: "aae6cf8", keeps: "every", routine: PULL_ROUTINE },
  cf58bbd831957b817f8bfa7bf52313a8e9ba6256344ad34ab0c69916c8b1f85d: { commit: "24d980d", keeps: "significant", routine: PULL_ROUTINE },
  "93eb1ae6d6affd455d0878d1ce66849788eb34924f0f084a28e79b7c4eafee88": { commit: "24d980d", keeps: "significant", routine: PULL_ROUTINE },
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
const SIGNIFICANT_WORDS = "outside the bounds, lower than the current value, moved more than the cap, a fallback changing the value"

function everyNote(routine: readonly string[]): string {
  const words = routine.map((r) => lower(rejectionText(r))).join("; ")
  const kind = routine.length === 1 ? "the routine one" : "routine ones"
  return `This oracle runs code from before principal 24d980d: its last rejection is the latest of every rejection, ${kind} included (${words}). A routine rejection can replace a significant one here; the rejection history keeps them all.`
}

const SIGNIFICANT_ONLY = `This oracle runs principal 24d980d or later: its last rejection keeps only significant ones (${SIGNIFICANT_WORDS}). Routine rejections appear only in the rejection history.`
const UNKNOWN = `This oracle's code is not one the dashboard recognizes. Code from principal 24d980d or later may keep only significant rejections here (${SIGNIFICANT_WORDS}); the rejection history keeps them all.`

/** States whether `last_rejection()` keeps every reason or only significant ones, for the oracle's wasm hash. */
export function lastRejectionNote(oracleWasmHash: string): string {
  const known = ORACLE_WASM_LAST_REJECTION[oracleWasmHash.trim().toLowerCase()]
  if (!known) return UNKNOWN
  return known.keeps === "every" ? everyNote(known.routine) : SIGNIFICANT_ONLY
}
