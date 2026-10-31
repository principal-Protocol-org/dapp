import "server-only"

/**
 * The app's Postgres access: one module-level node-postgres `Pool` (Neon recommends `pg` on Vercel;
 * the local `postgres:17` container speaks the same protocol). `attachDatabasePool` lets Fluid
 * compute close idle connections before a function instance is suspended.
 *
 * `sql` is a tagged template: every `${value}` becomes a numbered parameter ($1, $2, ...), so a
 * query can never be built by string concatenation. The app connects with `DATABASE_URL` (the
 * pooled string on Neon); migrations use a direct connection (scripts/db-migrate.mjs).
 * Nothing here ever logs or returns the connection string.
 */
import { attachDatabasePool } from "@vercel/functions"
import { Pool } from "pg"

export type Sql = <T extends object = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T[]>

export class DatabaseConfigError extends Error {
  constructor() {
    super("DATABASE_URL is not set.")
    this.name = "DatabaseConfigError"
  }
}

let pool: Pool | undefined

function getPool(): Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new DatabaseConfigError()
  // Every wait is bounded on the client (R2-40, R2-41): connecting (5 s: a Neon compute waking from
  // scale-to-zero can take over 2 s; pages are bounded anyway by the 1.5 s registry race) and each
  // query (5 s). No server-side timeout: pg sends `statement_timeout` / `options` in the startup
  // packet, and Neon's pooler (PgBouncer) refuses any startup parameter but a few session basics.
  pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000, query_timeout: 5_000 })
  attachDatabasePool(pool)
  return pool
}

/** `$1, $2, ...` text and the parameter list for a tagged template. */
export function toQuery(strings: TemplateStringsArray, values: unknown[]): { text: string; values: unknown[] } {
  let text = strings[0]
  for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`
  return { text, values }
}

export const sql: Sql = async <T extends object = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => {
  const { text, values: params } = toQuery(strings, values)
  const result = await getPool().query(text, params)
  return result.rows as T[]
}
