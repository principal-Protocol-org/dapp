import "server-only"

/**
 * The API's side of the pending Mainnet stub (D-24): while `config/manifests/mainnet.json` is
 * `{ "network": "mainnet", "pending": true }`, every route answers 503 `not_configured` with
 * "Mainnet contracts are not deployed yet.", never cached, and reads nothing.
 */
import { MAINNET_PENDING_MESSAGE, MainnetPendingError } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import type { Manifest } from "@/lib/protocol/types"

export function mainnetPendingResponse(): Response {
  return Response.json({ error: "not_configured", message: MAINNET_PENDING_MESSAGE }, { status: 503, headers: { "cache-control": "no-store" } })
}

/** The active manifest, or the pending answer a route returns as is. Any other manifest error is thrown, as before. */
export function deployedManifest(): Manifest | Response {
  try {
    return activeManifest()
  } catch (error) {
    if (error instanceof MainnetPendingError) return mainnetPendingResponse()
    throw error
  }
}
