"use client"

import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useAccountState } from "@/hooks/use-account-state"
import { useMarketCompliance } from "@/hooks/use-market-compliance"
import { useWallet } from "@/hooks/use-wallet"
import { noticeForError, type TxNotice } from "@/lib/app/tx-notice"
import { evaluateAccountCompliance, type ComplianceItem, type MarketCompliance } from "@/lib/protocol/compliance"
import { explorerUrl } from "@/lib/protocol/explorer"
import { shorten } from "@/lib/protocol/format"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import { addTrustline, onboardingAvailable } from "@/lib/protocol/onboarding"
import type { Live, Network } from "@/lib/protocol/types"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { showTxToast, TxNoticeView } from "@/components/app/actions/tx-feedback"
import { UNAVAILABLE } from "@/components/app/live"
import { AccessRequest } from "@/components/app/market/access-request"
import { complianceIssues } from "@/components/app/market/attention"

/**
 * Each fix in words. `friendbot` and `onboarding` come only where Get test tokens exists (Testnet, a
 * local network), and `fund` and `access` only where it does not (Mainnet): the items and
 * `onboardingAvailable` read the same network.
 */
const FIX_TEXT: Record<NonNullable<ComplianceItem["fix"]>, string> = {
  friendbot: "Fund the account with Friendbot, then reload.",
  fund: "Send XLM to this account from an exchange or another wallet, then reload.",
  trustline: "Add a trustline to the underlying asset in your wallet.",
  onboarding: "Get test tokens.",
  access: "Request access below.",
  issuer: "Contact the issuer of the underlying asset.",
}

const STATUS_TEXT: Record<ComplianceItem["status"], string> = {
  ok: "OK",
  missing: "Action needed",
  blocked: "Blocked",
  unavailable: "Unavailable",
}

function yesNo(v: boolean) {
  return v ? "Yes" : "No"
}

function MarketModel({ compliance }: { compliance: Live<MarketCompliance> | undefined }) {
  if (!compliance) return <Skeleton className="h-16 w-full" />
  if (compliance.status === "unavailable") {
    return <p className="wrap-anywhere">{UNAVAILABLE}: the underlying asset&apos;s compliance model could not be read ({compliance.error}).</p>
  }
  const c = compliance.value
  if (c.kind === "sep57") {
    return (
      <div className="grid gap-1">
        <p>The underlying is a SEP-57 token. It has no issuer flags (authorization required, revocable, clawback) and no administrator address: the issuer acts through a role.</p>
      </div>
    )
  }
  return (
    <dl className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2">
      <div>
        <dt className="label">Authorization required</dt>
        <dd className="font-mono text-sm">{yesNo(c.authRequired)}</dd>
      </div>
      <div>
        <dt className="label">Authorization revocable</dt>
        <dd className="font-mono text-sm">{yesNo(c.authRevocable)}</dd>
      </div>
      <div>
        <dt className="label">Clawback enabled</dt>
        <dd className="font-mono text-sm">{yesNo(c.clawbackEnabled)}</dd>
      </div>
      <div>
        <dt className="label">Administrator</dt>
        <dd className="font-mono text-sm break-all" title={c.administrator}>
          {shorten(c.administrator, 8, 8)}
        </dd>
      </div>
    </dl>
  )
}

/** The compliance items for the connected account on this market; null until they can be read fresh. */
export function useComplianceItems(marketId: string) {
  const { network } = useManifest()
  const { state } = useWallet()
  const compliance = useMarketCompliance(marketId)
  const account = useAccountState(marketId)
  const marketCompliance = compliance.data
  const kind = marketCompliance?.status === "live" ? marketCompliance.value.kind : null
  const kindError = marketCompliance?.status === "unavailable" ? marketCompliance.error : undefined
  const items = account.data && !account.stale ? evaluateAccountCompliance(account.data, kind, kindError, network) : null
  const address = state.status === "connected" ? state.publicKey : null
  return { connected: address !== null, address, marketCompliance, account, items }
}

/** How many compliance items are not OK for the connected account; undefined when not known. */
export function useComplianceIssues(marketId: string): number | undefined {
  const { connected, items } = useComplianceItems(marketId)
  return complianceIssues(connected, items)
}

type TrustlineRun = { phase: "idle" } | { phase: "running" } | { phase: "sent" } | { phase: "failed"; notice: TxNotice }

/**
 * A failed trustline, as the transaction notices say it. Refused by the network: "not accepted",
 * with its hash. Anything else may have stopped before or after sending (`addTrustline` then names
 * the hash to look up), so "not sent" is not claimed.
 */
function trustlineNotice(error: unknown, network: Network): TxNotice {
  const notice = noticeForError("The trustline", error, network)
  return notice.hash ? notice : { ...notice, title: "Adding the trustline did not finish." }
}

/**
 * Add trustline: the one step a user signs on every network. It trusts this market's underlying
 * for the connected address, signed in the wallet (the `changeTrust` alone, checked before it is
 * sent), then refreshes the account reads so the item turns OK.
 */
function AddTrustline({ marketId, address }: { marketId: string; address: string }) {
  const m = useManifest()
  const { sign } = useWallet()
  const queryClient = useQueryClient()
  const [run, setRun] = useState<TrustlineRun>({ phase: "idle" })
  // A double click must not sign twice: state updates land too late to disable the button.
  const busy = useRef(false)
  const asset = getMarket(m, marketId)?.underlying
  if (!asset) return null

  async function add(underlying: { code: string; issuer: string }) {
    if (busy.current) return
    busy.current = true
    setRun({ phase: "running" })
    try {
      const { hash } = await addTrustline({ manifest: m, account: address, asset: underlying, sign: (xdr) => sign(xdr, address) })
      showTxToast({ tone: "success", title: "Trustline added.", hash, url: explorerUrl(m.network, "tx", hash) })
      // Sent and confirmed: the button gives way to the done line, so it is not offered again while the reads catch up.
      setRun({ phase: "sent" })
    } catch (error) {
      setRun({ phase: "failed", notice: trustlineNotice(error, m.network) })
    } finally {
      busy.current = false
    }
    // Done-ness comes from the chain, also after a failure that may have landed.
    try {
      await queryClient.invalidateQueries({ queryKey: ["account", m.network] })
    } catch {
      // A failed refetch shows as unavailable in the reads themselves.
    }
  }

  const running = run.phase === "running"
  return (
    <div className="grid gap-2">
      {run.phase === "sent" ? (
        <p role="status" className="text-ink-muted">
          Trustline added. Your account checks update within a few seconds.
        </p>
      ) : (
        <Button type="button" variant="secondary" className="w-fit" onClick={() => void add(asset)} disabled={running} aria-busy={running}>
          {running ? "Adding trustline…" : "Add trustline"}
        </Button>
      )}
      {run.phase === "failed" ? <TxNoticeView notice={run.notice} /> : null}
    </div>
  )
}

/**
 * The compliance body: the underlying asset's model and the account's items, with the fix for each
 * ("onboarding" opens the Get test tokens dialog). Where Get test tokens does not exist (Mainnet), a
 * missing trustline has its Add trustline button and the access request sits under the items
 * (spec 0005: the trustline button is Mainnet-only; on Testnet, Get test tokens adds the trustline).
 */
export function ComplianceContent({
  marketId,
  onGetTestTokens,
}: {
  marketId: string
  onGetTestTokens: () => void
}) {
  const { connected, address, marketCompliance, account, items } = useComplianceItems(marketId)
  const testTokens = onboardingAvailable(useManifest())

  return (
    <div className="grid gap-5 text-sm text-ink">
      <section aria-label="Market model" className="grid gap-2">
        <h3 className="label">Underlying asset</h3>
        <MarketModel compliance={marketCompliance} />
      </section>
      <section aria-label="Your account" className="grid gap-2">
        <h3 className="label">Your account</h3>
        {!connected ? (
          <p>Connect a wallet to check whether your account can use this market.</p>
        ) : account.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : items ? (
          <>
            <ul className="grid gap-3">
              {items.map((item) => (
                <li key={item.id} className="grid gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0">
                  <p className="wrap-anywhere">
                    <span className="font-semibold">{STATUS_TEXT[item.status]}.</span> {item.message}
                  </p>
                  {item.fix ? (
                    item.fix === "onboarding" && testTokens ? (
                      <Button type="button" variant="secondary" className="w-fit" onClick={onGetTestTokens}>
                        Get test tokens
                      </Button>
                    ) : (
                      <p className="text-ink-muted">Fix: {FIX_TEXT[item.fix]}</p>
                    )
                  ) : null}
                  {!testTokens && item.id === "trustline" && item.status === "missing" && address ? (
                    // A new account starts with a new button.
                    <AddTrustline key={address} marketId={marketId} address={address} />
                  ) : null}
                </li>
              ))}
            </ul>
            {!testTokens && address ? <AccessRequest address={address} items={items} /> : null}
          </>
        ) : (
          <p>{account.stale ? "Unavailable — last update failed." : `${UNAVAILABLE}: your account could not be read right now.`}</p>
        )}
      </section>
    </div>
  )
}
