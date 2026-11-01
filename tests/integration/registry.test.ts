// @vitest-environment node
/**
 * The market registry against the local stack (spec 0002 §1): the Router's real events, the real
 * contracts' Wasm hashes and wiring, and the real `market_registry` / `ingest_cursor` tables
 * (`principal-pg`; `DATABASE_URL` from `.env.local`; run `pnpm db:migrate` first). Skipped when the
 * network or the database is unreachable. It writes only true verdicts (the seed's row) and removes
 * the throwaway row it creates. Discovery runs under a test-only `ingest_cursor` name, removed after:
 * the recorder's live cursor is never read, written or deleted. Prints counts and verdicts only.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

function loadEnv() {
  if (process.env.DATABASE_URL) return
  try {
    for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
      const m = /^DATABASE_URL=(.*)$/.exec(line.trim())
      if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "")
    }
  } catch {
    /* no .env.local */
  }
}
loadEnv()

const THROWAWAY = "C" + "Y".repeat(55)
/** Every cursor this suite reads or writes gets this prefix, so the live one is never touched. */
const TEST_CURSOR = "test:"

let ready = false
let env: Awaited<ReturnType<typeof setup>>

async function setup() {
  const { parseManifest } = await import("@/lib/protocol/manifest")
  const manifest = parseManifest(JSON.parse(readFileSync(join(process.cwd(), "config/manifests/local.json"), "utf8")))
  const { createRpcReader } = await import("@/lib/protocol/reader")
  const { createRpcServer } = await import("@/lib/protocol/stellar")
  const { sql } = await import("@/lib/server/db")
  const registry = await import("@/lib/server/registry")
  const rpc = createRpcServer(manifest.rpcUrl)
  await rpc.getHealth()
  await sql`select market from market_registry limit 1`
  const live = registry.sqlRegistryStore(sql)
  // The real tables, with the cursor kept under a test-only name.
  const store = {
    ...live,
    cursor: (name: string) => live.cursor(TEST_CURSOR + name),
    saveCursor: (name: string, ledger: number, cursor: string | null) => live.saveCursor(TEST_CURSOR + name, ledger, cursor),
  }
  return { manifest, rpc, sql, registry, store, deps: { store, reader: createRpcReader(manifest), rpc, manifest } }
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return
  try {
    env = await setup()
    ready = true
  } catch {
    ready = false
  }
}, 30_000)

describe("market registry on the local stack", () => {
  it("validates the seed on-chain: topology, wiring and all seven pinned Wasm hashes", async (ctx) => {
    if (!ready) return ctx.skip()
    const seed = env.manifest.markets[0]
    const v = await env.registry.validateMarket(env.deps.reader, env.rpc, env.manifest, seed)
    console.log("seed verdict:", JSON.stringify(v))
    expect(v).toEqual({ valid: true })
  }, 60_000)

  it("rebuilds the seed from its pool alone (R2-37 id and name, R2-12 pins)", async (ctx) => {
    if (!ready) return ctx.skip()
    const seed = env.manifest.markets[0]
    const built = await env.registry.marketFromPool(env.deps.reader, env.rpc, { ...env.manifest, markets: [] }, seed.contracts.pool)
    console.log("built:", built.marketId, built.displayName, Object.keys(built.wasmHashes ?? {}).length, "pins")
    expect({ ...built, wasmHashes: undefined }).toEqual({ ...seed, wasmHashes: undefined })
    expect(Object.keys(built.wasmHashes ?? {}).sort()).toEqual(["config", "manager", "pool", "pt", "recoveryEscrow", "sy", "yt"])
  }, 60_000)

  it("discovers the seed's mkt_reg through every getEvents page, keeps it a seed, and resumes from the cursor", async (ctx) => {
    if (!ready) return ctx.skip()
    const seedPool = env.manifest.markets[0].contracts.pool
    const testCursor = TEST_CURSOR + env.registry.cursorName(env.manifest)
    const liveCursor = await env.sql`select ledger, cursor from ingest_cursor where name = ${env.registry.cursorName(env.manifest)}`
    // A fresh scan from the RPC's oldest ledger: the dev stack registered the seed within retention.
    await env.sql`delete from ingest_cursor where name = ${testCursor}`
    try {
      const first = await env.registry.discover(env.deps)
      console.log("first scan checked:", first.checked.length, "pools; gap:", first.gap)
      expect(first.checked).toContain(seedPool)
      const saved = await env.store.cursor(env.registry.cursorName(env.manifest))
      expect(saved?.cursor).toBeTruthy()
      const again = await env.registry.discover(env.deps)
      console.log("resumed scan checked:", again.checked.length, "pools")
      expect(again.checked).not.toContain(seedPool)

      const rows = await env.store.rows()
      expect(rows.find((r) => r.pool === seedPool)).toMatchObject({ source: "seed", valid: true })
      const listed = await env.registry.resolvedMarkets({ store: env.store, manifest: env.manifest })
      expect(listed.map((m) => m.contracts.pool)).toContain(seedPool)
    } finally {
      await env.sql`delete from ingest_cursor where name = ${testCursor}`
    }
    // The recorder's own cursor is as it was.
    expect(await env.sql`select ledger, cursor from ingest_cursor where name = ${env.registry.cursorName(env.manifest)}`).toEqual(liveCursor)
  }, 120_000)

  it("the SQL store keeps a verdict through an unreadable check and ranks sources", async (ctx) => {
    if (!ready) return ctx.skip()
    const market = { ...env.manifest.markets[0], marketId: "local-usdy-throwaway", contracts: { ...env.manifest.markets[0].contracts, pool: THROWAWAY } }
    try {
      await env.store.record({ pool: THROWAWAY, source: "published", valid: true, reason: null, market })
      await env.store.record({ pool: THROWAWAY, source: "discovered", valid: null, reason: "could not be checked: test", market: null })
      const row = (await env.store.rows()).find((r) => r.pool === THROWAWAY)
      expect(row).toMatchObject({ source: "published", valid: true, reason: "could not be checked: test", marketId: "local-usdy-throwaway" })
      expect((row?.market as { marketId: string }).marketId).toBe("local-usdy-throwaway")
      await env.store.record({ pool: THROWAWAY, source: "discovered", valid: false, reason: "Unregistered from the Router.", market: null })
      expect((await env.store.rows()).find((r) => r.pool === THROWAWAY)).toMatchObject({ valid: false, source: "published" })
    } finally {
      await env.sql`delete from market_registry where pool = ${THROWAWAY}`
    }
  }, 30_000)
})
