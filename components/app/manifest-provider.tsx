"use client"

import { createContext, useContext, useMemo } from "react"
import type { Manifest } from "@/lib/protocol/types"

/**
 * The manifest client code reads (spec 0002 §1): resolved on the server by the app layout — the
 * static manifest with the seeds and the valid registry markets — and passed down once. Client code
 * never reads the static manifest itself, so a market discovered or published since the deploy is
 * listed without a redeploy. 0001's topology gate still runs before every action.
 *
 * `seedCount` is the static manifest's market count: the resolved list leaves out a seed the
 * registry marked invalid, so "N of M markets listed" needs M from the server.
 */
const ManifestContext = createContext<{ manifest: Manifest; seedCount: number } | null>(null)

const MISSING = "needs a <ManifestProvider> above it: the app layout resolves the manifest on the server and provides it."

export function ManifestProvider({ manifest, seedCount, children }: { manifest: Manifest; seedCount: number; children?: React.ReactNode }) {
  // One value per manifest and count: a new object each render would re-render every reader.
  const value = useMemo(() => ({ manifest, seedCount }), [manifest, seedCount])
  return <ManifestContext.Provider value={value}>{children}</ManifestContext.Provider>
}

export function useManifest(): Manifest {
  const value = useContext(ManifestContext)
  if (!value) throw new Error(`useManifest ${MISSING}`)
  return value.manifest
}

/** How many markets the static manifest names (its seeds), whatever the registry hides. */
export function useSeedCount(): number {
  const value = useContext(ManifestContext)
  if (!value) throw new Error(`useSeedCount ${MISSING}`)
  return value.seedCount
}
