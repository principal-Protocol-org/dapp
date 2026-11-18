/**
 * The dashboard's history drill on the local stack (spec 0004 D-31, plan 0008 Task 12):
 * `scripts/dev-stack/drill.sh` with `PRINCIPAL_NETWORK=local`, as a developer runs it, then the event
 * indexer over the local market.
 *
 * - The drill exits 0 and prints one JSON object on stdout: every transaction hash of the run, the
 *   throwaway account and its RecoveryEscrow record id. Its progress lines go to stderr.
 * - Afterwards the index holds, for the drill's own transactions: one `recovery` (the seizure of the
 *   throwaway account), one oracle `ref_rej` with reason `deviate`, the keeper tick's `ref_set`, and two
 *   RiskControl `paused` rows (the pause, then the unpause).
 * - The throwaway key is gone from the Stellar CLI keystore, RiskControl is not paused, the oracle is
 *   fresh again, and nothing shaped like a secret key was printed.
 * - A drill stopped (SIGTERM) while RiskControl is paused unpauses it in its trap before it exits.
 *
 * - When the market has not matured (and the oracle is fresh), the throwaway account also mints PT and YT,
 *   so the seizure record holds PT and YT (what finalize_record settles after maturity); otherwise the
 *   drill says why it skipped the mint and the record holds SY only. The dev stack's market matures a day
 *   after its deploy (MATURITY_SECONDS=86400 by default); once it has, `DRILL_MANIFEST=<manifest>` runs this
 *   suite, and the drill, on another local deployment, e.g. one made with `MANIFEST_OUT=<path> MATURITY_SECONDS=1200 deploy.sh`.
 *
 * The local database already holds earlier seizures (the indexer suite's), so every count is over the
 * drill's own transaction hashes. Needs `scripts/dev-stack/up.sh`, a deployed market, and `principal-pg`
 * migrated (`pnpm db:migrate`) on this machine. The drill signs with the dev stack's local keys only.
 */
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

// `server-only` throws outside a react-server bundle; the indexer is a server module.
vi.mock("server-only", () => ({}))

import { parseManifest } from "@/lib/protocol/manifest"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer } from "@/lib/protocol/stellar"
import type { Manifest } from "@/lib/protocol/types"
import { sql } from "@/lib/server/db"
import { getIndexedEvents, indexEvents, type IndexGroup } from "@/lib/server/indexer"
import { DAPP, DEV_STACK, loadDatabaseUrl, MINUTE, readManifest, redact, run, skipReason } from "./local-stack"

/** The manifest the drill runs on: `DRILL_MANIFEST` (another local deployment), else `config/manifests/local.json`. */
function drillManifest(): Manifest {
  const path = process.env.DRILL_MANIFEST
  return path ? parseManifest(JSON.parse(readFileSync(path, "utf8"))) : readManifest()
}

const DRILL = join(DEV_STACK, "drill.sh")
const HASH = /^[0-9a-f]{64}$/
const SECRET = /S[A-Z2-7]{55}/

/** What drill.sh prints on stdout when it succeeds. */
type DrillSummary = {
  network: string
  marketId: string
  account: string | null
  key: string | null
  keyRemoved: boolean
  recordIds: number[]
  mint: { done: true; syShares: number } | { done: false; reason: string }
  record: { id: number; account: string; sy_shares: string; pt_amount: string; yt_amount: string; lp_amount: string; finalized: boolean } | null
  rejection: { reason: string; value: string } | null
  pausedSeconds: number | null
  txs: { step: string; hash: string; url: string | null }[]
}

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
  if (!["localhost", "127.0.0.1", "::1", "[::1]", ""].includes(host)) return "DATABASE_URL is not a database on this machine; this suite writes rows"
  try {
    await sql`select members from ingest_cursor limit 1`
    await sql`select raw_xdr from events limit 1`
  } catch (error) {
    return `the local database is not reachable or not migrated (pnpm db:migrate): ${error instanceof Error ? error.name : "unknown"}`
  }
  return null
}

const skip = await reason()
if (skip) console.warn(`[drill] skipped: ${skip}`)

function log(line: string): void {
  console.info(`[drill] ${redact(line)}`)
}

/** Runs the indexer until every asked group has reached the RPC's latest ledger. */
async function indexAll(manifest: Manifest, groups: IndexGroup[]): Promise<void> {
  for (let runs = 1; runs <= 20; runs++) {
    const result = await indexEvents(
      { sql, rpc: createRpcServer(manifest.rpcUrl), manifest, markets: manifest.markets },
      { deadline: Date.now() + MINUTE, groups },
    )
    expect(result.groups.filter((g) => g.error)).toEqual([])
    if (result.groups.every((g) => g.complete)) return
  }
  throw new Error("the indexer did not reach the latest ledger in 20 runs")
}

type Row = { group_name: string; contract_id: string; topic: string; tx_hash: string; data: Record<string, unknown> }
const rowsOf = (hashes: string[]) =>
  sql<Row>`select group_name, contract_id, topic, tx_hash, data from events where network = 'local' and tx_hash = any(${hashes}::text[]) order by id`

async function isPaused(manifest: Manifest): Promise<unknown> {
  return (await createRpcReader(manifest)({ contractId: manifest.shared.riskControl, functionName: "is_paused" })).value
}

async function keyExists(name: string): Promise<boolean> {
  try {
    await run("stellar", ["keys", "address", name])
    return true
  } catch {
    return false
  }
}

describe.skipIf(skip !== null)("drill.sh on the local network", () => {
  it(
    "seizes a throwaway account, gets one deviate rejection and pauses RiskControl for a few seconds; the index holds each",
    async () => {
      const manifest = drillManifest()
      const market = manifest.markets[0]
      let stdout: string
      let stderr: string
      try {
        ;({ stdout, stderr } = await run("bash", [DRILL], {
          cwd: DAPP,
          env: { ...process.env, PRINCIPAL_NETWORK: "local", DRILL_PAUSE_SECONDS: "3" },
          maxBuffer: 16 * 1024 * 1024,
        }))
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; code?: number }
        log(`drill.sh failed (exit ${e.code}):\n${e.stderr ?? ""}\n${e.stdout ?? ""}`)
        throw new Error("drill.sh did not exit 0")
      }
      log(stderr.trim())
      expect(`${stdout}${stderr}`, "nothing shaped like a secret key is printed").not.toMatch(SECRET)

      const out = JSON.parse(stdout) as DrillSummary
      expect(out).toMatchObject({ network: "local", marketId: market.marketId, keyRemoved: true, rejection: { reason: "deviate" } })
      expect(out.account).toMatch(/^G[A-Z2-7]{55}$/)
      expect(out.key).toMatch(/^drill-local-\d+-\d+$/)
      expect(out.recordIds).toHaveLength(1)
      expect(out.pausedSeconds).toBeGreaterThanOrEqual(0)
      expect(out.pausedSeconds).toBeLessThan(60)
      const steps = out.txs.map((t) => t.step)
      const expected = ["friendbot", "trustline", "authorize", "grant_account", "grant_pt", "grant_yt", "pay", "deposit", "deauthorize", "seize", "deviate", "oracle_tick", "pause", "unpause"]
      for (const step of out.mint.done ? [...expected, "mint"] : expected) {
        expect(steps, `the summary lists the ${step} transaction`).toContain(step)
      }
      for (const tx of out.txs) {
        expect(tx.hash, `${tx.step} has a transaction hash`).toMatch(HASH)
        // explorerUrl's rule: the local network has no explorer.
        expect(tx.url).toBeNull()
        expect(stderr, `${tx.step}'s hash is printed`).toContain(tx.hash)
      }
      const hashOf = (step: string) => out.txs.find((t) => t.step === step)?.hash as string

      // The run leaves nothing behind: no key, no pause, a fresh oracle.
      expect(await keyExists(out.key as string), "the throwaway key is removed").toBe(false)
      expect(await isPaused(manifest)).toBe(false)
      expect((await createRpcReader(manifest)({ contractId: manifest.shared.oracle, functionName: "is_available" })).value).toBe(true)

      await indexAll(manifest, ["escrow", "oracle", "risk"])
      const rows = await rowsOf(out.txs.map((t) => t.hash))
      log(`indexed rows of the drill: ${JSON.stringify(rows.map((r) => ({ group: r.group_name, topic: r.topic, tx: r.tx_hash.slice(0, 8) })))}`)

      const recovery = rows.filter((r) => r.topic === "recovery")
      expect(recovery).toHaveLength(1)
      expect(recovery[0]).toMatchObject({
        group_name: "escrow",
        contract_id: market.contracts.recoveryEscrow,
        tx_hash: hashOf("seize"),
        data: { account: out.account, id: String(out.recordIds[0]) },
      })
      // The record's shape follows the mint: PT and YT held for finalize_record, or SY only.
      const data = recovery[0].data as Record<string, string>
      expect(out.record).toMatchObject({ id: out.recordIds[0], account: out.account, finalized: false })
      expect(BigInt(data.sy_shares)).toBeGreaterThan(0n)
      if (out.mint.done) {
        log(`minted PT and YT: the record holds PT ${out.record?.pt_amount}, YT ${out.record?.yt_amount}`)
        expect(BigInt(data.pt_amount)).toBeGreaterThan(0n)
        expect(BigInt(data.yt_amount)).toBeGreaterThan(0n)
        expect(out.record).toMatchObject({ pt_amount: data.pt_amount, yt_amount: data.yt_amount })
        expect(stderr).toContain("finalize_record --caller")
      } else {
        log(`no mint (${out.mint.reason}): the record holds SY only`)
        expect(out.mint.reason).toMatch(/matured|stale/)
        expect(stderr).toContain(`no PT and YT mint: ${out.mint.reason}`)
        expect(data).toMatchObject({ pt_amount: "0", yt_amount: "0" })
      }

      // Exactly one deviate rejection. A keeper tick refused as stale_ts (the drill retries it once) is a
      // ref_rej of the drill's own too: it may only come from that refused tick.
      const rejections = rows.filter((r) => r.topic === "ref_rej" && r.data.reason === "deviate")
      const refusedTicks = out.txs.filter((t) => t.step === "oracle_tick (refused: stale_ts)").map((t) => t.hash)
      const others = rows.filter((r) => r.topic === "ref_rej" && r.data.reason !== "deviate")
      for (const r of others) expect(r, "a non-deviate rejection is the retried tick's stale_ts").toMatchObject({ data: { reason: "stale_ts" } })
      expect(others.map((r) => r.tx_hash).sort()).toEqual([...refusedTicks].sort())
      expect(rejections).toHaveLength(1)
      expect(rejections[0]).toMatchObject({
        group_name: "oracle",
        contract_id: manifest.shared.oracle,
        tx_hash: hashOf("deviate"),
        data: { reason: "deviate", value: out.rejection?.value },
      })
      // The keeper's next tick made the oracle fresh again.
      expect(rows.filter((r) => r.topic === "ref_set" && r.tx_hash === hashOf("oracle_tick"))).toHaveLength(1)

      const paused = rows.filter((r) => r.topic === "paused" && r.contract_id === manifest.shared.riskControl)
      expect(paused).toHaveLength(2)
      expect(paused.every((r) => r.group_name === "risk")).toBe(true)
      expect(paused.find((r) => r.tx_hash === hashOf("pause"))?.data).toMatchObject({ paused: true })
      expect(paused.find((r) => r.tx_hash === hashOf("unpause"))?.data).toMatchObject({ paused: false })

      // The dashboard's read model serves them.
      const risk = await getIndexedEvents(sql, { network: "local", group: "risk", limit: 20 })
      expect(risk.rows.filter((r) => r.topic === "paused" && [hashOf("pause"), hashOf("unpause")].includes(r.txHash ?? ""))).toHaveLength(2)
    },
    10 * MINUTE,
  )

  it(
    "a drill stopped while RiskControl is paused unpauses it in its trap",
    async () => {
      const manifest = drillManifest()
      expect(await isPaused(manifest)).toBe(false)
      const child = spawn("bash", [DRILL], {
        cwd: DAPP,
        env: { ...process.env, PRINCIPAL_NETWORK: "local", DRILL_STEPS: "pause", DRILL_PAUSE_SECONDS: "30" },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stderr = ""
      let stdout = ""
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
      const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)))
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the drill never reported the pause:\n${stderr}`)), 2 * MINUTE)
        child.on("close", (code) => {
          clearTimeout(timer)
          reject(new Error(`the drill exited (${code}) before it reported the pause:\n${redact(stderr)}`))
        })
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString()
          if (/RiskControl is paused/.test(stderr)) {
            clearTimeout(timer)
            resolve()
          }
        })
      })
      const stoppedAt = Date.now()
      child.kill("SIGTERM")
      const code = await exited
      log(stderr.trim())
      expect(code, "a stopped drill does not report success").not.toBe(0)
      expect(Date.now() - stoppedAt, "the trap does not wait for the pause to run out").toBeLessThan(25_000)
      expect(stdout.trim(), "no summary for a stopped run").toBe("")
      expect(stderr).not.toMatch(SECRET)
      expect(await isPaused(manifest)).toBe(false)

      const pauseHash = /pause: tx ([0-9a-f]{64})/.exec(stderr)?.[1]
      const unpauseHash = /unpause \(trap\): tx ([0-9a-f]{64})/.exec(stderr)?.[1]
      expect(pauseHash).toMatch(HASH)
      expect(unpauseHash).toMatch(HASH)
      await indexAll(manifest, ["risk"])
      const paused = (await rowsOf([pauseHash as string, unpauseHash as string])).filter((r) => r.topic === "paused")
      expect(paused.map((r) => [r.tx_hash, r.data.paused])).toEqual([
        [pauseHash, true],
        [unpauseHash, false],
      ])
    },
    5 * MINUTE,
  )
})
