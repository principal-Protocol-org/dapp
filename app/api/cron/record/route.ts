import "server-only"

/**
 * `GET` or `POST /api/cron/record`: the 15-minute recorder (spec 0002 §6). Called by Vercel Cron
 * (`GET`, `Authorization: Bearer $CRON_SECRET`) or by an Upstash QStash schedule (`POST` by
 * default, `Upstash-Signature`); both methods run the same checks, and any other caller gets 401
 * and nothing runs. The answer is `{ recorded, failed }`.
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

/**
 * The recorder's budget for the registry read (M9). Pages race it at 1.5 s and fall back to the
 * seeds; the recorder can wait for a cold database, or discovered markets would get gaps.
 */
const RECORDER_ROWS_TIMEOUT_MS = 10_000

const sha256 = (value: string) => createHash("sha256").update(value).digest()

/** Constant-time: both sides are hashed to equal length before `timingSafeEqual`. */
function bearerMatches(header: string | null): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret || !header?.startsWith("Bearer ")) return false
  return timingSafeEqual(sha256(header.slice("Bearer ".length)), sha256(secret))
}

/**
 * A QStash signature is bound to the URL it was sent to, so it is checked against the URL this
 * request came in on (R2-29, amended): a signature issued for another destination of the same QStash
 * account fails. On Vercel the platform sets the host, and a request reaches this deployment only
 * through one of its own domains, so Production, testnet and previews all work with no variable to
 * set. Off Vercel (`VERCEL` unset), a proxy could pass a client's Host header through and let the
 * caller choose that URL, so the QStash path refuses there; the Bearer path still works.
 */
async function signatureValid(request: Request): Promise<boolean> {
  const signature = request.headers.get("upstash-signature")
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY
  if (process.env.VERCEL !== "1" || !signature || !currentSigningKey || !nextSigningKey) return false
  try {
    return await new Receiver({ currentSigningKey, nextSigningKey }).verify({
      signature,
      body: await request.text(),
      url: request.url,
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
        // M8: a failed discovery (a getEvents error, say) never skips re-validating the listed
        // markets. Only the error's name is logged: RPC text may carry a provider URL. A missing
        // database is not a discovery failure: it stops the run, as before.
        let checked: string[] = []
        try {
          checked = (await discover(registry, { deadline: Date.now() + (deadline - Date.now()) * 0.6 })).checked
        } catch (error) {
          if (error instanceof DatabaseConfigError) throw error
          console.error("registry: discovery failed:", error instanceof Error ? error.name : "unknown")
        }
        await revalidate(registry, { skip: new Set(checked), deadline })
      },
      markets: () => resolvedMarkets({ store, manifest, timeoutMs: RECORDER_ROWS_TIMEOUT_MS }),
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

/** QStash schedules call with POST unless told otherwise (M13): the same handler, the same checks. */
export const POST = GET
