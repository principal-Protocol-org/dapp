// The read-only deployment check (spec 0005 M-22): reads the deployment a manifest names and
// compares it with the manifest. It needs no key and no database, and signs or sends nothing.
//
//   pnpm smoke:mainnet [--json]                                         config/manifests/mainnet.json
//   node --experimental-transform-types scripts/smoke.mjs --network testnet|local [--json]
//
// Every read goes through the app's own read functions and contract reader, on the manifest's
// `rpcUrl` and `networkPassphrase`, and so takes a slot of the app's read cap (at most 6 requests in
// flight, lib/protocol/rpc-limiter.ts). Only simulations and ledger-entry reads, in this order:
//   1. the ledger clock (getLatestLedger);
//   2. the code hash of every contract the manifest names (one getLedgerEntries), against its pin in
//      `wasmHashes` (a market's own pin first);
//   3. each market's topology (fetchTopology: Router.market(pool) and the manager's maturity);
//   4. each oracle of the manifest's markets (fetchOracleView, and its feed's price when it names one);
//   5. each market's state (fetchMarketState), RiskControl (fetchRiskView) and the pauses (fetchPauses).
//
// It prints one table (market, topology, oracle state, feed, value against feed, paused), then what
// it found and a summary line. Exit code 0 when every topology matches, every contract's code could
// be read, every pinned code hash matches and every read of a manifest contract answered; 1
// otherwise; 2 for a usage error. A stale oracle, a paused contract, a contract with no pin (its code
// read) and a failed read of a contract the manifest does not name (an oracle's feed) are warnings:
// reported, never a failure. `--json` prints the same as JSON.
//
// A public RPC refuses a burst as busy (HTTP 429, -32004): the Mainnet gateway took about 100 reads
// at 6 in flight, then refused the rest for a while (2026-11-20). A read refused that way, or one the
// RPC did not answer (a network error, a timeout), is asked again after a pause (1, 2, 4, 8, then
// every 15 s, each with some jitter), through the same cap. A contract's own answer, an error among
// them, is never asked again. The run's budget is 4 minutes: after it no read is asked (a read not
// asked fails the check), and a run still going a minute later (a hung RPC answering nothing) stops
// with exit 1 and no table.
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadAppTypeScript, TypeScriptTransformRequired } from "./lib/load-app-ts.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const NETWORKS = ["local", "testnet", "mainnet"]
/** The run's budget: no read is asked after it. */
const RUN_BUDGET_MS = 240_000
/** How long after the budget a run still going is stopped (the reads already sent time out in 20 s). */
const STOP_AFTER_BUDGET_MS = 60_000
/** The pauses before each new attempt of a refused read; the last one repeats. */
const WAITS_MS = [1_000, 2_000, 4_000, 8_000, 15_000]

class UsageError extends Error {}

/**
 * One row of the check: a market of the manifest, or the shared contracts (`market` null).
 * @typedef {{ status: "match" } | { status: "mismatch", fields: string[] } | { status: "unread", reason: string }} TopologyResult
 * @typedef {{ contract: string, state: "fresh" | "warning" | "stale" | "unavailable", ageSeconds: number | null, maxStaleSeconds: number | null }} OracleResult
 * @typedef {{ kind: string, contract: string, expected: string | null, actual: string | null, reason?: string }} CodeResult
 *   `expected` null: the manifest pins no hash for it; `actual` null: the code could not be read (`reason`).
 * @typedef {{ call: string, reason: string, manifest: boolean }} FailedRead
 *   `manifest`: the contract is one the manifest names (else an oracle's feed, say).
 * @typedef {{
 *   market: string | null,
 *   asset: string | null,
 *   topology: TopologyResult | null,
 *   oracle: OracleResult | null,
 *   feed: string,
 *   againstFeed: string,
 *   paused: string[] | null,
 *   code: CodeResult[],
 *   unread: FailedRead[],
 * }} Row
 */

// ---------------------------------------------------------------- the verdict (pure)

/** A contract or account id as the alerts shorten it ("CCKX…K7IT"). */
const shortId = (id) => (/^[CG][A-Z2-7]{55}$/.test(id) ? `${id.slice(0, 4)}…${id.slice(-4)}` : id)

/** Seconds as "3d 4h", "2h 5m", "4m 10s" or "12s". */
function duration(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  if (s >= 86_400) return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${s}s`
}

const where = (row) => (row.market === null ? "shared" : row.market)
const named = (row) => (row.market === null ? "the shared contracts" : `${row.market} (${row.asset})`)
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`
const pinned = (c) => c.expected !== null
const codeMatches = (c) => pinned(c) && c.actual === c.expected

/** Every failed read once, by call: a read two rows share (RiskControl's) is one failure. */
function failedReads(rows) {
  const byCall = new Map()
  for (const row of rows) for (const read of row.unread) if (!byCall.has(read.call)) byCall.set(read.call, read)
  return [...byCall.values()]
}

/** Each oracle once, with the assets of the rows that read it, in row order. */
function oracles(rows) {
  const byContract = new Map()
  for (const row of rows) {
    if (!row.oracle) continue
    const entry = byContract.get(row.oracle.contract)
    if (entry) entry.assets.push(row.asset)
    else byContract.set(row.oracle.contract, { oracle: row.oracle, assets: [row.asset] })
  }
  return [...byContract.values()]
}

/**
 * 1 when a topology mismatches or could not be read, a pinned code hash differs or could not be
 * read (pinned or not), or a read of a manifest contract failed; else 0. A stale oracle, a pause, a
 * contract with no pin whose code was read, and a failed read of another contract do not count.
 * @param {Row[]} rows
 * @returns {0 | 1}
 */
export function exitCode(rows) {
  const bad = rows.some(
    (row) =>
      (row.topology !== null && row.topology.status !== "match") ||
      row.code.some((c) => c.actual === null || (pinned(c) && !codeMatches(c))) ||
      row.unread.some((read) => read.manifest),
  )
  return bad ? 1 : 0
}

/**
 * What the check found: a `FAIL: …` line per failure, a `warning: …` line per reported condition,
 * then the summary line, `PASS: …` or `FAIL: …` (as `exitCode`).
 * @param {Row[]} rows
 * @returns {string[]}
 */
export function summarize(rows) {
  const failures = []
  const warnings = []
  for (const row of rows) {
    const t = row.topology
    if (t?.status === "mismatch") failures.push(`FAIL: topology of ${named(row)}: ${t.fields.join(", ")} ${t.fields.length === 1 ? "differs" : "differ"} from the manifest`)
    if (t?.status === "unread") failures.push(`FAIL: topology of ${named(row)} could not be read: ${t.reason}`)
    for (const c of row.code) {
      if (c.actual === null) failures.push(`FAIL: code of ${c.kind} ${c.contract} (${where(row)}) could not be read: ${c.reason ?? "no answer"}`)
      else if (!pinned(c)) warnings.push(`warning: ${c.kind} ${c.contract} (${where(row)}) has no pinned code hash in the manifest; not checked`)
      else if (c.actual !== c.expected) failures.push(`FAIL: code of ${c.kind} ${c.contract} (${where(row)}): the chain runs ${c.actual}, the manifest pins ${c.expected}`)
    }
  }
  const reads = failedReads(rows)
  for (const read of reads) {
    if (read.manifest) failures.push(`FAIL: could not read ${read.call}: ${read.reason}`)
    else warnings.push(`warning: could not read ${read.call} (not a manifest contract): ${read.reason}`)
  }

  const seen = oracles(rows)
  for (const { oracle, assets } of seen) {
    const which = `oracle ${shortId(oracle.contract)} (${assets.join(", ")})`
    const age = oracle.ageSeconds === null ? "" : `: its value is ${duration(oracle.ageSeconds)} old`
    const allowed = oracle.maxStaleSeconds === null ? "" : `, ${duration(oracle.maxStaleSeconds)} allowed`
    if (oracle.state === "stale") warnings.push(`warning: ${which} is stale${age}${allowed}; operations that need its price are blocked (reported; does not fail the check)`)
    if (oracle.state === "warning") warnings.push(`warning: ${which} is near its limit${age}${allowed}`)
    if (oracle.state === "unavailable") warnings.push(`warning: ${which}: its freshness is not known (a read it needs did not answer)`)
  }
  const paused = rows.flatMap((row) => row.paused ?? [])
  if (paused.length > 0) warnings.push(`warning: paused: ${paused.join(", ")}`)

  const topologies = rows.filter((row) => row.topology !== null)
  const matching = topologies.filter((row) => row.topology?.status === "match").length
  const checked = rows.flatMap((row) => row.code).filter(pinned)
  const pins = new Set(checked.map((c) => c.expected)).size
  const states = ["fresh", "warning", "stale", "unavailable"]
    .map((state) => [state, seen.filter((o) => o.oracle.state === state).length])
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${n} ${state}`)
  const failed = reads.filter((read) => read.manifest).length
  const verdict = exitCode(rows) === 0 ? "PASS" : "FAIL"
  const summary =
    `${verdict}: ${matching} of ${topologies.length} topologies match, ` +
    `${checked.filter(codeMatches).length} of ${checked.length} code hashes match (${plural(pins, "pinned hash", "pinned hashes")}), ` +
    `${plural(failed, "failed read")}; ${plural(seen.length, "oracle")}${states.length > 0 ? `: ${states.join(", ")}` : ""}; ` +
    `${paused.length === 0 ? "nothing paused" : `${paused.length} paused`}`
  return [...failures, ...warnings, summary]
}

/**
 * The rows as a text table: market, topology, oracle state, feed, value against feed, paused.
 * @param {Row[]} rows
 * @returns {string[]}
 */
function table(rows) {
  const head = ["Market", "Topology", "Oracle", "Feed", "Value against feed", "Paused"]
  const body = rows.map((row) => {
    const t = row.topology
    const o = row.oracle
    return [
      row.market === null ? "shared contracts" : `${row.asset} ${row.market}`,
      t === null ? "-" : t.status === "match" ? "match" : t.status === "mismatch" ? `MISMATCH: ${t.fields.join(", ")}` : "UNREAD",
      o === null ? "-" : o.ageSeconds === null ? o.state : `${o.state}, ${duration(o.ageSeconds)} old`,
      row.feed || "-",
      row.againstFeed || "-",
      row.paused === null ? "UNREAD" : row.paused.length === 0 ? "no" : row.paused.join(", "),
    ]
  })
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)]
}

// ---------------------------------------------------------------- the reads

/** A read the run did not ask: its budget had run out. */
class BudgetSpent extends Error {
  constructor() {
    super("not asked: the run's 4-minute budget had run out")
    this.name = "BudgetSpent"
  }
}

/**
 * `run`, asked again while the RPC refuses it as busy or cannot be reached for a moment
 * (`isTransient`), after the pauses of `WAITS_MS`, until `deadline`; then its last error. Any
 * other error, a contract's own answer among them, is final. Past `deadline` it is not asked at all.
 */
async function patiently(run, { isTransient, deadline, waited }) {
  for (let attempt = 0; ; attempt++) {
    if (Date.now() >= deadline) throw new BudgetSpent()
    try {
      return await run()
    } catch (error) {
      const ms = Math.round(WAITS_MS[Math.min(attempt, WAITS_MS.length - 1)] * (0.75 + Math.random() / 2))
      if (!isTransient(error) || Date.now() + ms > deadline) throw error
      waited(attempt, ms)
      await new Promise((done) => setTimeout(done, ms))
    }
  }
}

/** Every `{ status: "unavailable", source }` read in a read model (a `Live` tree), as its call and reason. */
function unavailableReads(tree, out = []) {
  if (tree === null || typeof tree !== "object") return out
  if (Array.isArray(tree)) {
    for (const item of tree) unavailableReads(item, out)
    return out
  }
  if ("status" in tree && typeof tree.status === "string") {
    if (tree.status === "unavailable" && tree.source) out.push({ contract: tree.source.contractId, fn: tree.source.fn, args: tree.source.args, reason: tree.error })
    return out
  }
  for (const value of Object.values(tree)) unavailableReads(value, out)
  return out
}

const callText = (r) => `${r.contract} ${r.fn}${r.args.length > 0 ? `(${r.args.map((a) => shortId(typeof a?.value === "string" ? a.value : JSON.stringify(a))).join(", ")})` : ""}`

/**
 * The contracts a check reads the code of, each once and in a row (`market` null for the shared
 * row): the shared Router first, so a market on it does not claim it; then each market's oracle,
 * its Router when it has one of its own, and its seven contracts; then the other shared contracts.
 */
export function codeTargets(manifest) {
  const seen = new Set()
  const targets = []
  const add = (market, kind, contract, expected) => {
    if (!contract || seen.has(contract)) return
    seen.add(contract)
    targets.push({ market, kind, contract, expected: expected ? expected.toLowerCase() : null })
  }
  add(null, "router", manifest.shared.router, manifest.wasmHashes.router)
  const KINDS = ["router", "sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow"]
  for (const m of manifest.markets) {
    const pin = (kind) => m.wasmHashes?.[kind] ?? manifest.wasmHashes[kind]
    add(m.marketId, "oracle", m.contracts.oracle, pin("oracle"))
    for (const kind of KINDS) add(m.marketId, kind, m.contracts[kind], pin(kind))
  }
  for (const kind of ["oracle", "permissioning", "riskControl", "factory"]) add(null, kind, manifest.shared[kind], manifest.wasmHashes[kind])
  return targets
}

/**
 * Reads the deployment `config/manifests/<network>.json` names, in the order of the header comment,
 * and builds the rows. Logs to stderr only.
 */
async function check(network) {
  const load = loadAppTypeScript(root)
  const { parseManifest, validateManifest, manifestOracles } = await load("lib/protocol/manifest.ts")
  const { dedupeReads, isTransientRpcError } = await load("lib/protocol/reader.ts")
  const { getLedgerClock } = await load("lib/protocol/stellar.ts")
  const { createServerRpc, serverReader, serverRpcUrlOf } = await load("lib/server/rpc-urls.ts")
  const { limitRpc } = await load("lib/protocol/rpc-limiter.ts")
  const { contractWasmHashesSettled } = await load("lib/protocol/wasm.ts")
  const { fetchTopology, fetchMarketState } = await load("lib/protocol/market-state.ts")
  const { fetchOracleView } = await load("lib/protocol/dashboard/oracle.ts")
  const { storedAgainstFeed } = await load("lib/protocol/dashboard/oracle-state.ts")
  const { fetchRiskView } = await load("lib/protocol/dashboard/risk.ts")
  const { fetchPauses } = await load("lib/protocol/dashboard/pauses.ts")
  const { formatTokenAmount } = await load("lib/protocol/format.ts")
  const { userErrorMessage } = await load("lib/protocol/errors.ts")

  const path = join(root, "config", "manifests", `${network}.json`)
  if (!existsSync(path)) throw new UsageError(`config/manifests/${network}.json does not exist`)
  const manifest = parseManifest(JSON.parse(readFileSync(path, "utf8")))
  if (manifest.network !== network) throw new UsageError(`config/manifests/${network}.json is for "${manifest.network}"`)
  const findings = validateManifest(manifest).filter((f) => f.severity === "error")
  if (findings.length > 0) return { manifest, rpcHost: new URL(serverRpcUrlOf(manifest)).host, clock: null, rows: null, findings: findings.map((f) => `FAIL: manifest: ${f.message}`), retries: null }

  const reason = (error) => userErrorMessage(error).split("\n")[0].slice(0, 200)
  const deadline = Date.now() + RUN_BUDGET_MS
  // The reads already queued under the cap when the budget runs out still run, each up to the RPC
  // client's 20 s: past a minute more, stop rather than wait on an RPC that answers nothing.
  setTimeout(() => {
    console.error("smoke: failed: the RPC did not answer within the run's budget (4 minutes, plus 1 to finish)")
    process.exit(1)
  }, RUN_BUDGET_MS + STOP_AFTER_BUDGET_MS).unref()
  const retries = { reads: 0, waits: 0, longestMs: 0 }
  const waited = (attempt, ms) => {
    if (retries.waits === 0) {
      console.error(`smoke: the RPC is busy or not answering; a read it refuses is asked again after a pause, until ${new Date(deadline).toISOString().slice(11, 19)} UTC`)
    }
    if (attempt === 0) retries.reads++
    retries.waits++
    retries.longestMs = Math.max(retries.longestMs, ms)
  }
  const patient = (run) => patiently(run, { isTransient: isTransientRpcError, deadline, waited })
  const rpc = createServerRpc(manifest)
  const direct = serverReader(manifest)
  // One answer per distinct call for the whole run; the retry sits inside, so a refused read is asked again.
  const reader = dedupeReads(Object.assign((call) => patient(() => direct(call)), { rpcUrl: direct.rpcUrl }))
  console.error(`smoke: reading the ${network} deployment from ${new URL(serverRpcUrlOf(manifest)).host} (${plural(manifest.markets.length, "market")})`)

  // 1. The ledger clock: the oracles' age is measured on it.
  const sharedUnread = []
  let clock = null
  try {
    clock = await patient(() => limitRpc(() => getLedgerClock(rpc)))
  } catch (error) {
    sharedUnread.push({ call: "getLatestLedger", reason: reason(error), manifest: true })
  }

  // 2. Code: one getLedgerEntries for every contract, one ledger snapshot.
  const targets = codeTargets(manifest)
  let hashes
  try {
    hashes = await patient(() => contractWasmHashesSettled(rpc, targets.map((t) => t.contract)))
  } catch (error) {
    hashes = targets.map(() => error)
  }
  const code = targets.map((t, i) => {
    const h = hashes[i]
    const result = { kind: t.kind, contract: t.contract, expected: t.expected }
    return { market: t.market, result: typeof h === "string" ? { ...result, actual: h } : { ...result, actual: null, reason: reason(h) } }
  })
  const codeOf = (market) => code.filter((c) => c.market === market).map((c) => c.result)

  // 3 to 5. Topologies, oracles, market states, RiskControl and the pauses, one stage after another.
  const topologies = await Promise.all(manifest.markets.map((m) => fetchTopology(reader, m)))
  const oracleIds = manifestOracles(manifest).map((o) => o.oracle)
  const views = new Map((await Promise.all(oracleIds.map((id) => fetchOracleView(reader, manifest, id, clock?.closeTime ?? null)))).map((v) => [v.contractId, v]))
  const states = await Promise.all(manifest.markets.map((m) => fetchMarketState(reader, manifest, m.marketId)))
  const risk = await fetchRiskView(reader, manifest, clock?.sequence ?? 0)
  const pauses = await fetchPauses(reader, manifest)

  const manifestContracts = new Set([
    ...Object.values(manifest.shared),
    ...manifest.markets.flatMap((m) => [...Object.values(m.contracts), m.underlying.sac]),
  ])
  const assigned = new Set()
  /** The failed reads of `trees` no earlier row reported. */
  const failed = (...trees) =>
    trees.flatMap((tree) => unavailableReads(tree)).flatMap((r) => {
      const call = callText(r)
      if (assigned.has(call)) return []
      assigned.add(call)
      return [{ call, reason: r.reason, manifest: manifestContracts.has(r.contract) }]
    })
  const amount = (raw) => formatTokenAmount(raw, 7)
  const pausedOf = (entries) => (entries.some((c) => c.paused.status !== "live") ? null : entries.filter((c) => c.paused.value).map((c) => c.label))

  const readOracles = new Set()
  const rows = manifest.markets.map((m, i) => {
    const topology = topologies[i]
    const view = views.get(m.contracts.oracle)
    const first = !readOracles.has(m.contracts.oracle)
    readOracles.add(m.contracts.oracle)
    const age = clock && view.timestamp.status === "live" ? Number(BigInt(clock.closeTime) - view.timestamp.value) : null
    const maxStale = view.maxStale.status === "live" ? Number(view.maxStale.value) : null

    let feed
    let againstFeed
    const stored = view.value.status === "live" ? `${amount(view.value.value)} stored` : "stored value unread"
    if (view.feed.status === "unsupported") {
      feed = "none (the oracle's code has no feed)"
      againstFeed = stored
    } else if (view.feed.status === "unavailable") {
      feed = "UNREAD"
      againstFeed = stored
    } else if (view.feed.value === null) {
      feed = "no feed set"
      againstFeed = `${stored}, no feed price`
    } else if (view.feedPrice?.status !== "live") {
      feed = `UNREAD (${shortId(view.feed.value.contract)})`
      againstFeed = stored
    } else {
      const price = view.feedPrice.value
      const feedAge = clock ? `, ${duration(clock.closeTime - Number(price.timestamp))} old` : ""
      feed = `${amount(price.value)} (${shortId(view.feed.value.contract)}${feedAge})`
      let comparison
      try {
        comparison = view.value.status === "live" ? storedAgainstFeed(view.value.value, price.value) : null
      } catch (error) {
        comparison = reason(error)
      }
      againstFeed = comparison === null ? stored : `${stored}: ${comparison}`
    }

    return {
      market: m.marketId,
      asset: m.underlying.code,
      topology:
        topology.status === "unavailable"
          ? { status: "unread", reason: topology.error }
          : topology.value.matches
            ? { status: "match" }
            : { status: "mismatch", fields: topology.value.mismatches },
      oracle: { contract: m.contracts.oracle, state: view.freshness, ageSeconds: age === null ? null : Math.max(0, age), maxStaleSeconds: maxStale },
      feed,
      againstFeed,
      paused: pausedOf(pauses.contracts.filter((c) => c.marketId === m.marketId)),
      code: codeOf(m.marketId),
      unread: failed(topology, ...(first ? [view] : []), states[i]),
    }
  })
  rows.push({
    market: null,
    asset: null,
    topology: null,
    oracle: null,
    feed: "",
    againstFeed: "",
    paused: pausedOf(pauses.contracts.filter((c) => c.marketId === undefined)),
    code: codeOf(null),
    unread: [...sharedUnread, ...failed(risk, pauses)],
  })
  return { manifest, rpcHost: new URL(serverRpcUrlOf(manifest)).host, clock, rows, findings: [], retries }
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const flags = { json: false, network: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") continue
    if (arg === "--json") flags.json = true
    else if (arg === "--network") {
      flags.network = argv[++i]
      if (!NETWORKS.includes(flags.network)) throw new UsageError(`--network must be one of ${NETWORKS.join(", ")}`)
    } else throw new UsageError(`unexpected argument "${arg}"; usage: smoke.mjs --network ${NETWORKS.join("|")} [--json]`)
  }
  if (flags.network === undefined) throw new UsageError(`--network is required (${NETWORKS.join(", ")})`)
  return flags
}

async function main(argv) {
  const { network, json } = parseArgs(argv)
  const { manifest, rpcHost, clock, rows, findings, retries } = await check(network)
  const lines = rows === null ? [...findings, "FAIL: the manifest has errors; nothing was read"] : summarize(rows)
  const code = rows === null ? 1 : exitCode(rows)
  if (retries && retries.waits > 0) {
    console.error(`smoke: the RPC refused or did not answer: ${plural(retries.reads, "read")} asked again (${plural(retries.waits, "wait")}, the longest ${Math.round(retries.longestMs / 1000)} s)`)
  }
  const ledger = clock ? { sequence: clock.sequence, closeTime: new Date(clock.closeTime * 1000).toISOString() } : null
  if (json) {
    console.log(JSON.stringify({ network, rpcHost, sourceCommit: manifest.sourceCommit, ledger, rows, lines, exitCode: code, retries }, null, 2))
  } else {
    const at = ledger ? `ledger ${ledger.sequence} (${ledger.closeTime})` : "ledger unread"
    console.log(`Principal deployment check: ${network}, ${at}, RPC ${rpcHost}, contracts at ${manifest.sourceCommit.slice(0, 7)}`)
    console.log("")
    if (rows !== null) for (const line of table(rows)) console.log(line)
    console.log("")
    for (const line of lines) console.log(line)
  }
  process.exitCode = code
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    const usage = error instanceof UsageError || error instanceof TypeScriptTransformRequired
    // One line, never an error object: an RPC client's error carries its whole request.
    const text = error instanceof Error ? (usage ? error.message : `${error.name}: ${error.message.split("\n")[0].slice(0, 300)}`) : "unknown error"
    console.error(`smoke: ${usage ? "" : "failed: "}${text}`)
    process.exitCode = usage ? 2 : 1
  }
}
