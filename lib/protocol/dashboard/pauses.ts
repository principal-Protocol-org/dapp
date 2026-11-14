/**
 * Every pausable contract's pause, for the overview's "Pauses" line (a live widget, D-6): RiskControl
 * plus each market's SY wrapper, pool and manager. Four kinds of `is_paused` read, nothing else, so it
 * can refresh every 15 s without re-reading each market's whole state.
 */
import { allLive, readLive, toBool, unavailable, type ContractReader } from "../reader"
import type { Live, Manifest } from "../types"

export type PauseKind = "riskControl" | "sy" | "pool" | "manager"

export type ContractPause = {
  kind: PauseKind
  contractId: string
  /** The market the contract belongs to; none for the protocol-wide RiskControl. */
  marketId?: string
  /** "Risk control", "SY wrapper (<market>)": the words the Safety card uses. */
  label: string
  paused: Live<boolean>
}

export type PauseView = {
  contracts: ContractPause[]
  /** The labels of the paused contracts (empty when none is); unavailable, naming the contract, when any read fails. */
  paused: Live<string[]>
}

const KIND_WORDS: Record<Exclude<PauseKind, "riskControl">, string> = {
  sy: "SY wrapper",
  pool: "Market pool",
  manager: "Principal manager",
}

export async function fetchPauses(reader: ContractReader, manifest: Manifest): Promise<PauseView> {
  const read = (contractId: string) => readLive<unknown, boolean>(reader, { contractId, functionName: "is_paused" }, toBool)
  const targets: Omit<ContractPause, "paused">[] = [
    { kind: "riskControl", contractId: manifest.shared.riskControl, label: "Risk control" },
    ...manifest.markets.flatMap((m) =>
      (["sy", "pool", "manager"] as const).map((kind) => ({
        kind,
        contractId: m.contracts[kind],
        marketId: m.marketId,
        label: `${KIND_WORDS[kind]} (${m.marketId})`,
      })),
    ),
  ]
  const reads = await Promise.all(targets.map((t) => read(t.contractId)))
  const contracts = targets.map((t, i) => ({ ...t, paused: reads[i] }))

  const down = contracts.find((c) => c.paused.status === "unavailable")
  const paused: Live<string[]> =
    down && down.paused.status === "unavailable"
      ? unavailable(`${down.label}: ${down.paused.error}`, down.paused.source)
      : allLive(reads, (values) => contracts.filter((_, i) => values[i]).map((c) => c.label))
  return { contracts, paused }
}
