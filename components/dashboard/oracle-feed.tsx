"use client"

import type { FeedPrice, OracleFeed, OracleView, Sep40Asset } from "@/lib/protocol/dashboard/oracle"
import { mapLive, onlyRead, storedAgainstFeedLive, type OracleViewAt } from "@/lib/protocol/dashboard/oracle-state"
import type { VerifiableFigure } from "@/lib/protocol/dashboard/verify"
import { explorerUrl } from "@/lib/protocol/explorer"
import { unavailable } from "@/lib/protocol/reader"
import type { Live, Network } from "@/lib/protocol/types"
import { accountShort } from "./event-words"
import type { FigureSpec } from "./figure"
import { LINK, ORACLE_SCALE, oracleValue, PATH_UNSUPPORTED, timestampText, unsupportedFigure, UnsupportedRow } from "./oracle-shared"
import { Panel, Row } from "./panel"
import { current, Shown, type QueryLike } from "./query-figures"

/** The Feed card when `feed_source()` is None. */
export const NO_FEED_SOURCE = "No feed source set: updated by push only."

const COMPARISON_SCALE =
  "get_reference_value against the feed's lastprice at 7 decimals, in integer math: Equal; below a factor of 2, the difference as a percent of the smaller value, rounded down to 0.01 %; from a factor of 2, the larger over the smaller, to the nearest 0.1"

const assetKey = (a: Sep40Asset) => (a.kind === "Stellar" ? `Stellar ${accountShort(a.address)}` : `Other ${a.symbol}`)

/**
 * Which rows the card has, from `feed_source()`: none yet (loading); the code has no feed
 * (unsupported); no feed source set (none); a feed, or not known (a failed refresh, no ledger clock,
 * an unreadable `feed_source`): every row, each Unavailable with its reason when not read.
 */
export type FeedState = "loading" | "unsupported" | "none" | "set"

/** The Feed card's figures (3af9388): what it shows, and what the page's evidence table lists. */
export type FeedFigures = {
  state: FeedState
  source: FigureSpec<OracleFeed | null>
  asset: FigureSpec<Sep40Asset | null>
  minInterval: FigureSpec<bigint>
  price: FigureSpec<FeedPrice>
  age: FigureSpec<bigint>
  comparison: FigureSpec<string>
  /** `feed_source` on code that lacks it: "Not supported", with the call that shows it. */
  unsupported: VerifiableFigure | null
  /** The figures the card shows, in order, for the evidence table and the as-of line. */
  specs: FigureSpec<unknown>[]
}

/** The selected oracle's feed figures, from its query (`read`: its reads' time; `blocked`: why nothing could be read). */
export function feedFigures(q: QueryLike<OracleViewAt>, read: FigureSpec<unknown>["read"], nowSeconds: number | null, blocked?: string): FeedFigures {
  const view = q.stale ? undefined : q.data?.view
  const pick = <T,>(f: (v: OracleView) => Live<T>) => current(q, (d) => f(d.view), blocked)
  const feedRead = view?.feed
  const state: FeedState =
    q.stale || (!view && blocked)
      ? "set"
      : !view || !feedRead
        ? "loading"
        : feedRead.status === "unsupported"
          ? "unsupported"
          : feedRead.status === "live" && feedRead.value === null
            ? "none"
            : "set"
  const feedLive = (v: OracleView): Live<OracleFeed | null> => (v.feed.status === "unsupported" ? unavailable(PATH_UNSUPPORTED, v.feed.source) : v.feed)
  const priceLive = (v: OracleView): Live<FeedPrice> => v.feedPrice ?? unavailable("no feed source is set")
  const source: FigureSpec<OracleFeed | null> = {
    label: state === "none" ? "Feed source" : "Feed contract",
    live: pick(feedLive),
    format: (f) => (f === null ? NO_FEED_SOURCE : f.contract),
    scale: "feed_source(): the SEP-40 price feed this oracle reads and the asset it asks for; None until set_feed_source",
    read,
  }
  const asset: FigureSpec<Sep40Asset | null> = {
    label: "Asset key",
    live: pick((v) => mapLive(feedLive(v), (f) => f?.asset ?? null)),
    format: (a) => (a === null ? NO_FEED_SOURCE : assetKey(a)),
    scale: "Sep40Asset, the key the oracle passes to the feed's lastprice: Stellar(address) or Other(symbol)",
    read,
  }
  const minInterval: FigureSpec<bigint> = {
    label: "Minimum interval between feed updates",
    live: pick((v) =>
      v.feedMinInterval.status === "unsupported"
        ? unavailable(`${PATH_UNSUPPORTED}: feed_min_interval_seconds answers HostError: Error(WasmVm, MissingValue)`, v.feedMinInterval.source)
        : v.feedMinInterval,
    ),
    format: (s) => (s === 0n ? "No minimum" : `${s.toLocaleString("en-US")} s`),
    scale: "Seconds: sync_from_feed refuses (throttle) a feed update sooner than this after the last accepted one; 300 unless set",
    read,
  }
  const price: FigureSpec<FeedPrice> = {
    label: "Feed price",
    live: pick(priceLive),
    format: (p) => oracleValue(p.value),
    scale: `The feed's lastprice in its own decimals (decimals()), rescaled to 7 as the oracle does, truncated: ${ORACLE_SCALE}`,
    read,
  }
  const age: FigureSpec<bigint> = {
    label: "Feed tick age",
    live: pick((v) => onlyRead(mapLive(priceLive(v), (p) => p.timestamp), "lastprice")),
    format: (ts) => timestampText(ts, nowSeconds),
    scale: "Unix seconds (UTC): the timestamp of the feed's lastprice; its age is ledger time − that timestamp",
    read,
  }
  const comparison: FigureSpec<string> = {
    label: "Stored value against feed",
    live: pick((v) => storedAgainstFeedLive(v.value, priceLive(v))),
    format: (text) => text,
    scale: COMPARISON_SCALE,
    read,
  }
  const unsupported = !q.stale && feedRead?.status === "unsupported" ? unsupportedFigure("Feed source", "feed_source", feedRead.source, read) : null
  const specs = (state === "set" ? [source, asset, minInterval, price, age, comparison] : state === "none" ? [source] : []) as FigureSpec<unknown>[]
  return { state, source, asset, minInterval, price, age, comparison, unsupported, specs }
}

/** A contract outside the manifest (a feed): its short id, linking to stellar.expert when the network has it. */
function ContractLink({ network, label, id }: { network: Network; label: string; id: string }) {
  const url = explorerUrl(network, "contract", id)
  if (!url) return <span title={id}>{accountShort(id)}</span>
  return (
    <a href={url} target="_blank" rel="noreferrer" title={id} aria-label={`${label} ${id} on stellar.expert`} className={LINK}>
      {accountShort(id)}
    </a>
  )
}

/**
 * The Feed card: the SEP-40 feed the selected oracle reads (`feed_source()`), its minimum interval,
 * the feed's price and its age, and the stored value against it. Every figure has its drawer. On
 * code without the feed views it says so, with the call that shows it; with no feed source set, it
 * says the oracle is updated by push only.
 */
export function FeedPanel({ network, feed }: { network: Network; feed: FeedFigures }) {
  return (
    <Panel
      title="Feed"
      meta={
        <p className="text-xs/5 text-ink-muted">
          feed_source(): the SEP-40 price feed this oracle reads with sync_from_feed, when its code supports one and one is set, and that feed&apos;s latest
          price beside the stored value
        </p>
      }
    >
      <dl className="grid gap-3">
        {feed.state === "loading" ? (
          <Row label="Feed contract">
            <Shown {...feed.source} />
          </Row>
        ) : feed.state === "unsupported" && feed.unsupported ? (
          <UnsupportedRow label="Feed source" figure={feed.unsupported} />
        ) : feed.state === "none" ? (
          <Row label="Feed source">
            <Shown {...feed.source} className="font-sans" />
          </Row>
        ) : (
          <>
            <Row label="Feed contract">
              <Shown {...feed.source} render={(f, display) => (f === null ? display : <ContractLink network={network} label="Feed contract" id={f.contract} />)} />
            </Row>
            <Row label="Asset key">
              <Shown {...feed.asset} render={(a, display) => (a?.kind === "Stellar" ? <span title={a.address}>{display}</span> : display)} />
            </Row>
            <Row label="Minimum interval between feed updates">
              <Shown {...feed.minInterval} />
            </Row>
            <Row label="Feed price">
              <Shown {...feed.price} />
            </Row>
            <Row label="Feed tick age">
              <Shown {...feed.age} />
            </Row>
            <Row label="Stored value against feed">
              <Shown {...feed.comparison} className="font-sans" />
            </Row>
          </>
        )}
      </dl>
      {feed.state === "unsupported" ? (
        <p className="text-xs/5 text-ink-muted">This oracle&apos;s code has no feed_source view: the read answers HostError: Error(WasmVm, MissingValue).</p>
      ) : null}
    </Panel>
  )
}
