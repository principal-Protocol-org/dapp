"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { useManifest } from "@/components/app/manifest-provider"
import { forgetWizardSalt, readWizardSalts, subscribeWizardSalts } from "@/lib/app/wizard-salts"
import { deriveMarketContracts, predictMarket, readContractAdmin, readDefaults, readFixedParams, readProtocolAdmin, readSacAdmin } from "@/lib/protocol/factory"
import { marketProgress, type MarketProgress } from "@/lib/protocol/market-progress"
import { createRpcReader } from "@/lib/protocol/reader"
import { readSeedState } from "@/lib/protocol/seed"
import { createRpcServer } from "@/lib/protocol/stellar"
import type { Manifest, Market, MarketContracts } from "@/lib/protocol/types"

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
 * What the seed (step 6) reads for the new market: the unseeded pool's state, the oracle's freshness,
 * the SY exchange rate, the tokenization fee, and the signer's PT and SY of this market. Polled like
 * the progress, and refreshed by every signed manager transaction.
 */
export function useSeedState(predicted: MarketContracts, account: string | null) {
  const manifest = useManifest()
  return useQuery({
    queryKey: ["manage", manifest.network, "seed-state", predicted.pool, account],
    queryFn: () => readSeedState(createRpcReader(manifest), manifest, predicted, account),
    refetchInterval: PROGRESS_REFETCH_MS,
  })
}

/** The Resume list is read on mount and on focus, not polled, and a read stays fresh this long (ms). */
export const IN_PROGRESS_STALE_MS = 60_000

/** A half-finished market from the registry: its salt and the asset its SY wraps (checked on chain when indexed). */
export type RegistrySalt = { salt: string; underlying: string }

/**
 * The markets being created that the manager view lists as "Resume at step N" (spec 0002 §5
 * "Resuming"), each with its progress read from the chain:
 *
 * - the salts this browser started (`wizard-salts`), whoever is connected. One whose pool is listed
 *   has nothing left to resume, and one with nothing on chain (a reset network) never had: both are
 *   forgotten;
 * - the registry's salts (`registry`, from the factory's events, so from any browser), deduplicated
 *   with those, and listed only to `account` when it is the asset's issuer or the market's protocol
 *   admin, and only while the pool is not listed.
 *
 * Ownership is decided before any progress is read (a full progress read is some thirty RPC calls):
 * one SAC `admin()` read per asset covers all its salts, then one `protocol_admin()` read per salt on
 * an asset this account does not issue (its config is derived from the salt, locally). A read that
 * fails is "not this account's". Without a wallet the registry's salts cost no read at all.
 *
 * Nothing here is polled: each read is made on mount (and on focus) and stays fresh for a minute
 * (`IN_PROGRESS_STALE_MS`).
 */
export function useMarketsInProgress(registry: readonly RegistrySalt[] = [], account: string | null = null) {
  const manifest = useManifest()
  const { network } = manifest
  // Browser storage, as a string snapshot (stable by value); none on the server and during hydration.
  const raw = useSyncExternalStore(
    subscribeWizardSalts,
    () => readWizardSalts(network).join(","),
    () => "",
  )
  const salts = useMemo(() => (raw === "" ? [] : raw.split(",")), [raw])
  const fromRegistry = account === null ? [] : registry.filter((r) => !salts.includes(r.salt))

  // 1. The asset's issuer: one admin() per asset.
  const assets = [...new Set(fromRegistry.map((r) => r.underlying))]
  const sacAdmins = useQueries({
    queries: assets.map((sac) => ({
      queryKey: ["manage", network, "sac-admin", sac],
      queryFn: () => readSacAdmin(createRpcReader(manifest), sac),
      staleTime: IN_PROGRESS_STALE_MS,
    })),
  })
  const adminOf = (sac: string) => sacAdmins[assets.indexOf(sac)]?.data
  const issues = (sac: string) => {
    const a = adminOf(sac)
    return a?.status === "live" && a.value === account
  }
  // 2. The protocol admin, for the salts on an asset this account does not issue.
  const others = fromRegistry.filter((r) => adminOf(r.underlying) !== undefined && !issues(r.underlying))
  const protocolAdmins = useQueries({
    queries: others.map((r) => ({
      queryKey: ["manage", network, "protocol-admin", r.salt],
      queryFn: () => readProtocolAdmin(createRpcReader(manifest), deriveMarketContracts(manifest, r.salt).config),
      staleTime: IN_PROGRESS_STALE_MS,
    })),
  })
  const owned = fromRegistry
    .filter((r) => {
      if (issues(r.underlying)) return true
      const p = protocolAdmins[others.indexOf(r)]?.data
      return p?.status === "live" && p.value === account
    })
    .map((r) => r.salt)

  // 3. Progress, for this browser's salts and the registry's salts this account owns only.
  const all = [...salts, ...owned]
  const queries = useQueries({ queries: all.map((salt) => ({ ...progressQuery(manifest, salt), staleTime: IN_PROGRESS_STALE_MS })) })
  const progressOf = (salt: string) => queries[all.indexOf(salt)]?.data as MarketProgress | undefined

  const listed = useMemo(() => new Set(manifest.markets.map((m) => m.contracts.pool)), [manifest])
  const done = salts.filter((salt) => {
    const p = progressOf(salt)
    return p !== undefined && (p.step === 1 || listed.has(p.predicted.pool))
  })
  const doneKey = done.join(",")
  useEffect(() => {
    for (const salt of doneKey === "" ? [] : doneKey.split(",")) forgetWizardSalt(network, salt)
  }, [doneKey, network])

  const shown = [
    ...salts.filter((salt) => !done.includes(salt)),
    ...owned.filter((salt) => {
      const p = progressOf(salt)
      return p === undefined || (p.step !== 1 && !listed.has(p.predicted.pool))
    }),
  ]
  return shown.map((salt) => ({ salt, progress: queries[all.indexOf(salt)] }))
}
