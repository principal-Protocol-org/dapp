"use client"

import { useId } from "react"
import { Button } from "@/components/ui/button"
import { UNAVAILABLE } from "@/components/app/live"
import { ManagerSignFlow } from "@/components/app/manage/manager-sign-flow"
import { useManifestFindings } from "@/hooks/use-manifest-findings"
import { useSacAdmin } from "@/hooks/use-wizard"
import { useWallet } from "@/hooks/use-wallet"
import { knownUnderlyings, PARAM_LABEL, type MarketParams, type ParamErrors } from "@/lib/protocol/factory"
import type { Blocker } from "@/lib/protocol/gates"
import { createEngineCall, createPoolAndEscrowCall, createTokensCall, type ManagerCall } from "@/lib/protocol/manager-calls"
import { evaluateManagerGates } from "@/lib/protocol/manager-gates"
import type { MarketProgress } from "@/lib/protocol/market-progress"
import type { Role } from "@/lib/protocol/roles"
import type { Live, Manifest } from "@/lib/protocol/types"

export type StepDeployProps = {
  manifest: Manifest
  salt: string
  progress: MarketProgress
  /** The asset the market is on: the parameters' choice, or what the deployed tokens fixed. */
  underlying: string | undefined
  /** The parameters, once every one passes the contracts' checks. */
  params: MarketParams | undefined
  errors: ParamErrors
  account: string | null
  ledgerTime: number | null
  /** What the deployed contracts fixed: nothing is signed until it is read (`ready`). */
  fixedState: "ready" | "reading" | "unavailable"
  onEdit(): void
}

const PHASES = [
  { key: "tokens", what: "SY wrapper, PT and YT" },
  { key: "engine", what: "Market config and PrincipalManager" },
  { key: "poolAndEscrow", what: "Pool and recovery escrow" },
] as const

/**
 * Step 3 (spec 0002 §5): the factory's three calls, `create_tokens`, `create_engine` and
 * `create_pool_and_escrow`, with this market's salt. Each is its own transaction, reviewed and signed
 * in the connected wallet (`ManagerSignFlow`); a resumed market runs only the phases left. R5-10:
 * every contract the factory deploys checks the underlying SAC's `admin()` live, so only that
 * account can sign; any other wallet is told which one must.
 */
export function StepDeploy({ manifest, salt, progress, underlying, params, errors, account, ledgerTime, fixedState, onEdit }: StepDeployProps) {
  const id = useId()
  const { state: wallet } = useWallet()
  const findings = useManifestFindings()
  const admin = useSacAdmin(underlying)
  const code = underlying ? (knownUnderlyings(manifest).get(underlying)?.code ?? "asset") : "asset"
  const resumed = progress.phases.tokens

  const adminRead: Live<string> | undefined = admin.data ?? (admin.isError ? { status: "unavailable", error: admin.error.message } : undefined)
  const roles: Live<Role[]> = !adminRead
    ? { status: "unavailable", error: "the asset's admin is still being read" }
    : adminRead.status === "unavailable"
      ? adminRead
      : { status: "live", value: adminRead.value === account ? ["issuer"] : [], ledger: adminRead.ledger }
  const isIssuer = adminRead?.status === "live" && account !== null && adminRead.value === account

  let calls: ManagerCall[] = []
  let buildError: string | null = null
  if (account && params) {
    try {
      const c = { source: account, salt, params }
      calls = [
        ...(progress.phases.tokens ? [] : [createTokensCall(manifest, c)]),
        ...(progress.phases.engine ? [] : [createEngineCall(manifest, c)]),
        createPoolAndEscrowCall(manifest, c),
      ]
    } catch (error) {
      buildError = error instanceof Error ? error.message : String(error)
    }
  }

  // The factory is a shared contract: no listed market is needed (R2-53's `listed`).
  const blockersFor = (call: ManagerCall): Blocker[] => evaluateManagerGates(call, { wallet, roles, findings, listed: true })
  const problems = Object.entries(errors) as [keyof MarketParams, string][]

  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-5">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="font-serif text-2xl text-ink">
          Step 3 of 7: Deploy
        </h2>
        <p className="text-sm text-ink-muted">
          Three transactions with this market&apos;s salt, each reviewed and signed in your wallet. Each one deploys its contracts
          completely or not at all.
        </p>
      </div>

      <ol className="grid gap-2">
        {PHASES.map((phase, i) => {
          const done = progress.phases[phase.key]
          return (
            <li key={phase.key} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-line bg-surface p-3">
              <span className="text-ink">
                <span className="text-ink-muted">{i + 1}. </span>
                {phase.what}
              </span>
              <span className={done ? "text-sm text-positive" : "text-sm text-ink-muted"}>{done ? "Deployed" : "To deploy"}</span>
            </li>
          )
        })}
      </ol>

      {adminRead?.status === "unavailable" ? (
        <p role="alert" className="text-sm text-negative">
          {UNAVAILABLE}: who may deploy on {code} could not be read ({adminRead.error}). Deploying stays off until it can.
        </p>
      ) : null}
      {adminRead?.status === "live" && !isIssuer ? (
        <p role="alert" className="rounded-lg border border-line bg-surface p-4 text-sm break-words text-ink">
          Only the {code} issuer can deploy this market: every contract checks the asset contract&apos;s admin, which is{" "}
          <span className="font-mono">{adminRead.value}</span>.{" "}
          {account ? (
            <>
              You are connected as <span className="font-mono">{account}</span>.{" "}
            </>
          ) : null}
          Connect that wallet to deploy. This page&apos;s link keeps your place.
        </p>
      ) : null}

      {fixedState === "reading" ? <p className="text-sm text-ink-muted">Reading what the deployed contracts fixed…</p> : null}
      {problems.length > 0 ? (
        <div role="alert" className="grid gap-1 text-sm text-negative">
          <p>Fix the parameters before deploying:</p>
          <ul className="list-disc pl-5">
            {problems.map(([key, message]) => (
              <li key={key}>
                {PARAM_LABEL[key]}: {message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {buildError ? (
        <p role="alert" className="text-sm text-negative">
          {buildError}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={onEdit}>
          Edit the parameters
        </Button>
        <ManagerSignFlow
          label={resumed ? "Continue the deployment" : "Deploy the market"}
          title="Deploy the market"
          steps={calls}
          disabled={calls.length === 0 || !isIssuer || fixedState !== "ready"}
          blockersFor={blockersFor}
          ledgerTime={ledgerTime}
          network={manifest.network}
        />
      </div>
    </section>
  )
}
