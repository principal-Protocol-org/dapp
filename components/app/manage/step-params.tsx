"use client"

import { useId } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UNAVAILABLE } from "@/components/app/live"
import { knownUnderlyings, PARAM_LABEL, type MarketParams, type ParamDefaults, type ParamDraft, type ParamErrors } from "@/lib/protocol/factory"
import type { Manifest, MarketContractName } from "@/lib/protocol/types"

export type StepParamsProps = {
  manifest: Manifest
  draft: Partial<ParamDraft>
  errors: ParamErrors
  /** Fields a half-deployed market already fixed on chain: shown, not editable. */
  locked: ReadonlySet<keyof MarketParams>
  /** The current market's settings, to say where each default came from or why it is missing. */
  defaults?: ParamDefaults
  onChange(key: keyof MarketParams, value: string): void
  onNext(): void
}

type FieldSpec = { key: keyof MarketParams; label: string; help?: string; mono?: boolean; numeric?: boolean }

const TOKEN_FIELDS: FieldSpec[] = [
  { key: "ptName", label: PARAM_LABEL.ptName },
  { key: "ptSymbol", label: PARAM_LABEL.ptSymbol },
  { key: "ytName", label: PARAM_LABEL.ytName },
  { key: "ytSymbol", label: PARAM_LABEL.ytSymbol },
]
const FEE_FIELDS: FieldSpec[] = [
  { key: "tokenizationFeeBps", label: "Tokenization fee (bps)", help: "Charged on minting. At most 100 (1%).", numeric: true },
  { key: "ytFeeBps", label: "YT fee (bps)", help: "Share of claimed yield. At most 5000 (50%).", numeric: true },
  { key: "swapFeeTierBps", label: "Swap fee tier (bps)", help: "Yearly swap fee rate, scaled by the time left. At most 500.", numeric: true },
  { key: "protocolShareBps", label: "Protocol share (bps)", help: "The treasury's share of every fee. At most 10000 (100%).", numeric: true },
  {
    key: "timeStretchYears",
    label: "Time stretch (years)",
    help: "How gently the pool's curve flattens, 1 to 20. The time to maturity must stay under three quarters of it.",
    numeric: true,
  },
]
const ADDRESS_FIELDS: FieldSpec[] = [
  { key: "treasury", label: PARAM_LABEL.treasury, help: "Receives the protocol's share of the fees. It must hold the asset.", mono: true },
  { key: "protocolAdmin", label: PARAM_LABEL.protocolAdmin, help: "Can change the protocol share and the treasury, and claims the protocol's fees.", mono: true },
]

const CODE_NAME: Record<MarketContractName, string> = {
  sy: "SY wrapper",
  pt: "PT",
  yt: "YT",
  config: "Market config",
  manager: "PrincipalManager",
  pool: "Pool",
  recoveryEscrow: "Recovery escrow",
}

function Fact({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="label">{label}</dt>
      <dd className="font-mono text-xs break-all text-ink">{value ?? "Not in the manifest"}</dd>
    </div>
  )
}

/**
 * Step 1 (spec 0002 §5): the market's parameters. Defaults are the current market's, read on its
 * contracts; the treasury and the protocol admin are plain fields because the issuer signs them into
 * the market and their defaults come from an RPC read. The shared contracts and the code every
 * market contract runs come from the manifest and are shown read-only.
 */
export function StepParams({ manifest, draft, errors, locked, defaults, onChange, onNext }: StepParamsProps) {
  const id = useId()
  const assets = [...knownUnderlyings(manifest).entries()]
  const ready = Object.keys(errors).length === 0

  const missingDefault = (key: keyof MarketParams): string | undefined => {
    if (!defaults || locked.has(key) || !(key in defaults)) return undefined
    const read = defaults[key as Exclude<keyof ParamDefaults, "market">]
    return read.status === "unavailable" ? `Default ${UNAVAILABLE.toLowerCase()} (${read.error}): enter it.` : undefined
  }

  const field = (f: FieldSpec) => {
    const fieldId = `${id}-${f.key}`
    const error = errors[f.key]
    const note = locked.has(f.key) ? "Fixed on chain by the contracts already deployed." : (missingDefault(f.key) ?? f.help)
    return (
      <div key={f.key} className="grid min-w-0 gap-1.5">
        <Label htmlFor={fieldId}>{f.label}</Label>
        <Input
          id={fieldId}
          value={draft[f.key] ?? ""}
          readOnly={locked.has(f.key)}
          inputMode={f.numeric ? "numeric" : undefined}
          autoComplete="off"
          spellCheck={false}
          className={f.mono || f.numeric ? "font-mono" : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? `${fieldId}-note` : undefined}
          onChange={(e) => onChange(f.key, e.target.value)}
        />
        {note ? (
          <p id={`${fieldId}-note`} className="text-xs/5 text-ink-muted">
            {note}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs/5 text-negative">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  const assetId = `${id}-underlying`
  const maturityId = `${id}-maturity`
  return (
    <section aria-labelledby={`${id}-heading`} className="grid gap-6">
      <div className="grid gap-1">
        <h2 id={`${id}-heading`} className="font-serif text-2xl text-ink">
          Step 1 of 7: Parameters
        </h2>
        <p className="text-sm text-ink-muted">
          {defaults
            ? `Defaults are those of ${defaults.market.displayName}, read on its contracts. Check each one: you sign them into the new market.`
            : "This network lists no market to take defaults from: enter each parameter."}
        </p>
      </div>

      <fieldset className="grid gap-4">
        <legend className="label mb-2">Asset and maturity</legend>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-[560px]:grid-cols-2">
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={assetId}>{PARAM_LABEL.underlying}</Label>
            <select
              id={assetId}
              value={draft.underlying ?? ""}
              disabled={locked.has("underlying")}
              aria-invalid={errors.underlying ? true : undefined}
              onChange={(e) => onChange("underlying", e.target.value)}
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-sm text-ink"
            >
              {assets.map(([sac, a]) => (
                <option key={sac} value={sac}>
                  {a.code} ({sac.slice(0, 6)}…{sac.slice(-6)})
                </option>
              ))}
            </select>
            {errors.underlying ? (
              <p role="alert" className="text-xs/5 text-negative">
                {errors.underlying}
              </p>
            ) : null}
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={maturityId}>Maturity (UTC)</Label>
            <Input
              id={maturityId}
              type="datetime-local"
              step={(draft.maturity?.length ?? 0) > 16 ? 1 : 60}
              value={draft.maturity ?? ""}
              readOnly={locked.has("maturity")}
              className="font-mono"
              aria-invalid={errors.maturity ? true : undefined}
              aria-describedby={`${maturityId}-note`}
              onChange={(e) => onChange("maturity", e.target.value)}
            />
            <p id={`${maturityId}-note`} className="text-xs/5 text-ink-muted">
              {locked.has("maturity") ? "Fixed on chain by the contracts already deployed." : "Date and time in UTC, checked against the ledger time."}
            </p>
            {errors.maturity ? (
              <p role="alert" className="text-xs/5 text-negative">
                {errors.maturity}
              </p>
            ) : null}
          </div>
        </div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="label mb-2">Tokens</legend>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-[560px]:grid-cols-2">{TOKEN_FIELDS.map(field)}</div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="label mb-2">Fees and pool</legend>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-[560px]:grid-cols-2">{FEE_FIELDS.map(field)}</div>
      </fieldset>

      <fieldset className="grid gap-4">
        <legend className="label mb-2">Addresses you sign into the market</legend>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">{ADDRESS_FIELDS.map(field)}</div>
      </fieldset>

      <section aria-labelledby={`${id}-manifest`} className="grid gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="grid gap-1">
          <h3 id={`${id}-manifest`} className="font-serif text-lg text-ink">
            From this network&apos;s manifest (read-only)
          </h3>
          <p className="text-xs/5 text-ink-muted">
            The shared contracts the market is wired to, and the code each of its contracts runs. The factory deploys exactly this code.
          </p>
        </div>
        <dl className="grid grid-cols-[minmax(0,1fr)] gap-3 min-[560px]:grid-cols-2">
          <Fact label="MarketFactory" value={manifest.shared.factory} />
          <Fact label="Permissioning" value={manifest.shared.permissioning} />
          <Fact label="Oracle" value={manifest.shared.oracle} />
          <Fact label="RiskControl" value={manifest.shared.riskControl} />
          <Fact label="Router" value={manifest.shared.router} />
        </dl>
        <dl className="grid grid-cols-[minmax(0,1fr)] gap-3 min-[560px]:grid-cols-2">
          {(Object.keys(CODE_NAME) as MarketContractName[]).map((k) => (
            <Fact key={k} label={`${CODE_NAME[k]} code`} value={manifest.wasmHashes[k]} />
          ))}
        </dl>
      </section>

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!ready} onClick={onNext}>
          Next: preview the addresses
        </Button>
      </div>
    </section>
  )
}
