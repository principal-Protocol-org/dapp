"use client"

import { useMemo } from "react"
import { validateManifest } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { Finding } from "@/lib/protocol/types"

/** Problems found in the active manifest. An `error` finding means the data cannot be trusted. */
export function useManifestFindings(): Finding[] {
  return useMemo(() => validateManifest(activeManifest()), [])
}
