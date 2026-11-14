/**
 * The event indexer on the local stack (spec 0004 D-13 to D-15): a seizure made the way the issuer
 * authority makes one (deauthorize on the SAC, then `RecoveryEscrow.seize_all_positions`), indexed
 * into the local Postgres, re-run idempotently, reconciled with `record_count`, re-indexed from a
 * checkpoint with `pnpm indexer:reindex`, and moved through `indexer:export` / `indexer:import`.
 *
 * Needs `scripts/dev-stack/up.sh` (and a deployed market), the migrations applied (`pnpm db:migrate`),
 * and `DATABASE_URL` on this machine (a shared database is refused: this suite writes and deletes
 * local rows). The admin is the dev stack's `FAUCET_ISSUER_SECRET` (on the local stack the issuer,
 * the SAC admin and every market admin are one key); it is never printed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// `server-only` throws outside a react-server bundle; the indexer and the faucet are server modules.
vi.mock("server-only", () => ({}))

import { Keypair } from "@stellar/stellar-sdk"
import { fetchAccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { createHorizon } from "@/lib/protocol/horizon"
import { addTrustline, fundWithFriendbot } from "@/lib/protocol/onboarding"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer } from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"
import { sql } from "@/lib/server/db"
import { createStellarFaucetChain, resetFaucetStateForTests, runFaucet } from "@/lib/server/faucet"
import { indexCursorName, indexEvents, type IndexGroup, type IndexResult } from "@/lib/server/indexer"
import { sacSetAuthorized, scAddress, scI128, seizeAllPositions, sendAs } from "../live/admin"
import { keypairSigner } from "./keypair-signer"
import { complianceKind, DAPP, eventually, faucetIssuerSecret, loadDatabaseUrl, MINUTE, readManifest, run, skipReason } from "./local-stack"

const U = 10_000_000n

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
    await sql`select close_time from ingest_cursor limit 1`
    await sql`select raw_xdr from events limit 1`
  } catch (error) {
    return `the local database is not reachable or not migrated (pnpm db:migrate): ${error instanceof Error ? error.name : "unknown"}`
  }
  return null
}

const skip = await reason()
if (skip) console.warn(`[indexer] skipped: ${skip}`)

function log(line: string): void {
  console.info(`[indexer] ${line}`)
}

describe.skipIf(skip !== null)("event indexer on the local network", () => {
  let manifest: Manifest
  let market: Market
  let kind: ComplianceKind
  let seized: { hash: string; ledger: number; ids: bigint[]; account: string }
  let scratch: string

  const markets = () => [market]
  /** Runs the indexer until every asked group has reached the RPC's latest ledger. */
  async function indexAll(groups?: IndexGroup[]): Promise<IndexResult & { runs: number; total: number }> {
    let total = 0
    for (let runs = 1; runs <= 20; runs++) {
      const result = await indexEvents(
        { sql, rpc: createRpcServer(manifest.rpcUrl), manifest, markets: markets() },
        { deadline: Date.now() + MINUTE, ...(groups ? { groups } : {}) },
      )
      total += result.inserted
      expect(result.groups.filter((g) => g.error)).toEqual([])
      if (result.groups.every((g) => g.complete)) return { ...result, inserted: result.inserted, runs, total }
    }
    throw new Error("the indexer did not reach the latest ledger in 20 runs")
  }

  /** The script as an operator runs it; `DATABASE_URL` comes from this process's environment. */
  async function script(args: string[]): Promise<string> {
    const { stdout, stderr } = await run(process.execPath, [join(DAPP, "scripts", "indexer.mjs"), ...args], { cwd: DAPP })
    const out = `${stdout}${stderr}`
    // The connection string never reaches the terminal.
    expect(out).not.toContain(process.env.DATABASE_URL as string)
    expect(out).not.toMatch(/postgres(ql)?:\/\//)
    return out.trim()
  }

  const escrowRows = async (fromLedger: number) =>
    sql<Record<string, unknown>>`
      select id, contract_id, group_name, topic, ledger, close_time, tx_hash, pool, data, raw_xdr
      from events where network = 'local' and group_name = 'escrow' and ledger >= ${fromLedger} order by id`

  beforeAll(async () => {
    manifest = readManifest()
    market = manifest.markets[0]
    kind = await complianceKind(manifest, market)
    scratch = mkdtempSync(join(tmpdir(), "principal-indexer-"))
  })
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it("catches up from the RPC's oldest ledger (the local manifest has no deployLedger): no gap claimed", async () => {
    const started = Date.now()
    const result = await indexAll()
    log(`caught up in ${result.runs} run(s), ${Math.round((Date.now() - started) / 1000)} s, ${result.total} new rows`)
    log(`groups: ${JSON.stringify(result.groups)}`)
    expect(result.groups.map((g) => g.group).sort()).toEqual(["escrow", "market", "oracle", "permissioning", "risk"])
    const health = await createRpcServer(manifest.rpcUrl).getHealth()
    for (const g of result.groups) expect(g.indexedThrough).toBeGreaterThanOrEqual(health.latestLedger - 20)
  }, 5 * MINUTE)

  it("indexes a seizure: a recovery row with its tx hash, and reconcile ok", async () => {
    // A fresh holder with SY: Friendbot, its trustline, the faucet (authorize, grants, 100,000 USDY), a deposit.
    const holder = Keypair.random()
    const account = holder.publicKey()
    const signer = keypairSigner(holder, manifest.networkPassphrase)
    const read = () => fetchAccountState(createRpcReader(manifest), createHorizon(manifest.horizonUrl), manifest, market.marketId, account, kind)
    await fundWithFriendbot({ manifest, account })
    await eventually(read, (a) => a.accountExists.status === "live" && a.accountExists.value, "the funded account")
    await addTrustline({
      manifest,
      account,
      asset: { code: market.underlying.code, issuer: market.underlying.issuer },
      sign: (xdr) => signer.sign(xdr, manifest.networkPassphrase, account),
    })
    await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value !== "none", "the trustline")
    resetFaucetStateForTests()
    const chain = createStellarFaucetChain(manifest, { env: { FAUCET_ISSUER_SECRET: faucetIssuerSecret() } })
    const faucet = await runFaucet({ account, manifest, ip: "127.0.0.1", now: Date.now(), chain })
    expect(faucet).toMatchObject({ performed: expect.arrayContaining(["authorize", "pay"]) })
    await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value === "authorized", "the authorized trustline")
    const deposit = await sendAs({ manifest, signer: holder, contractId: market.contracts.sy, method: "deposit", args: [scAddress(account), scI128(1_000n * U), scI128(0n)] })
    log(`deposit ${deposit.hash} (ledger ${deposit.ledger})`)

    // The issuer authority (the SAC admin) deauthorizes the holder, then seizes everything it holds.
    const admin = Keypair.fromSecret(faucetIssuerSecret())
    const sacAdmin = await createRpcReader(manifest)({ contractId: market.underlying.sac, functionName: "admin" })
    expect(sacAdmin.value, "the dev stack's issuer key is the SAC admin, the escrow's issuer authority").toBe(admin.publicKey())
    await sacSetAuthorized({ manifest, admin, sac: market.underlying.sac, account, authorize: false })
    const seize = await seizeAllPositions({ manifest, market, admin, accounts: [account] })
    seized = { hash: seize.hash, ledger: seize.ledger, ids: seize.ids, account }
    log(`seize_all_positions ${seize.hash} (ledger ${seize.ledger}), record ids ${seize.ids.join(", ")}`)

    const result = await indexAll()
    const rows = await sql<Record<string, unknown>>`
      select id, contract_id, group_name, topic, ledger, close_time, tx_hash, pool, data, raw_xdr
      from events where network = 'local' and tx_hash = ${seize.hash} order by id`
    log(`rows of the seizure: ${JSON.stringify(rows.map((r) => ({ id: r.id, group: r.group_name, topic: r.topic, contract: r.contract_id })))}`)
    const recovery = rows.filter((r) => r.topic === "recovery")
    expect(recovery).toHaveLength(1)
    expect(recovery[0]).toMatchObject({
      contract_id: market.contracts.recoveryEscrow,
      group_name: "escrow",
      ledger: seize.ledger,
      tx_hash: seize.hash,
      pool: market.contracts.pool,
      data: { caller: admin.publicKey(), id: seize.ids[0].toString(), account, pt_amount: "0", yt_amount: "0", lp_amount: "0" },
    })
    expect(BigInt((recovery[0].data as Record<string, string>).sy_shares)).toBeGreaterThan(0n)
    expect(typeof recovery[0].raw_xdr).toBe("string")
    // The SY wrapper's own seize event is in the market group, with the same transaction.
    expect(rows.some((r) => r.group_name === "market" && r.topic === "seize" && r.contract_id === market.contracts.sy)).toBe(true)

    // record_count matches the indexed recovery events of this escrow (all inside the RPC's window).
    log(`reconcile: ${JSON.stringify(result.reconcile)}`)
    expect(result.reconcile).toEqual([expect.objectContaining({ escrow: market.contracts.recoveryEscrow, ok: true })])
    const [{ n }] = await sql<{ n: number }>`
      select count(*)::int as n from events where network = 'local' and contract_id = ${market.contracts.recoveryEscrow} and topic = 'recovery'`
    expect(result.reconcile[0].indexed).toBe(n)
    expect(result.reconcile[0].recordCount).toBe(n)
  }, 5 * MINUTE)

  it("a second run inserts 0", async () => {
    // The groups no other process writes to on the dev stack (an oracle tick may land at any time).
    const again = await indexAll(["escrow", "market"])
    expect(again.total).toBe(0)
  }, 2 * MINUTE)

  it("indexer:reindex then a run restores the same rows", async () => {
    const before = await escrowRows(seized.ledger)
    expect(before.length).toBeGreaterThanOrEqual(1)
    await sql`delete from events where network = 'local' and group_name = 'escrow' and ledger >= ${seized.ledger}`

    // The cursor is past them: a plain run does not bring them back.
    expect((await indexAll(["escrow"])).total).toBe(0)
    expect(await escrowRows(seized.ledger)).toHaveLength(0)

    const out = await script(["reindex", "--network", "local", "--group", "escrow", "--from", String(seized.ledger)])
    log(out)
    expect(out).toMatch(new RegExp(`reindex: ${indexCursorName("escrow", "local")} was indexed through \\d+; the next run reads from ledger ${seized.ledger}`))
    const [cursor] = await sql<{ ledger: string }>`select ledger from ingest_cursor where name = ${indexCursorName("escrow", "local")}`
    expect(Number(cursor.ledger)).toBe(seized.ledger - 1)

    const restored = await indexAll(["escrow"])
    expect(restored.total).toBe(before.length)
    expect(await escrowRows(seized.ledger)).toEqual(before)

    // Moving a cursor forward would skip events silently: refused.
    await expect(script(["reindex", "--network", "local", "--group", "escrow", "--from", String(Number.MAX_SAFE_INTEGER)])).rejects.toThrow(/would skip ledgers/)
  }, 3 * MINUTE)

  it("indexer:export then indexer:import restores the rows, and never rewinds a cursor", async () => {
    const file = join(scratch, "local.jsonl")
    const exported = await script(["export", "--network", "local", "--out", file])
    log(exported)
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({ kind: "meta", format: "principal-indexer-export", version: 1, network: "local" })
    expect(lines.filter((l) => l.kind === "cursor").map((l) => l.name)).toEqual(
      expect.arrayContaining((["escrow", "oracle", "permissioning", "risk", "market"] as const).map((g) => indexCursorName(g, "local"))),
    )
    const recoveryLine = lines.find((l) => l.kind === "event" && l.tx_hash === seized.hash && l.topic === "recovery")
    expect(recoveryLine).toMatchObject({ network: "local", group_name: "escrow", ledger: seized.ledger, pool: market.contracts.pool })
    expect(typeof recoveryLine?.raw_xdr).toBe("string")

    const before = await escrowRows(seized.ledger)
    await sql`delete from events where network = 'local' and group_name = 'escrow' and ledger >= ${seized.ledger}`
    // A cursor ahead of the file's stays where it is.
    const [{ ledger: escrowCursor }] = await sql<{ ledger: string }>`select ledger from ingest_cursor where name = ${indexCursorName("escrow", "local")}`
    await sql`update ingest_cursor set ledger = ${Number(escrowCursor) + 1000} where name = ${indexCursorName("escrow", "local")}`

    const imported = await script(["import", "--in", file])
    log(imported)
    expect(imported).toMatch(new RegExp(`import: \\d+ events \\(${before.length} new\\)`))
    expect(await escrowRows(seized.ledger)).toEqual(before)
    const [after] = await sql<{ ledger: string }>`select ledger from ingest_cursor where name = ${indexCursorName("escrow", "local")}`
    expect(Number(after.ledger)).toBe(Number(escrowCursor) + 1000)
    // Put the cursor back where the chain is (the shifted value is ahead of the tip).
    await sql`update ingest_cursor set ledger = ${Number(escrowCursor)} where name = ${indexCursorName("escrow", "local")}`

    // Importing the same file again changes nothing.
    expect(await script(["import", "--in", file])).toMatch(/\(0 new\), \d+ cursors \(0 moved forward\)/)
  }, 2 * MINUTE)
})
