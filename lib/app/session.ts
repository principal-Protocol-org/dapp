export type WalletSession = { connected: boolean }

const KEY = "pp-wallet"
const DEFAULT: WalletSession = { connected: true }

/**
 * Remembered wallet intent. Absent or unreadable storage means "no explicit disconnect", so
 * the default is `connected: true` (restore may still only succeed if Freighter allows the site).
 */
export function readSession(): WalletSession {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return DEFAULT
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && typeof (parsed as WalletSession).connected === "boolean") {
      return { connected: (parsed as WalletSession).connected }
    }
  } catch {
    // private mode / blocked storage / malformed JSON
  }
  return DEFAULT
}

export function writeSession(s: WalletSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ connected: s.connected }))
  } catch {
    // storage unavailable: the session just won't persist
  }
}
