import "server-only"

/**
 * What the manager page reads on the server (spec 0002 §5, R2-38): the registry's invalid rows
 * with their reason, and the salts of markets the factory started that are not listed yet (spec §5
 * "Resuming"). Request-time, like the resolved manifest.
 */
import { connection } from "next/server"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { sql } from "./db"
import { invalidMarkets, resumableSalts, sqlRegistryStore } from "./registry"

export async function invalidRegistryMarkets() {
  await connection()
  return invalidMarkets({ store: sqlRegistryStore(sql), manifest: activeManifest() })
}

export async function resumableRegistrySalts() {
  await connection()
  return resumableSalts({ store: sqlRegistryStore(sql), manifest: activeManifest() })
}
