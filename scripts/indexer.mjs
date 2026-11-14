// The event indexer's operator commands (spec 0004 D-15, D-30). The scheduled job is
// `/api/cron/index`; these run by hand.
//
//   pnpm indexer:reindex --network <n> --group <g> --from <ledger>   reset one group's cursor
//   pnpm indexer:export  --out <file.jsonl> [--network <n>]           every events row and cursor, as JSON Lines
//   pnpm indexer:import  --in <file.jsonl>                            upsert a file written by export (idempotent)
//   pnpm indexer:capture --network <n> [--out <file.jsonl>]           index from the network's RPC into a local
//                                                                      database, then export (default out:
//                                                                      var/indexer-capture/<n>-<YYYYMMDD>.jsonl)
//
// Networks: local, testnet, mainnet. Groups: escrow, oracle, permissioning, risk, market.
//
// Database: --database-url <url>, else the DATABASE_URL of --env-file <path>, else DATABASE_URL in
// the environment, else the DATABASE_URL of .env.local. `capture` writes only to a database on this
// machine (localhost, 127.0.0.1, ::1 or a socket): its rows reach a shared database through `import`,
// with the developer's go. This script never prints a connection string or any part of it.
//
// `capture` runs the app's own indexer (lib/server/indexer.ts) and needs Node's TypeScript transform
// (`pnpm indexer:capture` passes --experimental-transform-types). On the RPC it only reads:
// getHealth, getEvents, getLedgers and the simulation of RecoveryEscrow.record_count.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { registerHooks } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseEnv } from "node:util"
import pg from "pg"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const NETWORKS = ["local", "testnet", "mainnet"]
const GROUPS = ["escrow", "oracle", "permissioning", "risk", "market"]
const EVENT_ID = /^\d{19}-\d{10}$/
const CONTRACT = /^C[A-Z2-7]{55}$/
const CURSOR_NAME = new RegExp(`^events:(${GROUPS.join("|")}):(${NETWORKS.join("|")})$`)
const FORMAT = "principal-indexer-export"
/** Events per insert statement on import. */
const IMPORT_BATCH = 500
/** Capture: one indexer run's deadline, and the whole capture's. */
const CAPTURE_RUN_MS = 120_000
const CAPTURE_TOTAL_MS = 30 * 60_000

class UsageError extends Error {}

function fail(message) {
  console.error(`indexer: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- arguments and connection

function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}"`)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`)
    flags[arg.slice(2)] = value
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

/** A database on this machine: a loopback host or a Unix socket. */
export function isLocalDatabase(url) {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  return host === "" || host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
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

// ---------------------------------------------------------------- reindex

/**
 * Sets a group's cursor so the next indexer run reads again from `from`. Rows already indexed are
 * kept, and the events read again are not duplicated (the RPC event id is the key). It never moves
 * a cursor forward: that would skip events without recording a gap.
 */
export async function reindex(pool, { network, group, from }) {
  const name = `events:${group}:${network}`
  const { rows } = await pool.query("select ledger from ingest_cursor where name = $1", [name])
  const current = rows[0]?.ledger == null ? null : Number(rows[0].ledger)
  if (current !== null && from - 1 > current) {
    throw new UsageError(`${name} is indexed through ledger ${current}; --from ${from} would skip ledgers ${current + 1}-${from - 1}`)
  }
  await pool.query(
    `insert into ingest_cursor (name, ledger, cursor, close_time) values ($1, $2, null, null)
     on conflict (name) do update set ledger = excluded.ledger, cursor = null, close_time = null`,
    [name, from - 1],
  )
  console.log(`reindex: ${name} was indexed through ${current ?? "nothing"}; the next run reads from ledger ${from}`)
}

// ---------------------------------------------------------------- export

/** Writes the cursors and every events row (of `network`, when given) to `out` as JSON Lines. */
export async function exportRows(pool, { out, network }) {
  const cursorRows = (
    await pool.query(
      network
        ? "select name, ledger, cursor, close_time from ingest_cursor where name like $1 order by name"
        : "select name, ledger, cursor, close_time from ingest_cursor where name like 'events:%' order by name",
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
    ...cursorRows.map((r) => ({ kind: "cursor", name: r.name, ledger: Number(r.ledger), cursor: r.cursor, close_time: iso(r.close_time) })),
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

function checkCursor(c, line) {
  const bad = (field) => new UsageError(`line ${line}: cursor ${field} is not valid`)
  if (typeof c.name !== "string" || !CURSOR_NAME.test(c.name)) throw bad("name")
  if (!Number.isInteger(c.ledger) || c.ledger < 0) throw bad("ledger")
  if (c.cursor !== null && typeof c.cursor !== "string") throw bad("cursor")
  if (c.close_time !== null && (typeof c.close_time !== "string" || Number.isNaN(Date.parse(c.close_time)))) throw bad("close_time")
}

/** Reads and checks a file written by `export`; nothing is written when any line is invalid. */
export function readExport(path) {
  if (!existsSync(path)) throw new UsageError("the --in file does not exist")
  const events = []
  const cursors = []
  const lines = readFileSync(path, "utf8").split("\n")
  lines.forEach((text, i) => {
    if (text.trim() === "") return
    let row
    try {
      row = JSON.parse(text)
    } catch {
      throw new UsageError(`line ${i + 1} is not JSON`)
    }
    if (row.kind === "meta") {
      if (row.format !== FORMAT || row.version !== 1) throw new UsageError(`line ${i + 1}: not a ${FORMAT} v1 file`)
    } else if (row.kind === "event") {
      checkEvent(row, i + 1)
      events.push(row)
    } else if (row.kind === "cursor") {
      checkCursor(row, i + 1)
      cursors.push(row)
    } else throw new UsageError(`line ${i + 1}: unknown kind`)
  })
  return { events, cursors }
}

/**
 * Upserts a file written by `export`, in one transaction: each event once (by its RPC event id),
 * then each cursor, moved only forward (an older cursor in the file never rewinds the database).
 */
export async function importRows(pool, { path }) {
  const { events, cursors } = readExport(path)
  const client = await pool.connect()
  let inserted = 0
  let moved = 0
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
      const res = await client.query(
        `insert into ingest_cursor (name, ledger, cursor, close_time) values ($1, $2, $3, $4)
         on conflict (name) do update set
           ledger = excluded.ledger,
           cursor = excluded.cursor,
           close_time = coalesce(excluded.close_time, ingest_cursor.close_time)
         where ingest_cursor.ledger is null or excluded.ledger > ingest_cursor.ledger
         returning name`,
        [c.name, c.ledger, c.cursor, c.close_time],
      )
      moved += res.rowCount ?? 0
    }
    await client.query("commit")
  } catch (error) {
    await client.query("rollback").catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return { events: events.length, inserted, cursors: cursors.length, moved }
}

// ---------------------------------------------------------------- capture

/**
 * Lets Node load the app's TypeScript as Next and Vitest do: the `@/` alias, extensionless relative
 * imports, and `server-only` under the `react-server` condition (an empty module there).
 */
function loadAppTypeScript() {
  if (process.features?.typescript !== "transform") {
    throw new UsageError("capture loads the app's TypeScript: run it with `pnpm indexer:capture` (node --experimental-transform-types)")
  }
  const EXTENSIONS = [".ts", ".tsx", "/index.ts"]
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "server-only") return next(specifier, { ...context, conditions: [...(context.conditions ?? []), "react-server"] })
      let spec = specifier
      if (spec.startsWith("@/")) spec = pathToFileURL(join(root, spec.slice(2))).href
      const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null
      const appRelative = (spec.startsWith("./") || spec.startsWith("../")) && parent !== null && !parent.includes("/node_modules/")
      if (spec.startsWith("file:") || appRelative) {
        const base = spec.startsWith("file:") ? fileURLToPath(spec) : join(dirname(parent), spec)
        if (!(existsSync(base) && statSync(base).isFile())) {
          for (const ext of EXTENSIONS) if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context)
        }
      }
      return next(spec, context)
    },
  })
  return (path) => import(pathToFileURL(join(root, path)).href)
}

const today = () => new Date().toISOString().slice(0, 10).replaceAll("-", "")

/**
 * Indexes `network` from its manifest's RPC into this machine's database, run after run until every
 * group has reached the RPC's latest ledger, then exports that network's rows and cursors to `out`.
 */
async function capture(pool, { network, out }) {
  const load = loadAppTypeScript()
  const { parseManifest } = await load("lib/protocol/manifest.ts")
  const { indexEvents, INDEX_GROUPS } = await load("lib/server/indexer.ts")
  const { resolvedMarkets, sqlRegistryStore } = await load("lib/server/registry.ts")
  const { createRpcServer } = await load("lib/protocol/stellar.ts")

  const manifest = parseManifest(JSON.parse(readFileSync(join(root, "config", "manifests", `${network}.json`), "utf8")))
  if (manifest.network !== network) throw new UsageError(`config/manifests/${network}.json is for "${manifest.network}"`)
  const sql = sqlOf(pool)
  const markets = await resolvedMarkets({ store: sqlRegistryStore(sql), manifest, timeoutMs: 10_000 })
  const rpc = createRpcServer(manifest.rpcUrl)
  console.log(
    `capture: ${network} from ${new URL(manifest.rpcUrl).host} (deploy ledger ${manifest.deployLedger ?? "not set"}), ` +
      `${markets.length} market(s): ${markets.map((m) => m.marketId).join(", ")}`,
  )

  const started = Date.now()
  const gaps = new Map()
  let last
  let inserted = 0
  let failures = 0
  for (let run = 1; ; run++) {
    last = await indexEvents({ sql, rpc, manifest, markets }, { deadline: Date.now() + CAPTURE_RUN_MS })
    inserted += last.inserted
    for (const g of last.groups) if (g.gap && !gaps.has(g.group)) gaps.set(g.group, g.gap)
    console.log(
      `capture: run ${run}: +${last.inserted} rows; ` +
        last.groups.map((g) => `${g.group} through ${g.indexedThrough}${g.complete ? "" : g.error ? " (failed)" : " (partial)"}`).join(", "),
    )
    if (last.groups.every((g) => g.complete)) break
    failures = last.groups.some((g) => g.error) ? failures + 1 : 0
    if (failures === 3) throw new Error("the RPC failed three runs in a row; the cursors keep the progress, run the capture again")
    if (Date.now() - started > CAPTURE_TOTAL_MS) throw new Error("the capture did not reach the latest ledger in 30 minutes; run it again to resume")
  }

  const counts = await sql`select group_name, count(*)::int as n from events where network = ${network} group by group_name`
  const written = await exportRows(pool, { out, network })
  console.log(`capture: done in ${Math.round((Date.now() - started) / 1000)} s, ${inserted} new rows this capture`)
  for (const group of INDEX_GROUPS) {
    const g = last.groups.find((x) => x.group === group)
    const n = counts.find((c) => c.group_name === group)?.n ?? 0
    const gap = gaps.get(group)
    console.log(`  ${group.padEnd(13)} ${String(n).padStart(6)} rows, indexed through ledger ${g?.indexedThrough}${gap ? `, gap ${gap.from}-${gap.to}` : ", no gap"}`)
  }
  for (const r of last.reconcile) {
    console.log(`  reconcile ${r.escrow}: record_count ${r.recordCount ?? "unreadable"}, indexed recovery events ${r.indexed} (${r.ok ? "ok" : "MISMATCH"})`)
  }
  console.log(`capture: wrote ${written.events} events and ${written.cursors} cursors to ${relative(process.cwd(), resolve(out)) || out} (${written.bytes} bytes)`)
}

// ---------------------------------------------------------------- main

async function main(argv) {
  const { command, flags } = parseArgs(argv)
  if (!["reindex", "export", "import", "capture"].includes(command)) {
    throw new UsageError("usage: indexer.mjs reindex|export|import|capture [--flags]; see the comment at the top of scripts/indexer.mjs")
  }
  const db = databaseUrl(flags)
  let args
  if (command === "reindex") {
    const network = networkOf(flags, true)
    const group = requireFlag(flags, "group")
    if (!GROUPS.includes(group)) throw new UsageError(`--group must be one of ${GROUPS.join(", ")}`)
    const from = Number(requireFlag(flags, "from"))
    if (!Number.isInteger(from) || from < 1) throw new UsageError("--from must be a ledger number")
    args = { network, group, from }
  } else if (command === "export") {
    args = { out: requireFlag(flags, "out"), network: networkOf(flags, false) }
  } else if (command === "import") {
    args = { path: requireFlag(flags, "in") }
  } else {
    const network = networkOf(flags, true)
    if (!isLocalDatabase(db.url)) {
      throw new UsageError(`capture writes only to a database on this machine; the one from ${db.from} is not (import its file into a shared database instead)`)
    }
    args = { network, out: flags.out ?? join("var", "indexer-capture", `${network}-${today()}.jsonl`) }
  }

  const pool = new pg.Pool({ connectionString: db.url, max: 5, connectionTimeoutMillis: 10_000 })
  try {
    if (command === "reindex") await reindex(pool, args)
    else if (command === "export") {
      const r = await exportRows(pool, args)
      console.log(`export: ${r.events} events and ${r.cursors} cursors to ${args.out} (${r.bytes} bytes)`)
    } else if (command === "import") {
      const r = await importRows(pool, args)
      console.log(`import: ${r.events} events (${r.inserted} new), ${r.cursors} cursors (${r.moved} moved forward)`)
    } else await capture(pool, args)
  } finally {
    await pool.end().catch(() => {})
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) fail(error.message)
    // A database error is reported by its code only; anything else by its name and scrubbed text.
    if (error && typeof error === "object" && "code" in error && /^[0-9A-Z]{5}$|^E[A-Z]+$/.test(String(error.code))) {
      fail(`the database refused (error code ${dbCode(error)}). Check it is reachable, the credentials, and that pnpm db:migrate ran.`)
    }
    fail(`failed: ${describe(error)}`)
  }
}
