"use client"

import { useAccountState } from "@/hooks/use-account-state"
import { useMarketCompliance } from "@/hooks/use-market-compliance"
import { useWallet } from "@/hooks/use-wallet"
import { evaluateAccountCompliance, type ComplianceItem, type MarketCompliance } from "@/lib/protocol/compliance"
import { shorten } from "@/lib/protocol/format"
import { activeManifest } from "@/lib/protocol/manifest-source"
import { onboardingAvailable } from "@/lib/protocol/onboarding"
import type { Live } from "@/lib/protocol/types"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { UNAVAILABLE } from "@/components/app/live"

const FIX_TEXT: Record<NonNullable<ComplianceItem["fix"]>, string> = {
  friendbot: "Fund the account with Friendbot, then reload.",
  trustline: "Add a trustline to the underlying asset in your wallet.",
  onboarding: "Get test tokens.",
  issuer: "Contact the issuer of the underlying asset.",
}

/** Where Get test tokens does not exist (mainnet), access is the market administrator's to grant. */
const NO_ONBOARDING_FIX = "Ask the market's administrator to grant your account access."

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

/** Where the compliance fix for an item is done; "onboarding" opens the Get test tokens dialog. */
export function ComplianceCard({
  marketId,
  onGetTestTokens,
}: {
  marketId: string
  onGetTestTokens: () => void
}) {
  const { state } = useWallet()
  const compliance = useMarketCompliance(marketId)
  const account = useAccountState(marketId)
  const connected = state.status === "connected"
  const testTokens = onboardingAvailable(activeManifest())
  const marketCompliance = compliance.data
  const kind = marketCompliance?.status === "live" ? marketCompliance.value.kind : null
  const kindError = marketCompliance?.status === "unavailable" ? marketCompliance.error : undefined

  const items = account.data && !account.stale ? evaluateAccountCompliance(account.data, kind, kindError) : null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Compliance</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm text-ink">
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
                      <p className="text-ink-muted">
                        Fix: {item.fix === "onboarding" ? NO_ONBOARDING_FIX : FIX_TEXT[item.fix]}
                      </p>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p>{account.stale ? "Unavailable — last update failed." : `${UNAVAILABLE}: your account could not be read right now.`}</p>
          )}
        </section>
      </CardContent>
    </Card>
  )
}
