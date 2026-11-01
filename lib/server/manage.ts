import "server-only"

/**
 * What the manager page reads on the server (spec 0002 §5, R2-38): the registry's invalid rows
 * with their reason. Request-time, like the resolved manifest.
 */
import { connection } from "next/server"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { sql } from "./db"
import { invalidMarkets, sqlRegistryStore } from "./registry"

export async function invalidRegistryMarkets() {
  await connection()
  return invalidMarkets({ store: sqlRegistryStore(sql), manifest: activeManifest() })
}
