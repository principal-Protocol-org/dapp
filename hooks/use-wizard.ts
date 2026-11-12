"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { useManifest } from "@/components/app/manifest-provider"
import { forgetWizardSalt, readWizardSalts, subscribeWizardSalts } from "@/lib/app/wizard-salts"
import { predictMarket, readContractAdmin, readDefaults, readFixedParams, readSacAdmin } from "@/lib/protocol/factory"
import { marketProgress, type MarketProgress } from "@/lib/protocol/market-progress"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer } from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"

/**
 * The market-creation wizard's chain reads (spec 0002 §5, R5-10). Every key starts with
 * `["manage", network]`, which a signed manager transaction refreshes (`useExecute`), so the step
 * moves on as soon as the chain does.
 */
const PROGRESS_REFETCH_MS = 30_000

const progressKey = (manifest: Manifest, salt: string) => ["manage", manifest.network, "wizard-progress", salt] as const
const progressQuery = (manifest: Manifest, salt: string) => ({
  queryKey: progressKey(manifest, salt),
  queryFn: () => marketProgress(createRpcReader(manifest), createRpcServer(manifest.rpcUrl), manifest, salt),
})

/**
 * Where `salt`'s market stands, read from the chain (`marketProgress`), and polled while the wizard
 * shows it. A failed refresh keeps the last read (`data`) beside the error.
 */
export function useMarketProgress(salt: string) {
  const manifest = useManifest()
  return useQuery({ ...progressQuery(manifest, salt), refetchInterval: PROGRESS_REFETCH_MS })
}

/** The current market's settings, the defaults of a new one; none without a current market. */
export function useParamDefaults(market: Market | undefined) {
  const manifest = useManifest()
  return useQuery({
    queryKey: ["manage", manifest.network, "wizard-defaults", market?.marketId],
    queryFn: () => readDefaults(createRpcReader(manifest), market as Market),
    enabled: market !== undefined,
    staleTime: Infinity,
  })
}

/** What a half-deployed market already fixed on chain; read only once a phase has run. */
export function useFixedParams(salt: string, progress: MarketProgress | undefined) {
  const manifest = useManifest()
  const phases = progress?.phases
  return useQuery({
    queryKey: ["manage", manifest.network, "wizard-fixed", salt, phases?.tokens, phases?.engine],
    queryFn: () => readFixedParams(createRpcReader(manifest), (progress as MarketProgress).predicted, phases as MarketProgress["phases"]),
    enabled: phases !== undefined && phases.tokens,
    staleTime: Infinity,
  })
}

/** Step 2: `predict_market`, read on chain and checked against the salt's derivation. */
export function usePredictedMarket(salt: string) {
  const manifest = useManifest()
  return useQuery({
    queryKey: ["manage", manifest.network, "wizard-predict", salt],
    queryFn: () => predictMarket(createRpcReader(manifest), manifest, salt),
    staleTime: Infinity,
  })
}

/** The asset contract's `admin()`: who must sign a deployment on it (R5-10). */
export function useSacAdmin(sac: string | undefined) {
  const manifest = useManifest()
  return useQuery({
    queryKey: ["manage", manifest.network, "sac-admin", sac],
    queryFn: () => readSacAdmin(createRpcReader(manifest), sac as string),
    enabled: sac !== undefined,
    refetchInterval: PROGRESS_REFETCH_MS,
  })
}

/** A shared contract's `get_admin()` (RiskControl, Router, Permissioning): who must sign its wiring and grants. */
export function useContractAdmin(contractId: string) {
  const manifest = useManifest()
  return useQuery({
    queryKey: ["manage", manifest.network, "contract-admin", contractId],
    queryFn: () => readContractAdmin(createRpcReader(manifest), contractId),
    refetchInterval: PROGRESS_REFETCH_MS,
  })
}

/**
 * The markets this browser started creating (`wizard-salts`), each with its progress read from the
 * chain: what the manager view lists as "Resume at step N". Each is read on mount (and on focus), not
 * polled: a full progress read is some thirty RPC calls. A salt whose pool is listed has nothing left
 * to resume, and one with nothing on chain (a reset network) never had: both are forgotten.
 */
export function useMarketsInProgress() {
  const manifest = useManifest()
  // Browser storage, as a string snapshot (stable by value); none on the server and during hydration.
  const raw = useSyncExternalStore(
    subscribeWizardSalts,
    () => readWizardSalts(manifest.network).join(","),
    () => "",
  )
  const salts = useMemo(() => (raw === "" ? [] : raw.split(",")), [raw])
  const queries = useQueries({ queries: salts.map((salt) => progressQuery(manifest, salt)) })

  const listed = useMemo(() => new Set(manifest.markets.map((m) => m.contracts.pool)), [manifest])
  const done = salts.filter((salt, i) => {
    const p = queries[i]?.data
    return p !== undefined && (p.step === 1 || listed.has(p.predicted.pool))
  })
  const doneKey = done.join(",")
  useEffect(() => {
    for (const salt of doneKey === "" ? [] : doneKey.split(",")) forgetWizardSalt(manifest.network, salt)
  }, [doneKey, manifest.network])

  return salts.filter((salt) => !done.includes(salt)).map((salt) => ({ salt, progress: queries[salts.indexOf(salt)] }))
}
