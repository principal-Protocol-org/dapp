// @vitest-environment node
/**
 * The alert check on the local stack and the local Postgres (spec 0004 D-12, D-20, D-28; plan 0008
 * Task 9). A local HTTP listener stands in for the webhook (never a real external URL); it records
 * every payload it gets, and can hang to test the 5 s timeout.
 *
 * - `oracle_stale`: the local oracle's `max_stale_seconds` is shortened to 5 s with `set_safety_params`
 *   (the local oracle admin, `principal-localdev-admin`), so its value goes stale; the check opens the
 *   alert once and posts once, a second run changes nothing, and once `max_stale_seconds` is restored
 *   the check closes it once and posts once.
 * - `risk_warning` then `risk_exhausted` (D-12): the local RiskControl's limit is set to the window's
 *   volume plus 1,000 USDY, a fresh holder deposits 950 then 50; the limit is then put back. These rows
 *   are the risk page's exhaustion history.
 * - `signer_low`: the local admin key as the keeper signer, against a floor above its balance on the
 *   local Horizon, then the default floor.
 * - `oracle_unavailable` (debounced): the local manifest pointed at a closed port, so this server's
 *   reads fail. One failed run that the next run clears is never posted; two failed runs in a row post
 *   it once (confirmed), and the run that reads again posts its close.
 * - Fallback RPC (D-6): the same dead `rpcUrl` with the local RPC as `rpcFallbackUrls`; reads (and the
 *   check's ledger clock) answer from the fallback, and each read's source names it.
 * - The routes: `?test=1` with a webhook that hangs (502 after the 5 s timeout, the row kept), then one
 *   that answers (200); the scheduled check (500 exactly while a critical alert is open); `GET
 *   /api/dashboard/alerts` and `GET /api/health`. No answer and no log line holds the webhook URL.
 *
 * The keys stay in this process (the CLI's keystore, the dev stack's faucet key); none is printed. The
 * oracle's and RiskControl's settings are restored in `finally`. The alerts rows stay in the local
 * database as the local network's evidence (the dashboard reads them); a later run starts from them.
 * Skipped unless the local stack answers and `principal-pg` is migrated through 0007.
 */
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Keypair } from "@stellar/stellar-sdk"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
// The two public GET routes call `connection()` to stay out of the build's prerender.
vi.mock("next/server", () => ({ connection: async () => {} }))

import { fetchAccountState } from "@/lib/protocol/account-state"
import { createHorizon } from "@/lib/protocol/horizon"
import { addTrustline, fundWithFriendbot } from "@/lib/protocol/onboarding"
import { createRpcReader, readLive } from "@/lib/protocol/reader"
import type { Manifest } from "@/lib/protocol/types"
import { countsAsCritical } from "@/lib/app/alert-types"
import { DEBOUNCE_MIN_AGE_MS, runAlertCheck, webhookPoster, type AlertCheckResult, type AlertRef, type WebhookPayload } from "@/lib/server/alerts"
import { sql } from "@/lib/server/db"
import { createStellarFaucetChain, resetFaucetStateForTests, runFaucet } from "@/lib/server/faucet"
import { scAddress, scI128, sendAs } from "../live/admin"
import { keypairSigner } from "./keypair-signer"
import { complianceKind, createLog, eventually, faucetIssuerSecret, ledgerClock, loadDatabaseUrl, MINUTE, oracleTick, readManifest, run, skipReason, U } from "./local-stack"

const ADMIN_KEY = "principal-localdev-admin"

async function reason(): Promise<string | null> {
  const chain = await skipReason()
  if (chain) return chain
  loadDatabaseUrl()
  const url = process.env.DATABASE_URL
  if (!url) return "DATABASE_URL is not set (scripts/dev-stack/deploy.sh writes it to .env.local)"
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return "DATABASE_URL is not a connection string"
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return "DATABASE_URL is not a database on this machine; this suite writes alerts"
  try {
    await sql`select opened_posted, resolved_posted from alerts limit 1`
  } catch (error) {
    return `the local database is not reachable or not migrated through 0007 (pnpm db:migrate): ${error instanceof Error ? error.name : "unknown"}`
  }
  return null
}

const skip = await reason()
if (skip) console.info(`[alerts] skipped: ${skip}. Start it with scripts/dev-stack/up.sh, then pnpm db:migrate.`)

const out = createLog("alerts")

/** The stand-in webhook: every POST it got, and whether it answered. */
type Hit = { body: WebhookPayload; answered: boolean }
const hits: Hit[] = []
let mode: "ok" | "hang" = "ok"
const TOKEN = `local-${randomBytes(8).toString("hex")}`
let HOOK = ""
const server = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on("data", (c: Buffer) => chunks.push(c))
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WebhookPayload
    if (mode === "hang") {
      hits.push({ body, answered: false })
      return // never answers: the poster's 5 s timeout must cut it
    }
    hits.push({ body, answered: true })
    res.writeHead(200, { "content-type": "text/plain" }).end("ok")
  })
})

/** What the app logs (errors and warnings), checked for the webhook URL. */
const logged: string[] = []

async function cli(contract: string, fn: string, args: string[] = [], send = false): Promise<string> {
  const { stdout } = await run("stellar", ["contract", "invoke", "--id", contract, "--source", ADMIN_KEY, "--network", "local", ...(send ? [] : ["--send=no"]), "--", fn, ...args])
  return stdout.trim()
}

const has = (refs: AlertRef[], kind: string, subject?: string) => refs.some((r) => r.kind === kind && (subject === undefined || r.subject === subject))
const posted = (kind: string) => hits.filter((h) => h.answered && h.body.kind === kind)
const brief = (r: AlertCheckResult) =>
  `opened [${r.opened.map((a) => a.kind).join(", ")}] resolved [${r.resolved.map((a) => a.kind).join(", ")}] open [${r.open.map((a) => a.kind).join(", ")}] posted ${r.posted} failures ${r.postFailures} held [${r.held.join(", ")}] critical ${r.critical}`

describe.skipIf(skip !== null)("the alert check on the local stack", () => {
  let manifest: Manifest
  let admin: string
  let firstId = 0

  beforeAll(async () => {
    manifest = readManifest()
    admin = (await run("stellar", ["keys", "address", ADMIN_KEY])).stdout.trim()
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    HOOK = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/T000/B000/${TOKEN}`
    const [row] = await sql<{ id: string | null }>`select max(id)::text as id from alerts`
    firstId = Number(row?.id ?? 0)
    for (const level of ["error", "warn"] as const) {
      const original = console[level].bind(console)
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "))
        original(...args)
      })
    }
  })

  afterAll(async () => {
    expect(logged.join("\n")).not.toContain(TOKEN)
    expect(logged.join("\n")).not.toContain(HOOK)
    out.log(`app log lines: ${logged.length}, none with the webhook URL`)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.restoreAllMocks()
    out.summary()
  })

  const check = (env: Record<string, string> = {}) => runAlertCheck({ sql, manifest, env, post: webhookPoster(HOOK) })

  it("oracle_stale opens once and posts once on a shortened max_stale, then closes once and posts once", async () => {
    const oracle = manifest.shared.oracle
    out.log(`oracle tick first, for a fresh baseline: ${await oracleTick()}`)
    const maxStale = BigInt(JSON.parse(await cli(oracle, "max_stale_seconds")))
    const deviation = BigInt(JSON.parse(await cli(oracle, "max_deviation_bps")))
    out.log(`oracle ${oracle}: max_stale_seconds ${maxStale}, max_deviation_bps ${deviation}`)

    const baseline = await check()
    out.log(`baseline: ${brief(baseline)}`)
    expect(baseline.open.some((a) => a.kind === "oracle_stale")).toBe(false)
    const before = posted("oracle_stale").length

    try {
      await cli(oracle, "set_safety_params", ["--caller", admin, "--max_stale_seconds", "5", "--max_deviation_bps", String(deviation)], true)
      const ts = Number(JSON.parse(await cli(oracle, "get_reference_timestamp")))
      await eventually(() => ledgerClock(manifest), (c) => c.closeTime > ts + 5, "a ledger more than 5 s past the oracle's value")
      out.log(`max_stale_seconds set to 5; the value (timestamp ${ts}) is now stale`)

      const first = await check()
      out.log(`run 1: ${brief(first)}`)
      expect(has(first.opened, "oracle_stale", oracle)).toBe(true)
      expect(first.critical).toBe(true)
      expect(posted("oracle_stale").length - before).toBe(1)
      expect(posted("oracle_stale").at(-1)?.body).toMatchObject({ status: "opened", kind: "oracle_stale", subject: oracle, severity: "critical", network: "local", test: false })
      out.log(`webhook got: ${posted("oracle_stale").at(-1)?.body.text}`)

      const second = await check()
      out.log(`run 2: ${brief(second)}`)
      expect(has(second.opened, "oracle_stale")).toBe(false)
      expect(posted("oracle_stale").length - before).toBe(1)
      const [{ n }] = await sql<{ n: string }>`select count(*)::text as n from alerts where network = 'local' and kind = 'oracle_stale' and resolved_at is null`
      expect(n).toBe("1")
    } finally {
      await cli(oracle, "set_safety_params", ["--caller", admin, "--max_stale_seconds", String(maxStale), "--max_deviation_bps", String(deviation)], true)
      out.log(`max_stale_seconds restored to ${maxStale}`)
    }

    const third = await check()
    out.log(`run 3 (restored): ${brief(third)}`)
    expect(has(third.resolved, "oracle_stale", oracle)).toBe(true)
    expect(posted("oracle_stale").length - before).toBe(2)
    expect(posted("oracle_stale").at(-1)?.body).toMatchObject({ status: "resolved", kind: "oracle_stale" })
    out.log(`webhook got: ${posted("oracle_stale").at(-1)?.body.text}`)

    const fourth = await check()
    expect(has(fourth.opened, "oracle_stale") || has(fourth.resolved, "oracle_stale")).toBe(false)
    expect(posted("oracle_stale").length - before).toBe(2)

    const rows = await sql<{ id: string; opened_at: Date; resolved_at: Date | null; opened_posted: boolean; resolved_posted: boolean }>`
      select id, opened_at, resolved_at, opened_posted, resolved_posted from alerts
      where network = 'local' and kind = 'oracle_stale' and id > ${firstId} order by id`
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ opened_posted: true, resolved_posted: true })
    expect(rows[0].resolved_at && rows[0].resolved_at > rows[0].opened_at).toBe(true)
    out.log(`alerts row ${rows[0].id}: opened ${rows[0].opened_at.toISOString()}, resolved ${rows[0].resolved_at?.toISOString()}, both notices delivered`)
  }, 3 * MINUTE)

  it("risk_warning at 90% then risk_exhausted at 100% of a real limit, each opened and closed once (D-12)", async () => {
    const rc = manifest.shared.riskControl
    const market = manifest.markets[0]
    const limitBefore = BigInt(JSON.parse(await cli(rc, "get_cb_limit")))
    const volume0 = BigInt(JSON.parse(await cli(rc, "get_cb_volume")))
    out.log(`RiskControl ${rc}: limit ${limitBefore}, window volume ${volume0}`)

    // A fresh holder with USDY, as the indexer suite makes one: Friendbot, trustline, the faucet.
    const holder = Keypair.random()
    const account = holder.publicKey()
    const signer = keypairSigner(holder, manifest.networkPassphrase)
    const kind = await complianceKind(manifest, market)
    const read = () => fetchAccountState(createRpcReader(manifest), createHorizon(manifest.horizonUrl), manifest, market.marketId, account, kind)
    await fundWithFriendbot({ manifest, account })
    await eventually(read, (a) => a.accountExists.status === "live" && a.accountExists.value, "the funded account")
    await addTrustline({ manifest, account, asset: { code: market.underlying.code, issuer: market.underlying.issuer }, sign: (xdr) => signer.sign(xdr, manifest.networkPassphrase, account) })
    await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value !== "none", "the trustline")
    resetFaucetStateForTests()
    const chain = createStellarFaucetChain(manifest, { env: { FAUCET_ISSUER_SECRET: faucetIssuerSecret() } })
    await runFaucet({ account, manifest, ip: "127.0.0.1", now: Date.now(), chain })
    await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value === "authorized", "the authorized trustline")
    const deposit = (amount: bigint) => sendAs({ manifest, signer: holder, contractId: market.contracts.sy, method: "deposit", args: [scAddress(account), scI128(amount), scI128(0n)] })

    const limit = volume0 + 1_000n * U
    try {
      await cli(rc, "set_cb_limit", ["--caller", admin, "--new_limit", String(limit)], true)
      out.log(`cb_limit set to ${limit} (window volume + 1,000 USDY)`)
      const d1 = await deposit(950n * U)
      out.log(`deposit 950 USDY: tx ${d1.hash} (ledger ${d1.ledger})`)
      const warned = await check()
      out.log(`run at 95%: ${brief(warned)}`)
      expect(has(warned.opened, "risk_warning", rc)).toBe(true)

      const d2 = await deposit(50n * U)
      out.log(`deposit 50 USDY: tx ${d2.hash} (ledger ${d2.ledger})`)
      const exhausted = await check()
      out.log(`run at 100%: ${brief(exhausted)}`)
      expect(has(exhausted.opened, "risk_exhausted", rc)).toBe(true)
      expect(has(exhausted.resolved, "risk_warning", rc)).toBe(true)
      expect(exhausted.critical).toBe(true)
      const open = exhausted.open.find((a) => a.kind === "risk_exhausted")
      expect(open?.payload).toMatchObject({ scope: "protocol", limit: String(limit), percent: "100.0" })
    } finally {
      await cli(rc, "set_cb_limit", ["--caller", admin, "--new_limit", String(limitBefore)], true)
      out.log(`cb_limit restored to ${limitBefore}`)
    }
    const closed = await check()
    out.log(`run after restore: ${brief(closed)}`)
    expect(has(closed.resolved, "risk_exhausted", rc)).toBe(true)
    expect(posted("risk_warning").map((h) => h.body.status)).toEqual(["opened", "resolved"])
    expect(posted("risk_exhausted").map((h) => h.body.status)).toEqual(["opened", "resolved"])
    for (const h of [...posted("risk_warning"), ...posted("risk_exhausted")]) out.log(`webhook got: ${h.body.text}`)
  }, 5 * MINUTE)

  it("signer_low reads the keeper signer's XLM on the local Horizon", async () => {
    // The local oracle admin as the keeper signer (push mode); its secret stays in this process.
    const secret = (await run("stellar", ["keys", "secret", ADMIN_KEY])).stdout.trim()
    const low = await check({ ORACLE_ADMIN_SECRET: secret, ALERT_SIGNER_MIN_XLM: "100000000" })
    expect(has(low.opened, "signer_low", admin)).toBe(true)
    const payload = low.open.find((a) => a.kind === "signer_low")?.payload
    expect(payload).toMatchObject({ account: admin, minXlm: "100000000", found: true })
    out.log(`signer ${admin} holds ${String(payload?.balanceXlm)} XLM: under a 100,000,000 XLM floor, signer_low opened`)
    const fine = await check({ ORACLE_ADMIN_SECRET: secret })
    expect(has(fine.resolved, "signer_low", admin)).toBe(true)
    expect(JSON.stringify([low, fine])).not.toMatch(/S[A-Z2-7]{55}/)
    out.log("at the default 20 XLM floor it closed")
  }, 2 * MINUTE)

  /** A local port nothing listens on: every request to it is refused (a transient failure). */
  async function deadRpcUrl(): Promise<string> {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const port = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    return `http://127.0.0.1:${port}/rpc`
  }
  const unavailableRows = () =>
    sql<{ id: string; resolved_at: Date | null; opened_posted: boolean; resolved_posted: boolean; payload: Record<string, unknown> }>`
      select id, resolved_at, opened_posted, resolved_posted, payload from alerts
      where network = 'local' and kind = 'oracle_unavailable' and id > ${firstId} order by id`

  it("oracle_unavailable is debounced: a one-run blip is never posted; two failed runs post it once, then its close", async () => {
    const dead = { ...manifest, rpcUrl: await deadRpcUrl(), rpcFallbackUrls: undefined }
    // `now` stamps the run: a later one stands for a scheduled run DEBOUNCE_MIN_AGE_MS on (M-2).
    const blindCheck = (now?: number) => runAlertCheck({ sql, manifest: dead, env: {}, post: webhookPoster(HOOK), ...(now === undefined ? {} : { now }) })
    const before = posted("oracle_unavailable").length

    const blip = await blindCheck()
    out.log(`blip, run 1 (dead RPC): ${brief(blip)}`)
    expect(has(blip.opened, "oracle_unavailable", manifest.shared.oracle)).toBe(true)
    expect(blip.open.find((a) => a.kind === "oracle_unavailable") && countsAsCritical(blip.open.find((a) => a.kind === "oracle_unavailable")!)).toBe(false)
    expect(blip.unread).toEqual(expect.arrayContaining(["oracle", "risk"]))
    const cleared = await check()
    out.log(`blip, run 2 (RPC back): ${brief(cleared)}`)
    expect(has(cleared.resolved, "oracle_unavailable")).toBe(true)
    expect(posted("oracle_unavailable").length - before).toBe(0)
    const [blipRow] = await unavailableRows()
    expect(blipRow).toMatchObject({ opened_posted: true, resolved_posted: true })
    expect(blipRow.payload.confirmedAt).toBeUndefined()

    const first = await blindCheck()
    // A retry seconds later (QStash's, on the 500) is no second look: still unconfirmed, nothing posted.
    const retry = await blindCheck()
    const young = retry.open.find((a) => a.kind === "oracle_unavailable")
    expect(young?.payload.confirmedAt).toBeUndefined()
    expect(countsAsCritical(young!)).toBe(false)
    expect(posted("oracle_unavailable").length - before).toBe(0)
    const second = await blindCheck(Date.now() + DEBOUNCE_MIN_AGE_MS)
    out.log(`outage, run 2 (still dead): ${brief(second)}`)
    const confirmed = second.open.find((a) => a.kind === "oracle_unavailable")
    expect(typeof confirmed?.payload.confirmedAt).toBe("string")
    expect(countsAsCritical(confirmed!)).toBe(true)
    expect(second.critical).toBe(true)
    expect(has(first.opened, "oracle_unavailable")).toBe(true)
    expect(posted("oracle_unavailable").map((h) => h.body.status).slice(before)).toEqual(["opened"])
    out.log(`webhook got: ${posted("oracle_unavailable").at(-1)?.body.text}`)
    const back = await check()
    expect(has(back.resolved, "oracle_unavailable")).toBe(true)
    expect(posted("oracle_unavailable").map((h) => h.body.status).slice(before)).toEqual(["opened", "resolved"])
    out.log(`webhook got: ${posted("oracle_unavailable").at(-1)?.body.text}`)
    const rows = await unavailableRows()
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ opened_posted: true, resolved_posted: true })
  }, 3 * MINUTE)

  it("a dead rpcUrl with the local RPC as fallback: reads answer from the fallback and name it (D-6)", async () => {
    const live = manifest.rpcUrl
    const viaFallback = { ...manifest, rpcUrl: await deadRpcUrl(), rpcFallbackUrls: [live] }
    const read = await readLive(createRpcReader(viaFallback), { contractId: manifest.shared.oracle, functionName: "max_stale_seconds" })
    out.log(`max_stale_seconds through the fallback: ${JSON.stringify(read.status === "live" ? { value: String(read.value), ledger: read.ledger, rpcUrl: read.source?.rpcUrl, viaFallback: read.source?.viaFallback } : read)}`)
    expect(read).toMatchObject({ status: "live", value: 3_600n, source: { rpcUrl: live, viaFallback: true } })
    const r = await runAlertCheck({ sql, manifest: viaFallback, env: {}, post: webhookPoster(HOOK) })
    out.log(`check with the dead rpcUrl and the fallback: ${brief(r)}`)
    expect(r.unread).not.toContain("oracle")
    expect(r.open.some((a) => a.kind === "oracle_unavailable")).toBe(false)
  }, 2 * MINUTE)

  it("the routes: ?test=1 with a hanging then a working webhook, the scheduled check, the alerts API and the health endpoint", async () => {
    const bearer = randomBytes(32).toString("hex")
    const network = process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK
    process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK = "local"
    process.env.CRON_SECRET = bearer
    process.env.ALERT_WEBHOOK_URL = HOOK
    try {
      const { GET: cron } = await import("@/app/api/cron/alerts/route")
      const { GET: alertsApi } = await import("@/app/api/dashboard/alerts/route")
      const { GET: health } = await import("@/app/api/health/route")
      const call = (query = "") => cron(new Request(`http://127.0.0.1/api/cron/alerts${query}`, { headers: { authorization: `Bearer ${bearer}` } }))

      expect((await cron(new Request("http://127.0.0.1/api/cron/alerts?test=1"))).status).toBe(401)

      mode = "hang"
      const started = Date.now()
      const hung = await call("?test=1")
      const waited = Date.now() - started
      const hungText = await hung.text()
      out.log(`?test=1 with a hanging webhook: ${hung.status} ${hungText} after ${waited} ms`)
      expect(hung.status).toBe(502)
      expect(JSON.parse(hungText)).toMatchObject({ test: { delivered: false } })
      expect(waited).toBeGreaterThanOrEqual(4_900)
      expect(waited).toBeLessThan(15_000)
      expect(hungText).not.toContain(TOKEN)
      const [kept] = await sql<{ test: boolean; opened_posted: boolean; resolved_at: Date | null }>`
        select test, opened_posted, resolved_at from alerts where network = 'local' and test order by id desc limit 1`
      expect(kept).toMatchObject({ test: true, opened_posted: false })
      expect(kept.resolved_at).not.toBeNull()

      mode = "ok"
      const sent = await call("?test=1")
      const sentBody = (await sent.json()) as { test: { openedAt: string; delivered: boolean } }
      out.log(`?test=1: ${sent.status} ${JSON.stringify(sentBody)}`)
      expect(sent.status).toBe(200)
      expect(sentBody.test.delivered).toBe(true)
      const testHit = hits.at(-1)
      expect(testHit?.body).toMatchObject({ kind: "test", test: true, network: "local" })
      expect(testHit?.body.text).toMatch(/^\[Principal local\] TEST alert: /)
      out.log(`webhook got: ${testHit?.body.text}`)

      const scheduled = await call()
      const scheduledText = await scheduled.text()
      const result = JSON.parse(scheduledText) as AlertCheckResult
      out.log(`scheduled run: ${scheduled.status} ${brief(result)}`)
      expect(scheduled.status).toBe(result.critical ? 500 : 200)
      expect(result.critical).toBe(result.open.some(countsAsCritical))
      expect(scheduledText).not.toContain(TOKEN)

      const api = await alertsApi()
      const apiText = await api.text()
      expect(api.status).toBe(200)
      expect(api.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=30")
      expect(apiText).not.toContain(TOKEN)
      const answer = JSON.parse(apiText) as { open: { kind: string }[]; recent: { kind: string; resolvedAt: string | null }[]; lastTest: { openedAt: string; delivered: boolean } }
      expect(answer.lastTest).toEqual({ openedAt: sentBody.test.openedAt, delivered: true })
      expect(answer.open.map((a) => a.kind).sort()).toEqual(result.open.map((a) => a.kind).sort())
      for (const kind of ["oracle_stale", "risk_warning", "risk_exhausted"]) expect(answer.recent.some((a) => a.kind === kind && a.resolvedAt !== null), `${kind} closed in recent`).toBe(true)
      expect(answer.recent.some((a) => a.kind === "test")).toBe(false)
      out.log(`GET /api/dashboard/alerts: ${answer.open.length} open [${answer.open.map((a) => a.kind).join(", ")}], ${answer.recent.length} recent, lastTest ${JSON.stringify(answer.lastTest)}`)

      const h = await health()
      const healthBody = (await h.json()) as Record<string, { status: string; count?: number; sequence?: number }> & { network: string }
      out.log(`GET /api/health: ${h.status} ${JSON.stringify(healthBody)}`)
      expect(h.status).toBe(200)
      expect(h.headers.get("cache-control")).toBe("public, s-maxage=15, stale-while-revalidate=15")
      expect(healthBody.network).toBe("local")
      expect(healthBody.ledger.status).toBe("ok")
      expect(healthBody.indexer.status).toBe("ok")
      expect(healthBody.keeper.status).toBe("ok")
      expect(healthBody.openAlerts).toMatchObject({ status: "ok", count: answer.open.length })
    } finally {
      delete process.env.CRON_SECRET
      delete process.env.ALERT_WEBHOOK_URL
      if (network === undefined) delete process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK
      else process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK = network
    }
  }, 2 * MINUTE)
})
