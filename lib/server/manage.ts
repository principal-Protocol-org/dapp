import "server-only"

/**
 * What the manager page reads on the server (spec 0002 §5, R2-38): the registry's invalid rows
 * with their reason, and the salts of markets the factory started that are not listed yet (spec §5
 * "Resuming"). Request-time, like the resolved manifest.
 */
import { connection } from "next/server"
import { activeManifest, manifestPending } from "@/lib/protocol/manifest-source"
import { sql } from "./db"
import { invalidMarkets, resumableSalts, sqlRegistryStore } from "./registry"

/**
 * Next renders the manage page in parallel with the `/app` layout, even while the layout shows the
 * pending Mainnet page instead (D-24): then nothing is read, and the answer is `unavailable`.
 */
export async function invalidRegistryMarkets() {
  await connection()
  if (manifestPending()) return { status: "unavailable" as const }
  return invalidMarkets({ store: sqlRegistryStore(sql), manifest: activeManifest() })
}

export async function resumableRegistrySalts() {
  await connection()
  if (manifestPending()) return { status: "unavailable" as const }
  return resumableSalts({ store: sqlRegistryStore(sql), manifest: activeManifest() })
}
