// Applies db/migrations/*.sql in order, each once, over a DIRECT connection.
//
//   node scripts/db-migrate.mjs [--env-file <path>]
//
// Connection: DATABASE_URL_UNPOOLED if set, else DATABASE_URL with "-pooler" removed from the host
// (Neon convention: DDL does not go through the pooler). Variables come from --env-file when given,
// otherwise from the environment, then .env.local. This script never prints a connection string or
// any part of it: failures are reported by error code only.
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { parseEnv } from "node:util"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function fail(message) {
  console.error(`db-migrate: ${message}`)
  process.exit(1)
}

function loadEnv(argv) {
  const i = argv.indexOf("--env-file")
  if (i !== -1) {
    const path = argv[i + 1]
    if (!path) fail("--env-file needs a path")
    if (!existsSync(path)) fail(`env file not found: ${path}`)
    return { ...process.env, ...parseEnv(readFileSync(path, "utf8")) }
  }
  const local = join(root, ".env.local")
  const fromFile = existsSync(local) ? parseEnv(readFileSync(local, "utf8")) : {}
  return { ...fromFile, ...process.env }
}

/** The direct (unpooled) connection string, or null when none is configured. */
export function directUrl(env) {
  if (env.DATABASE_URL_UNPOOLED) return env.DATABASE_URL_UNPOOLED
  if (!env.DATABASE_URL) return null
  const url = new URL(env.DATABASE_URL)
  url.hostname = url.hostname.replace("-pooler", "")
  return url.toString()
}

async function main() {
  const env = loadEnv(process.argv.slice(2))
  let connectionString
  try {
    connectionString = directUrl(env)
  } catch {
    fail("DATABASE_URL is not a valid connection string")
  }
  if (!connectionString) fail("set DATABASE_URL (or DATABASE_URL_UNPOOLED), or pass --env-file <path>")

  const dir = join(root, "db", "migrations")
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  const client = new pg.Client({ connectionString })
  try {
    await client.connect()
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    )
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name))
    for (const file of files) {
      if (done.has(file)) {
        console.log(`skip   ${file}`)
        continue
      }
      await client.query("begin")
      try {
        await client.query(readFileSync(join(dir, file), "utf8"))
        await client.query("insert into schema_migrations (name) values ($1)", [file])
        await client.query("commit")
      } catch (error) {
        await client.query("rollback")
        throw error
      }
      console.log(`apply  ${file}`)
    }
  } catch (error) {
    // Never echo error.message: connection errors can carry the host or the URL.
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown"
    fail(`migration failed (error code ${code}). Check the database is reachable and the credentials are right.`)
  } finally {
    await client.end().catch(() => {})
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
