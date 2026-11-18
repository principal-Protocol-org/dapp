// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { clearGap, clearGapRefusal, isLocalDatabase, mergeCursor, parseArgs, readExport, reindexRefusal } from "../../../scripts/indexer.mjs"

const POOL = "CB3JI6H2HZ3PMWKLEKDPQUURFSKJSFTLNFNBU4CFEHAZXMWL5SNNS6OJ"
const ESCROW = "CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q"
const OTHER = "CA62ACRTFADKNOP37CS7DPQ5DNJML4TFHIX6LZG5IBEHJM3PED2V7F2I"

describe("isLocalDatabase (capture writes only to this machine)", () => {
  it.each([
    ["postgres://principal:principal@127.0.0.1:5432/principal", true],
    ["postgres://principal:principal@localhost:5432/principal", true],
    ["postgresql://u:p@[::1]:5432/db", true],
    // pg takes the host from the query string over the URL's: refused.
    ["postgres://u:p@localhost/db?host=remote.example", false],
    ["postgres://u:p@localhost/db?host=/var/run/postgresql", false],
    // No host: pg would fall back to PGHOST or a socket.
    ["postgres:///db", false],
    ["postgres://u:p@10.0.0.5:5432/db", false],
    ["not a connection string", false],
  ])("%s: %s", async (url, local) => {
    expect(await isLocalDatabase(url)).toBe(local)
  })
})

describe("parseArgs", () => {
  it("--force takes no value; other flags need one", () => {
    expect(parseArgs(["reindex", "--force", "--group", "escrow"])).toEqual({ command: "reindex", flags: { force: true, group: "escrow" } })
    expect(() => parseArgs(["reindex", "--group"])).toThrow(/--group needs a value/)
  })

  it("--yes takes no value either, and pnpm's bare -- is skipped", () => {
    expect(parseArgs(["clear-gap", "--", "--network", "testnet", "--group", "market", "--yes"])).toEqual({
      command: "clear-gap",
      flags: { network: "testnet", group: "market", yes: true },
    })
  })
})

describe("clear-gap (a stored gap known to be false)", () => {
  /** An `ingest_cursor` of one row behind pg's `pool.query`, with the update's guard. */
  function fakePool(row: { ledger: number; gap_from: number | null; gap_to: number | null } | null, opts: { widenBeforeUpdate?: boolean } = {}) {
    const queries: { text: string; values: unknown[] }[] = []
    const state = row ? { ...row } : null
    const pool = {
      async query(text: string, values: unknown[]) {
        queries.push({ text: text.replace(/\s+/g, " "), values })
        if (text.startsWith("select ledger, gap_from, gap_to from ingest_cursor")) {
          // pg answers bigint columns as strings.
          return { rows: state ? [{ ledger: String(state.ledger), gap_from: state.gap_from === null ? null : String(state.gap_from), gap_to: state.gap_to === null ? null : String(state.gap_to) }] : [], rowCount: state ? 1 : 0 }
        }
        if (text.startsWith("update ingest_cursor set gap_from = null, gap_to = null")) {
          if (opts.widenBeforeUpdate && state) state.gap_from = (state.gap_from as number) - 10
          const [, from, to] = values as [string, number, number | null]
          if (!state || state.gap_from !== from || state.gap_to !== to) return { rows: [], rowCount: 0 }
          state.gap_from = null
          state.gap_to = null
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`unexpected SQL: ${text}`)
      },
    }
    return { pool, queries, state }
  }
  const NAME = "events:market:testnet"

  it("off this machine it needs --yes; on this machine, or with --yes, it may clear", () => {
    expect(clearGapRefusal({ name: NAME, local: false, yes: false, from: "--env-file" })).toMatch(/not on this machine.*--yes/)
    expect(clearGapRefusal({ name: NAME, local: false, yes: false, from: "--env-file" })).toContain("--env-file")
    expect(clearGapRefusal({ name: NAME, local: false, yes: true, from: "--env-file" })).toBeNull()
    expect(clearGapRefusal({ name: NAME, local: true, yes: false, from: ".env.local" })).toBeNull()
  })

  it("prints the gap before anything, then refuses without --yes off this machine, clearing nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const { pool, queries, state } = fakePool({ ledger: 5_800_000, gap_from: 5_707_342, gap_to: 5_790_000 })
    await expect(clearGap(pool, { network: "testnet", group: "market", local: false, yes: false, from: "--env-file" })).rejects.toThrow(/--yes/)
    expect(log.mock.calls.flat().join("\n")).toContain(`${NAME} stores a gap: ledgers 5707342-5790000 (indexed through 5800000)`)
    expect(queries.map((q) => q.text.split(" ")[0])).toEqual(["select"])
    expect(state).toMatchObject({ gap_from: 5_707_342, gap_to: 5_790_000 })
    log.mockRestore()
  })

  it("with --yes it clears exactly the gap it printed, keeping the cursor, and says the alert closes on the next check", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const { pool, queries, state } = fakePool({ ledger: 5_800_000, gap_from: 5_707_342, gap_to: 5_790_000 })
    expect(await clearGap(pool, { network: "testnet", group: "market", local: false, yes: true, from: "--env-file" })).toEqual({
      cleared: true,
      gap: { from: 5_707_342, to: 5_790_000 },
    })
    expect(queries[1].values).toEqual([NAME, 5_707_342, 5_790_000])
    expect(queries[1].text).toMatch(/where name = \$1 and gap_from = \$2 and gap_to is not distinct from \$3/)
    expect(state).toEqual({ ledger: 5_800_000, gap_from: null, gap_to: null })
    expect(log.mock.calls.flat().join("\n")).toMatch(/next cron\/alerts run closes the open indexer_gap alert/)
    log.mockRestore()
  })

  it("a gap the indexer widened between the read and the clear is refused, to be read again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { pool, state } = fakePool({ ledger: 5_800_000, gap_from: 5_707_342, gap_to: 5_790_000 }, { widenBeforeUpdate: true })
    await expect(clearGap(pool, { network: "testnet", group: "market", local: true, yes: false, from: ".env.local" })).rejects.toThrow(/changed while it was read/)
    expect(state?.gap_from).toBe(5_707_332)
    vi.restoreAllMocks()
  })

  it("no stored gap (or no cursor): nothing to clear, no write", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    for (const row of [{ ledger: 5_800_000, gap_from: null, gap_to: null }, null]) {
      const { pool, queries } = fakePool(row)
      expect(await clearGap(pool, { network: "testnet", group: "escrow", local: false, yes: false, from: "--env-file" })).toEqual({ cleared: false })
      expect(queries).toHaveLength(1)
    }
    expect(log.mock.calls.flat().join("\n")).toMatch(/stores no gap; nothing to clear/)
    log.mockRestore()
  })
})

describe("reindexRefusal", () => {
  it("never moves a cursor forward", () => {
    expect(reindexRefusal({ name: "events:escrow:testnet", from: 600, current: 500, oldest: 100, force: true })).toMatch(/would skip ledgers 501-599/)
  })

  it("a start below the RPC's oldest ledger needs --force: it would record a gap the index may hold", () => {
    expect(reindexRefusal({ name: "events:escrow:testnet", from: 100, current: 500, oldest: 300, force: false })).toMatch(/older than the RPC's oldest ledger 300.*--force/s)
    expect(reindexRefusal({ name: "events:escrow:testnet", from: 100, current: 500, oldest: 300, force: true })).toBeNull()
    // The RPC could not be read: the same check cannot be made, so --force too.
    expect(reindexRefusal({ name: "events:escrow:testnet", from: 100, current: 500, oldest: null, force: false })).toMatch(/--force/)
    expect(reindexRefusal({ name: "events:escrow:testnet", from: 300, current: 500, oldest: 300, force: false })).toBeNull()
  })
})

describe("readExport", () => {
  const dir = mkdtempSync(join(tmpdir(), "indexer-script-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const file = (name: string, lines: object[]) => {
    const path = join(dir, name)
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
    return path
  }
  const meta = (network: string | null) => ({ kind: "meta", format: "principal-indexer-export", version: 1, network })
  const event = (network: string) => ({
    kind: "event",
    id: "0024512890283298816-0000000001",
    network,
    contract_id: ESCROW,
    group_name: "escrow",
    topic: "recovery",
    ledger: 5_707_400,
    close_time: "2026-11-13T10:00:00.000Z",
    tx_hash: "ab".repeat(32),
    pool: POOL,
    data: {},
    raw_xdr: "AAAAAQ==",
  })
  const cursor = (network: string) => ({
    kind: "cursor",
    name: `events:escrow:${network}`,
    ledger: 5_707_500,
    cursor: null,
    close_time: null,
    gap_from: null,
    gap_to: null,
    members: [ESCROW],
    reconcile: null,
  })

  it("reads a file of the network asked", () => {
    const out = readExport(file("ok.jsonl", [meta("testnet"), cursor("testnet"), event("testnet")]), "testnet")
    expect(out.events).toHaveLength(1)
    expect(out.cursors).toHaveLength(1)
  })

  it("refuses a line of another network", () => {
    expect(() => readExport(file("meta.jsonl", [meta("local"), event("testnet")]), "testnet")).toThrow(/network/)
    expect(() => readExport(file("event.jsonl", [meta(null), event("local")]), "testnet")).toThrow(/line 2.*network/)
    expect(() => readExport(file("cursor.jsonl", [meta(null), cursor("local")]), "testnet")).toThrow(/line 2.*network/)
  })

  it("refuses an invalid gap or member list", () => {
    expect(() => readExport(file("gap.jsonl", [meta("testnet"), { ...cursor("testnet"), gap_from: 10, gap_to: 5 }]), "testnet")).toThrow(/gap/)
    expect(() => readExport(file("members.jsonl", [meta("testnet"), { ...cursor("testnet"), members: ["nope"] }]), "testnet")).toThrow(/members/)
  })
})

describe("mergeCursor (import)", () => {
  const db = { ledger: 1_000, cursor: "c", close_time: "2026-11-14T00:00:00.000Z", gap_from: 100, gap_to: 200, members: [ESCROW], reconcile: null }
  const line = { name: "events:escrow:testnet", ledger: 1_500, cursor: null, close_time: "2026-11-14T01:00:00.000Z", gap_from: null, gap_to: null, members: [ESCROW], reconcile: null }

  it("a group the database never indexed takes the file's cursor, gap and members", () => {
    const out = mergeCursor(null, { ...line, gap_from: 5, gap_to: 9 })
    expect(out).toMatchObject({ moved: true, cleared: false, row: { ledger: 1_500, gap_from: 5, gap_to: 9, members: [ESCROW] } })
  })

  it("a file ahead moves the cursor forward, takes its members, and widens the gap with the file's", () => {
    const out = mergeCursor({ ...db, gap_from: null, gap_to: null }, { ...line, members: [ESCROW, OTHER], gap_from: 1_100, gap_to: 1_200 })
    expect(out).toMatchObject({ moved: true, row: { ledger: 1_500, close_time: line.close_time, members: [ESCROW, OTHER], gap_from: 1_100, gap_to: 1_200 } })
  })

  it("a file behind never rewinds the cursor", () => {
    const out = mergeCursor({ ...db, gap_from: null, gap_to: null }, { ...line, ledger: 900 })
    expect(out).toMatchObject({ moved: false, row: { ledger: 1_000, cursor: "c", members: [ESCROW] } })
  })

  it("clears the database's gap when the file reaches past it, with every member, and no gap of its own there", () => {
    expect(mergeCursor(db, line)).toMatchObject({ cleared: true, row: { gap_from: null, gap_to: null } })
    // Even when the file is behind the cursor, as long as it covers the gap.
    expect(mergeCursor(db, { ...line, ledger: 200 })).toMatchObject({ moved: false, cleared: true, row: { ledger: 1_000, gap_from: null } })
    // A gap of the file elsewhere does not keep the database's.
    expect(mergeCursor(db, { ...line, gap_from: 500, gap_to: 600 })).toMatchObject({ cleared: true, row: { gap_from: 500, gap_to: 600 } })
  })

  it("keeps the database's gap otherwise", () => {
    // The file stops inside the gap.
    expect(mergeCursor(db, { ...line, ledger: 150 })).toMatchObject({ cleared: false, row: { gap_from: 100, gap_to: 200 } })
    // The file lacks a contract the database indexes.
    expect(mergeCursor({ ...db, members: [ESCROW, OTHER] }, line)).toMatchObject({ cleared: false, row: { gap_from: 100, gap_to: 200 } })
    // The file has its own gap there: widened together.
    expect(mergeCursor(db, { ...line, gap_from: 150, gap_to: 300 })).toMatchObject({ cleared: false, row: { gap_from: 100, gap_to: 300 } })
    // A database row without members cannot be checked.
    expect(mergeCursor({ ...db, members: null }, line)).toMatchObject({ cleared: false })
  })
})
