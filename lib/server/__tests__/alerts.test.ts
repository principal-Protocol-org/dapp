// @vitest-environment node
import { Keypair } from "@stellar/stellar-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { BLOCKED_WHEN_STALE, type Freshness, type OracleView } from "@/lib/protocol/dashboard/oracle"
import type { PauseView } from "@/lib/protocol/dashboard/pauses"
import type { RiskView } from "@/lib/protocol/dashboard/risk"
import { liveValue } from "@/lib/protocol/reader"
import type { Live } from "@/lib/protocol/types"
import type { Sql } from "@/lib/server/db"
import { redact } from "@/lib/server/request"
import {
  ALERT_KINDS,
  alertTitle,
  CRITICAL,
  evaluateAlerts,
  heldKinds,
  INDEXER_LAG_SECONDS,
  listAlerts,
  openAlertCounts,
  REJECTION_WINDOW_SECONDS,
  sendTestAlert,
  signerAccount,
  signerMinStroops,
  syncAlerts,
  WEBHOOK_TIMEOUT_MS,
  webhookPayload,
  webhookPoster,
  WebhookError,
  type AlertInput,
  type DesiredAlert,
  type WebhookPayload,
} from "@/lib/server/alerts"

const ORACLE = "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS"
const RISK = "CCRZ55SG273OTUZSFME6A6XXXEZ3GM5IMVRLF4NEEWNC54NGCRHIMHJC"
const SY = "CA62ACRTFADKNOP37CS7DPQ5DNJML4TFHIX6LZG5IBEHJM3PED2V7F2I"
const POOL = "CB3JI6H2HZ3PMWKLEKDPQUURFSKJSFTLNFNBU4CFEHAZXMWL5SNNS6OJ"
const MANAGER = "CDYL4ZOIZ3DKEDWIMBUXHYQUAT4BAZTYZ7ZRCVLAMFAXGTJZRTOLVG47"
const USDY = "CB2YO6BCOTN336RQUAMHOBCNABJG74URBIMNUHXB27K2QOLJKDCDXODZ"
const SIGNER = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const HASH = "ab".repeat(32)
const HOOK = "https://hooks.example.test/services/T000/B000/very-secret-token"
const SECRET_SHAPED = `S${"A".repeat(55)}`

const NOW = Date.parse("2026-11-14T12:00:00.000Z")
const LEDGER_TIME = NOW / 1000
const iso = (ms: number) => new Date(ms).toISOString()
const ago = (seconds: number) => iso(NOW - seconds * 1000)

const live = <T,>(value: T): Live<T> => liveValue(value, 777)
const down = (error: string): Live<never> => ({ status: "unavailable", error })

/** An oracle read at `LEDGER_TIME`, `age` seconds after its last value. */
function oracle(freshness: Freshness, o: { age?: number; maxStale?: number; reason?: string } = {}): OracleView {
  const maxStale = o.maxStale ?? 3_600
  const age = o.age ?? 600
  const unread = freshness === "unavailable"
  return {
    contractId: ORACLE,
    value: unread ? down(o.reason ?? "rpc down") : live(10_000_919n),
    timestamp: unread ? down(o.reason ?? "rpc down") : live(BigInt(LEDGER_TIME - age)),
    available: unread ? down(o.reason ?? "rpc down") : live(freshness !== "stale"),
    freshness,
    timeToBlock: unread ? down(o.reason ?? "rpc down") : live(maxStale - age),
    maxStale: unread ? down(o.reason ?? "rpc down") : live(BigInt(maxStale)),
    deviationBps: live(1_000n),
    bounds: live(null),
    sources: { primary: { hash: live(null) }, fallback: { hash: live(null) }, active: { hash: live(null) } },
    path: { status: "unsupported" },
    lastRejection: live(null),
    blockedWhenStale: BLOCKED_WHEN_STALE,
  }
}

function risk(limit: bigint, volume: bigint, assets: { asset: string; limit: bigint; volume: bigint }[] = []): RiskView {
  const remaining = (l: bigint, v: bigint) => (l <= 0n ? null : l > v ? l - v : 0n)
  return {
    contractId: RISK,
    limit: live(limit),
    volume: live(volume),
    remaining: live(remaining(limit, volume)),
    effectiveWrapAndMint: null,
    doubleReporting: [],
    consumers: {},
    window: { start: live(5_707_351), length: live(17_280), lapsed: live(false) },
    assetLimits: assets.map((a) => ({ asset: a.asset, limit: live(a.limit), volume: live(a.volume), remaining: live(remaining(a.limit, a.volume)) })),
    paused: live(false),
  }
}

type PauseState = boolean | "down"
function pauses(state: Partial<Record<"riskControl" | "sy" | "pool" | "manager", PauseState>> = {}): PauseView {
  const read = (s: PauseState | undefined): Live<boolean> => (s === "down" ? down("rpc down") : live(s ?? false))
  const contracts: PauseView["contracts"] = [
    { kind: "riskControl", contractId: RISK, label: "Risk control", paused: read(state.riskControl) },
    { kind: "sy", contractId: SY, marketId: "m1", label: "SY wrapper (m1)", paused: read(state.sy) },
    { kind: "pool", contractId: POOL, marketId: "m1", label: "Market pool (m1)", paused: read(state.pool) },
    { kind: "manager", contractId: MANAGER, marketId: "m1", label: "Principal manager (m1)", paused: read(state.manager) },
  ]
  const failed = contracts.find((c) => c.paused.status === "unavailable")
  return {
    contracts,
    paused: failed ? down(`${failed.label}: rpc down`) : live(contracts.filter((c) => c.paused.status === "live" && c.paused.value).map((c) => c.label)),
  }
}

const HEALTHY = { healthy: true, lastSuccessAt: ago(600), lastTickAt: ago(600), rejected24h: 0, failures24h: 0 }
const GROUPS = ["escrow", "oracle", "permissioning", "risk", "market"] as const
const cursors = (lagSeconds = 120, over: Partial<Record<(typeof GROUPS)[number], { gapFrom?: number; gapTo?: number; lag?: number | null }>> = {}) =>
  GROUPS.map((group) => {
    const o = over[group] ?? {}
    const lag = o.lag === undefined ? lagSeconds : o.lag
    return { group, ledger: 5_719_749, closeTime: lag === null ? null : ago(lag), gapFrom: o.gapFrom ?? null, gapTo: o.gapTo ?? null }
  })

function input(over: Partial<AlertInput> = {}): AlertInput {
  return {
    network: "testnet",
    now: NOW,
    intervalSeconds: 1_800,
    oracleId: ORACLE,
    oracle: oracle("fresh"),
    ticks: [],
    rejectionEvents: [],
    keeper: HEALTHY,
    pauses: pauses(),
    risk: risk(100_000_000_000_000n, 0n),
    signer: null,
    indexer: cursors(),
    ...over,
  }
}

const kinds = (alerts: DesiredAlert[]) => alerts.map((a) => `${a.kind} ${a.subject}`).sort()

describe("CRITICAL", () => {
  it("is exactly the five kinds that answer 500", () => {
    expect([...CRITICAL]).toEqual(["oracle_stale", "oracle_unavailable", "keeper_unhealthy", "risk_exhausted", "indexer_gap"])
  })
})

describe("evaluateAlerts: each kind's trigger and resolution (D-20)", () => {
  it("raises nothing when everything is fine", () => {
    expect(evaluateAlerts(input())).toEqual([])
    expect(heldKinds(input())).toEqual([])
  })

  describe("oracle freshness, from the live view at the latest ledger time", () => {
    it("fresh below 75% of max_stale: nothing", () => {
      expect(evaluateAlerts(input({ oracle: oracle("fresh", { age: 2_699 }) }))).toEqual([])
    })
    it("warning from 75% of max_stale, with the age and the time left", () => {
      const [a, ...rest] = evaluateAlerts(input({ oracle: oracle("warning", { age: 2_700 }) }))
      expect(rest).toEqual([])
      expect(a).toEqual({
        kind: "oracle_warning",
        subject: ORACLE,
        severity: "warning",
        payload: { ageSeconds: 2_700, maxStaleSeconds: 3_600, secondsToBlock: 900 },
      })
    })
    it("stale past max_stale: oracle_stale (critical) and no warning beside it", () => {
      const alerts = evaluateAlerts(input({ oracle: oracle("stale", { age: 3_601 }) }))
      expect(alerts).toEqual([
        { kind: "oracle_stale", subject: ORACLE, severity: "critical", payload: { ageSeconds: 3_601, maxStaleSeconds: 3_600, secondsToBlock: -1 } },
      ])
    })
    it("unreadable: oracle_unavailable (critical) with the reason, and the freshness alerts are held, not closed", () => {
      const i = input({ oracle: oracle("unavailable", { reason: "HostError: Error(Contract, #3)" }) })
      expect(evaluateAlerts(i)).toEqual([
        { kind: "oracle_unavailable", subject: ORACLE, severity: "critical", payload: { reason: "HostError: Error(Contract, #3)" } },
      ])
      expect(heldKinds(i)).toEqual(expect.arrayContaining(["oracle_warning", "oracle_stale"]))
    })
    it("a read that threw is unavailable too", () => {
      const i = input({ oracle: { error: "the ledger could not be read" } })
      expect(kinds(evaluateAlerts(i))).toEqual([`oracle_unavailable ${ORACLE}`])
      expect(evaluateAlerts(i)[0].payload).toEqual({ reason: "the ledger could not be read" })
    })
  })

  describe("oracle_rejection: a new significant rejection, from ref_rej and from the keeper's ticks", () => {
    const event = (o: { reason?: string; value?: string; age?: number; tx?: string } = {}) => ({
      id: `0024565012345678848-${String(o.age ?? 60).padStart(10, "0")}`,
      at: ago(o.age ?? 60),
      ledger: 5_719_800,
      reason: o.reason ?? "deviate",
      value: o.value ?? "12000000",
      txHash: o.tx ?? HASH,
    })
    const tick = (o: { reason?: string; value?: string; age?: number; tx?: string | null; decision?: "rejected" | "error" } = {}) => ({
      at: ago(o.age ?? 60),
      decision: o.decision ?? ("rejected" as const),
      reason: o.reason ?? "deviate",
      value: o.value ?? "12000000",
      txHash: o.tx === undefined ? HASH : o.tx,
    })

    it("an indexed significant ref_rej opens one alert keyed by reason and value", () => {
      const [a] = evaluateAlerts(input({ rejectionEvents: [event()] }))
      expect(a).toEqual({
        kind: "oracle_rejection",
        subject: "deviate:12000000",
        severity: "warning",
        payload: { reason: "deviate", value: "12000000", lastAt: ago(60), occurrences: 1, txHash: HASH, sources: ["event"] },
      })
    })
    it("the same rejection in an event and in the keeper's tick is one alert", () => {
      const alerts = evaluateAlerts(input({ rejectionEvents: [event({ age: 120 })], ticks: [tick({ age: 125 })] }))
      expect(kinds(alerts)).toEqual(["oracle_rejection deviate:12000000"])
      expect(alerts[0].payload).toMatchObject({ occurrences: 2, sources: ["event", "tick"], lastAt: ago(120) })
    })
    it("repeats of one rejection without a transaction (feed mode) keep one alert", () => {
      const alerts = evaluateAlerts(input({ ticks: [tick({ age: 60, tx: null }), tick({ age: 1_860, tx: null }), tick({ age: 3_660, tx: HASH })] }))
      expect(kinds(alerts)).toEqual(["oracle_rejection deviate:12000000"])
      expect(alerts[0].payload).toMatchObject({ occurrences: 3, txHash: HASH })
    })
    it("each distinct (reason, value) has its own alert", () => {
      const alerts = evaluateAlerts(input({ rejectionEvents: [event(), event({ reason: "oob", value: "99" })], ticks: [tick({ reason: "decrease", value: "9" })] }))
      expect(kinds(alerts)).toEqual(["oracle_rejection decrease:9", "oracle_rejection deviate:12000000", "oracle_rejection oob:99"])
    })
    it("routine reasons (stale_ts, no_data) and broken-feed reasons are not significant rejections", () => {
      const alerts = evaluateAlerts(
        input({
          rejectionEvents: [event({ reason: "stale_ts" }), event({ reason: "no_data" })],
          ticks: [tick({ reason: "stale_ts" }), tick({ reason: "bad_price", age: 99_999 })],
        }),
      )
      expect(alerts).toEqual([])
    })
    it("an error tick is not a rejection", () => {
      expect(evaluateAlerts(input({ ticks: [tick({ decision: "error", reason: "failed: TypeError" })] }))).toEqual([])
    })
    it(`resolves once no occurrence is younger than ${REJECTION_WINDOW_SECONDS} s`, () => {
      expect(kinds(evaluateAlerts(input({ rejectionEvents: [event({ age: REJECTION_WINDOW_SECONDS - 1 })] })))).toEqual(["oracle_rejection deviate:12000000"])
      expect(evaluateAlerts(input({ rejectionEvents: [event({ age: REJECTION_WINDOW_SECONDS })] }))).toEqual([])
    })
    it("is held while either source cannot be read", () => {
      expect(heldKinds(input({ rejectionEvents: { error: "DatabaseError" } }))).toContain("oracle_rejection")
      expect(heldKinds(input({ ticks: { error: "DatabaseError" } }))).toEqual(expect.arrayContaining(["oracle_rejection", "feed_broken"]))
    })
  })

  describe("feed_broken: the keeper's ticks with a broken-feed reason in the last 2 × interval", () => {
    const tick = (reason: string, age: number) => ({ at: ago(age), decision: "rejected" as const, reason, value: null, txHash: null })
    it("bad_price, rescale or future_ts within 3,600 s opens feed_broken for the oracle", () => {
      const [a] = evaluateAlerts(input({ ticks: [tick("bad_price", 30), tick("rescale", 1_830), tick("future_ts", 3_599)] }))
      expect(a).toEqual({
        kind: "feed_broken",
        subject: ORACLE,
        severity: "warning",
        payload: { reasons: ["bad_price", "rescale", "future_ts"], lastAt: ago(30), occurrences: 3 },
      })
    })
    it("resolves once the last broken tick is 2 × interval old", () => {
      expect(evaluateAlerts(input({ ticks: [tick("bad_price", 3_600)] }))).toEqual([])
    })
  })

  describe("keeper_unhealthy", () => {
    it("no run recorded is neutral: no alert, and an open one would close", () => {
      const i = input({ keeper: { healthy: false, lastSuccessAt: null, lastTickAt: null, rejected24h: 0, failures24h: 0 } })
      expect(evaluateAlerts(i)).toEqual([])
      expect(heldKinds(i)).not.toContain("keeper_unhealthy")
    })
    it("recorded runs whose last success is older than 2 × interval: critical", () => {
      const keeper = { healthy: false, lastSuccessAt: ago(3_600), lastTickAt: ago(60), rejected24h: 1, failures24h: 2 }
      expect(evaluateAlerts(input({ keeper }))).toEqual([
        {
          kind: "keeper_unhealthy",
          subject: ORACLE,
          severity: "critical",
          payload: { lastSuccessAt: ago(3_600), lastTickAt: ago(60), intervalSeconds: 1_800, rejected24h: 1, failures24h: 2 },
        },
      ])
    })
    it("runs that never succeeded are unhealthy", () => {
      const keeper = { healthy: false, lastSuccessAt: null, lastTickAt: ago(60), rejected24h: 0, failures24h: 3 }
      expect(kinds(evaluateAlerts(input({ keeper })))).toEqual([`keeper_unhealthy ${ORACLE}`])
    })
    it("held when the ticks cannot be read", () => {
      const i = input({ keeper: { error: "DatabaseError" } })
      expect(evaluateAlerts(i)).toEqual([])
      expect(heldKinds(i)).toContain("keeper_unhealthy")
    })
  })

  describe("paused: one alert per paused contract", () => {
    it("subject is the role and the short id", () => {
      const alerts = evaluateAlerts(input({ pauses: pauses({ sy: true, riskControl: true }) }))
      expect(kinds(alerts)).toEqual(["paused riskControl:CCRZ…MHJC", "paused sy:CA62…7F2I"])
      expect(alerts.find((a) => a.subject.startsWith("sy:"))).toEqual({
        kind: "paused",
        subject: "sy:CA62…7F2I",
        severity: "warning",
        payload: { contractId: SY, role: "sy", label: "SY wrapper (m1)", marketId: "m1" },
      })
    })
    it("a pause read that failed holds the paused alerts; the known pauses still open", () => {
      const i = input({ pauses: pauses({ pool: true, manager: "down" }) })
      expect(kinds(evaluateAlerts(i))).toEqual(["paused pool:CB3J…S6OJ"])
      expect(heldKinds(i)).toContain("paused")
    })
  })

  describe("risk_warning and risk_exhausted (D-12)", () => {
    const LIMIT = 100_000_000_000_000n
    it("below 90%: nothing", () => {
      expect(evaluateAlerts(input({ risk: risk(LIMIT, (LIMIT * 9n) / 10n - 1n) }))).toEqual([])
    })
    it("90% opens a warning on the protocol-wide limit", () => {
      expect(evaluateAlerts(input({ risk: risk(LIMIT, (LIMIT * 9n) / 10n) }))).toEqual([
        { kind: "risk_warning", subject: RISK, severity: "warning", payload: { scope: "protocol", limit: String(LIMIT), volume: String((LIMIT * 9n) / 10n), percent: "90.0" } },
      ])
    })
    it("100% is exhausted (critical), with no warning beside it", () => {
      expect(evaluateAlerts(input({ risk: risk(LIMIT, LIMIT) }))).toEqual([
        { kind: "risk_exhausted", subject: RISK, severity: "critical", payload: { scope: "protocol", limit: String(LIMIT), volume: String(LIMIT), percent: "100.0" } },
      ])
    })
    it("a limit of 0 is off: nothing, whatever the volume", () => {
      expect(evaluateAlerts(input({ risk: risk(0n, 5n) }))).toEqual([])
    })
    it("a per-asset limit is judged on its own, keyed by the asset", () => {
      const alerts = evaluateAlerts(input({ risk: risk(LIMIT, 0n, [{ asset: USDY, limit: 1_000n, volume: 950n }]) }))
      expect(alerts).toEqual([
        { kind: "risk_warning", subject: `asset:${USDY}`, severity: "warning", payload: { scope: "asset", asset: USDY, limit: "1000", volume: "950", percent: "95.0" } },
      ])
    })
    it("held when RiskControl cannot be read", () => {
      expect(heldKinds(input({ risk: { error: "the ledger could not be read" } }))).toEqual(expect.arrayContaining(["risk_warning", "risk_exhausted"]))
      const r = risk(LIMIT, 0n)
      expect(heldKinds(input({ risk: { ...r, volume: down("rpc down") } }))).toEqual(expect.arrayContaining(["risk_warning", "risk_exhausted"]))
    })
  })

  describe("signer_low: the keeper signer's XLM on Horizon", () => {
    const MIN = 200_000_000n // 20 XLM
    it("below the floor opens signer_low for the signer", () => {
      expect(evaluateAlerts(input({ signer: { account: SIGNER, stroops: 199_999_999n, minStroops: MIN } }))).toEqual([
        { kind: "signer_low", subject: SIGNER, severity: "warning", payload: { account: SIGNER, balanceXlm: "19.9999999", minXlm: "20", found: true } },
      ])
    })
    it("at the floor: nothing", () => {
      expect(evaluateAlerts(input({ signer: { account: SIGNER, stroops: MIN, minStroops: MIN } }))).toEqual([])
    })
    it("an account that does not exist holds no XLM", () => {
      expect(evaluateAlerts(input({ signer: { account: SIGNER, stroops: null, minStroops: MIN } }))[0].payload).toEqual({
        account: SIGNER,
        balanceXlm: "0",
        minXlm: "20",
        found: false,
      })
    })
    it("no keeper key: no check; a Horizon failure: held", () => {
      expect(heldKinds(input({ signer: null }))).not.toContain("signer_low")
      const i = input({ signer: { account: SIGNER, error: "Horizon responded 503" } })
      expect(evaluateAlerts(i)).toEqual([])
      expect(heldKinds(i)).toContain("signer_low")
    })
  })

  describe("indexer_lag and indexer_gap", () => {
    it(`a group more than ${INDEXER_LAG_SECONDS} s behind opens indexer_lag for that group`, () => {
      const alerts = evaluateAlerts(input({ indexer: cursors(120, { oracle: { lag: 3_601 } }) }))
      expect(alerts).toEqual([
        { kind: "indexer_lag", subject: "oracle", severity: "warning", payload: { group: "oracle", lagSeconds: 3_601, indexedThrough: 5_719_749, closeTime: ago(3_601) } },
      ])
      expect(evaluateAlerts(input({ indexer: cursors(3_600) }))).toEqual([])
    })
    it("a group with no cursor or no close time is neutral", () => {
      expect(evaluateAlerts(input({ indexer: cursors(120, { risk: { lag: null } }).filter((c) => c.group !== "market") }))).toEqual([])
    })
    it("a stored gap opens indexer_gap (critical) per group, with from and to", () => {
      expect(evaluateAlerts(input({ indexer: cursors(120, { escrow: { gapFrom: 5_707_342, gapTo: 5_710_000 } }) }))).toEqual([
        { kind: "indexer_gap", subject: "escrow", severity: "critical", payload: { group: "escrow", from: 5_707_342, to: 5_710_000 } },
      ])
    })
    it("held when the cursors cannot be read", () => {
      expect(heldKinds(input({ indexer: { error: "DatabaseError" } }))).toEqual(expect.arrayContaining(["indexer_lag", "indexer_gap"]))
    })
  })
})

// ---------------------------------------------------------------- the alerts table, in memory

type Row = {
  id: number
  network: string
  kind: string
  subject: string
  severity: string
  opened_at: Date
  resolved_at: Date | null
  payload: Record<string, unknown>
  test: boolean
  opened_posted: boolean
  resolved_posted: boolean
}

/**
 * A stand-in for `sql` over one in-memory `alerts` table: it answers the statements `lib/server/alerts`
 * sends (matched by their text), with the partial unique index's behavior. The integration suite runs
 * the same statements on Postgres.
 */
function alertsDb() {
  const rows: Row[] = []
  let nextId = 1
  const texts: string[] = []
  const byId = (id: unknown) => rows.find((r) => r.id === Number(id))
  const sql = vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join("$?").replace(/\s+/g, " ").trim()
    texts.push(text)
    const out = (r: Row) => ({ ...r, id: String(r.id) })
    if (text.startsWith("insert into alerts (network, kind, subject, severity, opened_at, payload)")) {
      const [network, kind, subject, severity, at, payload] = v as [string, string, string, string, string, string]
      if (rows.some((r) => r.network === network && r.kind === kind && r.subject === subject && r.resolved_at === null)) return []
      const row: Row = { id: nextId++, network, kind, subject, severity, opened_at: new Date(at), resolved_at: null, payload: JSON.parse(payload), test: false, opened_posted: false, resolved_posted: false }
      rows.push(row)
      return [{ id: String(row.id) }]
    }
    if (text.startsWith("insert into alerts (network, kind, subject, severity, opened_at, resolved_at, payload, test, resolved_posted)")) {
      const [network, at, , payload] = v as [string, string, string, string]
      const row: Row = { id: nextId++, network, kind: "test", subject: "webhook", severity: "warning", opened_at: new Date(at), resolved_at: new Date(at), payload: JSON.parse(payload), test: true, opened_posted: false, resolved_posted: true }
      rows.push(row)
      return [{ id: String(row.id) }]
    }
    if (text.startsWith("update alerts set resolved_at =")) {
      const [at, id] = v
      const r = byId(id)
      if (!r || r.resolved_at !== null) return []
      r.resolved_at = new Date(at as string)
      return [{ id: String(r.id) }]
    }
    if (text.startsWith("update alerts set opened_posted = true")) {
      const r = byId(v[0])
      if (!r || r.opened_posted) return []
      r.opened_posted = true
      return [{ id: String(r.id) }]
    }
    if (text.startsWith("update alerts set opened_posted = false")) {
      const r = byId(v[0])
      if (r) r.opened_posted = false
      return []
    }
    if (text.startsWith("update alerts set resolved_posted = true")) {
      const r = byId(v[0])
      if (!r || r.resolved_at === null || r.resolved_posted) return []
      r.resolved_posted = true
      return [{ id: String(r.id) }]
    }
    if (text.startsWith("update alerts set resolved_posted = false")) {
      const r = byId(v[0])
      if (r) r.resolved_posted = false
      return []
    }
    if (text.includes("from alerts") && text.includes("not opened_posted or")) {
      const [network, limit] = v as [string, number]
      return rows
        .filter((r) => r.network === network && !r.test && (!r.opened_posted || (r.resolved_at !== null && !r.resolved_posted)))
        .sort((a, b) => a.id - b.id)
        .slice(0, Number(limit))
        .map(out)
    }
    if (text.includes("from alerts") && text.includes("group by severity")) {
      const [network] = v
      const open = rows.filter((r) => r.network === network && r.resolved_at === null && !r.test)
      return ["warning", "critical"].map((s) => ({ severity: s, n: String(open.filter((r) => r.severity === s).length) })).filter((x) => x.n !== "0")
    }
    if (text.includes("from alerts") && text.includes("and test order by")) {
      const [network] = v
      const t = rows.filter((r) => r.network === network && r.test).sort((a, b) => b.opened_at.getTime() - a.opened_at.getTime() || b.id - a.id)
      return t.slice(0, 1).map(out)
    }
    if (text.includes("from alerts") && text.includes("resolved_at is null or resolved_at >")) {
      const [network, since] = v as [string, string]
      return rows
        .filter((r) => r.network === network && !r.test && (r.resolved_at === null || r.resolved_at > new Date(since)))
        .sort((a, b) => b.opened_at.getTime() - a.opened_at.getTime() || b.id - a.id)
        .map(out)
    }
    if (text.includes("from alerts") && text.includes("resolved_at is null and not test")) {
      const [network] = v
      return rows
        .filter((r) => r.network === network && r.resolved_at === null && !r.test)
        .sort((a, b) => a.opened_at.getTime() - b.opened_at.getTime() || a.id - b.id)
        .map(out)
    }
    throw new Error(`unexpected query: ${text}`)
  })
  return { sql: sql as unknown as Sql, rows, texts }
}

const STALE: DesiredAlert = { kind: "oracle_stale", subject: ORACLE, severity: "critical", payload: { ageSeconds: 3_700, maxStaleSeconds: 3_600, secondsToBlock: -100 } }
const LAG: DesiredAlert = { kind: "indexer_lag", subject: "oracle", severity: "warning", payload: { group: "oracle", lagSeconds: 4_000 } }

function poster() {
  const sent: WebhookPayload[] = []
  const post = vi.fn(async (p: WebhookPayload) => {
    sent.push(p)
  })
  return { post, sent }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("syncAlerts: each alert opens once and closes once", () => {
  it("opens once, resolves once across three runs, posting each change once", async () => {
    const db = alertsDb()
    const { post, sent } = poster()

    const first = await syncAlerts(db.sql, "testnet", [STALE], post, NOW)
    expect(first.opened).toEqual([{ kind: "oracle_stale", subject: ORACLE, severity: "critical" }])
    expect(first.resolved).toEqual([])
    expect(first.open).toEqual([{ kind: "oracle_stale", subject: ORACLE, severity: "critical", openedAt: iso(NOW), payload: STALE.payload }])
    expect(first.postFailures).toBe(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ status: "opened", kind: "oracle_stale", subject: ORACLE, severity: "critical", network: "testnet", at: iso(NOW), test: false })

    const second = await syncAlerts(db.sql, "testnet", [STALE], post, NOW + 300_000)
    expect(second.opened).toEqual([])
    expect(second.resolved).toEqual([])
    expect(second.open).toHaveLength(1)
    expect(sent).toHaveLength(1)

    const third = await syncAlerts(db.sql, "testnet", [], post, NOW + 600_000)
    expect(third.opened).toEqual([])
    expect(third.resolved).toEqual([{ kind: "oracle_stale", subject: ORACLE, severity: "critical" }])
    expect(third.open).toEqual([])
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ status: "resolved", kind: "oracle_stale", at: iso(NOW + 600_000) })

    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ opened_at: new Date(NOW), resolved_at: new Date(NOW + 600_000), opened_posted: true, resolved_posted: true })
    // Opening relies on the partial unique index, closing on resolved_at.
    expect(db.texts.some((t) => t.includes("on conflict (network, kind, subject) where resolved_at is null do nothing returning id"))).toBe(true)
  })

  it("a condition that returns after its close opens a new alert", async () => {
    const db = alertsDb()
    const { post } = poster()
    await syncAlerts(db.sql, "testnet", [STALE], post, NOW)
    await syncAlerts(db.sql, "testnet", [], post, NOW + 1_000)
    const again = await syncAlerts(db.sql, "testnet", [STALE], post, NOW + 2_000)
    expect(again.opened).toHaveLength(1)
    expect(db.rows.map((r) => r.resolved_at === null)).toEqual([false, true])
  })

  it("held kinds keep their open alerts: an unreadable source closes nothing", async () => {
    const db = alertsDb()
    const { post, sent } = poster()
    await syncAlerts(db.sql, "testnet", [STALE, LAG], post, NOW)
    const r = await syncAlerts(db.sql, "testnet", [], post, NOW + 1_000, { held: ["oracle_stale"] })
    expect(r.resolved).toEqual([{ kind: "indexer_lag", subject: "oracle", severity: "warning" }])
    expect(r.open.map((a) => a.kind)).toEqual(["oracle_stale"])
    expect(sent.map((p) => `${p.status} ${p.kind}`)).toEqual(["opened oracle_stale", "opened indexer_lag", "resolved indexer_lag"])
  })

  it("another network's alerts are left alone", async () => {
    const db = alertsDb()
    const { post } = poster()
    await syncAlerts(db.sql, "local", [STALE], post, NOW)
    const r = await syncAlerts(db.sql, "testnet", [], post, NOW + 1_000)
    expect(r.resolved).toEqual([])
    expect(db.rows[0].resolved_at).toBeNull()
  })

  it("webhook failure keeps state and hides the URL", async () => {
    const db = alertsDb()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {})
    const logs = vi.spyOn(console, "log").mockImplementation(() => {})
    // Node's fetch puts the host in its message; the post may throw anything.
    const failing = vi.fn(async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${HOOK}`)
    })

    const first = await syncAlerts(db.sql, "testnet", [STALE], failing, NOW)
    expect(first.opened).toHaveLength(1)
    expect(first.postFailures).toBe(1)
    expect(first.open).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ resolved_at: null, opened_posted: false })

    const { post, sent } = poster()
    const second = await syncAlerts(db.sql, "testnet", [STALE], post, NOW + 300_000)
    expect(second.opened).toEqual([])
    expect(second.postFailures).toBe(0)
    // The next run re-posts the opening it could not deliver, once, with its original time.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ status: "opened", kind: "oracle_stale", at: iso(NOW) })
    expect(db.rows[0].opened_posted).toBe(true)

    await syncAlerts(db.sql, "testnet", [STALE], post, NOW + 600_000)
    expect(sent).toHaveLength(1)

    const logged = [...errors.mock.calls, ...warns.mock.calls, ...logs.mock.calls].flat().map(String).join("\n")
    expect(logged).not.toContain("hooks.example.test")
    expect(logged).not.toContain(HOOK)
    expect(errors).toHaveBeenCalled()
    expect(JSON.stringify([first, second])).not.toContain("hooks.example.test")
  })

  it("a close waits for its opening: both are sent in order once the webhook answers", async () => {
    const db = alertsDb()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const failing = vi.fn(async () => {
      throw new WebhookError("the webhook answered 500")
    })
    await syncAlerts(db.sql, "testnet", [STALE], failing, NOW)
    const closing = await syncAlerts(db.sql, "testnet", [], failing, NOW + 1_000)
    expect(closing.resolved).toHaveLength(1)
    expect(closing.postFailures).toBe(1) // the opening failed again; the close was not tried before it
    expect(failing).toHaveBeenCalledTimes(2)

    const { post, sent } = poster()
    await syncAlerts(db.sql, "testnet", [], post, NOW + 2_000)
    expect(sent.map((p) => `${p.status} ${p.at}`)).toEqual([`opened ${iso(NOW)}`, `resolved ${iso(NOW + 1_000)}`])
  })

  it("a run starts no post after its posting budget: the rest wait for the next run", async () => {
    const db = alertsDb()
    const { post, sent } = poster()
    const r = await syncAlerts(db.sql, "testnet", [STALE, LAG], post, NOW, { postBudgetMs: 0 })
    expect(r.opened).toHaveLength(2)
    expect(sent).toHaveLength(0)
    await syncAlerts(db.sql, "testnet", [STALE, LAG], post, NOW + 1_000)
    expect(sent.map((p) => p.kind)).toEqual(["oracle_stale", "indexer_lag"])
  })

  it("an opening another run claims first is not posted twice", async () => {
    const db = alertsDb()
    vi.spyOn(console, "error").mockImplementation(() => {})
    await syncAlerts(db.sql, "testnet", [STALE], async () => {
      throw new WebhookError("down")
    }, NOW)
    // An overlapping run claims the notice between this run's read of the pending notices and its own claim.
    const racing = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const rows = await db.sql(strings, ...values)
      if (strings.join("").includes("not opened_posted or")) for (const r of db.rows) r.opened_posted = true
      return rows
    }) as Sql
    const { post, sent } = poster()
    const r = await syncAlerts(racing, "testnet", [STALE], post, NOW + 1_000)
    expect(sent).toHaveLength(0)
    expect(r.posted).toBe(0)
    expect(r.postFailures).toBe(0)
  })
})

describe("webhookPayload", () => {
  const notice = (o: Partial<Parameters<typeof webhookPayload>[0]> = {}) => ({
    status: "opened" as const,
    kind: "oracle_stale",
    subject: ORACLE,
    severity: "critical" as const,
    network: "testnet" as const,
    at: iso(NOW),
    openedAt: iso(NOW),
    payload: STALE.payload,
    test: false,
    ...o,
  })

  it("is Slack- and Discord-compatible: text and content, plus the alert's fields", () => {
    const p = webhookPayload(notice())
    expect(p.text).toBe(p.content)
    expect(p.text).toMatch(/^\[Principal testnet\] Critical alert opened: Oracle stale/)
    expect(p.text).toContain("CDYG…YIPS")
    expect(p).toMatchObject({ kind: "oracle_stale", subject: ORACLE, severity: "critical", network: "testnet", at: iso(NOW), status: "opened", test: false })
    expect(p.details).toEqual(STALE.payload)
  })

  it("a close says resolved and since when it was open", () => {
    const p = webhookPayload(notice({ status: "resolved", at: iso(NOW + 600_000) }))
    expect(p.text).toMatch(/^\[Principal testnet\] Resolved: Oracle stale/)
    expect(p.text).toContain(`open since ${iso(NOW)}`)
  })

  it("every kind has words; an unknown kind is shown as it is", () => {
    for (const kind of ALERT_KINDS) {
      expect(alertTitle(kind)).not.toBe(kind)
      expect(alertTitle(kind)).not.toContain("_")
      expect(webhookPayload(notice({ kind })).text).toContain(alertTitle(kind))
    }
    expect(alertTitle("something_new")).toBe("something_new")
  })

  it("the test alert is clearly marked", () => {
    const p = webhookPayload(notice({ kind: "test", subject: "webhook", severity: "warning", test: true, payload: {} }))
    expect(p.text).toMatch(/^\[Principal testnet\] TEST alert/)
    expect(p.text).toContain("No action needed")
    expect(p.test).toBe(true)
  })

  it("the payload contains no secret-shaped string and no URL (the redact check)", () => {
    const p = webhookPayload(
      notice({
        kind: "oracle_unavailable",
        payload: { reason: `simulation failed at https://rpc.provider.example/key/abc for ${SECRET_SHAPED}`, nested: { list: [SECRET_SHAPED] } },
      }),
    )
    const body = JSON.stringify(p)
    expect(redact(body)).toBe(body)
    expect(body).not.toMatch(/S[A-Z2-7]{55}/)
    expect(body).not.toContain("rpc.provider.example")
    expect(body).not.toMatch(/https?:\/\//)
  })
})

describe("webhookPoster: one POST with a 5 s timeout", () => {
  it(`times out after ${WEBHOOK_TIMEOUT_MS} ms by default`, () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(5_000)
  })

  it("POSTs the payload as JSON with a timeout signal", async () => {
    const fetchImpl = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () => new Response("ok", { status: 200 }))
    const p = webhookPayload({ status: "opened", kind: "test", subject: "webhook", severity: "warning", network: "testnet", at: iso(NOW), openedAt: iso(NOW), payload: {}, test: true })
    await webhookPoster(HOOK, { fetchImpl: fetchImpl as unknown as typeof fetch })(p)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(HOOK)
    expect(init?.method).toBe("POST")
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
    expect(JSON.parse(String(init?.body))).toEqual(p)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it("a webhook that hangs is cut at the timeout, and the error names no URL", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    )
    const started = Date.now()
    const error = await webhookPoster(HOOK, { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 50 })({} as WebhookPayload).catch((e: unknown) => e)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(error).toBeInstanceOf(WebhookError)
    expect(String((error as Error).message)).toBe("the webhook did not answer within 50 ms")
    expect(String((error as Error).message)).not.toContain("hooks.example.test")
  })

  it("a non-2xx answer is an error with its status only", async () => {
    const fetchImpl = vi.fn(async () => new Response(`no such hook ${HOOK}`, { status: 404 }))
    const error = await webhookPoster(HOOK, { fetchImpl: fetchImpl as unknown as typeof fetch })({} as WebhookPayload).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WebhookError)
    expect((error as Error).message).toBe("the webhook answered 404")
  })

  it("a network error is reported by name, never by its text (it carries the host)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed ${HOOK}`)
    })
    const error = await webhookPoster(HOOK, { fetchImpl: fetchImpl as unknown as typeof fetch })({} as WebhookPayload).catch((e: unknown) => e)
    expect((error as Error).message).toBe("the webhook could not be reached (TypeError)")
  })
})

describe("sendTestAlert (?test=1, the alert-test evidence)", () => {
  it("posts a clearly marked test alert, stores it as a test and resolves it at once", async () => {
    const db = alertsDb()
    const { post, sent } = poster()
    const r = await sendTestAlert(db.sql, "testnet", post, NOW)
    expect(r).toEqual({ openedAt: iso(NOW), delivered: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: "test", test: true, status: "opened" })
    expect(sent[0].text).toMatch(/TEST/)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({ kind: "test", test: true, opened_at: new Date(NOW), resolved_at: new Date(NOW), opened_posted: true })
  })

  it("a failed post keeps the row, undelivered, and the regular check never re-posts a test", async () => {
    const db = alertsDb()
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await sendTestAlert(db.sql, "testnet", async () => {
      throw new WebhookError("the webhook answered 500")
    }, NOW)
    expect(r).toEqual({ openedAt: iso(NOW), delivered: false })
    expect(db.rows[0]).toMatchObject({ test: true, opened_posted: false })
    const { post, sent } = poster()
    await syncAlerts(db.sql, "testnet", [], post, NOW + 1_000)
    expect(sent).toHaveLength(0)
  })
})

describe("listAlerts and openAlertCounts (GET /api/dashboard/alerts, /api/health)", () => {
  it("open, the last 7 days of history including resolved ones, and the last test; tests are never alerts", async () => {
    const db = alertsDb()
    const { post } = poster()
    const DAY = 86_400_000
    await syncAlerts(db.sql, "testnet", [{ ...STALE, kind: "risk_exhausted", subject: RISK }], post, NOW - 10 * DAY)
    await syncAlerts(db.sql, "testnet", [], post, NOW - 8 * DAY) // closed 8 days ago: out of the history
    await syncAlerts(db.sql, "testnet", [{ kind: "risk_warning", subject: RISK, severity: "warning", payload: { percent: "91.0" } }], post, NOW - 3 * DAY)
    await syncAlerts(db.sql, "testnet", [], post, NOW - 2 * DAY)
    await syncAlerts(db.sql, "testnet", [STALE], post, NOW - 60_000)
    await sendTestAlert(db.sql, "testnet", post, NOW - 30_000)

    const answer = await listAlerts(db.sql, "testnet", NOW)
    expect(answer.open).toEqual([{ kind: "oracle_stale", subject: ORACLE, severity: "critical", openedAt: iso(NOW - 60_000), payload: STALE.payload }])
    expect(answer.recent).toEqual([
      { kind: "oracle_stale", subject: ORACLE, severity: "critical", openedAt: iso(NOW - 60_000), resolvedAt: null, payload: STALE.payload },
      { kind: "risk_warning", subject: RISK, severity: "warning", openedAt: iso(NOW - 3 * DAY), resolvedAt: iso(NOW - 2 * DAY), payload: { percent: "91.0" } },
    ])
    expect(answer.lastTest).toEqual({ openedAt: iso(NOW - 30_000), delivered: true })
    expect(await openAlertCounts(db.sql, "testnet")).toEqual({ count: 1, critical: 1 })
  })

  it("no test yet: lastTest is null", async () => {
    const db = alertsDb()
    expect((await listAlerts(db.sql, "testnet", NOW)).lastTest).toBeNull()
    expect(await openAlertCounts(db.sql, "testnet")).toEqual({ count: 0, critical: 0 })
  })
})

describe("the keeper signer and its floor", () => {
  // Throwaway keys made for this run: no secret-shaped string lives in the repository.
  const adminPair = Keypair.random()
  const keeperPair = Keypair.random()
  const ADMIN = adminPair.secret()
  const KEEPER = keeperPair.secret()

  it("is ORACLE_KEEPER_SECRET's public key when set, else ORACLE_ADMIN_SECRET's, else none", () => {
    const keeper = signerAccount({ ORACLE_KEEPER_SECRET: KEEPER, ORACLE_ADMIN_SECRET: ADMIN })
    const admin = signerAccount({ ORACLE_ADMIN_SECRET: ADMIN })
    expect(keeper).toEqual({ account: keeperPair.publicKey() })
    expect(admin).toEqual({ account: adminPair.publicKey() })
    expect(signerAccount({})).toBeNull()
    expect(signerAccount({ ORACLE_KEEPER_SECRET: "  " })).toBeNull()
  })

  it("an invalid key is an error naming the variable, never the value", () => {
    const r = signerAccount({ ORACLE_KEEPER_SECRET: "SNOTAKEY" })
    expect(r).toEqual({ error: "ORACLE_KEEPER_SECRET is not a valid secret key" })
    expect(JSON.stringify(r)).not.toContain("SNOTAKEY")
  })

  it("ALERT_SIGNER_MIN_XLM defaults to 20 XLM; decimals are exact; an invalid value falls back to 20", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(signerMinStroops({})).toBe(200_000_000n)
    expect(signerMinStroops({ ALERT_SIGNER_MIN_XLM: "5.5" })).toBe(55_000_000n)
    expect(signerMinStroops({ ALERT_SIGNER_MIN_XLM: "0" })).toBe(0n)
    expect(signerMinStroops({ ALERT_SIGNER_MIN_XLM: "lots" })).toBe(200_000_000n)
    expect(signerMinStroops({ ALERT_SIGNER_MIN_XLM: "-1" })).toBe(200_000_000n)
  })
})
