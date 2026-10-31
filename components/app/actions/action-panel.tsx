"use client"

import { useId, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { AmountField } from "@/components/app/actions/amount-field"
import { GateList } from "@/components/app/actions/gate-list"
import type { FieldKey, FloorSpec, PanelConfig, PanelInputs, PreviewLine } from "@/components/app/actions/panel-config"
import { PreviewList, safeLines, useQuoteLines } from "@/components/app/actions/preview-lines"
import { SignFlow } from "@/components/app/actions/sign-flow"
import { TxNoticeView } from "@/components/app/actions/tx-feedback"
import { STALE, useGateContext } from "@/hooks/use-gate-context"
import { useSettings } from "@/hooks/use-settings"
import { useSimulation } from "@/hooks/use-simulation"
import { amountsComplete, checkAmount, spendBalance } from "@/lib/app/amounts"
import type { AccountState } from "@/lib/protocol/account-state"
import type { TxNotice } from "@/lib/app/tx-notice"
import { ACTION_META, invocationFor, type ActionId, type ActionInput, type GuardValues } from "@/lib/protocol/actions"
import { formatAmount, formatBps } from "@/lib/protocol/format"
import { BLOCKER_ORDER, evaluateGates, type Blocker } from "@/lib/protocol/gates"
import type { ActionOutput } from "@/lib/protocol/guards"
import { getMarket } from "@/lib/protocol/manifest"
import { useManifest } from "@/components/app/manifest-provider"
import type { MarketState } from "@/lib/protocol/market-state"

/** Every Principal token has 7 decimals; the underlying's are read from the manifest. */
const TOKEN_DECIMALS = 7

const FLOOR_ORDER: (keyof GuardValues)[] = ["minOut", "minOut2", "maxNetCost"]
const DEFAULT_FLOORS: Record<keyof GuardValues, FloorSpec> = {
  minOut: { label: "Minimum received", unit: "" },
  minOut2: { label: "Minimum received (second token)", unit: "" },
  maxNetCost: { label: "Maximum net cost", unit: "" },
}

/** Decimals of a field: deposit and mint spend the underlying (R24); everything else is a Principal token. */
const fieldDecimals = (action: ActionId, field: FieldKey, underlying: number) =>
  field === "amount" && (action === "deposit" || action === "mint") ? underlying : TOKEN_DECIMALS

/** The signed guard values, as "at least" / "at most" lines, at the slippage they were derived with. */
function floorLines(guards: GuardValues, config: PanelConfig, slippageBps: bigint, underlying: number): PreviewLine[] {
  // Withdraw's floor is `min_underlying_out`; every other floor is in a Principal token.
  const decimals = config.action === "withdraw" ? underlying : TOKEN_DECIMALS
  return FLOOR_ORDER.flatMap((key) => {
    const value = guards[key]
    if (value === undefined) return []
    const spec = config.floors?.[key] ?? DEFAULT_FLOORS[key]
    const limit = key === "maxNetCost" ? "costs more" : "gives less"
    return [
      {
        label: spec.label,
        value: `${formatAmount(value, decimals, decimals)}${spec.unit ? ` ${spec.unit}` : ""}`,
        hint: `Signed into the transaction with your ${formatBps(slippageBps)} slippage tolerance: it fails rather than ${limit}.`,
      },
    ]
  })
}

/** The config's notes; a note that cannot be worked out is left out rather than guessed. */
function configNotes(config: PanelConfig, ms: MarketState | undefined, account: AccountState | undefined): string[] {
  try {
    return config.notes?.({ ms, account }) ?? []
  } catch {
    return []
  }
}

/**
 * One action: amount fields, the indicative or exact preview, the gates of spec §5, and the
 * review → sign → result pipeline of spec §6. Configs (Tasks 15–18) only say what to ask for and
 * how to preview it; every safety rule lives here and in `lib/protocol`.
 */
export function ActionPanel({ config, marketId }: { config: PanelConfig; marketId: string }) {
  const baseId = useId()
  const manifest = useManifest()
  const market = getMarket(manifest, marketId)
  const meta = ACTION_META[config.action]
  const { slippageBps, deadlineSeconds } = useSettings()
  const gate = useGateContext(marketId)
  const [texts, setTexts] = useState<Partial<Record<FieldKey, string>>>({})
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({})
  const [last, setLast] = useState<{ owner: string; notice: TxNotice } | null>(null)

  const { wallet, ms, account, ledgerTime } = gate
  const source = wallet.status === "connected" ? wallet.publicKey : null
  const decimals = market?.underlying.decimals ?? TOKEN_DECIMALS

  // --- Amounts (Review Focus 3): parsed without rounding, checked against the balance spent (R24).
  const fields = config.fields.map((spec) => {
    const text = texts[spec.id] ?? ""
    const balance = account ? (spec.max ? spec.max(account) : spendBalance(config.action, spec.id, account)) : undefined
    const check = checkAmount(text, { decimals: fieldDecimals(config.action, spec.id, decimals), unit: spec.unit, optional: spec.optional, balance })
    // An untouched empty field is not flagged yet; it still keeps signing off.
    const error = !check.ok && (text.trim() !== "" || touched[spec.id]) ? check.message : undefined
    return { spec, text, balance, check, error }
  })
  const inputs: PanelInputs = {}
  for (const f of fields) if (f.check.ok) inputs[f.spec.id] = f.check.raw
  const fieldError = fields.some((f) => !f.check.ok)
  const amount = inputs.amount ?? 0n
  const secondaryAmount = config.fields.some((f) => f.id === "secondaryAmount") ? (inputs.secondaryAmount ?? 0n) : undefined
  const complete = !fieldError && amountsComplete(config.action, amount, secondaryAmount)
  const deadlineAt = (t: number) => BigInt(Math.floor(t) + deadlineSeconds)

  // --- Exact quote (R28: every action), as the connected user, once the network clock is known.
  const draft = { action: config.action, marketId, source: source ?? "", amount, secondaryAmount }
  // An action this release does not offer (R47) is never simulated: it can never be signed.
  const simInput: ActionInput | null =
    source !== null && complete && ledgerTime !== null && !meta.disabled ? { ...draft, guards: {}, deadline: deadlineAt(ledgerTime) } : null
  const sim = useSimulation(simInput)
  const guards = sim.guards?.ok ? sim.guards.guards : undefined

  // --- Gates (spec §5). Not evaluated while the clock or the data cannot be trusted (R32, R35).
  let blockers: Blocker[] = gate.unavailable
  if (gate.base) {
    blockers = evaluateGates({ ...draft, guards: {}, deadline: 0n }, { ...gate.base, simulation: sim.outcome })
    if (sim.guards && !sim.guards.ok) blockers = [...blockers, { code: "quote", message: sim.guards.reason }]
    // Nothing is simulated until the amounts are complete, nor ever for an action that is not offered:
    // the amount, or the `disabled` blocker, is the reason, not a missing quote.
    if (!complete || meta.disabled) blockers = blockers.filter((b) => b.code !== "quote")
    if (fieldError) {
      // The gates saw 0 for an amount that does not parse; the field's own refusal replaces theirs.
      const several = fields.length > 1
      const refusals: Blocker[] = fields.flatMap((f) =>
        f.check.ok ? [] : [{ code: f.check.code, message: several ? `${f.spec.label}: ${f.check.message}` : f.check.message }],
      )
      const rank = (b: Blocker) => BLOCKER_ORDER.indexOf(b.code)
      blockers = [...refusals, ...blockers.filter((b) => b.code !== "amount" && b.code !== "balance")].sort((a, b) => rank(a) - rank(b))
    }
  }
  // Signing needs every gate evaluated (a context) and passed, and floors from this input's simulation.
  const canReview = gate.base !== null && simInput !== null && blockers.length === 0 && guards !== undefined
  const buildInput = (): ActionInput | null =>
    canReview && simInput && guards && ledgerTime !== null ? { ...draft, source: simInput.source, guards, deadline: deadlineAt(ledgerTime) } : null

  // --- Previews: exact from the simulation, else indicative from on-chain views.
  const ctx = { account, accountStatus: gate.accountStatus, ledgerTime }
  const quoteLines = useQuoteLines(config, ms, inputs, ctx)
  const output = sim.output
  // Shown only alongside live market data, but computed from the simulation and the input alone.
  const exactLines = ms && output ? [...safeLines(() => config.exact(output, { inputs, guards })), ...(guards ? floorLines(guards, config, slippageBps, decimals) : [])] : null
  const describeResult = (out: ActionOutput, input: ActionInput): string | undefined => {
    try {
      return config.result?.(out, { input }) || undefined
    } catch {
      return undefined
    }
  }
  const indicativeLines = ms ? [...safeLines(() => config.indicative(ms, inputs, ctx)), ...(quoteLines ?? [])] : []
  // R38: market context beside either preview; it may compare the exact output with market reads.
  const marketOf = config.market
  const marketLines = ms && marketOf ? safeLines(() => marketOf(ms, { ...ctx, inputs, output })) : []
  const notes = configNotes(config, ms, account)

  // The review is bound to all of this; a change remounts SignFlow and discards it (Review Focus 2).
  const owner = JSON.stringify(wallet)
  const ownerKey = JSON.stringify([marketId, config.action, owner, texts.amount ?? "", texts.secondaryAmount ?? "", slippageBps.toString(), deadlineSeconds])
  const restoreCall =
    sim.outcome && !sim.outcome.ok && sim.outcome.kind === "restore_required" && sim.simulated && source !== null
      ? { source, invocation: invocationFor(manifest, sim.simulated) }
      : null

  if (!market) return null
  return (
    // A size container: the header stacks while the panel is narrow (375 px, or a desktop column),
    // so a long title such as "Add liquidity (SY only)" is never squeezed beside its description.
    <Card className="@container">
      <CardHeader className="flex-col gap-1 @lg:flex-row @lg:gap-4">
        <CardTitle>{meta.label}</CardTitle>
        {config.description ? <CardDescription>{config.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-5">
        {fields.map((f) => (
          <AmountField
            key={f.spec.id}
            id={`${baseId}-${f.spec.id}`}
            spec={f.spec}
            text={f.text}
            error={f.error}
            balance={f.balance}
            decimals={fieldDecimals(config.action, f.spec.id, decimals)}
            onChange={(text) => {
              setTexts((t) => ({ ...t, [f.spec.id]: text }))
              setTouched((t) => ({ ...t, [f.spec.id]: true }))
            }}
            onBlur={() => setTouched((t) => ({ ...t, [f.spec.id]: true }))}
          />
        ))}

        <section aria-label="Preview" className="grid gap-2">
          {!ms ? (
            gate.marketStatus === "loading" ? (
              <Skeleton className="h-12 w-full" />
            ) : (
              <p className="text-sm text-ink">
                {gate.marketStatus === "stale" ? `${STALE}.` : "Unavailable: this market's data could not be read."} No preview is shown.
              </p>
            )
          ) : exactLines ? (
            <>
              <p className="label">Exact (simulated)</p>
              <PreviewList lines={exactLines} />
            </>
          ) : indicativeLines.length > 0 ? (
            <>
              <p className="label">Indicative</p>
              <PreviewList lines={indicativeLines} />
              <p className="text-xs text-ink-muted">
                {source === null
                  ? "Estimated from on-chain views. Connect a wallet for an exact quote."
                  : sim.pending && simInput
                    ? "Estimated from on-chain views. Getting an exact quote…"
                    : "Estimated from on-chain views. The exact quote comes from simulating the transaction."}
              </p>
            </>
          ) : null}
          {marketLines.length > 0 ? (
            <>
              <p className="label mt-2">{config.marketLabel ?? "Market (indicative)"}</p>
              <PreviewList lines={marketLines} />
            </>
          ) : null}
        </section>

        {notes.length > 0 ? (
          <div className="grid gap-1 text-sm text-ink-muted">
            {notes.map((note, i) => (
              <p key={`${i}-${note}`}>{note}</p>
            ))}
          </div>
        ) : null}

        <GateList blockers={blockers} />

        <SignFlow
          key={ownerKey}
          label={meta.label}
          canReview={canReview}
          blockers={blockers}
          buildInput={buildInput}
          describeResult={describeResult}
          restoreCall={restoreCall}
          onRestored={sim.refresh}
          onNotice={(notice) => {
            setLast({ owner, notice })
            // Once a transaction reached the network (confirmed, or result not known yet) the form
            // starts over as on first load: the old amounts would fail against the new balances, and
            // must not be sent twice. A refused or failed attempt keeps them, to correct and retry.
            if (notice.tone !== "error") {
              setTexts({})
              setTouched({})
            }
          }}
          ledgerTime={ledgerTime}
          network={manifest.network}
        />

        {last && last.owner === owner ? <TxNoticeView notice={last.notice} /> : null}
      </CardContent>
    </Card>
  )
}
