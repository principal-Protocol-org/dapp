"use client"

import { useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { networkLabel } from "@/components/app/shell/network"
import { useAccountState } from "@/hooks/use-account-state"
import { useMarketPermissions } from "@/hooks/use-market-permissions"
import { useWallet } from "@/hooks/use-wallet"
import { activeManifest } from "@/lib/protocol/manifest-source"
import {
  addTrustline,
  fundWithFriendbot,
  onboardingAvailable,
  onboardingSteps,
  requestTestTokens,
  sharedTestAsset,
  TEST_TOKEN_AMOUNT,
  TEST_TOKEN_TOP_UP_BELOW,
  type FaucetErrorCode,
  type FaucetResponse,
  type FaucetStep,
  type OnboardingStepId,
} from "@/lib/protocol/onboarding"
import type { Market } from "@/lib/protocol/types"

/** The server's refusals, in plain words with their fix. */
const REFUSAL_TEXT: Record<FaucetErrorCode, string> = {
  rate_limited:
    "Get test tokens was used for this account or from this connection less than a minute ago, or is busy with other requests. Try again in a minute.",
  busy: "The faucet is busy — try again in a minute.",
  no_trustline: "The faucet found no trustline to the test asset on your account yet. Try again in a minute.",
  network: "Get test tokens runs only on Testnet or a local network.",
  invalid_account: "The faucet refused the account address. Reconnect your wallet, then try again.",
  invalid_content_type: "The faucet refused the request from this page. Reload the page, then try again.",
  cross_site: "The faucet refused the request from this page. Reload the page, then try again.",
  request_too_large: "The faucet refused the request as too large. Reload the page, then try again.",
  not_configured: "Get test tokens is not set up on this server yet. Ask the Principal team.",
  // Neutral: the cause may be a read, a timeout or a transaction (minor 6).
  failed: "The faucet could not finish — try again in a minute. Steps already done are kept.",
}

/** Where a failed faucet run stopped, in plain words. */
const STEP_TEXT: Record<FaucetStep, string> = {
  authorize: "authorizing your trustline",
  grant_account: "allowing your account",
  grant_pt: "allowing your account on PT",
  grant_yt: "allowing your account on YT",
  pay: "sending the test tokens",
}

function refusalText(r: Extract<FaucetResponse, { error: string }>): string {
  if (r.error === "failed" && r.step) {
    return `The faucet could not finish — try again in a minute. It stopped while ${STEP_TEXT[r.step]}; steps already done are kept.`
  }
  if (r.error === "rate_limited" && r.retryAfterSeconds) {
    return `Get test tokens was used for this account or from this connection less than a minute ago, or is busy with other requests. Try again in ${r.retryAfterSeconds} seconds.`
  }
  return REFUSAL_TEXT[r.error]
}

/**
 * `sent`: steps this run finished, shown as "Sent — confirming" until the refetched chain state
 * shows them done. Done-ness itself only ever comes from that state (R44), never from here.
 */
type Run =
  | { phase: "idle" }
  | { phase: "running"; step: OnboardingStepId; sent: OnboardingStepId[] }
  | { phase: "failed"; step: OnboardingStepId; message: string; sent: OnboardingStepId[] }
  | { phase: "finished"; sent: OnboardingStepId[] }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const thousands = (n: bigint) => n.toLocaleString("en-US")

/**
 * The Get test tokens checklist (spec §9) for the connected wallet: Friendbot, a trustline the user
 * signs, then the server faucet. Each step is skipped when already done; the account reads are
 * refreshed after every step. Offered on Testnet and a local network only, and only when every
 * market shares one test asset (R44).
 */
export function OnboardingDialog({
  open,
  onOpenChange,
  marketId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The market whose account reads are shown; the faucet itself onboards every market. */
  marketId?: string
}) {
  if (!onboardingAvailable(activeManifest())) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Mounted only while open: the account reads run for an open dialog only. */}
        {open ? <Body marketId={marketId} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function Body({ marketId }: { marketId?: string }) {
  const m = activeManifest()
  const asset = sharedTestAsset(m)
  const network = networkLabel(m.network)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Get test tokens</DialogTitle>
        <DialogDescription>
          {asset
            ? `Prepares your wallet for ${network}: it can then hold ${asset.code} and use every market. Test assets have no real value.`
            : `Prepares your wallet for ${network}. Test assets have no real value.`}
        </DialogDescription>
      </DialogHeader>
      {asset ? (
        <Checklist marketId={marketId ?? m.markets[0].marketId} asset={asset} />
      ) : (
        <p role="alert" className="text-sm text-ink">
          Get test tokens supports a single test asset, and the markets of this deployment use different underlying assets.
          Ask the Principal team for access.
        </p>
      )}
    </>
  )
}

function Checklist({ marketId, asset }: { marketId: string; asset: Market["underlying"] }) {
  const { state } = useWallet()
  const address = state.status === "connected" ? state.publicKey : null
  if (!address) {
    return <p className="text-sm text-ink">Connect your wallet on {networkLabel(activeManifest().network)} to get test tokens.</p>
  }
  // A new account starts a new checklist.
  return <AccountChecklist key={address} marketId={marketId} address={address} asset={asset} />
}

function AccountChecklist({ marketId, address, asset }: { marketId: string; address: string; asset: Market["underlying"] }) {
  const m = activeManifest()
  const { sign } = useWallet()
  const account = useAccountState(marketId)
  const permissions = useMarketPermissions(address)
  const queryClient = useQueryClient()
  const [run, setRun] = useState<Run>({ phase: "idle" })
  // A double click must not start two runs: state updates land too late to disable the button.
  const starting = useRef(false)

  /** Refetches every account read, the permissions included; resolves once they are back. */
  const refresh = async () => {
    try {
      await queryClient.invalidateQueries({ queryKey: ["account", m.network] })
    } catch {
      // A failed refetch shows as unavailable in the reads themselves.
    }
  }

  if ((account.isPending && !account.data) || (permissions.isPending && !permissions.data)) {
    return <Skeleton className="h-32 w-full" />
  }
  const data = account.data
  if (!data || account.stale || data.accountExists.status === "unavailable" || data.trustline.status === "unavailable") {
    const cause =
      data?.accountExists.status === "unavailable"
        ? ` (${data.accountExists.error})`
        : data?.trustline.status === "unavailable"
          ? ` (${data.trustline.error})`
          : ""
    return <p className="text-sm text-ink wrap-anywhere">Your account could not be read right now{cause}. Try again in a moment.</p>
  }

  // Every market's PT and YT (R44). Like the account read, an unread or stale permission read
  // offers nothing: whether the grant step is done cannot be told (round 2).
  const marketPerms = permissions.data
  if (!marketPerms || permissions.stale || marketPerms.some((p) => p.permPt.status !== "live" || p.permYt.status !== "live")) {
    return <p className="text-sm text-ink">Your permissions on the markets could not be read right now. Try again in a moment.</p>
  }
  const hasFriendbot = Boolean(m.friendbotUrl)
  const sent = run.phase === "idle" ? [] : run.sent
  const steps = onboardingSteps(data, { decimals: asset.decimals, markets: marketPerms })
    // Without a Friendbot the funding step is not offered; a missing account is refused below.
    .filter((s) => s.id !== "fund" || hasFriendbot)
  const missingAccount = !hasFriendbot && data.accountExists.value === false
  const todo = steps.filter((s) => !s.done)
  const running = run.phase === "running"

  async function perform(step: OnboardingStepId) {
    if (step === "fund") return fundWithFriendbot({ manifest: m, account: address })
    if (step === "trustline") {
      await addTrustline({ manifest: m, account: address, asset, sign: (xdr) => sign(xdr, address) })
      return
    }
    const result = await requestTestTokens({ account: address })
    if ("error" in result) throw new Error(refusalText(result))
  }

  async function start() {
    if (starting.current) return
    starting.current = true
    const done: OnboardingStepId[] = []
    try {
      for (const step of todo) {
        setRun({ phase: "running", step: step.id, sent: [...done] })
        try {
          await perform(step.id)
        } catch (error) {
          setRun({ phase: "failed", step: step.id, message: errorText(error), sent: [...done] })
          // Earlier steps (or part of the faucet run) may have landed: show what is true now.
          await refresh()
          return
        }
        done.push(step.id)
        // Done-ness comes from the chain: refetch after every step (R44).
        await refresh()
      }
      setRun({ phase: "finished", sent: done })
    } finally {
      starting.current = false
    }
  }

  const TEXT: Record<OnboardingStepId, { title: string; detail: string }> = {
    fund: {
      title: "Fund your account",
      detail: "Friendbot sends Testnet XLM to your account, for network fees and reserves.",
    },
    trustline: {
      title: `Add a trustline to ${asset.code}`,
      detail: `You sign one transaction in your wallet so your account can hold ${asset.code}.`,
    },
    grant: {
      title: `Get access and ${asset.code}`,
      detail: `Principal's Testnet faucet authorizes your trustline, allows your account on every market's PT and YT, and sends ${thousands(TEST_TOKEN_AMOUNT)} ${asset.code} while you hold less than ${thousands(TEST_TOKEN_TOP_UP_BELOW)}.`,
    },
  }

  function status(id: OnboardingStepId, done: boolean): string {
    if (done) return "Done"
    if (run.phase === "running" && run.step === id) return "Working…"
    if (run.phase === "failed" && run.step === id) return "Failed"
    if (sent.includes(id)) return "Sent — confirming"
    return "To do"
  }

  return (
    <div className="grid gap-4 text-sm text-ink">
      <ol className="grid gap-3">
        {steps.map((s, i) => (
          <li key={s.id} className="grid gap-0.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
            <p className="flex items-baseline justify-between gap-3">
              <span className="font-semibold">
                {i + 1}. {TEXT[s.id].title}
              </span>
              <span className="label shrink-0" aria-live="polite">
                {status(s.id, s.done)}
              </span>
            </p>
            <p className="text-ink-muted">{TEXT[s.id].detail}</p>
          </li>
        ))}
      </ol>

      {missingAccount ? (
        <p role="alert">
          Your account does not exist on this network yet, and this network has no Friendbot. Send XLM to it from another
          account, then open this again.
        </p>
      ) : null}
      {run.phase === "failed" ? <p role="alert">{run.message}</p> : null}
      {run.phase === "finished" ? (
        todo.length === 0 ? (
          <p role="status">Your account is ready. Balances and checks update within a few seconds.</p>
        ) : (
          <p role="status">Sent. The network does not show every change yet; this updates within a few seconds.</p>
        )
      ) : todo.length === 0 && run.phase === "idle" ? (
        <p role="status">
          Nothing left to do: your account is set up and holds at least {thousands(TEST_TOKEN_TOP_UP_BELOW)} {asset.code}.
        </p>
      ) : null}

      {todo.length > 0 && !missingAccount && run.phase !== "finished" ? (
        <DialogFooter>
          <Button type="button" onClick={() => void start()} disabled={running} aria-busy={running}>
            {running ? "Working…" : run.phase === "failed" ? "Try again" : "Start"}
          </Button>
        </DialogFooter>
      ) : null}
    </div>
  )
}
