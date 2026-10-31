"use client"

import { useMemo } from "react"
import { validateManifest } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { Finding } from "@/lib/protocol/types"

/** Problems found in the resolved manifest. An `error` finding means the data cannot be trusted. */
export function useManifestFindings(): Finding[] {
  const manifest = useManifest()
  return useMemo(() => validateManifest(manifest), [manifest])
}
