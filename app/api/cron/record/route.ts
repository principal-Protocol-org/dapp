import "server-only"

/**
 * `GET /api/cron/record`: the 15-minute recorder (spec 0002 §6). Called by Vercel Cron
 * (`Authorization: Bearer $CRON_SECRET`) or by an Upstash QStash schedule (`Upstash-Signature`);
 * any other caller gets 401 and nothing runs. The answer is `{ recorded, failed }`.
 *
 * Route handlers run at request time under Cache Components when they read the request or touch
 * the network, and this one does both, so it is never prerendered. No `runtime` export: Cache
 * Components runs handlers on the default Node.js runtime.
 */
import { createHash, timingSafeEqual } from "node:crypto"
import { Receiver } from "@upstash/qstash"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer } from "@/lib/protocol/stellar"
import { DatabaseConfigError, sql } from "@/lib/server/db"
import { recordAll } from "@/lib/server/recorder"
import { discover, resolvedMarkets, revalidate, sqlRegistryStore } from "@/lib/server/registry"

// Discovery (a few getEvents pages), ~40 validation reads per market, then ~30 simulations per
// market, a few attempts, one insert.
export const maxDuration = 60

const sha256 = (value: string) => createHash("sha256").update(value).digest()

/** Constant-time: both sides are hashed to equal length before `timingSafeEqual`. */
function bearerMatches(header: string | null): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret || !header?.startsWith("Bearer ")) return false
  return timingSafeEqual(sha256(header.slice("Bearer ".length)), sha256(secret))
}

/**
 * The URL QStash signs for this route: `QSTASH_RECORD_URL`, else the production domain Vercel
 * provides. Without either the QStash path refuses (fail closed): a signature issued for another
 * destination of the same QStash account must not be accepted here.
 */
function expectedUrl(): string | null {
  const configured = process.env.QSTASH_RECORD_URL
  if (configured) return configured
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL
  return host ? `https://${host}/api/cron/record` : null
}

async function signatureValid(request: Request): Promise<boolean> {
  const signature = request.headers.get("upstash-signature")
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY
  const url = expectedUrl()
  if (!signature || !currentSigningKey || !nextSigningKey || !url) return false
  try {
    return await new Receiver({ currentSigningKey, nextSigningKey }).verify({
      signature,
      body: await request.text(),
      url,
    })
  } catch {
    return false
  }
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } })

export async function GET(request: Request) {
  const authorized = bearerMatches(request.headers.get("authorization")) || (await signatureValid(request))
  if (!authorized) return json({ error: "unauthorized" }, 401)

  const manifest = activeManifest()
  try {
    const server = createRpcServer(manifest.rpcUrl)
    const reader = createRpcReader(manifest)
    const store = sqlRegistryStore(sql)
    const registry = { store, reader, rpc: server, manifest }
    const result = await recordAll({
      reader,
      sql,
      manifest,
      // Spec §1 / R2-36: discover new markets, re-validate the listed ones, then record what is
      // listed. Each stops at its deadline and resumes next run (R2-40); discovery gets 60 % of the
      // budget, so a flood of new pools never starves the re-check of the listed markets.
      refreshRegistry: async (deadline) => {
        const found = await discover(registry, { deadline: Date.now() + (deadline - Date.now()) * 0.6 })
        await revalidate(registry, { skip: new Set(found.checked), deadline })
      },
      markets: () => resolvedMarkets({ store, manifest }),
      now: () => Date.now(),
      ledgerCloseTime: async (ledger) => {
        const page = await server.getLedgers({ startLedger: ledger, pagination: { limit: 1 } })
        const found = page.ledgers.find((l) => l.sequence === ledger)
        if (!found) throw new Error(`ledger ${ledger} not found on the RPC node`)
        return Number(found.ledgerCloseTime)
      },
    })
    // Non-2xx when any market failed, so a scheduler alerts instead of seeing success.
    return json(result, result.failed.length > 0 ? 500 : 200)
  } catch (error) {
    if (error instanceof DatabaseConfigError) return json({ error: "not_configured" }, 503)
    console.error("recorder route failed:", error instanceof Error ? error.name : "unknown")
    return json({ error: "failed" }, 500)
  }
}
