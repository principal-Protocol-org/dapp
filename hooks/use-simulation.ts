"use client"

import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { MARKET_REFETCH_MS } from "@/hooks/use-market-state"
import { useSettings } from "@/hooks/use-settings"
import { invocationFor, type ActionInput } from "@/lib/protocol/actions"
import { guardsFrom, openGuards, parseOutput, type ActionOutput, type GuardResult } from "@/lib/protocol/guards"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { simulateInvocation, type SimulationOutcome } from "@/lib/protocol/stellar"

export const SIMULATION_DEBOUNCE_MS = 400

export type Simulation = {
  outcome?: SimulationOutcome
  /** The simulated return value, validated for this action. */
  output?: ActionOutput
  /** Floors derived from `output` at the current slippage; `{ ok: false }` is a refusal. */
  guards?: ReturnType<typeof guardsFrom>
  /** The input that was simulated (open guards): a restore is prepared for this same call. */
  simulated?: ActionInput
  /** From an input change until the simulation of that input returns. */
  pending: boolean
  /** Drops the outcome and simulates the same input again (after a restore). */
  refresh(): void
}

/** What a simulation depends on. Guards are always open here and the deadline ticks, so neither is in it. */
function keyParts(input: ActionInput): string[] {
  return [input.action, input.marketId, input.source, input.amount.toString(), input.secondaryAmount?.toString() ?? ""]
}

const withOpenGuards = (input: ActionInput): ActionInput => ({ ...input, guards: openGuards(input.action, input.amount) })

async function simulate(input: ActionInput): Promise<SimulationOutcome> {
  try {
    const m = activeManifest()
    return await simulateInvocation({
      rpcUrl: m.rpcUrl,
      networkPassphrase: m.networkPassphrase,
      source: input.source,
      invocation: invocationFor(m, input),
    })
  } catch (error) {
    return { ok: false, kind: "rpc_error", message: error instanceof Error ? error.message : String(error) }
  }
}

function derive(input: ActionInput, outcome: SimulationOutcome, slippageBps: bigint): { output?: ActionOutput; guards?: GuardResult } {
  if (!outcome.ok) return {}
  try {
    const output = parseOutput(input.action, outcome.retval)
    return { output, guards: guardsFrom(input.action, input, output, slippageBps) }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return { guards: { ok: false, reason: `The simulation returned a result this app cannot read (${why}), so there is no exact quote.` } }
  }
}

/**
 * Simulates the real call as the user, with open guards, 400 ms after the input stops changing
 * (R28: every action, claim and redeem included). The outcome is re-read with the market data.
 * Any input change drops the outcome at once: a quote is only ever shown for the input it was
 * simulated with, and is never kept for another one (`gcTime: 0`).
 */
export function useSimulation(input: ActionInput | null): Simulation {
  const { slippageBps } = useSettings()
  const queryClient = useQueryClient()
  const network = activeManifest().network
  const key = input ? keyParts(input).join("|") : null

  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    if (key === null) return
    const timer = setTimeout(() => setSettled(key), SIMULATION_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [key])
  const live = input !== null && settled === key ? input : null

  const queryKey = ["simulation", network, ...(live ? keyParts(live) : ["idle"])]
  const query = useQuery({
    queryKey,
    // The latest render's input: its deadline is current when the outcome is re-read.
    queryFn: () => (live ? simulate(withOpenGuards(live)) : Promise.reject(new Error("Nothing to simulate."))),
    enabled: live !== null,
    gcTime: 0,
    retry: false,
    refetchInterval: MARKET_REFETCH_MS,
  })

  const outcome = live ? query.data : undefined
  return {
    outcome,
    ...(live && outcome ? derive(live, outcome, slippageBps) : {}),
    simulated: live && outcome ? withOpenGuards(live) : undefined,
    pending: input !== null && outcome === undefined,
    // Reset, not refetch: the old outcome (e.g. "restore required") must not stand meanwhile.
    refresh: () => void queryClient.resetQueries({ queryKey, exact: true }),
  }
}
