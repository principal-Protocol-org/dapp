import "server-only"

/**
 * `GET /api/health` (spec 0004 D-28): what the server sees, for uptime monitors and reviewers. Public,
 * no auth, no secret, cached 15 s at the edge. It answers 200 while any part reads:
 *
 * ```
 * { network,
 *   ledger:     { status: "ok", sequence, closeTime },
 *   indexer:    { status: "ok", indexedThrough, indexedThroughCloseTime, lagSeconds, gaps },
 *   keeper:     { status: "ok", healthy, lastSuccessAt, lastTickAt },
 *   openAlerts: { status: "ok", count, critical } }
 * ```
 *
 * Each part is read on its own, at most `HEALTH_PART_TIMEOUT_MS`: a part that fails or hangs reads
 * `{ status: "unavailable", reason }` (this app's words, never an error's text) and the others still
 * answer. `keeper.healthy` is null while no keeper run is recorded (unknown, not unhealthy). When every
 * part is unavailable it answers 503 (not cached), so an uptime monitor sees the server is blind.
 * `connection()` keeps it out of the build's prerender.
 */
import { connection } from "next/server"
import { MainnetPendingError } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { createRpcServer, getLedgerClock } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"
import { openAlertCounts } from "@/lib/server/alerts"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { getIndexedEvents } from "@/lib/server/indexer"
import { mainnetPendingResponse } from "@/lib/server/mainnet-pending"
import { keeperHealth, ORACLE_TICK_INTERVAL_SECONDS } from "@/lib/server/oracle-ticks"

/** Uptime monitors give up after a few seconds: no part waits longer than this. */
export const HEALTH_PART_TIMEOUT_MS = 4_000

const CACHED = "public, s-maxage=15, stale-while-revalidate=15"

type Unavailable = { status: "unavailable"; reason: string }
type Part<T> = ({ status: "ok" } & T) | Unavailable

const TIMED_OUT = Symbol("timed out")

/** One part: its value, or unavailable with a fixed reason. Never throws. */
async function part<T extends object>(read: () => Promise<T>, failed: string): Promise<Part<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), HEALTH_PART_TIMEOUT_MS)
  })
  try {
    const value = await Promise.race([read(), timeout])
    if (value === TIMED_OUT) return { status: "unavailable", reason: "timed out" }
    return { status: "ok", ...value }
  } catch (error) {
    return { status: "unavailable", reason: error instanceof DatabaseConfigError ? "the database is not configured" : failed }
  } finally {
    clearTimeout(timer)
  }
}

export async function GET() {
  await connection()
  let manifest: Manifest | null = null
  try {
    manifest = activeManifest()
  } catch (error) {
    if (error instanceof MainnetPendingError) return mainnetPendingResponse()
    const none: Unavailable = { status: "unavailable", reason: "the manifest could not be read" }
    return Response.json({ network: null, ledger: none, indexer: none, keeper: none, openAlerts: none }, { status: 503, headers: { "cache-control": "no-store" } })
  }
  const { network } = manifest
  const oracle = manifest.shared.oracle
  const rpcUrl = manifest.rpcUrl

  const [ledger, indexer, keeper, openAlerts] = await Promise.all([
    part(async () => {
      const clock = await getLedgerClock(createRpcServer(rpcUrl))
      return { sequence: clock.sequence, closeTime: new Date(clock.closeTime * 1000).toISOString() }
    }, "the RPC could not be read"),
    part(async () => {
      const ix = await getIndexedEvents(sql, { network, limit: 1 })
      return { indexedThrough: ix.indexedThrough, indexedThroughCloseTime: ix.indexedThroughCloseTime, lagSeconds: ix.lagSeconds, gaps: ix.gaps }
    }, "the database could not be read"),
    part(async () => {
      const k = await keeperHealth(sql, network, ORACLE_TICK_INTERVAL_SECONDS, { oracle })
      return { healthy: k.lastTickAt === null ? null : k.healthy, lastSuccessAt: k.lastSuccessAt, lastTickAt: k.lastTickAt }
    }, "the database could not be read"),
    part(() => openAlertCounts(sql, network), "the database could not be read"),
  ])
  const blind = [ledger, indexer, keeper, openAlerts].every((p) => p.status === "unavailable")
  return Response.json({ network, ledger, indexer, keeper, openAlerts }, blind ? { status: 503, headers: { "cache-control": "no-store" } } : { headers: { "cache-control": CACHED } })
}
