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

/** The account an event is about: `account`, or the caller for a batch (whose accounts the event does not carry). */
export function eventSubject(topic: string, data: Record<string, unknown>): string | null {
  const value = topic === "acc_batch" ? data.caller : data.account
  return typeof value === "string" && value !== "" ? value : null
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
