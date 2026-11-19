import "server-only"

/**
 * `GET /api/health` (spec 0004 D-28): what the server sees, for uptime monitors and reviewers. Public,
 * no auth, no secret, cached 15 s at the edge. It answers 200 while any part reads:
 *
 * ```
 * { network,
 *   ledger:     { status: "ok", sequence, closeTime },
 *   indexer:    { status: "ok", indexedThrough, indexedThroughCloseTime, lagSeconds, gaps, pendingGroups },
 *   keeper:     { status: "ok", healthy, lastSuccessAt, lastOkAt, lastTickAt },
 *   keepers:    [{ oracle, asset, healthy, lastOkAt, lastTickAt }],
 *   openAlerts: { status: "ok", count, critical } }
 * ```
 *
 * Each part is read on its own, at most `HEALTH_PART_TIMEOUT_MS`: a part that fails or hangs reads
 * `{ status: "unavailable", reason }` (this app's words, never an error's text) and the others still
 * answer. The keeper is read per oracle of the manifest's markets: `keepers` lists each (null while
 * the keeper part is unavailable), and `keeper` stays one object, for monitors, with the worst
 * oracle's state (`worstKeeper`). `healthy` is null while no keeper run is recorded (unknown, not
 * unhealthy). The indexer
 * reads `{ status: "pending", reason: "no index run yet", … }` while a group has no cursor yet
 * (`pendingGroups` names them): not ok, and not unavailable either. When every part is unavailable it
 * answers 503 (not cached), so an uptime monitor sees the server is blind.
 * `connection()` keeps it out of the build's prerender.
 */
import { connection } from "next/server"
import { assetCodes, manifestOracles } from "@/lib/protocol/manifest"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { createRpcServer, getLedgerClock } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"
import { openAlertCounts } from "@/lib/server/alerts"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { getIndexedEvents } from "@/lib/server/indexer"
import { keeperHealth, keeperIntervalSeconds, type KeeperHealth } from "@/lib/server/oracle-ticks"

/** Uptime monitors give up after a few seconds: no part waits longer than this. */
export const HEALTH_PART_TIMEOUT_MS = 4_000

const CACHED = "public, s-maxage=15, stale-while-revalidate=15"

type Unavailable = { status: "unavailable"; reason: string }
type Part<T> = ({ status: "ok" } & T) | Unavailable

/** Health's word for an indexer with a group no run has indexed yet. */
const NO_INDEX_RUN_YET = "no index run yet"

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

/** One oracle's keeper, as `keepers` lists it: `healthy` null while no run of it is recorded. */
type OracleKeeper = { oracle: string; asset: string; healthy: boolean | null; lastOkAt: string | null; lastTickAt: string | null }

/** Unhealthy first, then unknown (no run yet), then healthy; among equals, the oldest `lastOkAt` (none recorded is the oldest). */
const rank = (k: OracleKeeper) => (k.healthy === false ? 0 : k.healthy === null ? 1 : 2)
const okTime = (k: OracleKeeper) => (k.lastOkAt === null ? Number.NEGATIVE_INFINITY : Date.parse(k.lastOkAt))

/** The oracle `keeper` describes: the worst of `keepers` (an oracle with no run makes a healthy keeper unknown, never an unhealthy one healthy). */
function worstKeeper<T extends OracleKeeper>(keepers: T[]): T {
  return keepers.reduce((worst, k) => (rank(k) < rank(worst) || (rank(k) === rank(worst) && okTime(k) < okTime(worst)) ? k : worst))
}

type KeeperSeen = OracleKeeper & { lastSuccessAt: string | null }
type KeeperPart = Part<{ healthy: boolean | null; lastSuccessAt: string | null; lastOkAt: string | null; lastTickAt: string | null }>

/**
 * `keeper` keeps its one-object shape (monitors parse it): the worst oracle's state; `keepers` lists
 * each oracle, null while the part is unavailable. A manifest with no market has no oracle: nothing is
 * known, as before the first run.
 */
function keeperParts(read: Part<{ each: KeeperSeen[] }>): { keeper: KeeperPart; keepers: OracleKeeper[] | null } {
  if (read.status !== "ok") return { keeper: read, keepers: null }
  const w = read.each.length > 0 ? worstKeeper(read.each) : { healthy: null, lastSuccessAt: null, lastOkAt: null, lastTickAt: null }
  return {
    keeper: { status: "ok", healthy: w.healthy, lastSuccessAt: w.lastSuccessAt, lastOkAt: w.lastOkAt, lastTickAt: w.lastTickAt },
    keepers: read.each.map(({ oracle, asset, healthy, lastOkAt, lastTickAt }) => ({ oracle, asset, healthy, lastOkAt, lastTickAt })),
  }
}

export async function GET() {
  await connection()
  let manifest: Manifest | null = null
  try {
    manifest = activeManifest()
  } catch {
    const none: Unavailable = { status: "unavailable", reason: "the manifest could not be read" }
    return Response.json({ network: null, ledger: none, indexer: none, keeper: none, keepers: null, openAlerts: none }, { status: 503, headers: { "cache-control": "no-store" } })
  }
  const { network } = manifest
  const oracles = manifestOracles(manifest)
  const rpcUrl = manifest.rpcUrl
  // The keeper's schedule, read per request: a bad value makes the keeper part unavailable, never a silent default.
  let intervalSeconds: number | null = null
  try {
    intervalSeconds = keeperIntervalSeconds(process.env)
  } catch {
    // Reported as the keeper part's reason below.
  }

  const [ledger, indexer, keepersPart, openAlerts] = await Promise.all([
    part(async () => {
      const clock = await getLedgerClock(createRpcServer(rpcUrl))
      return { sequence: clock.sequence, closeTime: new Date(clock.closeTime * 1000).toISOString() }
    }, "the RPC could not be read"),
    part(async () => {
      const ix = await getIndexedEvents(sql, { network, limit: 1 })
      return { indexedThrough: ix.indexedThrough, indexedThroughCloseTime: ix.indexedThroughCloseTime, lagSeconds: ix.lagSeconds, gaps: ix.gaps, pendingGroups: ix.pendingGroups }
    }, "the database could not be read"),
    intervalSeconds === null
      ? ({ status: "unavailable", reason: "the keeper's interval is not valid" } satisfies Unavailable)
      : part(async () => {
          // One read per oracle, side by side, within the part's 4 s; one that fails makes the part unavailable.
          const each = await Promise.all(
            oracles.map(async ({ oracle, markets }): Promise<KeeperSeen> => {
              const k: KeeperHealth = await keeperHealth(sql, network, intervalSeconds, { oracle })
              return { oracle, asset: assetCodes(markets), healthy: k.lastTickAt === null ? null : k.healthy, lastOkAt: k.lastOkAt, lastTickAt: k.lastTickAt, lastSuccessAt: k.lastSuccessAt }
            }),
          )
          return { each }
        }, "the database could not be read"),
    part(() => openAlertCounts(sql, network), "the database could not be read"),
  ])
  // Before the first run of a group the index is not "ok": it says so, with the groups still to run.
  const index = indexer.status === "ok" && indexer.pendingGroups.length > 0 ? { ...indexer, status: "pending" as const, reason: NO_INDEX_RUN_YET } : indexer
  const { keeper, keepers } = keeperParts(keepersPart)
  const blind = [ledger, index, keeper, openAlerts].every((p) => p.status === "unavailable")
  return Response.json(
    { network, ledger, indexer: index, keeper, keepers, openAlerts },
    blind ? { status: 503, headers: { "cache-control": "no-store" } } : { headers: { "cache-control": CACHED } },
  )
}
