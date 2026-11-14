/**
 * Plain words and short forms for the indexed compliance events (spec 0004 D-14): RecoveryEscrow seizures and
 * finalizations, and Permissioning changes. A topic not listed shows as it is.
 */
const COMPLIANCE_WORDS: Record<string, string> = {
  recovery: "Position seized into RecoveryEscrow",
  finalize: "Recovery record finalized",
  acc_grant: "Account allowed",
  acc_rev: "Account access removed",
  // `acc_batch` carries its caller alone, so a batch counts once, whatever its size.
  acc_batch: "Accounts allowed in a batch",
  ast_grant: "Account allowed for an asset",
  ast_rev: "Account access removed for an asset",
}

export function complianceEventWords(topic: string): string {
  return COMPLIANCE_WORDS[topic] ?? topic
}

/** RiskControl's indexed events (D-14): limits, the window, pausers and consumers. `paused` reads from its value. */
const RISK_WORDS: Record<string, string> = {
  cb_limit: "Circuit-breaker limit set",
  ast_limit: "Asset limit set",
  cb_window: "Window length set",
  add_psr: "Pauser added",
  rm_psr: "Pauser removed",
  add_cons: "Consumer added",
  rm_cons: "Consumer removed",
}

/** Plain words for any indexed event this module knows; a topic not listed shows as it is. */
export function eventWords(topic: string, data: Record<string, unknown> = {}): string {
  if (topic === "paused") return data.paused === false ? "Unpaused" : "Paused"
  return COMPLIANCE_WORDS[topic] ?? RISK_WORDS[topic] ?? topic
}

/** The field naming who an event is about, when it is not `account`. */
const SUBJECT_FIELD: Record<string, string> = { acc_batch: "caller", add_psr: "pauser", rm_psr: "pauser", add_cons: "consumer", rm_cons: "consumer" }

/** The account an event is about: `account`, the pauser or consumer, or the caller for a batch (whose accounts the event does not carry). */
export function eventSubject(topic: string, data: Record<string, unknown>): string | null {
  const value = data[SUBJECT_FIELD[topic] ?? "account"]
  return typeof value === "string" && value !== "" ? value : null
}

/** "2026-11-14 00:04:59 UTC": an indexed event's ledger close time, as the index stores it (ISO, UTC). */
export function closeTimeText(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(iso)
  return m ? `${m[1]} ${m[2]} UTC` : iso
}

/** "68be08…8f7a": a transaction hash, short. */
export const txShort = (hash: string) => (hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash)

/** "GBZX…MADI": an account or contract id, short. */
export const accountShort = (id: string) => (id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id)

/** How long ago, coarse enough for history: seconds under a minute, minutes under an hour, then hours and minutes, then days and hours. */
export function ago(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ago`
}
