/**
 * "How to verify" helpers (D-7): the `stellar contract invoke` command that re-reads a figure, and
 * the evidence table with the TRANCHE_2_3 §15.2 (l.1824) columns.
 */
import type { Live, Network, ReadSource } from "../types"

/**
 * The account a simulation-only read names as source (`NULL_ACCOUNT` of `@stellar/stellar-sdk/contract`,
 * the one `simulateContractRead` uses). It holds no key: `--send=no` only simulates, so nothing is signed.
 */
export const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"

/**
 * The CLI names a contract argument by its Rust parameter name (`--<name> <value>`), so the command
 * needs the names. They are taken from the contract sources (principal 665bb67, identical at 24d980d
 * for these views) and the Stellar Asset Contract interface:
 *
 * | fn | contract | parameters |
 * |---|---|---|
 * | `balance` | SAC (SEP-41 token interface) | `id` |
 * | `authorized` | SAC | `id` |
 * | `get_record` | RecoveryEscrow `:352` | `id` |
 * | `account_records` | RecoveryEscrow `:357` | `account` |
 * | `pending_claim`, `last_claimed_index` | YTToken `:559`, `:552` | `account` |
 * | `balance_of`, `net_deposited` | SYWrapper `:457`, `:486` | `account` |
 * | `lp_balance` | MarketPool `:764` | `account` |
 * | `is_consumer`, `is_pauser` | RiskControl `:216`, `:169` | `account` |
 * | `get_asset_limit`, `get_asset_volume` | RiskControl `:353`, `:361` | `asset` |
 * | `is_fresh` | OracleAdapter `:363` | `max_stale_seconds` |
 * | `swap_fee_rate` | MarketConfig `:269` | `seconds_to_maturity` |
 * | `split` | MarketConfig `:261` | `fee` |
 * | `market` | Router `:464` | `pool` |
 * | `is_allowed` | Permissioning `:87` | `account` |
 * | `is_allowed_for_asset` | Permissioning `:119` | `account`, `asset` |
 *
 * `balance` is ambiguous: PTToken and YTToken name it `account`, not `id`. A read of those records
 * the name on its source with `nameArgs`, which wins over this map.
 */
export const ARG_NAMES: Readonly<Record<string, readonly string[]>> = {
  balance: ["id"],
  authorized: ["id"],
  get_record: ["id"],
  account_records: ["account"],
  pending_claim: ["account"],
  last_claimed_index: ["account"],
  balance_of: ["account"],
  net_deposited: ["account"],
  lp_balance: ["account"],
  is_consumer: ["account"],
  is_pauser: ["account"],
  get_asset_limit: ["asset"],
  get_asset_volume: ["asset"],
  is_fresh: ["max_stale_seconds"],
  swap_fee_rate: ["seconds_to_maturity"],
  split: ["fee"],
  market: ["pool"],
  is_allowed: ["account"],
  is_allowed_for_asset: ["account", "asset"],
}

/** A source argument as `readLive` records it (`{ type, value }`, bigints as decimal strings), maybe named. */
type RecordedArg = { type?: unknown; value?: unknown; name?: unknown }

const asRecorded = (arg: unknown): RecordedArg => (arg && typeof arg === "object" ? (arg as RecordedArg) : { value: arg })

/** Records the contract's parameter names on a read's source, so `verifyCommand` needs no lookup. */
export function nameArgs<T>(live: Live<T>, names: readonly string[]): Live<T> {
  if (!live.source) return live
  const args = live.source.args.map((arg, i) => (names[i] === undefined ? arg : { ...asRecorded(arg), name: names[i] }))
  return { ...live, source: { ...live.source, args } } as Live<T>
}

/** The argument value as the CLI takes it: addresses, numbers and symbols as they are, bytes as hex, structs as JSON. */
function argValue(arg: RecordedArg): string {
  const v = arg.value
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v)
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))
}

/** Quotes a shell word unless it is plainly safe (addresses, numbers, hex, URLs). */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_.:/=+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015"

/**
 * The network flags. The CLI's built-in networks are named `local`, `testnet`, `futurenet` and
 * `mainnet` (`stellar network ls`), so the manifest's `local` and `testnet` map to themselves. The
 * built-in `mainnet` has no RPC ("Bring Your Own"), and `--rpc-url` cannot be added to `--network`
 * (the CLI then asks for the passphrase), so a Mainnet command names the RPC and passphrase instead.
 */
function networkFlags(network: Network, rpcUrl: string): string {
  if (network === "mainnet" && rpcUrl) return `--rpc-url ${shellWord(rpcUrl)} --network-passphrase ${shellWord(MAINNET_PASSPHRASE)}`
  return `--network ${network}`
}

function argNames(source: Pick<ReadSource, "fn" | "args">): string[] {
  return source.args.map((raw, i) => {
    const arg = asRecorded(raw)
    if (typeof arg.name === "string" && arg.name) return arg.name
    const name = ARG_NAMES[source.fn]?.[i]
    if (!name) throw new Error(`No argument name is known for ${source.fn} (argument ${i + 1})`)
    return name
  })
}

/**
 * The command that re-reads a figure as a simulation (nothing is signed or sent):
 * `stellar contract invoke --network <net> --id <C…> --source-account <null account> --send=no -- <fn> --<arg> <value>…`.
 * Throws when an argument's name is unknown: a command with a guessed flag would fail or mislead.
 */
export function verifyCommand(network: Network, source: ReadSource | Omit<ReadSource, "rawXdr" | "ledger">): string {
  const names = argNames(source)
  const args = source.args.map((raw, i) => `--${names[i]} ${shellWord(argValue(asRecorded(raw)))}`)
  return [
    "stellar contract invoke",
    networkFlags(network, source.rpcUrl),
    `--id ${source.contractId}`,
    `--source-account ${NULL_ACCOUNT}`,
    "--send=no",
    "--",
    source.fn,
    ...args,
  ].join(" ")
}

export type VerifiableFigure = { label: string; display: string; live: Live<unknown> }

const COLUMNS = [
  "Dashboard metric",
  "Contract ID / source",
  "Function + params",
  "Raw value",
  "Display value",
  "Ledger",
  "RPC/indexer coverage",
  "Cache/stale status",
  "Verified",
]

const NONE = "—"

/** A Markdown table cell: `|` escaped, line breaks flattened. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim()
}

function call(source: Pick<ReadSource, "fn" | "args">): string {
  let names: string[] | null
  try {
    names = argNames(source)
  } catch {
    names = null
  }
  const params = source.args.map((raw, i) => {
    const value = argValue(asRecorded(raw))
    return names ? `${names[i]}=${value}` : value
  })
  return `${source.fn}(${params.join(", ")})`
}

const unique = (xs: string[]) => [...new Set(xs.filter((x) => x !== ""))]
const orNone = (xs: string[], sep: string) => (xs.length > 0 ? xs.join(sep) : NONE)

function row(f: VerifiableFigure): string[] {
  const { live } = f
  if (live.status === "unavailable") {
    const s = live.source
    return [
      f.label,
      s ? s.contractId : NONE,
      s ? call(s) : NONE,
      NONE,
      f.display,
      NONE,
      s?.rpcUrl || NONE,
      `Unavailable: ${live.error}`,
      "",
    ]
  }
  const reads = live.sources ?? (live.source ? [live.source] : [])
  const spread = live.ledgerSpread
  return [
    f.label,
    orNone(unique(reads.map((s) => s.contractId)), ", "),
    orNone(reads.map(call), "; "),
    orNone(reads.map((s) => s.rawXdr), "; "),
    f.display,
    spread ? `${spread.min}–${spread.max}` : String(live.ledger),
    orNone(unique(reads.map((s) => s.rpcUrl)), ", "),
    spread ? `Read across ledgers ${spread.min}–${spread.max}` : "Live",
    "",
  ]
}

/** The page's figures as a Markdown table with the TRANCHE_2_3 l.1824 columns; "Verified" is left for the reviewer. */
export function evidenceRows(figures: VerifiableFigure[]): string {
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`.replace(/ {2}\|/g, " |")
  return [line(COLUMNS), `|${COLUMNS.map(() => "---").join("|")}|`, ...figures.map((f) => line(row(f)))].join("\n") + "\n"
}
