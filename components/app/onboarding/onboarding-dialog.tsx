"use client"

import { useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { networkLabel } from "@/components/app/shell/network"
import { useAccountState } from "@/hooks/use-account-state"
import { useWallet } from "@/hooks/use-wallet"
import { activeManifest } from "@/lib/protocol/manifest-source"
import {
  addTrustline,
  fundWithFriendbot,
  onboardingAvailable,
  onboardingSteps,
  requestTestTokens,
  testAsset,
  TEST_TOKEN_AMOUNT,
  TEST_TOKEN_TOP_UP_BELOW,
  type FaucetErrorCode,
  type OnboardingStepId,
} from "@/lib/protocol/onboarding"

/** The server's refusals, in plain words with their fix. */
const REFUSAL_TEXT: Record<FaucetErrorCode, string> = {
  rate_limited: "Get test tokens was used for this account or from this connection less than a minute ago. Try again in a minute.",
  no_trustline: "The faucet found no trustline to the test asset on your account yet. Wait a few seconds, then try again.",
  network: "Get test tokens runs only on Testnet or a local network.",
  invalid_account: "The faucet refused the account address. Reconnect your wallet, then try again.",
  not_configured: "Get test tokens is not set up on this server yet. Ask the Principal team.",
  failed: "The faucet could not finish: a network transaction did not go through. Steps already done are kept; try again in a minute.",
}

type Run =
  | { phase: "idle" }
  | { phase: "running"; step: OnboardingStepId; completed: OnboardingStepId[] }
  | { phase: "failed"; step: OnboardingStepId; message: string; completed: OnboardingStepId[] }
  | { phase: "finished"; completed: OnboardingStepId[] }

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const thousands = (n: bigint) => n.toLocaleString("en-US")

/**
 * The Get test tokens checklist (spec §9) for the connected wallet: Friendbot, a trustline the user
 * signs, then the server faucet. Each step is skipped when already done; the account reads are
 * refreshed after a run. Offered on Testnet and a local network only.
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
  const asset = testAsset(m)
  return (
    <>
      <DialogHeader>
        <DialogTitle>Get test tokens</DialogTitle>
        <DialogDescription>
          Prepares your wallet for {networkLabel(m.network)}: it can then hold {asset.code} and use every market. Test
          assets have no real value.
        </DialogDescription>
      </DialogHeader>
      <Checklist marketId={marketId ?? m.markets[0].marketId} />
    </>
  )
}

function Checklist({ marketId }: { marketId: string }) {
  const { state } = useWallet()
  const address = state.status === "connected" ? state.publicKey : null
  if (!address) {
    return <p className="text-sm text-ink">Connect Freighter on {networkLabel(activeManifest().network)} to get test tokens.</p>
  }
  // A new account starts a new checklist.
  return <AccountChecklist key={address} marketId={marketId} address={address} />
}

function AccountChecklist({ marketId, address }: { marketId: string; address: string }) {
  const m = activeManifest()
  const asset = testAsset(m)
  const { sign } = useWallet()
  const account = useAccountState(marketId)
  const queryClient = useQueryClient()
  const [run, setRun] = useState<Run>({ phase: "idle" })

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["account", m.network] })

  if (account.isPending && !account.data) return <Skeleton className="h-32 w-full" />
  const data = account.data
  if (!data || account.stale || data.accountExists.status === "unavailable" || data.trustline.status === "unavailable") {
    const cause =
      data?.accountExists.status === "unavailable"
        ? ` (${data.accountExists.error})`
        : data?.trustline.status === "unavailable"
          ? ` (${data.trustline.error})`
          : ""
    return <p className="text-sm text-ink">Your account could not be read right now{cause}. Try again in a moment.</p>
  }

  const hasFriendbot = Boolean(m.friendbotUrl)
  const completed = run.phase === "idle" ? [] : run.completed
  const steps = onboardingSteps(data, asset.decimals)
    // Without a Friendbot the funding step is not offered; a missing account is refused below.
    .filter((s) => s.id !== "fund" || hasFriendbot)
    .map((s) => ({ ...s, done: s.done || completed.includes(s.id) }))
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
    if ("error" in result) throw new Error(REFUSAL_TEXT[result.error])
  }

  async function start() {
    const done: OnboardingStepId[] = [...completed]
    for (const step of todo) {
      setRun({ phase: "running", step: step.id, completed: [...done] })
      try {
        await perform(step.id)
      } catch (error) {
        setRun({ phase: "failed", step: step.id, message: errorText(error), completed: [...done] })
        // Earlier steps (or part of the faucet run) may have landed: show what is true now.
        refresh()
        return
      }
      done.push(step.id)
    }
    setRun({ phase: "finished", completed: done })
    refresh()
  }

  const TEXT: Record<OnboardingStepId, { title: string; detail: string }> = {
    fund: {
      title: "Fund your account",
      detail: "Friendbot sends Testnet XLM to your account, for network fees and reserves.",
    },
    trustline: {
      title: `Add a trustline to ${asset.code}`,
      detail: `You sign one transaction in Freighter so your account can hold ${asset.code}.`,
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
        <p role="status">Your account is ready. Balances and checks update within a few seconds.</p>
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
