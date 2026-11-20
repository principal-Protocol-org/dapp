// The event indexer's operator commands (spec 0004 D-15, D-30). The scheduled job is
// `/api/cron/index`; these run by hand.
//
//   pnpm indexer:reindex --network <n> --group <g> --from <ledger> [--force]   reset one group's cursor
//   pnpm indexer:clear-gap --network <n> --group <g> [--yes]                    clear a stored gap known to be false
//   pnpm indexer:export  --out <file.jsonl> [--network <n>]                     events rows and cursors, as JSON Lines
//   pnpm indexer:import  --network <n> --in <file.jsonl>                        upsert a file written by export
//   pnpm indexer:capture --network <n> [--out <file.jsonl>]                     list the network's markets, index them
//                                                                                into a local database, then export
//                                                                                (default out:
//                                                                                var/indexer-capture/<n>-<YYYYMMDD>.jsonl)
//
// Networks: local, testnet, mainnet. Groups: escrow, oracle, permissioning, risk, market.
//
// Database: --database-url <url>, else the DATABASE_URL of --env-file <path>, else DATABASE_URL in
// the environment, else the DATABASE_URL of .env.local. `capture` writes only to a database on this
// machine (a host that resolves to loopback only, with no `host` query parameter): its rows reach a
// shared database through `import`, with the developer's go. This script never prints a connection
// string or any part of it. `clear-gap` prints the gap first, and on a database that is not on this
// machine it clears it only with --yes.
//
// `capture` runs the app's own registry discovery and indexer (lib/server/registry.ts,
// lib/server/indexer.ts) and needs Node's TypeScript transform (`pnpm indexer:capture` passes
// --experimental-transform-types). On the network it only reads: getHealth, getEvents, getLedgers,
// getLedgerEntries and simulations (each market's checks, RecoveryEscrow.record_count). It writes
// only the local database: the registry's tables and the index.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { lookup } from "node:dns/promises"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"
import pg from "pg"
import { loadAppTypeScript, TypeScriptTransformRequired } from "./lib/load-app-ts.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** pg's own connection-string parser (a dependency of pg), so the host checked is the host pg uses. */
const require = createRequire(import.meta.url)
const { parse: parseConnectionString } = createRequire(require.resolve("pg"))("pg-connection-string")

const NETWORKS = ["local", "testnet", "mainnet"]
const GROUPS = ["escrow", "oracle", "permissioning", "risk", "market"]
const EVENT_ID = /^\d{19}-\d{10}$/
const CONTRACT = /^C[A-Z2-7]{55}$/
const CURSOR_NAME = new RegExp(`^events:(${GROUPS.join("|")}):(${NETWORKS.join("|")})$`)
const FORMAT = "principal-indexer-export"
const BOOLEAN_FLAGS = new Set(["force", "yes"])
/** Events per insert statement on import. */
const IMPORT_BATCH = 500
/** Capture: one discovery or indexer run's deadline, and the whole capture's. */
const CAPTURE_RUN_MS = 120_000
const CAPTURE_TOTAL_MS = 30 * 60_000

class UsageError extends Error {}

function fail(message) {
  console.error(`indexer: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- arguments and connection

/** `<command> --flag value ... --force`: every flag takes a value but the boolean ones. A bare `--` (pnpm's separator) is skipped. */
export function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--") continue
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`)
    const key = arg.slice(2)
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true
      continue
    }
    const value = rest[i + 1]
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`)
    flags[key] = value
    i++
  }
  return { command, flags }
}

function requireFlag(flags, name) {
  const value = flags[name]
  if (value === undefined) throw new UsageError(`--${name} is required`)
  return value
}

function networkOf(flags, required) {
  const network = required ? requireFlag(flags, "network") : flags.network
  if (network !== undefined && !NETWORKS.includes(network)) throw new UsageError(`--network must be one of ${NETWORKS.join(", ")}`)
  return network
}

function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {}
}

/** The connection string and where it came from (never the string itself in any message). */
export function databaseUrl(flags, env = process.env) {
  if (flags["database-url"]) return { url: flags["database-url"], from: "--database-url" }
  if (flags["env-file"]) {
    if (!existsSync(flags["env-file"])) throw new UsageError("the --env-file does not exist")
    const url = readEnvFile(flags["env-file"]).DATABASE_URL
    if (!url) throw new UsageError("the --env-file has no DATABASE_URL")
    return { url, from: "--env-file" }
  }
  if (env.DATABASE_URL) return { url: env.DATABASE_URL, from: "DATABASE_URL" }
  const local = readEnvFile(join(root, ".env.local")).DATABASE_URL
  if (local) return { url: local, from: ".env.local" }
  throw new UsageError("no database: pass --database-url or --env-file, or set DATABASE_URL (or .env.local)")
}

const isLoopback = (address) => address === "::1" || /^127\./.test(address) || /^::ffff:127\./i.test(address)

/**
 * A database on this machine: the host pg would connect to (parsed as pg parses it) is named, is
 * not a socket path, comes with no `host`/`hostaddr` query parameter (pg takes the query's host over
 * the URL's), and resolves to loopback addresses only.
 */
export async function isLocalDatabase(url) {
  let query
  let host
  try {
    query = new URL(url).searchParams
    host = parseConnectionString(url).host
  } catch {
    return false
  }
  if (query.has("host") || query.has("hostaddr")) return false
  if (typeof host !== "string" || host === "" || host.startsWith("/")) return false
  try {
    const addresses = await lookup(host.replace(/^\[|\]$/g, ""), { all: true })
    return addresses.length > 0 && addresses.every((a) => isLoopback(a.address))
  } catch {
    return false
  }
}

/** A database error's code, never its text (which can carry the host or the URL). */
function dbCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown"
}

/** An error for the terminal: its name, its database code, and its text without URLs or secret keys. */
function describe(error) {
  if (!(error instanceof Error)) return "unknown error"
  const text = error.message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]").replace(/S[A-Z2-7]{55}/g, "[redacted]").split("\n")[0]
  return `${error.name}${"code" in error ? ` (code ${String(error.code)})` : ""}: ${text.slice(0, 300)}`
}

/** The app's `Sql` tagged template over a pg pool: every `${value}` is a numbered parameter. */
function sqlOf(pool) {
  return async (strings, ...values) => {
    let text = strings[0]
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`
    return (await pool.query(text, values)).rows
  }
}

const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString())
const num = (value) => (value === null || value === undefined ? null : Number(value))

/** An `ingest_cursor` row as read by pg (bigints as strings), in the export's shape. */
function cursorRow(r) {
  return {
    ledger: num(r.ledger),
    cursor: r.cursor ?? null,
    close_time: iso(r.close_time),
    gap_from: num(r.gap_from),
    gap_to: num(r.gap_to),
    members: r.members ?? null,
    reconcile: r.reconcile ?? null,
  }
}

function readManifestJson(network) {
  const path = join(root, "config", "manifests", `${network}.json`)
  if (!existsSync(path)) throw new UsageError(`config/manifests/${network}.json does not exist`)
  return JSON.parse(readFileSync(path, "utf8"))
}

/** The RPC's oldest ledger for `network` (its manifest's `rpcUrl`), or null when it cannot be read. */
async function rpcOldestLedger(network) {
  try {
    const { rpcUrl } = readManifestJson(network)
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(20_000),
    })
    const oldest = (await res.json())?.result?.oldestLedger
    return Number.isInteger(oldest) ? oldest : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- reindex

/**
 * Why a reindex must not run, or null. It never moves a cursor forward (that would skip events
 * without recording a gap). A start older than the RPC's oldest ledger (or one that cannot be checked)
 * needs `--force`: the next run would record those ledgers as a gap, which the index may hold already
 * (an imported capture).
 */
export function reindexRefusal({ name, from, current, oldest, force }) {
  if (current !== null && from - 1 > current) {
    return `${name} is indexed through ledger ${current}; --from ${from} would skip ledgers ${current + 1}-${from - 1}`
  }
  if (force) return null
  if (oldest === null) return `the RPC's oldest ledger could not be read to check --from ${from} against it; pass --force to reset anyway`
  if (from < oldest) {
    return (
      `--from ${from} is older than the RPC's oldest ledger ${oldest}: the next run would record ledgers ${from}-${oldest - 1} ` +
      "as a gap, which the index may already hold (an imported capture). Pass --force to do it anyway."
    )
  }
  return null
}

/**
 * Sets a group's cursor so the next indexer run reads again from `from`. Rows already indexed are
 * kept, and the events read again are not duplicated (the RPC event id is the key). Its members and
 * any stored gap are kept.
 */
export async function reindex(pool, { network, group, from, force, oldest }) {
  const name = `events:${group}:${network}`
  const { rows } = await pool.query("select ledger from ingest_cursor where name = $1", [name])
  const current = num(rows[0]?.ledger)
  const refusal = reindexRefusal({ name, from, current, oldest, force })
  if (refusal) throw new UsageError(refusal)
  if (oldest === null || from < oldest) {
    console.warn(`reindex: warning: ledgers from ${from} to the RPC's oldest ledger ${oldest ?? "(unknown)"} will be recorded as a gap (--force)`)
  }
  await pool.query(
    `insert into ingest_cursor (name, ledger, cursor, close_time) values ($1, $2, null, null)
     on conflict (name) do update set ledger = excluded.ledger, cursor = null, close_time = null`,
    [name, from - 1],
  )
  console.log(`reindex: ${name} was indexed through ${current ?? "nothing"}; the next run reads from ledger ${from}`)
}

// ---------------------------------------------------------------- clear-gap

/**
 * Why a gap must not be cleared yet, or null. On a database that is not on this machine (the shared
 * Testnet one) it needs `--yes`, so the operator has read the gap the command printed first.
 */
export function clearGapRefusal({ name, local, yes, from }) {
  if (local || yes) return null
  return `the database from ${from} is not on this machine: read the gap above, then run again with --yes to clear it on ${name}`
}

/**
 * Clears a group's stored gap (`gap_from`, `gap_to`) when the operator knows it is false: the
 * contracts it names had no events in those ledgers (a market built after the RPC's window began,
 * listed before its creation ledger was known). A real gap is filled by an import instead. It prints
 * the gap first, then clears exactly that gap: one the indexer widened in between is refused, to be
 * read again. The cursor and its members are kept. The next `cron/alerts` run closes the open
 * `indexer_gap` alert and posts its close.
 */
export async function clearGap(pool, { network, group, local, yes, from }) {
  const name = `events:${group}:${network}`
  const { rows } = await pool.query("select ledger, gap_from, gap_to from ingest_cursor where name = $1", [name])
  const row = rows[0]
  if (!row || row.gap_from === null || row.gap_from === undefined) {
    console.log(`clear-gap: ${name} stores no gap; nothing to clear`)
    return { cleared: false }
  }
  const gap = { from: num(row.gap_from), to: num(row.gap_to) }
  console.log(`clear-gap: ${name} stores a gap: ledgers ${gap.from}-${gap.to ?? gap.from} (indexed through ${num(row.ledger) ?? "nothing"})`)
  const refusal = clearGapRefusal({ name, local, yes, from })
  if (refusal) throw new UsageError(refusal)
  const cleared = await pool.query(
    "update ingest_cursor set gap_from = null, gap_to = null where name = $1 and gap_from = $2 and gap_to is not distinct from $3",
    [name, gap.from, gap.to],
  )
  if (cleared.rowCount === 0) throw new UsageError(`the gap on ${name} changed while it was read (an indexer run widened it); run clear-gap again`)
  console.log(`clear-gap: cleared ledgers ${gap.from}-${gap.to ?? gap.from} on ${name}. The next cron/alerts run closes the open indexer_gap alert.`)
  return { cleared: true, gap }
}

// ---------------------------------------------------------------- export

/** Writes the cursors and every events row (of `network`, when given) to `out` as JSON Lines. */
export async function exportRows(pool, { out, network }) {
  const columns = "name, ledger, cursor, close_time, gap_from, gap_to, members, reconcile"
  const cursorRows = (
    await pool.query(
      network
        ? `select ${columns} from ingest_cursor where name like $1 order by name`
        : `select ${columns} from ingest_cursor where name like 'events:%' order by name`,
      network ? [`events:%:${network}`] : [],
    )
  ).rows.filter((r) => CURSOR_NAME.test(r.name))
  const eventRows = (
    await pool.query(
      `select id, network, contract_id, group_name, topic, ledger, close_time, tx_hash, pool, data, raw_xdr
       from events ${network ? "where network = $1" : ""} order by network, ledger, id`,
      network ? [network] : [],
    )
  ).rows
  const lines = [
    { kind: "meta", format: FORMAT, version: 1, exportedAt: new Date().toISOString(), network: network ?? null, events: eventRows.length, cursors: cursorRows.length },
    ...cursorRows.map((r) => ({ kind: "cursor", name: r.name, ...cursorRow(r) })),
    ...eventRows.map((r) => ({ kind: "event", ...r, ledger: Number(r.ledger), close_time: iso(r.close_time) })),
  ]
  mkdirSync(dirname(resolve(out)), { recursive: true })
  writeFileSync(out, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return { events: eventRows.length, cursors: cursorRows.length, bytes: statSync(out).size }
}

// ---------------------------------------------------------------- import

function checkEvent(e, line) {
  const bad = (field) => new UsageError(`line ${line}: event ${field} is not valid`)
  if (typeof e.id !== "string" || !EVENT_ID.test(e.id)) throw bad("id")
  if (!NETWORKS.includes(e.network)) throw bad("network")
  if (typeof e.contract_id !== "string" || !CONTRACT.test(e.contract_id)) throw bad("contract_id")
  if (!GROUPS.includes(e.group_name)) throw bad("group_name")
  if (typeof e.topic !== "string" || e.topic === "") throw bad("topic")
  if (!Number.isInteger(e.ledger) || e.ledger <= 0) throw bad("ledger")
  if (typeof e.close_time !== "string" || Number.isNaN(Date.parse(e.close_time))) throw bad("close_time")
  if (typeof e.tx_hash !== "string" || !/^[0-9a-f]{64}$/.test(e.tx_hash)) throw bad("tx_hash")
  if (e.pool !== null && (typeof e.pool !== "string" || !CONTRACT.test(e.pool))) throw bad("pool")
  if (!e.data || typeof e.data !== "object" || Array.isArray(e.data)) throw bad("data")
  if (typeof e.raw_xdr !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(e.raw_xdr)) throw bad("raw_xdr")
}

/** Checks a cursor line and fills the fields an older export lacks with null. */
function checkCursor(c, line) {
  const bad = (field) => new UsageError(`line ${line}: cursor ${field} is not valid`)
  if (typeof c.name !== "string" || !CURSOR_NAME.test(c.name)) throw bad("name")
  if (!Number.isInteger(c.ledger) || c.ledger < 0) throw bad("ledger")
  const out = { ...c, gap_from: c.gap_from ?? null, gap_to: c.gap_to ?? null, members: c.members ?? null, reconcile: c.reconcile ?? null }
  if (out.cursor !== null && typeof out.cursor !== "string") throw bad("cursor")
  if (out.close_time !== null && (typeof out.close_time !== "string" || Number.isNaN(Date.parse(out.close_time)))) throw bad("close_time")
  const gapSet = out.gap_from !== null || out.gap_to !== null
  if (gapSet && !(Number.isInteger(out.gap_from) && Number.isInteger(out.gap_to) && out.gap_from > 0 && out.gap_from <= out.gap_to)) throw bad("gap")
  if (out.members !== null && !(Array.isArray(out.members) && out.members.every((m) => typeof m === "string" && CONTRACT.test(m)))) throw bad("members")
  if (out.reconcile !== null && !(typeof out.reconcile === "object" && typeof out.reconcile.at === "string" && Array.isArray(out.reconcile.results))) {
    throw bad("reconcile")
  }
  return out
}

/** Reads and checks a file written by `export` for `network`; nothing is written when any line is invalid. */
export function readExport(path, network) {
  if (!existsSync(path)) throw new UsageError("the --in file does not exist")
  const events = []
  const cursors = []
  const lines = readFileSync(path, "utf8").split("\n")
  lines.forEach((text, i) => {
    if (text.trim() === "") return
    const line = i + 1
    let row
    try {
      row = JSON.parse(text)
    } catch {
      throw new UsageError(`line ${line} is not JSON`)
    }
    if (row.kind === "meta") {
      if (row.format !== FORMAT || row.version !== 1) throw new UsageError(`line ${line}: not a ${FORMAT} v1 file`)
      if (row.network !== null && row.network !== network) throw new UsageError(`line ${line}: the file is for network "${row.network}", not "${network}"`)
    } else if (row.kind === "event") {
      checkEvent(row, line)
      if (row.network !== network) throw new UsageError(`line ${line}: an event of network "${row.network}", not "${network}"`)
      events.push(row)
    } else if (row.kind === "cursor") {
      const cursor = checkCursor(row, line)
      const of = CURSOR_NAME.exec(cursor.name)[2]
      if (of !== network) throw new UsageError(`line ${line}: a cursor of network "${of}", not "${network}"`)
      cursors.push(cursor)
    } else throw new UsageError(`line ${line}: unknown kind`)
  })
  return { events, cursors }
}

const least = (a, b) => (a == null ? (b ?? null) : b == null ? a : Math.min(a, b))
const greatest = (a, b) => (a == null ? (b ?? null) : b == null ? a : Math.max(a, b))
const newer = (a, b) => (!a ? (b ?? null) : !b ? a : a.at >= b.at ? a : b)

/**
 * One imported cursor line against the database's row (`current`, null when there is none).
 *
 * - The cursor only moves forward: a file ahead brings its ledger, close time and members, and
 *   widens the stored gap with its own; a file behind changes neither.
 * - The database's gap is cleared when the file's rows fill it: the file's cursor is at or past the
 *   gap's end, the file indexes every contract the database's cursor names, and the file has no gap
 *   of its own over it.
 * - The newer reconciliation is kept.
 */
export function mergeCursor(current, line) {
  const fileGap = line.gap_from == null ? null : { from: line.gap_from, to: line.gap_to }
  if (!current || current.ledger == null) {
    return {
      moved: true,
      cleared: false,
      row: {
        ledger: line.ledger,
        cursor: line.cursor,
        close_time: line.close_time,
        gap_from: fileGap?.from ?? null,
        gap_to: fileGap?.to ?? null,
        members: line.members ?? null,
        reconcile: newer(current?.reconcile, line.reconcile),
      },
    }
  }
  let gapFrom = current.gap_from
  let gapTo = current.gap_to
  let cleared = false
  const fills =
    gapFrom != null &&
    line.ledger >= gapTo &&
    Array.isArray(current.members) &&
    Array.isArray(line.members) &&
    current.members.every((m) => line.members.includes(m)) &&
    !(fileGap && fileGap.from <= gapTo && gapFrom <= fileGap.to)
  if (fills) {
    gapFrom = null
    gapTo = null
    cleared = true
  }
  const moved = line.ledger > current.ledger
  const reconcile = newer(current.reconcile, line.reconcile)
  if (!moved) {
    return { moved, cleared, row: { ledger: current.ledger, cursor: current.cursor, close_time: current.close_time, gap_from: gapFrom, gap_to: gapTo, members: current.members, reconcile } }
  }
  return {
    moved,
    cleared,
    row: {
      ledger: line.ledger,
      cursor: line.cursor,
      close_time: line.close_time ?? current.close_time,
      gap_from: least(gapFrom, fileGap?.from),
      gap_to: greatest(gapTo, fileGap?.to),
      members: line.members ?? null,
      reconcile,
    },
  }
}

/**
 * Upserts a file written by `export` for `network`, in one transaction: each event once (by its RPC
 * event id), then each cursor through `mergeCursor` under a row lock (a scheduled run that saves
 * meanwhile waits, then applies its own forward-only guard).
 */
export async function importRows(pool, { path, network }) {
  const { events, cursors } = readExport(path, network)
  const client = await pool.connect()
  let inserted = 0
  let moved = 0
  let cleared = 0
  try {
    await client.query("begin")
    for (let i = 0; i < events.length; i += IMPORT_BATCH) {
      // jsonb_to_recordset reads the table's columns and ignores the line's "kind".
      const batch = events.slice(i, i + IMPORT_BATCH)
      const res = await client.query(
        `insert into events (id, network, contract_id, group_name, topic, ledger, close_time, tx_hash, pool, data, raw_xdr)
         select id, network, contract_id, group_name, topic, ledger, close_time, tx_hash, pool, data, raw_xdr
         from jsonb_to_recordset($1::jsonb) as r(
           id text, network text, contract_id text, group_name text, topic text, ledger integer,
           close_time timestamptz, tx_hash text, pool text, data jsonb, raw_xdr text)
         on conflict (id) do nothing returning id`,
        [JSON.stringify(batch)],
      )
      inserted += res.rowCount ?? 0
    }
    for (const c of cursors) {
      const { rows } = await client.query(
        "select ledger, cursor, close_time, gap_from, gap_to, members, reconcile from ingest_cursor where name = $1 for update",
        [c.name],
      )
      const merged = mergeCursor(rows[0] ? cursorRow(rows[0]) : null, c)
      const r = merged.row
      await client.query(
        `insert into ingest_cursor (name, ledger, cursor, close_time, gap_from, gap_to, members, reconcile)
         values ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb)
         on conflict (name) do update set
           ledger = excluded.ledger, cursor = excluded.cursor, close_time = excluded.close_time,
           gap_from = excluded.gap_from, gap_to = excluded.gap_to, members = excluded.members, reconcile = excluded.reconcile`,
        [c.name, r.ledger, r.cursor, r.close_time, r.gap_from, r.gap_to, r.members, r.reconcile === null ? null : JSON.stringify(r.reconcile)],
      )
      if (merged.moved) moved++
      if (merged.cleared) cleared++
    }
    await client.query("commit")
  } catch (error) {
    await client.query("rollback").catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return { events: events.length, inserted, cursors: cursors.length, moved, cleared }
}

// ---------------------------------------------------------------- capture

const today = () => new Date().toISOString().slice(0, 10).replaceAll("-", "")

/**
 * Lists the network's markets as the app does (the registry's discovery from the Router's and the
 * factory's events, then the seeds and the valid registry markets), indexes them from the manifest's
 * RPC into this machine's database, run after run until every group has reached the RPC's latest
 * ledger, then exports that network's rows and cursors (with any stored gap) to `out`.
 */
async function capture(pool, { network, out }) {
  const load = loadAppTypeScript(root)
  const { parseManifest } = await load("lib/protocol/manifest.ts")
  const { indexEvents, INDEX_GROUPS } = await load("lib/server/indexer.ts")
  const { discover, resolvedMarkets, sqlRegistryStore } = await load("lib/server/registry.ts")
  const { createRpcReader } = await load("lib/protocol/reader.ts")
  const { createRpcServer } = await load("lib/protocol/stellar.ts")

  const manifest = parseManifest(readManifestJson(network))
  if (manifest.network !== network) throw new UsageError(`config/manifests/${network}.json is for "${manifest.network}"`)
  const sql = sqlOf(pool)
  const store = sqlRegistryStore(sql)
  const rpc = createRpcServer(manifest.rpcUrl)
  console.log(`capture: ${network} from ${new URL(manifest.rpcUrl).host} (deploy ledger ${manifest.deployLedger ?? "not set"})`)

  const started = Date.now()
  for (let run = 1; ; run++) {
    const found = await discover({ store, reader: createRpcReader(manifest), rpc, manifest }, { deadline: Date.now() + CAPTURE_RUN_MS })
    console.log(`capture: market discovery run ${run}: ${found.checked.length} pool(s) checked${found.gap ? ", with a registry gap" : ""}${found.complete ? "" : " (partial)"}`)
    if (found.complete) break
    if (run === 10) throw new Error("market discovery did not finish in 10 runs; run the capture again to resume")
  }
  const markets = await resolvedMarkets({ store, manifest, timeoutMs: 10_000 })
  const seeds = new Set(manifest.markets.map((m) => m.contracts.pool))
  console.log(`capture: ${markets.length} market(s) listed:`)
  for (const m of markets) console.log(`  ${m.marketId}  pool ${m.contracts.pool}  (${seeds.has(m.contracts.pool) ? "manifest seed" : "registry"})`)

  let last
  let inserted = 0
  let failures = 0
  for (let run = 1; ; run++) {
    last = await indexEvents({ sql, rpc, manifest, markets }, { deadline: Date.now() + CAPTURE_RUN_MS })
    inserted += last.inserted
    console.log(
      `capture: index run ${run}: +${last.inserted} rows; ` +
        last.groups.map((g) => `${g.group} through ${g.indexedThrough}${g.complete ? "" : g.error ? " (failed)" : " (partial)"}`).join(", "),
    )
    if (last.groups.every((g) => g.complete)) break
    failures = last.groups.some((g) => g.error) ? failures + 1 : 0
    if (failures === 3) throw new Error("the RPC failed three runs in a row; the cursors keep the progress, run the capture again")
    if (Date.now() - started > CAPTURE_TOTAL_MS) throw new Error("the capture did not reach the latest ledger in 30 minutes; run it again to resume")
  }

  const counts = await sql`
    select group_name, pool, count(*)::int as n from events where network = ${network} group by group_name, pool order by group_name, pool`
  const cursors = await sql`select name, ledger, gap_from, gap_to from ingest_cursor where name like ${`events:%:${network}`}`
  const written = await exportRows(pool, { out, network })
  console.log(`capture: done in ${Math.round((Date.now() - started) / 1000)} s, ${inserted} new rows this capture`)
  for (const group of INDEX_GROUPS) {
    const n = counts.filter((c) => c.group_name === group).reduce((sum, c) => sum + c.n, 0)
    const cursor = cursors.find((c) => c.name === `events:${group}:${network}`)
    const gap = cursor?.gap_from == null ? "no gap" : `gap ${cursor.gap_from}-${cursor.gap_to}`
    console.log(`  ${group.padEnd(13)} ${String(n).padStart(6)} rows, indexed through ledger ${cursor?.ledger ?? "none"}, ${gap}`)
  }
  const byPool = new Map()
  for (const c of counts) {
    const key = c.pool ?? "(shared contracts)"
    byPool.set(key, [...(byPool.get(key) ?? []), `${c.group_name} ${c.n}`])
  }
  for (const [key, parts] of byPool) {
    const market = markets.find((m) => m.contracts.pool === key)
    console.log(`  ${key}${market ? ` (${market.marketId})` : ""}: ${parts.join(", ")}`)
  }
  for (const r of last.reconcile) {
    console.log(`  reconcile ${r.escrow}: record_count ${r.recordCount ?? "unreadable"}, indexed recovery events ${r.indexed} (${r.ok ? "ok" : "MISMATCH"})`)
  }
  console.log(`capture: wrote ${written.events} events and ${written.cursors} cursors to ${relative(process.cwd(), resolve(out)) || out} (${written.bytes} bytes)`)
}

// ---------------------------------------------------------------- main

async function main(argv) {
  const { command, flags } = parseArgs(argv)
  if (!["reindex", "clear-gap", "export", "import", "capture"].includes(command)) {
    throw new UsageError("usage: indexer.mjs reindex|clear-gap|export|import|capture [--flags]; see the comment at the top of scripts/indexer.mjs")
  }
  const db = databaseUrl(flags)
  let args
  if (command === "reindex") {
    const network = networkOf(flags, true)
    const group = requireFlag(flags, "group")
    if (!GROUPS.includes(group)) throw new UsageError(`--group must be one of ${GROUPS.join(", ")}`)
    const from = Number(requireFlag(flags, "from"))
    if (!Number.isInteger(from) || from < 1) throw new UsageError("--from must be a ledger number")
    args = { network, group, from, force: flags.force === true, oldest: await rpcOldestLedger(network) }
  } else if (command === "clear-gap") {
    const network = networkOf(flags, true)
    const group = requireFlag(flags, "group")
    if (!GROUPS.includes(group)) throw new UsageError(`--group must be one of ${GROUPS.join(", ")}`)
    args = { network, group, yes: flags.yes === true, local: await isLocalDatabase(db.url), from: db.from }
  } else if (command === "export") {
    args = { out: requireFlag(flags, "out"), network: networkOf(flags, false) }
  } else if (command === "import") {
    args = { path: requireFlag(flags, "in"), network: networkOf(flags, true) }
  } else {
    const network = networkOf(flags, true)
    if (!(await isLocalDatabase(db.url))) {
      throw new UsageError(`capture writes only to a database on this machine; the one from ${db.from} is not (import its file into a shared database instead)`)
    }
    args = { network, out: flags.out ?? join("var", "indexer-capture", `${network}-${today()}.jsonl`) }
  }

  const pool = new pg.Pool({ connectionString: db.url, max: 5, connectionTimeoutMillis: 10_000 })
  try {
    if (command === "reindex") await reindex(pool, args)
    else if (command === "clear-gap") await clearGap(pool, args)
    else if (command === "export") {
      const r = await exportRows(pool, args)
      console.log(`export: ${r.events} events and ${r.cursors} cursors to ${args.out} (${r.bytes} bytes)`)
    } else if (command === "import") {
      const r = await importRows(pool, args)
      console.log(`import: ${r.events} events (${r.inserted} new), ${r.cursors} cursors (${r.moved} moved forward, ${r.cleared} gaps cleared)`)
    } else await capture(pool, args)
  } finally {
    await pool.end().catch(() => {})
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError || error instanceof TypeScriptTransformRequired) fail(error.message)
    // A database error is reported by its code only; anything else by its name and scrubbed text.
    if (error && typeof error === "object" && "code" in error && /^[0-9A-Z]{5}$|^E[A-Z]+$/.test(String(error.code))) {
      fail(`the database refused (error code ${dbCode(error)}). Check it is reachable, the credentials, and that pnpm db:migrate ran.`)
    }
    fail(`failed: ${describe(error)}`)
  }
}
