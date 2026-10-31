import "server-only"

/**
 * The manifest pages render with (spec 0002 §1): the static manifest, its `markets` replaced by
 * the resolved list — the seeds and the valid registry markets, or the seeds alone when the
 * database is down (R2-36). It reads cached verdicts only; nothing is validated here.
 *
 * `connection()` makes it request-time: without it, a database that is down during the build
 * would let the seeds-only answer be prerendered into the static shell. Callers read it inside
 * `<Suspense>` (like the market id, V3). React `cache` shares one read per request between the
 * app layout and the market route.
 */
import { connection } from "next/server"
import { cache } from "react"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { Manifest } from "@/lib/protocol/types"
import { sql } from "./db"
import { resolvedMarkets, sqlRegistryStore } from "./registry"

export const resolvedManifest = cache(async (): Promise<Manifest> => {
  await connection()
  const manifest = activeManifest()
  return { ...manifest, markets: await resolvedMarkets({ store: sqlRegistryStore(sql), manifest }) }
})
