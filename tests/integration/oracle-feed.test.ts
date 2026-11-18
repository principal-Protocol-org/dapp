/**
 * The keeper's feed mode on the local stack (spec 0004 D-21, D-22): `scripts/dev-stack/feed-oracle.sh`
 * deploys a SEP-40 mock feed (`tests/fixtures/sep40-mock`, 8 decimals) and a standalone OracleAdapter
 * of principal 24d980d that pulls from it, then `/api/cron/oracle` runs in feed mode
 * (`ORACLE_KEEPER_MODE=feed`, `ORACLE_KEEPER_ORACLE_ID` = that oracle) with a fresh key that holds no
 * role at all. Each run goes through the route itself: its memory is read from `oracle_ticks`, its
 * outcome is written there. Steps:
 *
 * - a newer feed price: `synced` with a hash, the oracle value is the price rescaled to 7 decimals,
 *   `last_update_was_feed()` is true;
 * - the same tick again: `skipped` (`stale_ts`), nothing sent;
 * - +15 %: `rejected` (`deviate`) with a hash, its (reason, value) read from the landed transaction's
 *   own `ref_rej`; the same again: `rejected`, nothing sent (feed-mode rejections answer 200);
 * - a price of 0: `rejected` (`bad_price`), nothing sent;
 * - `clear_price`: `skipped` (`no_data`), nothing sent;
 * - the manifest's own oracle (no `feed_source`, like 665bb67 on Testnet): 503 `not_configured`;
 * - `indexEvents` (group `oracle`) stores the one `ref_set` and the one `ref_rej`;
 * - the alert check raises `oracle_rejection` (deviate) and `feed_broken` (bad_price).
 *
 * "Nothing sent" is checked on the chain: the keeper account's sequence number does not move.
 * Needs `scripts/dev-stack/up.sh` (and a deployed market), Rust with wasm32v1-none, the migrations
 * (`pnpm db:migrate`) and `DATABASE_URL` on this machine (a shared database is refused). The rows it
 * writes (ticks and events of the standalone oracle) are deleted afterwards and the oracle group's
 * index cursor is put back as it was; the market, its oracle and `config/manifests/local.json` are
 * not touched. Testnet is never used.
 */
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { Keypair, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk"
import { fundWithFriendbot } from "@/lib/protocol/onboarding"
import { createRpcServer, simulateContractRead } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"
import { GET } from "@/app/api/cron/oracle/route"
import { collectAlertInput, evaluateAlerts } from "@/lib/server/alerts"
import { sql } from "@/lib/server/db"
import { indexCursorName, indexEvents } from "@/lib/server/indexer"
import { listTicks } from "@/lib/server/oracle-ticks"
import { scI128, scU64, sendAs } from "../live/admin"
import { DAPP, DEV_STACK, eventually, ledgerClock, loadDatabaseUrl, MINUTE, readManifest, run, skipReason } from "./local-stack"

/** Why this suite cannot run here, or null: the local stack, and a migrated database on this machine. */
async function reason(): Promise<string | null> {
  const stack = await skipReason()
  if (stack) return stack
  loadDatabaseUrl()
  const url = process.env.DATABASE_URL
  if (!url) return "DATABASE_URL is not set (scripts/dev-stack/deploy.sh writes it to .env.local)"
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return "DATABASE_URL is not a connection string"
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(host)) return "DATABASE_URL is not a database on this machine; this suite writes and deletes rows"
  try {
    await sql`select signer from oracle_ticks limit 1`
    await sql`select members from ingest_cursor limit 1`
    await sql`select raw_xdr from events limit 1`
  } catch (error) {
    return `the local database is not reachable or not migrated (pnpm db:migrate): ${error instanceof Error ? error.name : "unknown"}`
  }
  return null
}

const skip = await reason()
if (skip) console.warn(`[oracle-feed] skipped: ${skip}`)

const log = (line: string) => console.info(`[oracle-feed] ${line}`)

/** The feed's scale (FEED_DECIMALS): the oracle rescales its prices to 7 decimals. */
const FEED_DECIMALS = 8
const ONE_FEED = 100_000_000n
/** `{"Other":"USDY"}`, the asset feed-oracle.sh wires (Sep40Asset::Other(Symbol)). */
const ASSET = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol("USDY")])
const CRON = randomBytes(24).toString("hex")
const ENV_KEYS = ["CRON_SECRET", "NEXT_PUBLIC_PRINCIPAL_NETWORK", "ORACLE_KEEPER_MODE", "ORACLE_KEEPER_SECRET", "ORACLE_KEEPER_ORACLE_ID", "ORACLE_ADMIN_SECRET"] as const

type CursorRow = { name: string; ledger: string | null; cursor: string | null; close_time: Date | null; gap_from: string | null; gap_to: string | null; members: string[] | null }

describe.skipIf(skip !== null)("the keeper's feed mode on the local stack (D-21, D-22)", () => {
  let manifest: Manifest
  /** The manifest with the standalone oracle as its oracle, for the indexer and the alert check. */
  let standalone: Manifest
  let oracle: string
  let feed: string
  const keeper = Keypair.random()
  /** Moves the feed's price: a second role-less account, so the keeper's sequence counts only its own sends. */
  const poster = Keypair.random()
  let startedAt: Date
  let deployLedger: number
  let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>
  let savedCursor: CursorRow | null = null
  const cursorName = indexCursorName("oracle", "local")
  const hashes: Record<string, string> = {}

  const tick = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await GET(new Request("http://localhost/api/cron/oracle", { headers: { authorization: `Bearer ${CRON}` } }))
    const body = (await res.json()) as Record<string, unknown>
    log(`cron/oracle ${res.status} ${JSON.stringify(body)}`)
    return { status: res.status, body }
  }
  const sequence = async () => BigInt((await createRpcServer(manifest.rpcUrl).getAccount(keeper.publicKey())).sequenceNumber())
  const view = async (fn: string) => (await simulateContractRead({ rpcUrl: manifest.rpcUrl, networkPassphrase: manifest.networkPassphrase, invocation: { contractId: oracle, functionName: fn, args: [] } })).value
  const setPrice = async (price: bigint, timestamp: number) => {
    const sent = await sendAs({ manifest, signer: poster, contractId: feed, method: "set_price", args: [ASSET, scI128(price), scU64(timestamp)] })
    log(`feed.set_price(${price}, ${timestamp}): ${sent.hash}`)
  }
  /** A ledger whose close time is after `t`: the oracle takes only a newer timestamp. */
  const ledgerAfter = (t: number) => eventually(() => ledgerClock(manifest), (c) => c.closeTime > t, `a ledger after ${t}`)

  beforeAll(async () => {
    manifest = readManifest()
    startedAt = new Date(Date.now() - 1_000)
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    deployLedger = (await ledgerClock(manifest)).sequence

    const { stdout } = await run(join(DEV_STACK, "feed-oracle.sh"), [], { cwd: DAPP, env: { ...process.env, PRINCIPAL_NETWORK: "local", FEED_DECIMALS: String(FEED_DECIMALS) }, maxBuffer: 16 * 1024 * 1024 })
    ;({ oracle, feed } = JSON.parse(stdout.trim()) as { oracle: string; feed: string })
    log(`feed-oracle.sh: oracle ${oracle}, feed ${feed} (${FEED_DECIMALS} decimals), from ledger ${deployLedger}`)
    standalone = { ...manifest, deployLedger, shared: { ...manifest.shared, oracle } }

    for (const account of [keeper, poster]) await fundWithFriendbot({ manifest, account: account.publicKey() })
    await eventually(() => sequence().catch(() => null), (s) => s !== null, "the keeper account")
    log(`keeper ${keeper.publicKey()} (a fresh key with no role), poster ${poster.publicKey()}`)

    const [row] = await sql<CursorRow>`select name, ledger::text, cursor, close_time, gap_from::text, gap_to::text, members from ingest_cursor where name = ${cursorName}`
    savedCursor = row ?? null

    process.env.CRON_SECRET = CRON
    process.env.NEXT_PUBLIC_PRINCIPAL_NETWORK = "local"
    process.env.ORACLE_KEEPER_MODE = "feed"
    process.env.ORACLE_KEEPER_SECRET = keeper.secret()
    process.env.ORACLE_KEEPER_ORACLE_ID = oracle
    delete process.env.ORACLE_ADMIN_SECRET
  }, 10 * MINUTE)

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv?.[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    if (!oracle) return
    await sql`delete from oracle_ticks where network = 'local' and oracle = ${oracle}`
    // The not_configured run on the manifest's oracle: the only feed-mode rows there are this suite's.
    await sql`delete from oracle_ticks where network = 'local' and oracle = ${manifest.shared.oracle} and mode = 'feed' and at >= ${startedAt.toISOString()}::timestamptz`
    await sql`delete from events where network = 'local' and contract_id = ${oracle}`
    if (savedCursor) {
      const c = savedCursor
      await sql`
        update ingest_cursor set ledger = ${c.ledger}::bigint, cursor = ${c.cursor}, close_time = ${c.close_time}, gap_from = ${c.gap_from}::bigint,
          gap_to = ${c.gap_to}::bigint, members = ${c.members}::text[]
        where name = ${cursorName}`
    } else {
      await sql`delete from ingest_cursor where name = ${cursorName}`
    }
    log(`cleaned up: the standalone oracle's ticks and events, the oracle cursor put back (${savedCursor ? `ledger ${savedCursor.ledger}` : "none"})`)
    log(`hashes: ${JSON.stringify(hashes)}`)
  })

  let synced: { value: string; timestamp: number }

  it("a newer feed price: synced with a hash; the oracle holds the price rescaled to 7 decimals, from its feed", async () => {
    const t1 = (await ledgerClock(manifest)).closeTime
    await setPrice(ONE_FEED, t1)
    const before = await sequence()
    const { status, body } = await tick()
    expect(status).toBe(200)
    expect(body).toMatchObject({ status: "synced", mode: "feed", signer: keeper.publicKey(), value: "10000000", timestamp: t1 })
    expect(body.hash).toMatch(/^[0-9a-f]{64}$/)
    hashes.synced = body.hash as string
    expect(await sequence()).toBe(before + 1n)
    expect(await view("get_reference_value")).toBe(10_000_000n)
    expect(await view("get_reference_timestamp")).toBe(BigInt(t1))
    expect(await view("last_update_was_feed")).toBe(true)
    synced = { value: "10000000", timestamp: t1 }
  }, 2 * MINUTE)

  it("the same feed tick again: skipped (stale_ts), nothing sent", async () => {
    const before = await sequence()
    const { status, body } = await tick()
    expect(status).toBe(200)
    expect(body).toEqual({ status: "skipped", mode: "feed", signer: keeper.publicKey(), value: synced.value, timestamp: synced.timestamp, reason: "stale_ts" })
    expect(await sequence()).toBe(before)
  }, MINUTE)

  it("+15 %: rejected (deviate) and submitted once with a hash; the same rejection again is not submitted", async () => {
    const t2 = (await ledgerAfter(synced.timestamp)).closeTime
    await setPrice((ONE_FEED * 115n) / 100n, t2)
    const before = await sequence()
    const first = await tick()
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ status: "rejected", mode: "feed", value: "11500000", timestamp: t2, reason: "deviate" })
    expect(first.body.hash).toMatch(/^[0-9a-f]{64}$/)
    hashes.deviate = first.body.hash as string
    expect(await sequence()).toBe(before + 1n)
    // The rejection is on-chain: the oracle kept its value and records the significant rejection.
    expect(await view("get_reference_value")).toBe(10_000_000n)
    expect(await view("last_rejection")).toMatchObject({ reason: "deviate", value: 11_500_000n, timestamp: BigInt(t2) })
    const landed = await createRpcServer(manifest.rpcUrl).getTransaction(hashes.deviate)
    expect(landed.status).toBe("SUCCESS")
    // The landed transaction carries its own ref_rej, which the keeper recorded (fix round 1, item 5).
    const ofOracle = (landed.status === "SUCCESS" ? landed.events.contractEventsXdr.flat() : []).filter(
      (e) => e.contractId !== null && StrKey.encodeContract(Buffer.from(e.contractId.toBytes())) === oracle,
    )
    const landedRejections = ofOracle.filter((e) => e.body.value.topics[0]?.type === "scvSymbol" && String(e.body.value.topics[0].value) === "ref_rej")
    expect(landedRejections.map((e) => scValToNative(e.body.value.data))).toEqual([[11_500_000n, BigInt(t2), "deviate"]])

    // The route reads its memory from oracle_ticks: the same (reason, value) is not sent again.
    const repeat = await tick()
    expect(repeat.status).toBe(200)
    expect(repeat.body).toEqual({ status: "rejected", mode: "feed", signer: keeper.publicKey(), value: "11500000", timestamp: t2, reason: "deviate" })
    expect(await sequence()).toBe(before + 1n)
  }, 2 * MINUTE)

  it("a price of 0 (a broken feed): rejected (bad_price), never submitted", async () => {
    const t3 = (await ledgerClock(manifest)).closeTime
    await setPrice(0n, t3)
    const before = await sequence()
    const { status, body } = await tick()
    expect(status).toBe(200)
    expect(body).toEqual({ status: "rejected", mode: "feed", signer: keeper.publicKey(), value: "0", timestamp: t3, reason: "bad_price" })
    expect(await sequence()).toBe(before)
  }, MINUTE)

  it("clear_price (the feed has no data): skipped (no_data), nothing sent", async () => {
    const sent = await sendAs({ manifest, signer: poster, contractId: feed, method: "clear_price", args: [ASSET] })
    log(`feed.clear_price: ${sent.hash}`)
    const before = await sequence()
    const { status, body } = await tick()
    expect(status).toBe(200)
    expect(body).toEqual({ status: "skipped", mode: "feed", signer: keeper.publicKey(), value: null, timestamp: null, reason: "no_data" })
    expect(await sequence()).toBe(before)
  }, MINUTE)

  it("the manifest's own oracle has no feed_source (its code predates sync_from_feed): 503 not_configured", async () => {
    delete process.env.ORACLE_KEEPER_ORACLE_ID
    try {
      const { status, body } = await tick()
      expect(status).toBe(503)
      expect(body).toEqual({ error: "not_configured" })
      const [row] = await listTicks(sql, { network: "local", oracle: manifest.shared.oracle, limit: 1 })
      expect(row).toMatchObject({ mode: "feed", decision: "error", signer: keeper.publicKey() })
      expect(row.reason).toMatch(/^not_configured: the oracle has no feed_source function/)
    } finally {
      process.env.ORACLE_KEEPER_ORACLE_ID = oracle
    }
  }, MINUTE)

  it("every run is one oracle_ticks row under the standalone oracle; only the sync and the first deviate carry a hash", async () => {
    const ticks = (await listTicks(sql, { network: "local", oracle, limit: 20 })).reverse()
    expect(ticks.map((t) => [t.mode, t.decision, t.reason, t.txHash])).toEqual([
      ["feed", "synced", null, hashes.synced],
      ["feed", "skipped", "stale_ts", null],
      ["feed", "rejected", "deviate", hashes.deviate],
      ["feed", "rejected", "deviate", null],
      ["feed", "rejected", "bad_price", null],
      ["feed", "skipped", "no_data", null],
    ])
    expect(new Set(ticks.map((t) => t.signer))).toEqual(new Set([keeper.publicKey()]))
  })

  it("the indexer (group oracle) stores the one ref_set and the one ref_rej, with their transactions", async () => {
    let complete = false
    for (let runs = 1; runs <= 10 && !complete; runs++) {
      const result = await indexEvents({ sql, rpc: createRpcServer(manifest.rpcUrl), manifest: standalone, markets: [] }, { deadline: Date.now() + MINUTE, groups: ["oracle"] })
      expect(result.groups.filter((g) => g.error)).toEqual([])
      complete = result.groups.every((g) => g.complete)
    }
    expect(complete).toBe(true)
    const rows = await sql<{ topic: string; tx_hash: string; data: Record<string, unknown> }>`
      select topic, tx_hash, data from events where network = 'local' and group_name = 'oracle' and contract_id = ${oracle} order by ledger, id`
    log(`indexed: ${JSON.stringify(rows.map((r) => ({ topic: r.topic, tx: r.tx_hash, data: r.data })))}`)
    expect(rows.map((r) => r.topic).sort()).toEqual(["feed_set", "ref_rej", "ref_set"])
    const set = rows.find((r) => r.topic === "ref_set")
    const rej = rows.find((r) => r.topic === "ref_rej")
    expect(set).toMatchObject({ tx_hash: hashes.synced, data: { value: "10000000", timestamp: String(synced.timestamp) } })
    expect(rej).toMatchObject({ tx_hash: hashes.deviate, data: { value: "11500000", reason: "deviate" } })
  }, 5 * MINUTE)

  it("the alert check raises oracle_rejection (deviate, with its hash) and feed_broken (bad_price)", async () => {
    const input = await collectAlertInput({ sql, manifest: standalone, env: { ORACLE_KEEPER_MODE: "feed", ORACLE_KEEPER_SECRET: keeper.secret() } })
    const alerts = evaluateAlerts(input)
    log(`alerts: ${JSON.stringify(alerts.map((a) => ({ kind: a.kind, subject: a.subject, payload: a.payload })))}`)
    const rejection = alerts.find((a) => a.kind === "oracle_rejection")
    expect(rejection).toMatchObject({ subject: "deviate", payload: { reason: "deviate", value: "11500000", txHash: hashes.deviate } })
    expect((rejection?.payload.sources as string[]).sort()).toEqual(["event", "tick"])
    // Only the significant reason: routine and broken-feed reasons raise no oracle_rejection.
    expect(alerts.filter((a) => a.kind === "oracle_rejection").map((a) => a.subject)).toEqual(["deviate"])
    expect(alerts.find((a) => a.kind === "feed_broken")).toMatchObject({ subject: oracle, payload: { reasons: ["bad_price"] } })
  }, 2 * MINUTE)
})
