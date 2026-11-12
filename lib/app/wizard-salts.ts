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

/** This tab's own writes, which fire no `storage` event here. */
const listeners = new Set<() => void>()

/** Calls `onChange` on every change to the list: this tab's writes and other tabs' (`storage`). */
export function subscribeWizardSalts(onChange: () => void): () => void {
  listeners.add(onChange)
  if (typeof window !== "undefined") window.addEventListener("storage", onChange)
  return () => {
    listeners.delete(onChange)
    if (typeof window !== "undefined") window.removeEventListener("storage", onChange)
  }
}

function write(network: Network, salts: string[]): void {
  try {
    localStorage.setItem(keyOf(network), JSON.stringify(salts))
  } catch {
    // storage unavailable: the link still resumes the market
    return
  }
  for (const listener of [...listeners]) listener()
}

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

/** Remembers `salt`, newest first, once. The wizard calls it once a phase of the market is deployed. */
export function rememberWizardSalt(network: Network, salt: string): void {
  const valid = parseSalt(salt)
  if (!valid) return
  const current = readWizardSalts(network)
  if (current[0] === valid) return
  write(network, [valid, ...current.filter((s) => s !== valid)].slice(0, MAX))
}

/** Forgets `salt`: its market is listed (nothing left to resume), or nothing of it is on chain. */
export function forgetWizardSalt(network: Network, salt: string): void {
  const current = readWizardSalts(network)
  if (!current.includes(salt)) return
  write(network, current.filter((s) => s !== salt))
}
