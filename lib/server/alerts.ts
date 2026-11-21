import "server-only"

/**
 * The alert check (spec 0004 D-12, D-20): what is wrong now, kept in the `alerts` table, each change
 * posted to `ALERT_WEBHOOK_URL`. The table is also the evidence store: every alert's open and close
 * times, and the webhook tests (`test = true`).
 *
 * Three parts:
 * - `collectAlertInput` reads what the check judges: each oracle of the manifest's markets
 *   (`manifestOracles`; one per market on Mainnet) at the latest ledger time, with its keeper's
 *   recorded runs, its indexed `ref_rej` events and its keeper health; the manifest markets' stored
 *   registry verdicts; RiskControl, every pause, the index cursors and the keeper signer's XLM on
 *   Horizon. A source that cannot be read is `Unread`, never a guess.
 * - `evaluateAlerts` (pure) turns that into the alerts that should be open (`DesiredAlert[]`), and
 *   `heldSubjects` names what it could not judge, a whole kind or one alert (`kind\0subject`): those
 *   open alerts are kept, not closed, so a flaky read never closes and reopens an alert (and posts
 *   twice), and one oracle that cannot be read holds only its own alerts.
 * - `syncAlerts` opens each new alert once (the partial unique index on open alerts), closes each
 *   alert no longer wanted once, and posts each opening and each close to the webhook. A post that
 *   fails keeps the state and is sent again by the next run (migration 0007's `opened_posted`,
 *   `resolved_posted`). The webhook URL lives only in the poster's closure: it is never logged,
 *   stored or answered.
 *
 * Alerts and their payloads are public (`GET /api/dashboard/alerts`): contract ids, the signer's public
 * key and figures, nothing else. Every stored or posted string goes through `scrub` (no URL, no
 * secret-shaped string).
 */
import { Keypair } from "@stellar/stellar-sdk"
import { alertTitle, countsAsCritical, DEBOUNCED_KINDS, type Alert, type AlertSeverity, type RecentAlert } from "@/lib/app/alert-types"
import { fetchOracleView, type OracleView } from "@/lib/protocol/dashboard/oracle"
import { assetCodes, manifestOracles } from "@/lib/protocol/manifest"
import { fetchPauses, type PauseView } from "@/lib/protocol/dashboard/pauses"
import { BROKEN, isSignificantRejection, rejectionText } from "@/lib/protocol/dashboard/rejections"
import { fetchRiskView, type RiskView } from "@/lib/protocol/dashboard/risk"
import { fetchAccount } from "@/lib/protocol/horizon"
import { isTransientRpcError, type ContractReader } from "@/lib/protocol/reader"
import { createRpcServer, getLedgerClock } from "@/lib/protocol/stellar"
import type { Live, Manifest, Network } from "@/lib/protocol/types"
import type { Sql } from "./db"
import { INDEX_GROUPS, indexCursorName, type IndexGroup } from "./indexer"
import { keeperHealth, keeperIntervalSeconds, type KeeperHealth, type TickDecision } from "./oracle-ticks"
import { sqlRegistryStore, type RegistryStore } from "./registry"
import { serverReader, serverRpcUrls } from "./rpc-urls"
import { redact } from "./request"

// ---------------------------------------------------------------- kinds and thresholds

export type AlertKind =
  | "oracle_warning"
  | "oracle_stale"
  | "oracle_unavailable"
  | "oracle_rejection"
  | "feed_broken"
  | "keeper_unhealthy"
  | "seed_invalid"
  | "paused"
  | "risk_warning"
  | "risk_exhausted"
  | "signer_low"
  | "indexer_lag"
  | "indexer_gap"
  | "test"

export const ALERT_KINDS: readonly AlertKind[] = [
  "oracle_warning",
  "oracle_stale",
  "oracle_unavailable",
  "oracle_rejection",
  "feed_broken",
  "keeper_unhealthy",
  "seed_invalid",
  "paused",
  "risk_warning",
  "risk_exhausted",
  "signer_low",
  "indexer_lag",
  "indexer_gap",
  "test",
]

/** While one of these is open, `cron/alerts` answers 500, so the scheduler's own failure alert fires too. */
export const CRITICAL: readonly AlertKind[] = ["oracle_stale", "oracle_unavailable", "keeper_unhealthy", "seed_invalid", "risk_exhausted", "indexer_gap"]

export const isCritical = (kind: string): boolean => (CRITICAL as readonly string[]).includes(kind)
const severityOf = (kind: AlertKind): AlertSeverity => (isCritical(kind) ? "critical" : "warning")

/** A significant rejection keeps its alert open while it occurred in the last 24 h (the oracle page's "24 h" counts). */
export const REJECTION_WINDOW_SECONDS = 86_400
/** An index group whose cursor's ledger closed longer ago than this is lagging. */
export const INDEXER_LAG_SECONDS = 3_600
/** `ALERT_SIGNER_MIN_XLM`'s default. */
export const DEFAULT_SIGNER_MIN_XLM = "20"
/** One webhook POST waits at most this long. */
export const WEBHOOK_TIMEOUT_MS = 5_000
/**
 * Every post of a run ends by this long after the run started: a notice is claimed only when a whole
 * post (`WEBHOOK_TIMEOUT_MS`) still fits, so a run never holds a claim past `maxDuration` (60 s).
 */
export const POST_DEADLINE_MS = 50_000
/** The check's reads (RPC, Horizon, database) share this budget from the run's start; a read still pending then is `Unread`. */
export const READ_BUDGET_MS = 30_000
/** At most this many pending alerts are posted per run; the rest wait for the next one. */
export const MAX_POSTS_PER_RUN = 25
/** `GET /api/dashboard/alerts`'s history: alerts open at some time in the last 7 days. */
export const RECENT_ALERT_DAYS = 7
/**
 * A debounced alert (`oracle_unavailable`) is confirmed (posted, and critical) only by a run at least
 * this long after it opened: a scheduler retry seconds later is not a second look.
 */
export const DEBOUNCE_MIN_AGE_MS = 120_000
const RECENT_LIMIT = 200

/**
 * Kinds that record an event rather than a lasting condition: their close is silent (no "Resolved"
 * post), since the opening is what someone acts on.
 */
export const EVENT_KINDS: readonly AlertKind[] = ["oracle_rejection", "feed_broken"]

/** Reasons a pull-mode feed can give that mean its price is unusable (D-21, `BROKEN`): the keeper does not submit them. */
const BROKEN_FEED: ReadonlySet<string> = new Set(BROKEN)

/** The kinds about one oracle: their payload names its `asset`, and so does the webhook line. */
const ORACLE_KINDS: readonly string[] = ["oracle_warning", "oracle_stale", "oracle_unavailable", "oracle_rejection", "feed_broken", "keeper_unhealthy"]

/** Why each oracle's keeper health is `Unread` when `ORACLE_KEEPER_INTERVAL_SECONDS` is not valid. */
const BAD_INTERVAL = "the keeper's interval is not valid"

const STROOPS_PER_XLM = 10_000_000n
const DAY_MS = 86_400_000

// ---------------------------------------------------------------- input

/** A source that could not be read; `error` is this app's words or an error name, never an error's text. */
export type Unread = { error: string }

/** One recorded keeper run (`oracle_ticks`), as the check reads it. */
export type TickSeen = { at: string; decision: TickDecision; reason: string | null; value: string | null; txHash: string | null }
/** One indexed `ref_rej` event of the oracle. */
export type RejectionEventSeen = { id: string; at: string; ledger: number; reason: string; value: string; txHash: string }
/** One index group's cursor (`ingest_cursor`, `events:<group>:<network>`). */
export type CursorSeen = { group: IndexGroup; ledger: number | null; closeTime: string | null; gapFrom: number | null; gapTo: number | null }
/** The keeper signer's native balance (`stroops` null: the account does not exist), or why it could not be read. */
export type SignerSeen = { account: string; stroops: bigint | null; minStroops: bigint } | { account: string | null; error: string }

/** One oracle of the manifest's markets (`manifestOracles`), as the check reads it. */
export type OracleInput = {
  oracleId: string
  /** The underlying codes of the markets on this oracle, joined by ", " ("USDY"): every alert about it names them. */
  asset: string
  /** `fetchOracleView` at the latest ledger time (its freshness is measured in ledger time). */
  view: OracleView | Unread
  /** This oracle's recorded runs of the last 24 h, newest first. */
  ticks: TickSeen[] | Unread
  /** This oracle's indexed `ref_rej` events of the last 24 h. */
  rejectionEvents: RejectionEventSeen[] | Unread
  /** Unread with `BAD_INTERVAL` when the keeper's schedule is not valid: health is measured against it. */
  keeper: KeeperHealth | Unread
}

/**
 * A manifest market ("seed") and its stored registry verdict (`market_registry`): `valid` false hides it
 * from the app; null is no verdict yet (not checked, or unreadable on-chain). No row is null too.
 */
export type SeedSeen = { marketId: string; pool: string; asset: string; valid: boolean | null; reason: string | null }

export type AlertInput = {
  network: Network
  /** Wall-clock time of the check (ms): the windows over recorded rows are measured from it. */
  now: number
  /**
   * The keeper's schedule (`keeperIntervalSeconds`): `feed_broken` looks back 2 × this, and the keeper's
   * health is measured against it. Unread when `ORACLE_KEEPER_INTERVAL_SECONDS` is not valid.
   */
  intervalSeconds: number | Unread
  /** One entry per oracle of the manifest's markets, in the manifest's order. */
  oracles: OracleInput[]
  /** The manifest markets' stored verdicts, in the manifest's order. */
  seeds: SeedSeen[] | Unread
  pauses: PauseView | Unread
  risk: RiskView | Unread
  /** Null: no keeper key is configured, so there is no signer to check. */
  signer: SignerSeen | null
  indexer: CursorSeen[] | Unread
}

export type DesiredAlert = { kind: AlertKind; subject: string; severity: AlertSeverity; payload: Record<string, unknown> }

const unread = (v: unknown): v is Unread => typeof v === "object" && v !== null && !Array.isArray(v) && "error" in v
const isDown = (l: Live<unknown>): l is Extract<Live<unknown>, { status: "unavailable" }> => l.status === "unavailable"

/** "CDYG…YIPS": a Stellar id's first and last four characters; anything else as it is. */
export const shortId = (id: string) => (/^[CG][A-Z2-7]{55}$/.test(id) ? `${id.slice(0, 4)}…${id.slice(-4)}` : id)

/** A subject with every Stellar id in it shortened: "CDYG…YIPS:deviate", "asset:CB2Y…XODZ". */
export const shortSubject = (subject: string) => subject.replace(/\b[CG][A-Z2-7]{55}\b/g, shortId)

/** A hold of one alert (`heldSubjects`), beside a whole kind's. */
const holdKey = (kind: string, subject: string) => `${kind}\u0000${subject}`

const alert = (kind: AlertKind, subject: string, payload: Record<string, unknown>): DesiredAlert => ({ kind, subject, severity: severityOf(kind), payload })

// ---------------------------------------------------------------- evaluation

function oracleAlerts(o: OracleInput): DesiredAlert[] {
  const v = o.view
  if (unread(v)) return [alert("oracle_unavailable", o.oracleId, { asset: o.asset, reason: v.error })]
  if (v.freshness === "unavailable") {
    const down = ([v.timestamp, v.maxStale, v.timeToBlock, v.available, v.value] as Live<unknown>[]).find(isDown)
    return [alert("oracle_unavailable", o.oracleId, { asset: o.asset, reason: down?.error ?? "the oracle could not be read" })]
  }
  if (v.freshness === "fresh") return []
  const maxStale = v.maxStale.status === "live" ? Number(v.maxStale.value) : null
  const toBlock = v.timeToBlock.status === "live" ? v.timeToBlock.value : null
  const age = maxStale !== null && toBlock !== null ? Math.max(0, maxStale - toBlock) : null
  const timing = { asset: o.asset, ageSeconds: age, maxStaleSeconds: maxStale, secondsToBlock: toBlock }
  // Stale replaces the warning: one alert per state, so a value that ages past max_stale closes one and opens the other.
  return [alert(v.freshness === "stale" ? "oracle_stale" : "oracle_warning", o.oracleId, timing)]
}

type Occurrence = { at: number; reason: string; value: string; txHash: string | null; source: "event" | "tick" }

/** `oracle_rejection`'s subject: the oracle and the reason, "C…:deviate" (before the per-oracle alerts, the reason alone). */
const rejectionSubject = (oracle: string, reason: string) => `${oracle}:${reason}`

/**
 * Each significant rejection (`oob`, `decrease`, `deviate`, `fb_value`) of one oracle, from its indexed
 * `ref_rej` events and its keeper's `rejected` runs, keyed by oracle and reason: the same rejection seen
 * in its event and in the keeper's run, repeated by the feed-mode keeper without a transaction (D-21),
 * or tried again by the push keeper with each run's new value, is one alert. It stays open while an
 * occurrence is younger than `REJECTION_WINDOW_SECONDS`, then closes silently (an event kind). The
 * payload names the newest value.
 */
function rejectionAlerts(i: AlertInput, o: OracleInput): DesiredAlert[] {
  const since = i.now - REJECTION_WINDOW_SECONDS * 1000
  const seen: Occurrence[] = [
    ...(Array.isArray(o.rejectionEvents) ? o.rejectionEvents : []).map((e) => ({ at: Date.parse(e.at), reason: e.reason, value: e.value, txHash: e.txHash, source: "event" as const })),
    ...(Array.isArray(o.ticks) ? o.ticks : [])
      .filter((t) => t.decision === "rejected" && t.reason !== null)
      .map((t) => ({ at: Date.parse(t.at), reason: t.reason as string, value: t.value ?? "unknown", txHash: t.txHash, source: "tick" as const })),
  ].filter((x) => isSignificantRejection(x.reason) && x.at > since)

  const byReason = new Map<string, Occurrence[]>()
  for (const x of seen) byReason.set(x.reason, [...(byReason.get(x.reason) ?? []), x])
  return [...byReason.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, all]) => {
      const newest = [...all].sort((a, b) => b.at - a.at)
      const sources = (["event", "tick"] as const).filter((src) => all.some((x) => x.source === src))
      return alert("oracle_rejection", rejectionSubject(o.oracleId, reason), {
        asset: o.asset,
        reason: newest[0].reason,
        value: newest[0].value,
        lastAt: new Date(newest[0].at).toISOString(),
        occurrences: all.length,
        txHash: newest.find((x) => x.txHash !== null)?.txHash ?? null,
        sources,
      })
    })
}

/** One oracle's keeper runs with a broken-feed reason (`bad_price`, `rescale`, `future_ts`, `feed_err`) in the last 2 × interval. */
function feedAlerts(i: AlertInput, o: OracleInput): DesiredAlert[] {
  if (!Array.isArray(o.ticks) || unread(i.intervalSeconds)) return []
  const since = i.now - 2 * i.intervalSeconds * 1000
  const broken = o.ticks.filter((t) => t.reason !== null && BROKEN_FEED.has(t.reason) && Date.parse(t.at) > since).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (broken.length === 0) return []
  return [
    alert("feed_broken", o.oracleId, {
      asset: o.asset,
      reasons: [...new Set(broken.map((t) => t.reason as string))],
      lastAt: new Date(Date.parse(broken[0].at)).toISOString(),
      occurrences: broken.length,
    }),
  ]
}

/** No recorded run is neutral (D-19): nothing is known, so nothing is raised. */
function keeperAlerts(i: AlertInput, o: OracleInput): DesiredAlert[] {
  const k = o.keeper
  if (unread(k) || unread(i.intervalSeconds) || k.lastTickAt === null || k.healthy) return []
  return [
    alert("keeper_unhealthy", o.oracleId, {
      asset: o.asset,
      lastOkAt: k.lastOkAt,
      lastSuccessAt: k.lastSuccessAt,
      lastTickAt: k.lastTickAt,
      intervalSeconds: i.intervalSeconds,
      rejected24h: k.rejected24h,
      failures24h: k.failures24h,
    }),
  ]
}

/** A manifest market whose stored verdict is `valid = false`: the app hides it until a check passes. Subject: its market id. */
function seedAlerts(i: AlertInput): DesiredAlert[] {
  if (unread(i.seeds)) return []
  return i.seeds.filter((m) => m.valid === false).map((m) => alert("seed_invalid", m.marketId, { marketId: m.marketId, pool: m.pool, reason: m.reason, asset: m.asset }))
}

function pauseAlerts(i: AlertInput): DesiredAlert[] {
  if (unread(i.pauses)) return []
  return i.pauses.contracts
    .filter((c) => c.paused.status === "live" && c.paused.value)
    .map((c) =>
      alert("paused", `${c.kind}:${shortId(c.contractId)}`, { contractId: c.contractId, role: c.kind, label: c.label, ...(c.marketId ? { marketId: c.marketId } : {}) }),
    )
}

/** Tenths of a percent, rounded down: "90.0". */
const percentOf = (volume: bigint, limit: bigint) => {
  const tenths = (volume * 1000n) / limit
  return `${tenths / 10n}.${tenths % 10n}`
}

/** Volume ≥ 90% of a limit opens a warning, ≥ 100% exhausted (D-12); a limit of 0 is off. */
function limitAlert(limit: Live<bigint>, volume: Live<bigint>, subject: string, scope: Record<string, unknown>): DesiredAlert[] {
  if (limit.status !== "live" || volume.status !== "live" || limit.value <= 0n) return []
  const l = limit.value
  const v = volume.value
  const payload = { ...scope, limit: String(l), volume: String(v), percent: percentOf(v, l) }
  if (v >= l) return [alert("risk_exhausted", subject, payload)]
  if (v * 10n >= l * 9n) return [alert("risk_warning", subject, payload)]
  return []
}

function riskAlerts(i: AlertInput): DesiredAlert[] {
  const r = i.risk
  if (unread(r)) return []
  return [
    ...limitAlert(r.limit, r.volume, r.contractId, { scope: "protocol" }),
    ...r.assetLimits.flatMap((a) => limitAlert(a.limit, a.volume, `asset:${a.asset}`, { scope: "asset", asset: a.asset })),
  ]
}

/** Stroops as XLM, with no trailing zeros: 199_999_999n → "19.9999999", 200_000_000n → "20". */
export function xlmText(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM
  const frac = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0").replace(/0+$/, "")
  return frac ? `${whole}.${frac}` : `${whole}`
}

function signerAlerts(i: AlertInput): DesiredAlert[] {
  const s = i.signer
  if (s === null || "error" in s) return []
  if (s.stroops !== null && s.stroops >= s.minStroops) return []
  return [alert("signer_low", s.account, { account: s.account, balanceXlm: xlmText(s.stroops ?? 0n), minXlm: xlmText(s.minStroops), found: s.stroops !== null })]
}

/** A group with no cursor, or no close time, is neutral: the index has not run for it yet. */
function indexerAlerts(i: AlertInput): DesiredAlert[] {
  if (unread(i.indexer)) return []
  const order = (g: IndexGroup) => INDEX_GROUPS.indexOf(g)
  return [...i.indexer]
    .sort((a, b) => order(a.group) - order(b.group))
    .flatMap((c) => {
      const out: DesiredAlert[] = []
      if (c.closeTime !== null) {
        const lag = Math.max(0, Math.round((i.now - Date.parse(c.closeTime)) / 1000))
        if (lag > INDEXER_LAG_SECONDS) out.push(alert("indexer_lag", c.group, { group: c.group, lagSeconds: lag, indexedThrough: c.ledger, closeTime: new Date(Date.parse(c.closeTime)).toISOString() }))
      }
      if (c.gapFrom !== null) out.push(alert("indexer_gap", c.group, { group: c.group, from: c.gapFrom, to: c.gapTo ?? c.gapFrom }))
      return out
    })
}

/**
 * The alerts that should be open now, from the check's input (pure). Each oracle is judged on its
 * own, and every alert about it names it (its subject) and its asset (its payload). Thresholds:
 * - `oracle_warning` at an age ≥ 75% of `max_stale`, `oracle_stale` past it, `oracle_unavailable` when
 *   the oracle cannot be read (the view's own freshness, in ledger time);
 * - `oracle_rejection` per oracle and significant reason seen in the last 24 h;
 * - `feed_broken` on a broken-feed tick in the last 2 × interval;
 * - `keeper_unhealthy` when runs are recorded and the last run that did not fail is 2 × interval old or more (M-15);
 * - `seed_invalid` per manifest market whose stored verdict is `valid = false`;
 * - `paused` per paused contract;
 * - `risk_warning` at ≥ 90% of a limit, `risk_exhausted` at ≥ 100% (protocol-wide and per asset);
 * - `signer_low` under `ALERT_SIGNER_MIN_XLM`;
 * - `indexer_lag` over 3,600 s behind and `indexer_gap` on a stored gap, per group.
 */
export function evaluateAlerts(input: AlertInput): DesiredAlert[] {
  return [
    ...input.oracles.flatMap((o) => [...oracleAlerts(o), ...rejectionAlerts(input, o), ...feedAlerts(input, o), ...keeperAlerts(input, o)]),
    ...seedAlerts(input),
    ...pauseAlerts(input),
    ...riskAlerts(input),
    ...signerAlerts(input),
    ...indexerAlerts(input),
  ]
}

/**
 * What the input cannot judge (a source was not read): a whole kind, or one alert as `kind\0subject`.
 * Those open alerts stay open until it can. One oracle's unread source holds only that oracle's alerts:
 * its freshness, feed and keeper alerts by its id, its rejections by the prefix `<oracle>:` (a held
 * subject that ends with ":" holds every subject of its kind that starts with it; `isHeld`).
 */
export function heldSubjects(input: AlertInput): string[] {
  const held: string[] = []
  for (const o of input.oracles) {
    const v = o.view
    if (unread(v) || v.freshness === "unavailable") held.push(holdKey("oracle_warning", o.oracleId), holdKey("oracle_stale", o.oracleId))
    if (unread(o.ticks) || unread(o.rejectionEvents)) held.push(holdKey("oracle_rejection", rejectionSubject(o.oracleId, "")))
    // Both need the keeper's schedule: an invalid one holds them for every oracle.
    if (unread(o.ticks) || unread(input.intervalSeconds)) held.push(holdKey("feed_broken", o.oracleId))
    if (unread(o.keeper) || unread(input.intervalSeconds)) held.push(holdKey("keeper_unhealthy", o.oracleId))
  }
  if (unread(input.seeds)) held.push("seed_invalid")
  const p = input.pauses
  if (unread(p) || p.contracts.some((c) => c.paused.status === "unavailable")) held.push("paused")
  const r = input.risk
  if (unread(r) || ([r.limit, r.volume, ...r.assetLimits.flatMap((a) => [a.limit, a.volume])] as Live<unknown>[]).some(isDown)) held.push("risk_warning", "risk_exhausted")
  if (input.signer !== null && "error" in input.signer) held.push("signer_low")
  if (unread(input.indexer)) held.push("indexer_lag", "indexer_gap")
  return held
}

/**
 * Whether an open alert is held (`heldSubjects`): its kind, the alert itself, or, for a held subject
 * ending in ":", any subject of that kind that starts with it ("C…:" holds "C…:deviate"; a
 * subject from before the per-oracle alerts, "deviate", is held by no oracle).
 */
function isHeld(held: ReadonlySet<string>, kind: string, subject: string): boolean {
  if (held.has(kind) || held.has(holdKey(kind, subject))) return true
  for (let at = subject.indexOf(":"); at >= 0; at = subject.indexOf(":", at + 1)) if (held.has(holdKey(kind, subject.slice(0, at + 1)))) return true
  return false
}

/** The input's sources that could not be read, by name (per oracle as `<source>:<oracle id>`), for the run's answer and log. */
export function unreadSources(input: AlertInput): string[] {
  const perOracle = input.oracles.flatMap((o) =>
    Object.entries({ oracle: o.view, ticks: o.ticks, rejectionEvents: o.rejectionEvents, keeper: o.keeper })
      .filter(([, v]) => unread(v))
      .map(([k]) => `${k}:${o.oracleId}`),
  )
  const shared = { seeds: input.seeds, pauses: input.pauses, risk: input.risk, indexer: input.indexer }
  return [
    ...(unread(input.intervalSeconds) ? ["keeperInterval"] : []),
    ...perOracle,
    ...Object.entries(shared)
      .filter(([, v]) => unread(v))
      .map(([k]) => k),
    ...(input.signer !== null && "error" in input.signer ? ["signer"] : []),
  ]
}

// ---------------------------------------------------------------- the webhook

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi
/** No URL and no secret-shaped string, whatever a reason carries (an RPC error may name its provider's URL). */
export const scrub = (text: string) => redact(text.replace(URL_PATTERN, "[url]"))

function scrubValue(v: unknown): unknown {
  if (typeof v === "string") return scrub(v)
  if (Array.isArray(v)) return v.map(scrubValue)
  if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubValue(x)]))
  return v
}
const scrubPayload = (p: Record<string, unknown>) => scrubValue(p) as Record<string, unknown>

/** One opening or close, as `webhookPayload` words it. */
export type AlertNotice = {
  status: "opened" | "resolved"
  kind: string
  subject: string
  severity: AlertSeverity
  network: Network
  /** When it opened (an opening) or closed (a close). */
  at: string
  openedAt: string
  payload: Record<string, unknown>
  test: boolean
}

/** What is POSTed: `text` (Slack) and `content` (Discord) are the same line; the rest is for machines. */
export type WebhookPayload = {
  text: string
  content: string
  kind: string
  subject: string
  severity: AlertSeverity
  network: Network
  at: string
  status: "opened" | "resolved"
  test: boolean
  details: Record<string, unknown>
}

export type PostAlert = (payload: WebhookPayload) => Promise<void>

/** A kind in words (shared with the dashboard); an unknown kind as it is. */
export { alertTitle }

const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : String(v ?? "unknown"))
const s = (v: unknown) => String(v ?? "unknown")

/** One sentence of figures for an opening, from its payload. */
function detail(kind: string, p: Record<string, unknown>): string {
  switch (kind) {
    case "oracle_warning":
      return `Value age ${n(p.ageSeconds)} s of the ${n(p.maxStaleSeconds)} s allowed; operations block in ${n(p.secondsToBlock)} s.`
    case "oracle_stale":
      return `Value age ${n(p.ageSeconds)} s, over the ${n(p.maxStaleSeconds)} s allowed: mint, trades, single-sided liquidity and redemption are blocked.`
    case "oracle_unavailable":
      return `The oracle could not be read: ${s(p.reason)}.${typeof p.confirmedAt === "string" ? ` Still unreadable at ${p.confirmedAt}.` : ""}`
    case "oracle_rejection":
      return `${rejectionText(s(p.reason))} (reason ${s(p.reason)}), value ${s(p.value)}, seen ${n(p.occurrences)} time(s), last at ${s(p.lastAt)}.`
    case "feed_broken":
      return `The feed's price could not be used (${Array.isArray(p.reasons) ? p.reasons.join(", ") : s(p.reasons)}), last at ${s(p.lastAt)}.`
    case "keeper_unhealthy":
      return `Last run without an error: ${p.lastOkAt ? s(p.lastOkAt) : "none recorded"}. Last successful update: ${p.lastSuccessAt ? s(p.lastSuccessAt) : "none recorded"}. The keeper runs every ${n(p.intervalSeconds)} s.`
    case "seed_invalid":
      return `Market ${s(p.marketId)} (pool ${shortId(s(p.pool))}) failed the registry's checks: ${s(p.reason)}. It is hidden from the app until the check passes.`
    case "paused":
      return `${s(p.label)} (${shortId(s(p.contractId))}) is paused.`
    case "risk_warning":
    case "risk_exhausted":
      return `Volume at ${s(p.percent)}% of the ${p.scope === "asset" ? `${shortId(s(p.asset))} asset` : "protocol-wide"} limit (${s(p.volume)} of ${s(p.limit)} base units).`
    case "signer_low":
      return `${shortId(s(p.account))} holds ${s(p.balanceXlm)} XLM, below the ${s(p.minXlm)} XLM floor${p.found === false ? " (the account does not exist)" : ""}.`
    case "indexer_lag":
      return `Group ${s(p.group)} is indexed through ledger ${s(p.indexedThrough)}, ${n(p.lagSeconds)} s behind.`
    case "indexer_gap":
      return `Group ${s(p.group)} may miss events in ledgers ${s(p.from)} to ${s(p.to)}: the RPC no longer held them.`
    case "test":
      return "This is a test of the alert webhook, sent with ?test=1. No action needed."
    default:
      return ""
  }
}

/** Discord refuses a `content` over 2,000 characters. */
const MAX_TEXT = 1_900

/** The asset an alert names after its subject: an oracle's markets, or a manifest market's (not a risk limit's: a contract id, in its sentence). */
const assetOf = (kind: string, p: Record<string, unknown>) =>
  (ORACLE_KINDS.includes(kind) || kind === "seed_invalid") && typeof p.asset === "string" && p.asset !== "" ? p.asset : null

/**
 * The JSON a webhook receives for one opening or close; no URL and no secret-shaped string, ever. The
 * line shortens every contract id in the subject ("CDYG…YIPS:deviate") and names the asset of an
 * oracle's or a manifest market's alert; `subject` keeps the whole subject.
 */
export function webhookPayload(notice: AlertNotice): WebhookPayload {
  const details = scrubPayload(notice.payload)
  const head = `[Principal ${notice.network}]`
  const asset = assetOf(notice.kind, details)
  const what = `${alertTitle(notice.kind)} (${shortSubject(notice.subject)}${asset ? `, ${asset}` : ""})`
  let line: string
  if (notice.test) line = `${head} TEST alert: ${detail("test", details)} At ${notice.at}.`
  else if (notice.status === "opened")
    line = `${head} ${notice.severity === "critical" ? "Critical" : "Warning"} alert opened: ${what}. ${detail(notice.kind, details)} At ${notice.at}.`.replace(/ {2,}/g, " ")
  else line = `${head} Resolved: ${what}, open since ${notice.openedAt}. At ${notice.at}.`
  const text = scrub(line).slice(0, MAX_TEXT)
  return {
    text,
    content: text,
    kind: notice.kind,
    subject: scrub(notice.subject),
    severity: notice.severity,
    network: notice.network,
    at: notice.at,
    status: notice.status,
    test: notice.test,
    details,
  }
}

/** A post that failed, in this app's words: never the URL, never a fetch error's text (it names the host). */
export class WebhookError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WebhookError"
  }
}

const nameOf = (error: unknown) => {
  const name = (error as { name?: unknown } | null)?.name
  return typeof name === "string" ? name : "unknown"
}

/**
 * Posts to `url` (the server-only `ALERT_WEBHOOK_URL`), at most `timeoutMs` (5 s) per post. Any answer
 * but a 2xx is a `WebhookError` with its status; a redirect is one too (followed, a POST would turn
 * into a GET and read as delivered). The URL stays in this closure.
 */
export function webhookPoster(url: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): PostAlert {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS
  return async (payload) => {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      })
    } catch (error) {
      if (nameOf(error) === "TimeoutError") throw new WebhookError(`the webhook did not answer within ${timeoutMs} ms`)
      throw new WebhookError(`the webhook could not be reached (${nameOf(error)})`)
    }
    await res.body?.cancel().catch(() => undefined)
    if (!res.ok) throw new WebhookError(`the webhook answered ${res.status}`)
  }
}

/** Why a post failed, for the log: a `WebhookError`'s own words, anything else by name. */
const postFailure = (error: unknown) => (error instanceof WebhookError ? error.message : nameOf(error))

// ---------------------------------------------------------------- the alerts table

export type AlertRef = { kind: string; subject: string; severity: AlertSeverity }

export type SyncResult = {
  /** Alerts this run opened (a concurrent run's insert is not counted). */
  opened: AlertRef[]
  /** Alerts this run closed. */
  resolved: AlertRef[]
  /** Every open alert after the run. */
  open: Alert[]
  /** Notices delivered this run (openings and closes, this run's or earlier undelivered ones). */
  posted: number
  /** Notices whose post failed this run; each is sent again by the next run. */
  postFailures: number
}

type OpenRow = { id: string; kind: string; subject: string; severity: AlertSeverity; opened_at: Date | string; payload: Record<string, unknown> }
type PendingRow = OpenRow & { resolved_at: Date | string | null; opened_posted: boolean; resolved_posted: boolean }

const iso = (t: Date | string | number) => new Date(t).toISOString()
const ref = (a: { kind: string; subject: string; severity: AlertSeverity }): AlertRef => ({ kind: a.kind, subject: a.subject, severity: a.severity })
const toAlert = (r: OpenRow): Alert => ({ kind: r.kind, subject: r.subject, severity: r.severity, openedAt: iso(r.opened_at), payload: r.payload })

async function openRows(sql: Sql, network: Network): Promise<OpenRow[]> {
  return sql<OpenRow>`
    select id, kind, subject, severity, opened_at, payload from alerts
    where network = ${network} and resolved_at is null and not test
    order by opened_at, id`
}

/** Claims a notice (so an overlapping run does not post it too), posts it, and gives the claim back if the post fails. */
async function deliver(sql: Sql, row: PendingRow, status: "opened" | "resolved", network: Network, post: PostAlert): Promise<"posted" | "failed" | "taken"> {
  const claimed =
    status === "opened"
      ? await sql`update alerts set opened_posted = true where id = ${row.id} and not opened_posted returning id`
      : await sql`update alerts set resolved_posted = true where id = ${row.id} and resolved_at is not null and not resolved_posted returning id`
  if (claimed.length === 0) return "taken"
  const notice: AlertNotice = {
    status,
    kind: row.kind,
    subject: row.subject,
    severity: row.severity,
    network,
    at: iso(status === "opened" ? row.opened_at : (row.resolved_at as Date | string)),
    openedAt: iso(row.opened_at),
    payload: row.payload,
    test: false,
  }
  try {
    await post(webhookPayload(notice))
    return "posted"
  } catch (error) {
    console.error(`alerts: the ${status} notice of ${row.kind} ${shortSubject(row.subject)} was not delivered, the next run sends it again: ${postFailure(error)}`)
    if (status === "opened") await sql`update alerts set opened_posted = false where id = ${row.id}`
    else await sql`update alerts set resolved_posted = false where id = ${row.id}`
    return "failed"
  }
}

/** A debounced alert (`oracle_unavailable`) that no later check has confirmed yet: neither posted nor critical. */
const unconfirmed = (r: Pick<OpenRow, "kind" | "payload">) => DEBOUNCED_KINDS.includes(r.kind) && typeof r.payload?.confirmedAt !== "string"

/**
 * Posts the undelivered notices of `network`, oldest alert first: an alert's opening before its
 * close (a close is not sent while its opening is undelivered); an unconfirmed debounced alert waits.
 * At most `maxPosts` alerts. A notice is claimed only while a whole post (`postTimeoutMs`) still ends
 * by `deadline`, so a claimed notice is always posted or released before the run can be cut off.
 * Delivery is at least once: a post that times out after the webhook took it is sent again.
 */
async function deliverPending(sql: Sql, network: Network, post: PostAlert, opts: SyncOptions & { deadline: number }): Promise<{ posted: number; postFailures: number }> {
  const timeout = opts.postTimeoutMs ?? WEBHOOK_TIMEOUT_MS
  const fits = () => Date.now() + timeout <= opts.deadline
  if (!fits()) return { posted: 0, postFailures: 0 }
  const pending = await sql<PendingRow>`
    select id, kind, subject, severity, opened_at, resolved_at, payload, opened_posted, resolved_posted from alerts
    where network = ${network} and not test and (not opened_posted or (resolved_at is not null and not resolved_posted))
    order by id limit ${opts.maxPosts ?? MAX_POSTS_PER_RUN}`
  let posted = 0
  let postFailures = 0
  for (const row of pending) {
    if (row.resolved_at === null && unconfirmed(row)) continue
    if (!fits()) break
    if (!row.opened_posted) {
      const r = await deliver(sql, row, "opened", network, post)
      if (r === "failed") postFailures++
      if (r !== "posted") continue
      posted++
    }
    if (row.resolved_at === null || row.resolved_posted) continue
    if (!fits()) break
    const r = await deliver(sql, row, "resolved", network, post)
    if (r === "failed") postFailures++
    if (r === "posted") posted++
  }
  return { posted, postFailures }
}

export type SyncOptions = {
  /**
   * What is kept open even when not desired (`heldSubjects`): a kind (all its alerts), one alert
   * (`kind\0subject`), or `kind\0<prefix>:` (every subject of the kind that starts with the prefix).
   */
  held?: readonly string[]
  /**
   * Wall-clock time (ms) by which every post must have ended: `runAlertCheck` passes the run's start
   * plus `POST_DEADLINE_MS`. By default, `POST_DEADLINE_MS` from now.
   */
  deadline?: number
  /** The poster's own timeout (`WEBHOOK_TIMEOUT_MS` by default): a claim needs that much time left. */
  postTimeoutMs?: number
  maxPosts?: number
}

/**
 * Brings `network`'s open alerts to `desired`: opens each new one once (`insert … on conflict do
 * nothing` on the partial unique index of open alerts), closes each open one no longer desired once
 * (`resolved_at`), unless it is held (its kind, itself, or its subject's prefix: `isHeld`). The state is written before any post; then every
 * undelivered notice is posted (`post`), and one that fails stays undelivered for the next run.
 * `now` (ms) stamps `opened_at`, `resolved_at` and a debounced alert's `confirmedAt`.
 *
 * - A debounced kind (`oracle_unavailable`) opens at once but is posted, and counts as critical, only
 *   once a run at least `DEBOUNCE_MIN_AGE_MS` (120 s) after it opened still wants it: that run writes
 *   `payload.confirmedAt`. One that clears before is closed with both notices marked delivered, and
 *   nothing is sent.
 * - An event kind (`oracle_rejection`, `feed_broken`) closes silently: its close is marked delivered.
 */
export async function syncAlerts(sql: Sql, network: Network, desired: readonly DesiredAlert[], post: PostAlert, now: number, opts: SyncOptions = {}): Promise<SyncResult> {
  const deadline = opts.deadline ?? Date.now() + POST_DEADLINE_MS
  const at = iso(now)
  const held: ReadonlySet<string> = new Set(opts.held ?? [])
  const key = holdKey
  const wanted = new Map(desired.map((d) => [key(d.kind, d.subject), d]))
  const before = await openRows(sql, network)
  const isOpen = new Set(before.map((r) => key(r.kind, r.subject)))

  const opened: AlertRef[] = []
  for (const d of wanted.values()) {
    if (isOpen.has(key(d.kind, d.subject))) continue
    const inserted = await sql`
      insert into alerts (network, kind, subject, severity, opened_at, payload)
      values (${network}, ${d.kind}, ${d.subject}, ${d.severity}, ${at}::timestamptz, ${JSON.stringify(scrubPayload(d.payload))}::jsonb)
      on conflict (network, kind, subject) where resolved_at is null do nothing returning id`
    if (inserted.length > 0) opened.push(ref(d))
  }

  const resolved: AlertRef[] = []
  for (const r of before) {
    if (wanted.has(key(r.kind, r.subject))) {
      // Still wanted by a run at least DEBOUNCE_MIN_AGE_MS after it opened: a debounced alert is now
      // confirmed. A younger one waits, unposted and not critical, for a later run.
      const aged = now - new Date(r.opened_at).getTime() >= DEBOUNCE_MIN_AGE_MS
      if (unconfirmed(r) && aged) await sql`update alerts set payload = payload || jsonb_build_object('confirmedAt', ${at}::text) where id = ${r.id} and resolved_at is null`
      continue
    }
    if (isHeld(held, r.kind, r.subject)) continue
    const silentOpen = unconfirmed(r)
    const silentClose = silentOpen || (EVENT_KINDS as readonly string[]).includes(r.kind)
    const closed = await sql`
      update alerts set resolved_at = ${at}::timestamptz, opened_posted = opened_posted or ${silentOpen}, resolved_posted = resolved_posted or ${silentClose}
      where id = ${r.id} and resolved_at is null returning id`
    if (closed.length > 0) resolved.push(ref(r))
  }

  const delivery = await deliverPending(sql, network, post, { ...opts, deadline })
  const open = (await openRows(sql, network)).map(toAlert)
  return { opened, resolved, open, ...delivery }
}

/**
 * `?test=1`: a clearly marked test alert, stored (`test = true`, resolved at once: it is evidence, not
 * a condition) and posted once. A failed post keeps the row, undelivered; the regular check never
 * sends a test again.
 */
export async function sendTestAlert(sql: Sql, network: Network, post: PostAlert, now: number): Promise<{ openedAt: string; delivered: boolean }> {
  const at = iso(now)
  const payload = { note: "A test of the alert webhook (?test=1)." }
  const [row] = await sql<{ id: string }>`
    insert into alerts (network, kind, subject, severity, opened_at, resolved_at, payload, test, resolved_posted)
    values (${network}, 'test', 'webhook', 'warning', ${at}::timestamptz, ${at}::timestamptz, ${JSON.stringify(payload)}::jsonb, true, true)
    returning id`
  try {
    await post(webhookPayload({ status: "opened", kind: "test", subject: "webhook", severity: "warning", network, at, openedAt: at, payload, test: true }))
  } catch (error) {
    console.error(`alerts: the test alert was not delivered: ${postFailure(error)}`)
    return { openedAt: at, delivered: false }
  }
  await sql`update alerts set opened_posted = true where id = ${row.id} and not opened_posted returning id`
  return { openedAt: at, delivered: true }
}

/** The last `?test=1` and whether the webhook took it. */
export type LastTest = { openedAt: string; delivered: boolean }

/** `GET /api/dashboard/alerts`: open alerts, the 7-day history (open or closed), the last test. Tests are never alerts. */
export type AlertsAnswer = { open: Alert[]; recent: RecentAlert[]; lastTest: LastTest | null }

export async function listAlerts(sql: Sql, network: Network, now: number = Date.now()): Promise<AlertsAnswer> {
  const since = iso(now - RECENT_ALERT_DAYS * DAY_MS)
  const [open, recent, tests] = await Promise.all([
    openRows(sql, network),
    sql<OpenRow & { resolved_at: Date | string | null }>`
      select kind, subject, severity, opened_at, resolved_at, payload from alerts
      where network = ${network} and not test and (resolved_at is null or resolved_at > ${since}::timestamptz)
      order by opened_at desc, id desc limit ${RECENT_LIMIT}`,
    sql<{ opened_at: Date | string; opened_posted: boolean }>`
      select opened_at, opened_posted from alerts where network = ${network} and test order by opened_at desc, id desc limit 1`,
  ])
  return {
    open: open.map(toAlert),
    recent: recent.map((r) => ({ ...toAlert(r), resolvedAt: r.resolved_at === null ? null : iso(r.resolved_at) })),
    lastTest: tests[0] ? { openedAt: iso(tests[0].opened_at), delivered: tests[0].opened_posted } : null,
  }
}

/** The open alerts of `network` and how many count as critical (`countsAsCritical`), for `GET /api/health`. */
export async function openAlertCounts(sql: Sql, network: Network): Promise<{ count: number; critical: number }> {
  const open = (await openRows(sql, network)).map(toAlert)
  return { count: open.length, critical: open.filter(countsAsCritical).length }
}

// ---------------------------------------------------------------- reading the input

type Env = Readonly<Record<string, string | undefined>>

/**
 * The key the keeper signs with, by `ORACLE_KEEPER_MODE`: `ORACLE_ADMIN_SECRET`'s public key in `push`
 * mode (the default), `ORACLE_KEEPER_SECRET`'s in `feed` mode; null when that key is not set (no
 * check). Only the public key leaves this function; an error names the variable, never its value.
 */
export function signerAccount(env: Env): { account: string } | { error: string } | null {
  const mode = env.ORACLE_KEEPER_MODE?.trim() || "push"
  if (mode !== "push" && mode !== "feed") return { error: "ORACLE_KEEPER_MODE is neither push nor feed" }
  const name = mode === "feed" ? "ORACLE_KEEPER_SECRET" : "ORACLE_ADMIN_SECRET"
  const secret = env[name]?.trim()
  if (!secret) return null
  try {
    return { account: Keypair.fromSecret(secret).publicKey() }
  } catch {
    return { error: `${name} is not a valid secret key` }
  }
}

const XLM_AMOUNT = /^\d{1,12}(\.\d{1,7})?$/

const toStroops = (amount: string): bigint => {
  const [whole, frac = ""] = amount.split(".")
  return BigInt(whole) * STROOPS_PER_XLM + BigInt(frac.padEnd(7, "0"))
}

/** `ALERT_SIGNER_MIN_XLM` in stroops (20 XLM by default); a value that is not an XLM amount falls back to the default, with a warning. */
export function signerMinStroops(env: Env): bigint {
  const raw = env.ALERT_SIGNER_MIN_XLM?.trim()
  if (!raw) return toStroops(DEFAULT_SIGNER_MIN_XLM)
  if (!XLM_AMOUNT.test(raw)) {
    console.warn(`alerts: ALERT_SIGNER_MIN_XLM is not an XLM amount; using ${DEFAULT_SIGNER_MIN_XLM}`)
    return toStroops(DEFAULT_SIGNER_MIN_XLM)
  }
  return toStroops(raw)
}

/** A fetch whose every request gives up after `ms`. */
const timedFetch =
  (fetchImpl: typeof fetch, ms: number): typeof fetch =>
  (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) })

async function readSigner(manifest: Manifest, env: Env, fetchImpl: typeof fetch): Promise<SignerSeen | null> {
  const who = signerAccount(env)
  if (who === null) return null
  if ("error" in who) return { account: null, error: who.error }
  const read = await fetchAccount(manifest.horizonUrl, who.account, timedFetch(fetchImpl, WEBHOOK_TIMEOUT_MS))
  if (read.status === "unavailable") return { account: who.account, error: scrub(read.error) }
  const minStroops = signerMinStroops(env)
  if (read.value === null) return { account: who.account, stroops: null, minStroops }
  const native = read.value.balances.find((b) => b.asset_type === "native")
  if (native && !/^\d+(\.\d{1,7})?$/.test(native.balance)) return { account: who.account, error: "Horizon returned an unreadable XLM balance" }
  return { account: who.account, stroops: native ? toStroops(native.balance) : 0n, minStroops }
}

async function readTicks(sql: Sql, network: Network, oracle: string, since: string): Promise<TickSeen[]> {
  const rows = await sql<{ at: Date | string; decision: TickDecision; reason: string | null; value: string | null; tx_hash: string | null }>`
    select at, decision, reason, value::text as value, tx_hash from oracle_ticks
    where network = ${network} and oracle = ${oracle} and at > ${since}::timestamptz
    order by at desc, id desc limit 500`
  return rows.map((r) => ({ at: iso(r.at), decision: r.decision, reason: r.reason, value: r.value, txHash: r.tx_hash }))
}

async function readRejectionEvents(sql: Sql, network: Network, oracle: string, since: string): Promise<RejectionEventSeen[]> {
  const rows = await sql<{ id: string; close_time: Date | string; ledger: number | string; tx_hash: string; data: Record<string, unknown> }>`
    select id, close_time, ledger, tx_hash, data from events
    where network = ${network} and group_name = 'oracle' and contract_id = ${oracle} and topic = 'ref_rej' and close_time > ${since}::timestamptz
    order by ledger desc, id desc limit 500`
  return rows.flatMap((r) =>
    typeof r.data?.reason === "string"
      ? [{ id: r.id, at: iso(r.close_time), ledger: Number(r.ledger), reason: r.data.reason, value: String(r.data.value ?? "unknown"), txHash: r.tx_hash }]
      : [],
  )
}

async function readCursors(sql: Sql, network: Network): Promise<CursorSeen[]> {
  const names = INDEX_GROUPS.map((g) => indexCursorName(g, network))
  const rows = await sql<{ name: string; ledger: string | number | null; close_time: Date | string | null; gap_from: string | number | null; gap_to: string | number | null }>`
    select name, ledger, close_time, gap_from, gap_to from ingest_cursor where name = any(${names}::text[])`
  const num = (v: string | number | null) => (v === null ? null : Number(v))
  return INDEX_GROUPS.flatMap((group) => {
    const r = rows.find((x) => x.name === indexCursorName(group, network))
    return r ? [{ group, ledger: num(r.ledger), closeTime: r.close_time === null ? null : iso(r.close_time), gapFrom: num(r.gap_from), gapTo: num(r.gap_to) }] : []
  })
}

/** The latest ledger from `rpcUrl`, then each of `rpcFallbackUrls` on a transient failure, as the contract reads do (D-6). */
async function ledgerClockOf(manifest: Manifest): Promise<{ sequence: number; closeTime: number }> {
  const urls = serverRpcUrls(manifest)
  for (let i = 0; ; i++) {
    try {
      return await getLedgerClock(createRpcServer(urls[i]))
    } catch (error) {
      if (i === urls.length - 1 || !isTransientRpcError(error)) throw error
    }
  }
}

/** A read that throws becomes `Unread`, named by its error only. */
const guard = <T,>(p: Promise<T>): Promise<T | Unread> => p.catch((error: unknown) => ({ error: nameOf(error) }))

const TIMED_OUT = "the read did not answer within the check's read budget"

/** `p`, or `Unread` (timed out) when it has not settled by `deadline` (wall-clock ms). The read itself is left to finish or fail on its own. */
function by<T>(p: Promise<T | Unread>, deadline: number): Promise<T | Unread> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Unread>((resolve) => {
    timer = setTimeout(() => resolve({ error: TIMED_OUT }), Math.max(0, deadline - Date.now()))
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

export type AlertDeps = {
  sql: Sql
  manifest: Manifest
  /** Where the keeper keys and `ALERT_SIGNER_MIN_XLM` are read (`process.env` in the route). */
  env: Env
  /** ms; `Date.now()` by default: stamps the alerts and anchors the windows over recorded rows. */
  now?: number
  /**
   * Wall-clock ms the run started (`Date.now()` by default; the route takes it first thing): the reads
   * share `READ_BUDGET_MS` from it, and every post ends by `POST_DEADLINE_MS` from it.
   */
  startedAt?: number
  /** A test hook for `READ_BUDGET_MS`. */
  readBudgetMs?: number
  reader?: ContractReader
  /** The latest ledger (sequence, close time in unix seconds); the manifest's RPC, then its fallbacks, by default. */
  ledgerClock?: () => Promise<{ sequence: number; closeTime: number }>
  /** For Horizon; `fetch` by default. */
  fetchImpl?: typeof fetch
  /** Where the manifest markets' verdicts are read; `sqlRegistryStore(sql)` by default. */
  registry?: Pick<RegistryStore, "rows">
}

/** The manifest markets' stored verdicts, through the bounded read pages use (the seeds' own rows). A seed with no row has no verdict. */
async function readSeeds(registry: Pick<RegistryStore, "rows">, manifest: Manifest): Promise<SeedSeen[]> {
  const rows = await registry.rows({ listed: manifest.markets.map((m) => m.contracts.pool) })
  const byPool = new Map(rows.map((r) => [r.pool, r]))
  return manifest.markets.map((m) => {
    const row = byPool.get(m.contracts.pool)
    return { marketId: m.marketId, pool: m.contracts.pool, asset: m.underlying.code, valid: row?.valid ?? null, reason: row?.reason ?? null }
  })
}

/** `keeperIntervalSeconds(env)`, or Unread when it is not valid: the check still runs (only the keeper's and the feed's alerts need it). */
function intervalOf(env: Env): number | Unread {
  try {
    return keeperIntervalSeconds(env)
  } catch {
    // The variable's name only, never its value.
    console.error("alerts: ORACLE_KEEPER_INTERVAL_SECONDS is not valid; keeper_unhealthy and feed_broken are held for every oracle")
    return { error: BAD_INTERVAL }
  }
}

/**
 * Reads everything the check judges, all at once: each oracle's view, ticks, `ref_rej` events and
 * keeper health side by side (one `fetchOracleView` per oracle, nothing else new on-chain), with the
 * shared sources. Only the oracles and RiskControl wait for the ledger clock (they need its time and
 * sequence). Each source fails alone, and any still pending `READ_BUDGET_MS` after the run's start is
 * `Unread`, so the run always reaches its writes and posts.
 */
export async function collectAlertInput(deps: AlertDeps): Promise<AlertInput> {
  const { sql, manifest } = deps
  const now = deps.now ?? Date.now()
  const readsBy = (deps.startedAt ?? Date.now()) + (deps.readBudgetMs ?? READ_BUDGET_MS)
  const network = manifest.network
  // Read per run from the same environment as the keeper's keys; a bad value holds the keeper's and the feed's alerts, never a silent default.
  const intervalSeconds = intervalOf(deps.env)
  const reader = deps.reader ?? serverReader(manifest)
  const registry = deps.registry ?? sqlRegistryStore(sql)
  const since = iso(now - REJECTION_WINDOW_SECONDS * 1000)
  const noLedger: Unread = { error: "the ledger could not be read" }
  const clock = guard(deps.ledgerClock ? deps.ledgerClock() : ledgerClockOf(manifest))
  const afterClock = <T,>(read: (c: { sequence: number; closeTime: number }) => Promise<T>) =>
    clock.then((c): Promise<T | Unread> => (unread(c) ? Promise.resolve(noLedger) : guard(read(c))))
  const readOracle = async ({ oracle, markets }: { oracle: string; markets: Manifest["markets"] }): Promise<OracleInput> => {
    const [view, ticks, rejectionEvents, keeper] = await Promise.all([
      by(afterClock((c) => fetchOracleView(reader, manifest, oracle, c.closeTime)), readsBy),
      by(guard(readTicks(sql, network, oracle, since)), readsBy),
      by(guard(readRejectionEvents(sql, network, oracle, since)), readsBy),
      unread(intervalSeconds) ? intervalSeconds : by(guard(keeperHealth(sql, network, intervalSeconds, { oracle, now })), readsBy),
    ])
    return { oracleId: oracle, asset: assetCodes(markets), view, ticks, rejectionEvents, keeper }
  }
  const [oracles, seeds, risk, pauses, indexer, signer] = await Promise.all([
    Promise.all(manifestOracles(manifest).map(readOracle)),
    by(guard(readSeeds(registry, manifest)), readsBy),
    by(afterClock((c) => fetchRiskView(reader, manifest, c.sequence)), readsBy),
    by(guard(fetchPauses(reader, manifest)), readsBy),
    by(guard(readCursors(sql, network)), readsBy),
    by(
      readSigner(manifest, deps.env, deps.fetchImpl ?? fetch).catch((error: unknown): SignerSeen => ({ account: null, error: nameOf(error) })),
      readsBy,
    ).then((r): SignerSeen | null => (r !== null && "error" in r && !("account" in r) ? { account: null, error: r.error } : r)),
  ])
  return { network, now, intervalSeconds, oracles, seeds, pauses, risk, signer, indexer }
}

export type AlertCheckResult = SyncResult & {
  network: Network
  /**
   * What was kept as it was because its source was not read: a kind alone ("risk_warning") for all its
   * alerts, `kind:subject` for one alert ("oracle_stale:C…"), `kind:<oracle>:` for one oracle's rejections.
   */
  held: string[]
  /** The sources that could not be read, by name. */
  unread: string[]
  /** A critical alert is open: the route answers 500. */
  critical: boolean
}

/**
 * One run of the check: read, judge, sync, post. Everything is timed from the run's start
 * (`startedAt`): the reads end by `READ_BUDGET_MS`, the posts by `POST_DEADLINE_MS`. `critical` counts
 * a debounced alert only once confirmed.
 */
export async function runAlertCheck(deps: AlertDeps & { post: PostAlert }): Promise<AlertCheckResult> {
  const startedAt = deps.startedAt ?? Date.now()
  const input = await collectAlertInput({ ...deps, startedAt })
  const held = heldSubjects(input)
  const sync = await syncAlerts(deps.sql, input.network, evaluateAlerts(input), deps.post, input.now, { held, deadline: startedAt + POST_DEADLINE_MS })
  // The answer is JSON for people and logs: a held alert reads `kind:subject`, not with its NUL separator.
  const shown = held.map((h) => h.replace("\u0000", ":"))
  return { network: input.network, ...sync, held: shown, unread: unreadSources(input), critical: sync.open.some(countsAsCritical) }
}
