"use client"

import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { MARKET_REFETCH_MS, useMarketState } from "@/hooks/use-market-state"
import { useSettings } from "@/hooks/use-settings"
import { invocationFor, type ActionInput } from "@/lib/protocol/actions"
import { userErrorMessage } from "@/lib/protocol/errors"
import { guardsFrom, openGuards, parseOutput, type ActionOutput, type GuardRates, type GuardResult } from "@/lib/protocol/guards"
import { useManifest } from "@/components/app/manifest-provider"
import type { MarketState } from "@/lib/protocol/market-state"
import { simulateInvocation, type SimulationOutcome } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"

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
  return [
    input.action,
    input.marketId,
    input.source,
    input.amount.toString(),
    input.secondaryAmount?.toString() ?? "",
    input.desired ? `${input.desired.pt}/${input.desired.sy}` : "",
  ]
}

/**
 * The input with zero floors (and the Buy YT budget as its max_net_cost): what is simulated. The USDY
 * flash needs the exchange rate for that budget (R5-3), and this throws the reason without it.
 */
export const withOpenGuards = (input: ActionInput, rates?: GuardRates): ActionInput => ({
  ...input,
  guards: openGuards(input.action, input.amount, rates),
})

/**
 * `withOpenGuards`, or null while a rate it needs is not read (the USDY flash's exchange rate, R5-3):
 * nothing is simulated then, and the simulation waits for the market data rather than failing.
 */
function openFor(input: ActionInput, rates?: GuardRates): ActionInput | null {
  try {
    return withOpenGuards(input, rates)
  } catch {
    return null
  }
}

/** The rate an action's open guards depend on, as a key part: only the USDY flash's budget in SY needs one (R5-3). */
function rateKey(input: ActionInput, rates?: GuardRates): string[] {
  return input.action === "buy_yt_flash_underlying" ? [rates?.exchangeRate.toString() ?? "no-rate"] : []
}

/** One simulation of the real call as the user; a throw becomes an `rpc_error` outcome. Also used per route step. */
export async function simulate(m: Manifest, input: ActionInput): Promise<SimulationOutcome> {
  try {
    return await simulateInvocation({
      rpcUrl: m.rpcUrl,
      networkPassphrase: m.networkPassphrase,
      source: input.source,
      invocation: invocationFor(m, input),
    })
  } catch (error) {
    return { ok: false, kind: "rpc_error", message: userErrorMessage(error) }
  }
}

/**
 * The rates the floors may need (R5-3: the SY exchange rate), from market state that is neither
 * stale nor unread (R35), and only while the exchange rate itself is live. Also used by the route runner.
 */
export function ratesFrom(market: { data?: MarketState; stale: boolean }): GuardRates | undefined {
  const xr = market.stale ? undefined : market.data?.exchangeRate
  return xr?.status === "live" ? { exchangeRate: xr.value } : undefined
}

/**
 * The validated output and the floors at `slippageBps`; an unreadable result is a refusal. Also used
 * per route step. `rates` is the live SY exchange rate, when there is one (R5-3).
 */
export function derive(
  input: ActionInput,
  outcome: SimulationOutcome,
  slippageBps: bigint,
  rates?: GuardRates,
): { output?: ActionOutput; guards?: GuardResult } {
  if (!outcome.ok) return {}
  try {
    const output = parseOutput(input.action, outcome.retval)
    return { output, guards: guardsFrom(input.action, input, output, slippageBps, rates) }
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
  const manifest = useManifest()
  const network = manifest.network
  const key = input ? keyParts(input).join("|") : null
  // The panel's own market query (same key): the exchange rate the USDY flash's bound needs (R5-3).
  const rates = ratesFrom(useMarketState(input?.marketId ?? null))

  const [settled, setSettled] = useState<string | null>(null)
  useEffect(() => {
    if (key === null) return
    const timer = setTimeout(() => setSettled(key), SIMULATION_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [key])
  const live = input !== null && settled === key ? input : null
  // What is simulated, with the rates of this render. The rate an open guard depends on is in the
  // query key, so an outcome is always for these rates, and the floors are derived with them.
  const open = live ? openFor(live, rates) : null

  const queryKey = ["simulation", network, ...(live ? [...keyParts(live), ...rateKey(live, rates)] : ["idle"])]
  const query = useQuery({
    queryKey,
    // The latest render's input: its deadline is current when the outcome is re-read.
    queryFn: async () => {
      if (!open) throw new Error("Nothing to simulate.")
      return simulate(manifest, open)
    },
    enabled: open !== null,
    gcTime: 0,
    retry: false,
    refetchInterval: MARKET_REFETCH_MS,
  })

  const outcome = open ? query.data : undefined
  return {
    outcome,
    ...(open && outcome ? derive(open, outcome, slippageBps, rates) : {}),
    simulated: open && outcome ? open : undefined,
    pending: input !== null && outcome === undefined,
    // Reset, not refetch: the old outcome (e.g. "restore required") must not stand meanwhile.
    refresh: () => void queryClient.resetQueries({ queryKey, exact: true }),
  }
}
