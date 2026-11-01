import type { AccountStatus } from "@/hooks/use-gate-context"
import type { FieldKey } from "@/lib/app/amounts"
import type { AccountState } from "@/lib/protocol/account-state"
import type { ActionId, ActionInput, GuardValues } from "@/lib/protocol/actions"
import type { ActionOutput } from "@/lib/protocol/guards"
import type { MarketState } from "@/lib/protocol/market-state"
import type { Live } from "@/lib/protocol/types"

export type { FieldKey }

/** One amount input. Its value becomes `ActionInput.amount` or `ActionInput.secondaryAmount`. */
export type FieldSpec = {
  id: FieldKey
  /** The input's accessible label, e.g. "SY to spend". */
  label: string
  /** Token code shown beside the input and in its messages, e.g. "SY". */
  unit: string
  /** An empty field means 0 (redeem's PT or YT side). Default: an empty field is refused. */
  optional?: boolean
  /** The balance MAX fills and the amount is checked against. Default: what the field spends (R24). */
  max?: (account: AccountState) => Live<bigint>
}

/** One row of a preview: `label` and its formatted `value` (amounts already in token decimals). */
export type PreviewLine = { label: string; value: string; hint?: string }

/** The amounts that parse, by field. A field with an error is absent. */
export type PanelInputs = Partial<Record<FieldKey, bigint>>

export type IndicativeContext = {
  /** The connected account's state, when it has been read (never another address's). */
  account?: AccountState
  /** Why `account` is absent: no wallet (the default), still loading, or unreadable (V6). */
  accountStatus?: AccountStatus
  /** Latest ledger close time (seconds), or null until it loads. Never the browser clock. */
  ledgerTime: number | null
}

/**
 * What an exact preview may use: the simulated output (its first argument), the amounts entered and
 * the floors that will be signed. Deliberately no market state: an exact line is never computed
 * from an indicative read. Comparisons with market values (e.g. price impact against `pt_price`)
 * belong in `market` (R38).
 */
export type ExactContext = {
  inputs: PanelInputs
  /** The floors that will be signed, when the simulation gave usable ones. */
  guards?: GuardValues
}

/**
 * What the `market` section may use (R38): the indicative context, the amounts entered and, once it
 * is in, the exact simulated output for exactly these amounts (it is dropped on any input change).
 */
export type MarketContext = IndicativeContext & {
  inputs: PanelInputs
  output?: ActionOutput
}

/** What a result message may use: the input that was signed (amounts, floors, deadline). */
export type ResultContext = { input: ActionInput }

/** How a signed floor is labelled; the panel renders every floor itself. */
export type FloorSpec = { label: string; unit: string }

/**
 * One action panel (Tasks 15–18 write these). The panel owns everything else: parsing and MAX,
 * the gates, the exact simulation, the floors, the review, signing and the result.
 */
export type PanelConfig = {
  action: ActionId
  /** In `ActionInput` order: `amount` first. Claim has none. */
  fields: FieldSpec[]
  /** Optional line under the title. */
  description?: string
  /** Preview from on-chain views, labelled "Indicative". Pure and synchronous; may throw. */
  indicative(ms: MarketState, inputs: PanelInputs, ctx: IndicativeContext): PreviewLine[]
  /** Extra indicative lines that need a read (e.g. a pool quote); also labelled "Indicative". */
  quote?(ms: MarketState, inputs: PanelInputs, ctx: IndicativeContext): Promise<PreviewLine[]>
  /** Preview from the simulated return value: the exact numbers. Pure; may throw. */
  exact(output: ActionOutput, ctx: ExactContext): PreviewLine[]
  /**
   * Market context that stays visible beside the indicative and the exact preview (R38), e.g. the
   * pool's spot price, the price impact of the exact quote against it, the swap fee, the room left
   * under a limit. Every line is indicative: it reads market state, which may move before the
   * transaction lands. Pure and synchronous; may throw (the section then says why).
   */
  market?(ms: MarketState, ctx: MarketContext): PreviewLine[]
  /** Heading of the `market` section. Default "Market (indicative)". */
  marketLabel?: string
  /**
   * What a confirmed transaction did, from its decoded return value, e.g. "You bought 100 PT."
   * (spec §6 step 7). Used as the success message; "<label> confirmed." when absent, empty or throwing.
   */
  result?(output: ActionOutput, ctx: ResultContext): string
  /** Labels of the guard values the panel shows as "at least" lines. */
  floors?: Partial<Record<keyof GuardValues, FloorSpec>>
  /** Plain-words notes under the preview (e.g. what an SY balance can be used for). */
  notes?(ctx: { ms?: MarketState; account?: AccountState }): string[]
}
