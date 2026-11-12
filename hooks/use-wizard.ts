"use client"

import { useMemo, useSyncExternalStore } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { useManifest } from "@/components/app/manifest-provider"
import { readWizardSalts } from "@/lib/app/wizard-salts"
import { predictMarket, readDefaults, readFixedParams, readSacAdmin } from "@/lib/protocol/factory"
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
  refetchInterval: PROGRESS_REFETCH_MS,
})

/** Where `salt`'s market stands, read from the chain (`marketProgress`); an error when it cannot be read. */
export function useMarketProgress(salt: string) {
  const manifest = useManifest()
  return useQuery(progressQuery(manifest, salt))
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

function subscribeStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange)
  return () => window.removeEventListener("storage", onChange)
}

/**
 * The markets this browser started creating (`wizard-salts`), each with its progress read from the
 * chain: what the manager view lists as "Resume at step N".
 */
export function useMarketsInProgress() {
  const manifest = useManifest()
  // Browser storage, as a string snapshot (stable by value); none on the server and during hydration.
  const raw = useSyncExternalStore(
    subscribeStorage,
    () => readWizardSalts(manifest.network).join(","),
    () => "",
  )
  const salts = useMemo(() => (raw === "" ? [] : raw.split(",")), [raw])
  const queries = useQueries({ queries: salts.map((salt) => progressQuery(manifest, salt)) })
  return salts.map((salt, i) => ({ salt, progress: queries[i] }))
}
