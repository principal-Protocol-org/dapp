"use client"

import type { ReactNode } from "react"
import { LabelWithTip, UnavailableTip } from "@/components/app/info-tip"
import { useManifest } from "@/components/app/manifest-provider"
import { Metric } from "@/components/app/market/metric"
import { Skeleton } from "@/components/ui/skeleton"
import { ALERTS_NOT_AVAILABLE, dashboardLiveMs, useOpenAlerts, usePausers, usePauses, useRiskView, type IndexedEvent } from "@/hooks/use-dashboard"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import type { RecentAlert } from "@/lib/app/alert-types"
import { EFFECTIVE_WRAP_AND_MINT_LABEL, riskWindowKind, type Remaining, type RiskView } from "@/lib/protocol/dashboard/risk"
import { contractLabel, type VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { explorerUrl } from "@/lib/protocol/explorer"
import { formatAmountFixed } from "@/lib/protocol/format"
import { unavailable } from "@/lib/protocol/reader"
import type { Live, Manifest, Network } from "@/lib/protocol/types"
import { AsOf, cadenceText, readsOf } from "./as-of"
import { CopyEvidence } from "./copy-evidence"
import { EventList, TxLink, type EventRowText } from "./event-list"
import { accountShort, closeTimeText, pausedWords } from "./event-words"
import { decimalsScale, verifiable, type FigureSpec } from "./figure"
import { Panel, Row } from "./panel"
import { current, readOf, refuse, Shown, unitsOf, type QueryLike } from "./query-figures"

/** The short row label of the effective capacity; `EFFECTIVE_WRAP_AND_MINT_LABEL` is its info tip. */
export const WRAP_AND_MINT = "Wrap-and-mint capacity"

/**
 * The effective wrap-and-mint capacity (D-10), or null when no market double-reports. It stays on the
 * page, Unavailable with the reason, after a failed refresh: the old value is never shown as current,
 * and the row does not vanish (it is dropped only when the last answer said no market double-reports).
 */
export function wrapAndMintSpec(
  risk: QueryLike<RiskView>,
  figure: Pick<FigureSpec<Remaining>, "format" | "scale" | "read">,
  refused: string | null,
): FigureSpec<Remaining> | null {
  const last = risk.data
  if (risk.stale) {
    if (last && last.effectiveWrapAndMint === null) return null
    return { label: WRAP_AND_MINT, ...figure, live: unavailable(`the last refresh failed: ${risk.error?.message ?? "unknown error"}`) }
  }
  if (!last || last.effectiveWrapAndMint === null) return null
  return { label: WRAP_AND_MINT, ...figure, live: refuse(last.effectiveWrapAndMint, refused) }
}

/** The wrap-and-mint row: the short label with the long one behind its tip, the figure, and why it is half the room left. */
export function WrapAndMintRow({ spec, doubleReporting }: { spec: FigureSpec<Remaining>; doubleReporting: readonly string[] }) {
  return (
    <Row
      label={
        <LabelWithTip
          label={WRAP_AND_MINT}
          tip={`${EFFECTIVE_WRAP_AND_MINT_LABEL}: the remaining capacity ÷ 2. Each market's is_consumer reads, for its SY and its manager, decide it.`}
        />
      }
    >
      <Shown {...spec} />
      {spec.live?.status === "live" ? (
        <span className="mt-1 block font-sans text-xs/5 text-ink-muted">
          Half the room left: in a market whose SY and manager both report to RiskControl, the SY deposit and the manager mint each count the same
          underlying, so one wrap-and-mint uses the room twice.
          {doubleReporting.length > 0 ? ` Markets: ${doubleReporting.join(", ")}.` : ""}
        </span>
      ) : null}
    </Row>
  )
}

function AccountLink({ network, id }: { network: Network; id: string }) {
  const url = explorerUrl(network, id.startsWith("C") ? "contract" : "account", id)
  if (!url)
    return (
      <span title={id} className="font-mono">
        {accountShort(id)}
      </span>
    )
  return (
    <a href={url} target="_blank" rel="noreferrer" title={id} className="font-mono underline decoration-line-strong underline-offset-4 hover:decoration-ink">
      {accountShort(id)}
    </a>
  )
}

/** An asset id as its code when a market holds it ("USDY"), else short. */
const assetName = (m: Manifest, asset: string) => m.markets.find((x) => x.underlying.sac === asset)?.underlying.code ?? accountShort(asset)

const ledgers = (n: number) => `${n.toLocaleString("en-US")} ledgers`

/** How each kind of window is worded: the volume's label and what the Window panel says under its title. */
const WINDOW_TEXT = {
  fixed: {
    volume: "Volume in this window",
    meta: "The stored start does not reset by itself: once ledger − start reaches the length, the next counted deposit opens a new window, and the contract reports a volume of 0 until then.",
  },
  sliding: {
    volume: "Volume counted now",
    meta: "The counted volume decays as older deposits leave the window, so room frees up gradually. The window never lapses or resets.",
  },
} as const

const RISK_ALERTS: Record<string, string> = {
  risk_warning: "Warning: volume at 90% or more of the limit",
  risk_exhausted: "Exhausted: volume at or above the limit",
}

/** Which limit a risk alert is about: the protocol-wide window, or one asset's (its subject is `asset:<SAC>`). */
function limitName(m: Manifest, a: RecentAlert): string {
  if (a.payload.scope === "asset" || a.subject.startsWith("asset:")) {
    const asset = typeof a.payload.asset === "string" ? a.payload.asset : a.subject.slice("asset:".length)
    return `${assetName(m, asset)} asset limit`
  }
  return "Protocol-wide limit"
}

/** The exhaustion history (D-12): the alert check's `risk_warning` and `risk_exhausted` alerts, open and closed. */
function ExhaustionHistory() {
  const m = useManifest()
  const q = useOpenAlerts()
  let body: ReactNode
  if (q.isError && q.error?.message === ALERTS_NOT_AVAILABLE) body = <p className="text-sm text-ink-muted">No alert data yet</p>
  else if (q.isError) body = <UnavailableTip label="Exhaustion history" reason={q.error?.message ?? "the alerts could not be read"} className="text-sm text-ink" />
  else if (!q.data) body = <Skeleton className="h-16 w-full" />
  else {
    const all: RecentAlert[] = [...q.data.open.map((a) => ({ ...a, resolvedAt: null })), ...(q.data.recent ?? [])]
    const seen = new Set<string>()
    const risk = all
      .filter((a) => a.kind in RISK_ALERTS)
      .filter((a) => {
        const key = `${a.kind}|${a.subject}|${a.openedAt}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => (a.openedAt < b.openedAt ? 1 : a.openedAt > b.openedAt ? -1 : 0))
    body = (
      <>
        {risk.length === 0 ? (
          <p className="text-sm text-ink-muted">No exhaustion in the last 7 days</p>
        ) : (
          <ul className="grid gap-3">
            {risk.map((a) => (
              <li key={`${a.kind}-${a.subject}-${a.openedAt}`} className="grid gap-0.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
                <span className="text-sm text-ink">{RISK_ALERTS[a.kind]}</span>
                <span className="text-xs/5 text-ink-muted">{limitName(m, a)}</span>
                <span className="flex flex-wrap gap-x-2 font-mono text-xs/5 text-ink-muted">
                  <span>Opened</span>
                  <span>{closeTimeText(a.openedAt)}</span>
                  <span aria-hidden="true">·</span>
                  {a.resolvedAt ? (
                    <>
                      <span>Closed</span>
                      <span>{closeTimeText(a.resolvedAt)}</span>
                    </>
                  ) : (
                    <span className="font-semibold text-negative">Open</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {q.data.recent === undefined ? <p className="text-xs/5 text-ink-muted">Only open alerts are listed: this server does not list closed ones yet.</p> : null}
      </>
    )
  }
  return (
    <Panel
      title="Exhaustion history"
      meta={
        <p className="text-xs/5 text-ink-muted">
          A trip rolls its transaction back, so it leaves no event. This history comes from the alert check and covers the last 7 days: a warning opens at 90%
          of the limit, exhausted at 100%, and each closes when the volume falls back. Refreshes every 1 min.
        </p>
      }
    >
      {body}
    </Panel>
  )
}

/**
 * The public risk page (`/dashboard/risk`): RiskControl's circuit breaker (limit, volume, raw and
 * effective remaining capacity, D-10), its window (D-11), the per-asset limits, every contract's
 * pause, the pausers (indexed, each confirmed live), the limit-change and pause history (indexed) and
 * the exhaustion history (alerts, D-12). No wallet is read; every figure has its How-to-verify drawer.
 */
export function RiskPanel() {
  const m = useManifest()
  const { sequence, isError: clockFailed } = useLedgerClock()
  const risk = useRiskView()
  const pauses = usePauses()
  const pausers = usePausers()

  const noClock = clockFailed && sequence === null ? "the ledger could not be read" : undefined
  const units = unitsOf(m)
  const refused = "refused" in units ? units.refused : null
  const amount = (v: bigint) => ("refused" in units ? String(v) : `${formatAmountFixed(v, units.decimals)} ${units.code ?? "(underlying units)"}`)
  const scale = "refused" in units ? undefined : decimalsScale(units.decimals, units.code ?? "underlying unit")
  const liveMs = dashboardLiveMs(m.network)
  const read = readOf(risk, liveMs)
  const remainingText = (left: Remaining) => (left === null ? "No limit (disabled)" : amount(left))
  const pick = <T,>(f: (r: RiskView) => Live<T>) => current(risk, f, noClock)
  // The contract version decides the window; the manifest says it before the first read.
  const windowKind = risk.data?.window.kind ?? riskWindowKind(m)
  const windowText = WINDOW_TEXT[windowKind]

  const limit: FigureSpec<bigint> = { label: "Circuit-breaker limit", live: refuse(pick((r) => r.limit), refused), format: (v) => (v === 0n ? "No limit (disabled)" : amount(v)), scale, read }
  const volume: FigureSpec<bigint> = { label: windowText.volume, live: refuse(pick((r) => r.volume), refused), format: amount, scale, read }
  const remaining: FigureSpec<Remaining> = { label: "Remaining capacity (raw)", live: refuse(pick((r) => r.remaining), refused), format: remainingText, scale, read }
  const wrapAndMint = wrapAndMintSpec(risk, { format: remainingText, scale, read }, refused)

  const riskData = risk.stale ? undefined : risk.data
  const windowStart: FigureSpec<number> = { label: "Window start", live: pick((r) => r.window.start), format: (v) => `Ledger ${v}`, read }
  const windowLength: FigureSpec<number> = { label: "Window length", live: pick((r) => r.window.length), format: ledgers, read }
  const start = riskData?.window.start
  const length = riskData?.window.length
  const windowEnd = start?.status === "live" && length?.status === "live" ? start.value + length.value - 1 : null
  // A sliding window (version 2) never lapses and has no end: its state is its length, read with its drawer.
  const windowState: FigureSpec<boolean> | FigureSpec<number> =
    windowKind === "sliding"
      ? {
          label: "Window state",
          live: pick((r) => r.window.length),
          format: (n: number) => `Sliding window of ${ledgers(n)}: used volume decays as older deposits leave it`,
          read,
        }
      : {
          label: "Window state",
          live: pick((r) => (r.window.kind === "fixed" ? r.window.lapsed : unavailable("this window has no lapsed state"))),
          format: (lapsed: boolean) => (lapsed ? "Lapsed: the next counted deposit opens a new window" : windowEnd !== null ? `Open through ledger ${windowEnd}` : "Open"),
          read,
        }

  const assets = (riskData?.assetLimits ?? []).map((a) => {
    const name = assetName(m, a.asset)
    return {
      asset: a.asset,
      name,
      limit: { label: `${name} asset limit`, live: refuse(a.limit, refused), format: (v: bigint) => (v === 0n ? "No limit (disabled)" : amount(v)), scale, read } as FigureSpec<bigint>,
      volume: { label: `${name} asset volume`, live: refuse(a.volume, refused), format: amount, scale, read } as FigureSpec<bigint>,
      remaining: { label: `${name} asset remaining`, live: refuse(a.remaining, refused), format: remainingText, scale, read } as FigureSpec<Remaining>,
    }
  })

  const pauseRead = readOf(pauses, liveMs)
  const pauseFigures: FigureSpec<boolean>[] = (pauses.data?.contracts ?? []).map((c) => ({
    label: `${c.label} pause`,
    live: pauses.stale ? unavailable(`the last refresh failed: ${pauses.error?.message ?? "unknown error"}`) : c.paused,
    format: (p) => (p ? "Paused" : "Not paused"),
    read: pauseRead,
  }))

  const pauserLive = pausers.live.stale ? undefined : pausers.live.data
  const pauserRead = readOf(pausers.live, liveMs)
  const pauserFailed = pausers.live.stale ? unavailable(`the last refresh failed: ${pausers.live.error?.message ?? "unknown error"}`) : undefined
  const admin: FigureSpec<string> = { label: "RiskControl admin", live: pauserFailed ?? pauserLive?.admin, format: (v) => v, read: pauserRead }
  const adminIsPauser: FigureSpec<boolean> = {
    label: "Admin is a pauser",
    live: pauserFailed ?? pauserLive?.adminIsPauser,
    format: (v) => (v ? "is_pauser reads true" : "is_pauser reads false"),
    read: pauserRead,
  }
  const pauserFigures = pausers.indexed.map((p) => ({
    ...p,
    spec: {
      label: `Pauser ${p.account}`,
      live: pauserFailed ?? pauserLive?.pausers.find((x) => x.account === p.account)?.isPauser,
      format: (v: boolean) => (v ? "Pauser" : "Not a pauser: the index may be behind"),
      read: pauserRead,
    } as FigureSpec<boolean>,
  }))

  const limitNow: FigureSpec<bigint> = { ...limit, label: "Circuit-breaker limit (now)" }
  const lengthNow: FigureSpec<number> = { ...windowLength, label: "Window length (now)" }
  const assetsNow = assets.map((a) => ({ ...a.limit, label: `${a.name} asset limit (now)` }))

  const all = [
    limit,
    volume,
    remaining,
    ...(wrapAndMint ? [wrapAndMint] : []),
    windowStart,
    windowLength,
    windowState,
    ...assets.flatMap((a) => [a.limit, a.volume, a.remaining]),
    ...pauseFigures,
    admin,
    adminIsPauser,
    ...pauserFigures.map((p) => p.spec),
  ] as FigureSpec<unknown>[]
  const figures = all.map(verifiable).filter((f): f is VerifiableFigure => f !== null)
  const newestUpdate = Math.max(0, ...[risk, pauses, pausers.live].map((q) => (q.stale ? 0 : q.dataUpdatedAt)))

  const describeLimit = (r: IndexedEvent): EventRowText => {
    const by = typeof r.data.caller === "string" ? <span title={r.data.caller}>by {accountShort(r.data.caller)}</span> : undefined
    const value = (raw: unknown) => {
      if (typeof raw !== "string" && typeof raw !== "number") return "an unreadable value"
      let v: bigint
      try {
        v = BigInt(raw)
      } catch {
        // Not an integer: shown as stored, never thrown or guessed.
        return `${raw} (raw value)`
      }
      return v === 0n ? "0 (disabled)" : amount(v)
    }
    if (r.topic === "cb_limit") return { title: `Circuit-breaker limit set to ${value(r.data.limit)}`, detail: by }
    if (r.topic === "ast_limit")
      return { title: `${typeof r.data.asset === "string" ? assetName(m, r.data.asset) : "Asset"} asset limit set to ${value(r.data.limit)}`, detail: by }
    if (r.topic === "cb_window")
      return { title: `Window length set to ${typeof r.data.ledgers === "number" ? ledgers(r.data.ledgers) : String(r.data.ledgers)}`, detail: by }
    return { title: r.topic, detail: by }
  }
  const describePause = (r: IndexedEvent): EventRowText => {
    const by = typeof r.data.caller === "string" ? <span title={r.data.caller}>by {accountShort(r.data.caller)}</span> : undefined
    if (r.topic === "paused") {
      const state = pausedWords(r.data)
      const label = contractLabel(m, r.contractId)
      // Only a decoded boolean says paused or unpaused (no guess).
      return { title: state === "Pause state not decoded" ? `${label}: pause state not decoded` : `${label} ${state.toLowerCase()}`, detail: by }
    }
    const who = typeof r.data.pauser === "string" ? accountShort(r.data.pauser) : "an account"
    return { title: r.topic === "add_psr" ? `Pauser added: ${who}` : `Pauser removed: ${who}`, detail: by }
  }

  return (
    <section aria-labelledby="risk-heading" className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <div className="grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 id="risk-heading" className="font-serif text-3xl text-ink">
              Risk
            </h1>
            <p className="mt-2 max-w-[68ch] text-ink-muted">
              RiskControl&apos;s circuit breaker, its window and per-asset limits, every contract&apos;s pause and who may pause, read live. Their history
              comes from the event index. No wallet is needed.
            </p>
          </div>
          <CopyEvidence figures={figures} />
        </div>
        <AsOf sources={readsOf(all.map((f) => f.live))} updatedAt={newestUpdate || null} cadenceMs={liveMs} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 min-[900px]:grid-cols-2">
        <Panel title="Circuit breaker" meta={<p className="text-xs/5 text-ink-muted">RiskControl {accountShort(m.shared.riskControl)}, protocol-wide · refreshes every {cadenceText(liveMs)}</p>}>
          <dl className="grid gap-3">
            <Row label="Limit">
              <Shown {...limit} />
            </Row>
            <Row label={windowText.volume}>
              <Shown {...volume} />
            </Row>
            <Row label="Remaining capacity (raw)">
              <Shown {...remaining} />
            </Row>
            {wrapAndMint ? <WrapAndMintRow spec={wrapAndMint} doubleReporting={risk.data?.doubleReporting ?? []} /> : null}
          </dl>
        </Panel>

        <Panel
          title="Window"
          meta={<p className="text-xs/5 text-ink-muted">{windowText.meta}</p>}
        >
          <dl className="grid gap-3">
            <Row label="Window start">
              <Shown {...windowStart} />
            </Row>
            <Row label="Window length">
              <Shown {...windowLength} />
            </Row>
            <Row label="State">
              <Shown {...(windowState as FigureSpec<unknown>)} />
            </Row>
          </dl>
        </Panel>

        <Panel title="Per-asset limits" meta={<p className="text-xs/5 text-ink-muted">One limit per underlying asset, in the same window</p>}>
          {risk.stale || (noClock && !riskData) ? (
            <UnavailableTip
              label="Per-asset limits"
              reason={risk.stale ? `the last refresh failed: ${risk.error?.message ?? "unknown error"}` : (noClock as string)}
              className="text-sm text-ink"
            />
          ) : !riskData ? (
            <Skeleton className="h-16 w-full" />
          ) : assets.length === 0 ? (
            <p className="text-sm text-ink-muted">No market lists an asset yet.</p>
          ) : (
            assets.map((a) => (
              <dl key={a.asset} className="grid gap-3">
                <Row label={`${a.name} limit`}>
                  <Shown {...a.limit} />
                </Row>
                <Row label={`${a.name} volume`}>
                  <Shown {...a.volume} />
                </Row>
                <Row label={`${a.name} remaining`}>
                  <Shown {...a.remaining} />
                </Row>
              </dl>
            ))
          )}
        </Panel>

        <Panel title="Pauses" meta={<p className="text-xs/5 text-ink-muted">RiskControl, and each market&apos;s SY wrapper, manager and pool · refreshes every {cadenceText(liveMs)}</p>}>
          {pauses.data === undefined ? (
            pauses.isError ? (
              <UnavailableTip label="Pauses" reason={pauses.error?.message ?? "the pauses could not be read"} className="text-sm text-ink" />
            ) : (
              <Skeleton className="h-24 w-full" />
            )
          ) : (
            <dl className="grid gap-3">
              {pauseFigures.map((f, i) => (
                <Row key={`${pauses.data?.contracts[i].contractId}-${i}`} label={pauses.data?.contracts[i].label}>
                  <Shown {...f} />
                </Row>
              ))}
            </dl>
          )}
        </Panel>

        <Panel title="Pausers" meta={<p className="text-xs/5 text-ink-muted">From the event index, each confirmed live with is_pauser.</p>}>
          <dl className="grid gap-3">
            <Row label="Admin (a pauser by the contract's rule)">
              <Shown {...admin} render={(v) => <AccountLink network={m.network} id={v} />} />
              <span className="mt-1 block">
                <Shown {...adminIsPauser} className="text-xs" />
              </span>
            </Row>
            {pausers.events.isError ? (
              <Row label="Indexed pausers">
                <UnavailableTip label="Indexed pausers" reason={pausers.events.error?.message ?? "the event index could not be read"} />
              </Row>
            ) : !pausers.events.data ? (
              <Row label="Indexed pausers">
                <Skeleton className="h-5 w-40 max-w-full" />
              </Row>
            ) : pauserFigures.length === 0 ? (
              <Row label="Indexed pausers">
                <span className="font-sans text-ink-muted">No pauser indexed yet</span>
              </Row>
            ) : (
              pauserFigures.map((p) => (
                <Row key={p.account} label={<AccountLink network={m.network} id={p.account} />}>
                  <Shown {...p.spec} />
                  <span className="mt-1 flex flex-wrap gap-x-2 font-mono text-xs/5 text-ink-muted">
                    <span className="whitespace-nowrap">Added at ledger {p.added.ledger}</span>
                    <TxLink network={m.network} hash={p.added.txHash} />
                  </span>
                </Row>
              ))
            )}
          </dl>
        </Panel>

        <ExhaustionHistory />

        <Panel
          title="Limit changes"
          meta={<p className="text-xs/5 text-ink-muted">The values now, read live, then every indexed cb_limit, ast_limit and cb_window, newest first</p>}
          className="min-[900px]:col-span-2"
        >
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 min-[420px]:grid-cols-3">
            <Metric label="Limit now" valueClassName="min-w-0 text-sm wrap-anywhere">
              <Shown {...limitNow} />
            </Metric>
            <Metric label="Window length now" valueClassName="min-w-0 text-sm wrap-anywhere">
              <Shown {...lengthNow} />
            </Metric>
            {assetsNow.map((f) => (
              <Metric key={f.label} label={f.label.replace(" (now)", " now")} valueClassName="min-w-0 text-sm wrap-anywhere">
                <Shown {...f} />
              </Metric>
            ))}
          </dl>
          <EventList label="Limit changes" group="risk" topics={LIMIT_TOPICS} describe={describeLimit} empty="No limit change indexed yet" />
        </Panel>

        <Panel
          title="Pause history"
          meta={<p className="text-xs/5 text-ink-muted">Every indexed pause and unpause (RiskControl, SY, manager, pool) and pauser change</p>}
          className="min-[900px]:col-span-2"
        >
          <EventList label="Pause history" topics={PAUSE_TOPICS} describe={describePause} empty="No pause recorded yet" />
        </Panel>

      </div>
    </section>
  )
}

const LIMIT_TOPICS = ["cb_limit", "ast_limit", "cb_window"] as const
const PAUSE_TOPICS = ["paused", "add_psr", "rm_psr"] as const
