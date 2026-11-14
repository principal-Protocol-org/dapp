/**
 * RiskControl's pausers (spec 0004, `/dashboard/risk`): the index lists who was added and removed
 * (`add_psr`, `rm_psr`), and each account it lists is confirmed live with `is_pauser(account)`. The
 * contract also counts its admin as a pauser (`is_pauser` returns true for `DataKey::Admin`, risk_control
 * 665bb67 `:168-180`), with no event, so the admin is read on its own (`get_admin`).
 */
import { readLive, toAddress, toBool, unavailable, type ContractReader } from "../reader"
import type { Live, Manifest } from "../types"

/** An indexed `add_psr` or `rm_psr` event (the fields this module reads), as the events API lists it. */
export type PauserEvent = { id: string; contractId: string; topic: string; ledger: number; closeTime: string; txHash: string; data: Record<string, unknown> }

/** An account the index says is a pauser: its last `add_psr`/`rm_psr` event is this `add_psr`. */
export type IndexedPauser = { account: string; added: PauserEvent }

/** Chain order: by ledger, then by the fixed-width event id. */
const oldestFirst = (a: PauserEvent, b: PauserEvent) => a.ledger - b.ledger || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The pausers the index holds for `riskControl`, in the order they were (last) added: its `add_psr`
 * and `rm_psr` replayed oldest first, so an account removed and added again is listed, and one
 * removed last is not. Another contract's events are ignored.
 */
export function indexedPausers(rows: readonly PauserEvent[], riskControl: string): IndexedPauser[] {
  const last = new Map<string, PauserEvent>()
  for (const row of [...rows].sort(oldestFirst)) {
    if (row.contractId !== riskControl || (row.topic !== "add_psr" && row.topic !== "rm_psr")) continue
    const pauser = row.data.pauser
    if (typeof pauser !== "string" || pauser === "") continue
    // Re-inserting moves the account to the end: the map keeps the order of each account's last event.
    last.delete(pauser)
    last.set(pauser, row)
  }
  return [...last].filter(([, row]) => row.topic === "add_psr").map(([account, added]) => ({ account, added }))
}

export type PauserView = {
  /** `get_admin()`: the admin may always pause. */
  admin: Live<string>
  /** `is_pauser(admin)`, confirming that rule live. */
  adminIsPauser: Live<boolean>
  /** `is_pauser(account)` for each account asked, in that order. */
  pausers: { account: string; isPauser: Live<boolean> }[]
}

export async function fetchPausers(reader: ContractReader, manifest: Manifest, accounts: readonly string[]): Promise<PauserView> {
  const risk = manifest.shared.riskControl
  const isPauser = (account: string) =>
    readLive<unknown, boolean>(reader, { contractId: risk, functionName: "is_pauser", args: [{ type: "address", value: account }] }, toBool)
  const [admin, pausers] = await Promise.all([
    readLive<unknown, string>(reader, { contractId: risk, functionName: "get_admin" }, toAddress),
    Promise.all(accounts.map(async (account) => ({ account, isPauser: await isPauser(account) }))),
  ])
  const adminIsPauser = admin.status === "live" ? await isPauser(admin.value) : unavailable(`the admin could not be read: ${admin.error}`)
  return { admin, adminIsPauser, pausers }
}
