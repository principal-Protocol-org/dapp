"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react"
import { Button } from "@/components/ui/button"
import { UNAVAILABLE } from "@/components/app/live"
import { useManifest } from "@/components/app/manifest-provider"
import { FlowBusyContext } from "@/components/app/manage/flow-busy"
import { StepGrants } from "@/components/app/manage/step-grants"
import { StepWire } from "@/components/app/manage/step-wire"
import { StepDeploy } from "@/components/app/manage/step-deploy"
import { StepParams } from "@/components/app/manage/step-params"
import { StepPreview } from "@/components/app/manage/step-preview"
import { StepPublish } from "@/components/app/manage/step-publish"
import { StepSeed } from "@/components/app/manage/step-seed"
import { useHydrated } from "@/hooks/use-hydrated"
import { useLedgerClock } from "@/hooks/use-ledger-clock"
import { useWallet } from "@/hooks/use-wallet"
import { useFixedParams, useMarketProgress, useParamDefaults } from "@/hooks/use-wizard"
import { rememberWizardSalt } from "@/lib/app/wizard-salts"
import {
  currentMarket,
  defaultMaturity,
  draftFromParams,
  factoryOf,
  paramsFromDefaults,
  paramsFromDraft,
  parseSalt,
  randomSalt,
  type MarketParams,
  type ParamDraft,
} from "@/lib/protocol/factory"
import type { MarketProgress, WizardStep } from "@/lib/protocol/market-progress"

/** The seven steps of spec 0002 §5, by number. */
export const STEP_TITLES: Record<WizardStep, string> = {
  1: "Parameters",
  2: "Addresses",
  3: "Deploy",
  4: "Wire",
  5: "Permissions",
  6: "Seed the pool",
  7: "Publish",
}

/** A step from 4 on: every contract exists, and `progress.live` holds what the chain says of them. */
export type ChainStep = 4 | 5 | 6 | 7

/** What a step from 4 on receives. Its own signatures go through `ManagerSignFlow`, like step 3's. */
export type ChainStepProps = {
  salt: string
  progress: MarketProgress & { live: NonNullable<MarketProgress["live"]> }
  account: string | null
  ledgerTime: number | null
}

/**
 * Steps 4–7, by number (plan 0005 Tasks 7–8). The wizard shows the step the chain has reached; a step
 * with no component says what comes next.
 */
export const CHAIN_STEPS: Partial<Record<ChainStep, ComponentType<ChainStepProps>>> = { 4: StepWire, 5: StepGrants, 6: StepSeed, 7: StepPublish }

const NEXT_STEP: Record<ChainStep, string> = {
  4: "Every contract of the market is deployed. Next, RiskControl lists the SY wrapper and the PrincipalManager as consumers, and the Router registers the pool. Their admins sign these.",
  5: "The market is wired. Next, the SY wrapper, PrincipalManager, pool, recovery escrow and treasury get their asset authorization and Permissioning permissions, signed by whoever holds those roles.",
  6: "Every permission holds. Next, the pool is seeded from a starting fixed APY and an amount.",
  7: "The pool holds liquidity. Next, the market is published to the registry, so it appears in the market list.",
}

function NextStep({ step }: { step: ChainStep }) {
  const id = useId()
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-2 rounded-lg border border-line bg-surface p-5">
      <h2 id={`${id}-heading`} className="font-serif text-2xl text-ink">
        Step {step} of 7: {STEP_TITLES[step]}
      </h2>
      <p className="text-ink">{NEXT_STEP[step]}</p>
      <p className="text-sm text-ink-muted">
        The app does not run this step yet. Where the market stands is read from the chain, so this link opens here again.
      </p>
    </section>
  )
}

function StepList({ current }: { current: WizardStep }) {
  return (
    <ol aria-label="Steps" className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-4 min-[900px]:grid-cols-7">
      {(Object.keys(STEP_TITLES).map(Number) as WizardStep[]).map((n) => {
        const done = n < current
        const here = n === current
        return (
          <li
            key={n}
            aria-current={here ? "step" : undefined}
            className={`grid gap-0.5 rounded-lg border p-2 text-sm ${here ? "border-ink text-ink" : "border-line text-ink-muted"}`}
          >
            <span className="font-mono text-xs">{n}</span>
            <span>{STEP_TITLES[n]}</span>
            {done ? <span className="text-xs text-positive">Done</span> : null}
          </li>
        )
      })}
    </ol>
  )
}

function Fallback() {
  return <p className="text-ink-muted">Loading the wizard…</p>
}

/**
 * The market-creation wizard (spec 0002 §5, R5-10). The salt in the URL (`?salt=`, 32 random bytes)
 * fixes the market's seven addresses, so the link alone resumes it: where the market stands is read
 * from the chain (`marketProgress`), never from a saved draft. A link without a salt gets a fresh one.
 * It reads the URL, so it renders inside the page's `<Suspense>`, and from the first client render
 * after hydration.
 */
export function Wizard() {
  const hydrated = useHydrated()
  const search = useSearchParams()
  const raw = search?.get("salt") ?? null

  useEffect(() => {
    if (!hydrated || raw !== null) return
    const next = new URLSearchParams(window.location.search)
    next.set("salt", randomSalt())
    // Next's History API support updates `useSearchParams` without a navigation.
    window.history.replaceState(null, "", `${window.location.pathname}?${next.toString()}${window.location.hash}`)
  }, [hydrated, raw])

  if (!hydrated || raw === null) return <Fallback />
  const salt = parseSalt(raw)
  if (!salt) {
    return (
      <p role="alert" className="rounded-lg border border-line bg-surface p-5 text-ink">
        This link&apos;s salt is not 32 bytes of hex, so it names no market.{" "}
        <Link href="/app/manage/new" className="underline underline-offset-4">
          Start a new market
        </Link>
      </p>
    )
  }
  return <WizardFor key={salt} salt={salt} />
}

function WizardFor({ salt }: { salt: string }) {
  const manifest = useManifest()
  let factoryProblem: string | null = null
  try {
    factoryOf(manifest)
  } catch (error) {
    factoryProblem = error instanceof Error ? error.message : String(error)
  }
  if (factoryProblem) {
    return (
      <p role="alert" className="rounded-lg border border-line bg-surface p-5 text-ink">
        {factoryProblem}
      </p>
    )
  }
  return <WizardFrame salt={salt} />
}

/** Holds the pin (flow-busy.tsx): the step a open review or sign flow started, shown until it closes. */
function WizardFrame({ salt }: { salt: string }) {
  const chainStepRef = useRef<WizardStep | undefined>(undefined)
  const [pin, setPin] = useState<WizardStep | null>(null)
  const open = useRef(0)
  const flowBusy = useMemo(
    () => ({
      enter() {
        if (open.current++ === 0) setPin(chainStepRef.current ?? null)
      },
      leave() {
        if (--open.current === 0) setPin(null)
      },
    }),
    [],
  )
  return (
    <FlowBusyContext.Provider value={flowBusy}>
      <WizardSteps salt={salt} pin={pin} chainStepRef={chainStepRef} />
    </FlowBusyContext.Provider>
  )
}

function WizardSteps({ salt, pin, chainStepRef }: { salt: string; pin: WizardStep | null; chainStepRef: { current: WizardStep | undefined } }) {
  const manifest = useManifest()
  const { state: wallet } = useWallet()
  const account = wallet.status === "connected" ? wallet.publicKey : null
  const { ledgerTime } = useLedgerClock()
  const progress = useMarketProgress(salt)
  // Steps 1–3 are the same chain state (nothing or part deployed): which one shows is the user's.
  const [view, setView] = useState<1 | 2 | 3 | null>(null)
  const [edits, setEdits] = useState<Partial<ParamDraft>>({})

  const p = progress.data
  const fixed = useFixedParams(salt, p)
  const baseUnderlying = fixed.data?.underlying ?? manifest.testAsset?.sac ?? currentMarket(manifest, undefined)?.underlying.sac
  const source = currentMarket(manifest, baseUnderlying)
  const defaults = useParamDefaults(source)

  const chainStep: WizardStep | undefined = !p ? undefined : p.step >= 4 ? p.step : (view ?? (p.step === 3 ? 3 : 1))
  // A step with a flow open stays shown while the chain moves on (flow-busy.tsx): the step that
  // started it renders its own outcome, and the wizard advances once every flow is closed.
  useEffect(() => {
    chainStepRef.current = chainStep
  })
  const current: WizardStep | undefined = chainStep === undefined ? undefined : (pin ?? chainStep)
  const { network } = manifest
  const deployedSomething = p !== undefined && p.step >= 3
  useEffect(() => {
    // Listed in the manager view to resume once a phase is on chain, not when step 3 is merely shown.
    if (deployedSomething) rememberWizardSalt(network, salt)
  }, [deployedSomething, network, salt])

  if (progress.isPending) return <p className="text-ink-muted">Reading where this market stands on chain…</p>
  // The full error view only when there is no read at all. A failed refresh (a poll, or the refresh
  // after a signature) keeps the last read and the step mounted, with any review in progress: it is
  // said beside it, never in its place (TanStack keeps `data` with `isError`).
  if (p === undefined) {
    return (
      <div role="alert" className="grid gap-3 rounded-lg border border-line bg-surface p-5">
        <p className="text-ink">
          {UNAVAILABLE}: {progress.error.message}
        </p>
        <div>
          <Button type="button" variant="secondary" onClick={() => void progress.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }
  if (current === undefined) return null

  const refreshError = progress.isError ? progress.error.message : null
  const header = (
    <>
      <StepList current={current} />
      {refreshError ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3">
          <p className="min-w-0 text-sm text-ink">
            Could not refresh where this market stands ({refreshError}). What is shown is the last read.
          </p>
          <Button type="button" variant="secondary" size="toggle" onClick={() => void progress.refetch()}>
            Refresh
          </Button>
        </div>
      ) : null}
      <p className="text-sm text-ink-muted">
        This page&apos;s link holds the market&apos;s salt (<span className="font-mono break-all">{salt}</span>), which fixes its seven
        addresses. Keep the link to come back: where the market stands is read from the chain.
      </p>
    </>
  )

  if (current >= 4) {
    const Step = CHAIN_STEPS[current as ChainStep]
    return (
      <div className="grid gap-6">
        {header}
        {Step && p.live ? (
          <Step salt={salt} progress={p as ChainStepProps["progress"]} account={account} ledgerTime={ledgerTime} />
        ) : (
          <NextStep step={current as ChainStep} />
        )}
      </div>
    )
  }

  // Steps 1–3: the parameters, from the current market's defaults, with whatever the chain already
  // fixed taking precedence and locked. Only the first load waits: once a signature deploys a phase,
  // the read of what it fixed must not unmount the deploy step and the flow running in it, so the
  // step stays and holds its button until the read is back.
  const waiting = ledgerTime === null || (source !== undefined && defaults.isPending)
  const readingFixed = p.phases.tokens && fixed.isPending
  // Shown above the step, never in its place (the step may hold a flow in progress); deploying waits.
  const fixedError = fixed.isError ? fixed.error.message : null
  if (waiting) {
    return (
      <div className="grid gap-6">
        {header}
        <p className="text-ink-muted">Reading the current market&apos;s settings…</p>
      </div>
    )
  }

  const locked = new Set(Object.keys(fixed.data ?? {}) as (keyof MarketParams)[])
  const userEdits = Object.fromEntries(Object.entries(edits).filter(([k]) => !locked.has(k as keyof MarketParams)))
  const draft: Partial<ParamDraft> = {
    ...draftFromParams({ maturity: defaultMaturity(ledgerTime) }),
    ...(defaults.data ? draftFromParams(paramsFromDefaults(defaults.data)) : {}),
    ...(baseUnderlying ? { underlying: baseUnderlying } : {}),
    ...userEdits,
    ...draftFromParams(fixed.data ?? {}),
  }
  const { params, errors } = paramsFromDraft(manifest, draft, ledgerTime)
  const change = (key: keyof MarketParams, value: string) => setEdits((e) => ({ ...e, [key]: value }))

  return (
    <div className="grid gap-6">
      {header}
      {fixedError ? (
        <p role="alert" className="text-sm text-negative">
          {UNAVAILABLE}: what the deployed contracts fixed could not be read ({fixedError}). Deploying waits until it can.
        </p>
      ) : null}
      {current === 1 ? (
        <StepParams
          manifest={manifest}
          draft={draft}
          errors={errors}
          locked={locked}
          defaults={defaults.data}
          onChange={change}
          onNext={() => setView(2)}
        />
      ) : null}
      {current === 2 ? <StepPreview salt={salt} onBack={() => setView(1)} onNext={() => setView(3)} /> : null}
      {current === 3 ? (
        <StepDeploy
          manifest={manifest}
          salt={salt}
          progress={p}
          underlying={draft.underlying}
          params={params}
          errors={errors}
          account={account}
          ledgerTime={ledgerTime}
          fixedState={fixedError !== null ? "unavailable" : readingFixed ? "reading" : "ready"}
          onEdit={() => setView(1)}
        />
      ) : null}
    </div>
  )
}
