import { parseSalt } from "@/lib/protocol/factory"
import type { Network } from "@/lib/protocol/types"

/**
 * The salts of the markets this browser started creating (spec 0002 §5 "Resuming"), so the manager
 * view can list each with "Resume at step N". A convenience only: the wizard's link (`?salt=`) is
 * what resumes a market from any browser, and where it stands is always read from the chain.
 * Unreadable or blocked storage is an empty list.
 */
const MAX = 20
const keyOf = (network: Network) => `pp-wizard-salts:${network}`

export function readWizardSalts(network: Network): string[] {
  try {
    const raw = localStorage.getItem(keyOf(network))
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((v) => {
      const salt = typeof v === "string" ? parseSalt(v) : undefined
      return salt ? [salt] : []
    })
  } catch {
    return []
  }
}

export function rememberWizardSalt(network: Network, salt: string): void {
  const valid = parseSalt(salt)
  if (!valid) return
  try {
    const salts = [valid, ...readWizardSalts(network).filter((s) => s !== valid)].slice(0, MAX)
    localStorage.setItem(keyOf(network), JSON.stringify(salts))
  } catch {
    // storage unavailable: the link still resumes the market
  }
}
