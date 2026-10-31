"use client"

import { createContext, useContext } from "react"
import type { Manifest } from "@/lib/protocol/types"

/**
 * The manifest client code reads (spec 0002 §1): resolved on the server by the app layout — the
 * static manifest with the seeds and the valid registry markets — and passed down once. Client code
 * never reads the static manifest itself, so a market discovered or published since the deploy is
 * listed without a redeploy. 0001's topology gate still runs before every action.
 */
const ManifestContext = createContext<Manifest | null>(null)

export function ManifestProvider({ manifest, children }: { manifest: Manifest; children?: React.ReactNode }) {
  return <ManifestContext.Provider value={manifest}>{children}</ManifestContext.Provider>
}

export function useManifest(): Manifest {
  const manifest = useContext(ManifestContext)
  if (!manifest) {
    throw new Error("useManifest needs a <ManifestProvider> above it: the app layout resolves the manifest on the server and provides it.")
  }
  return manifest
}
