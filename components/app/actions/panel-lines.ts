import { formatAmount, formatTokenAmount } from "@/lib/protocol/format"
import type { ActionOutput } from "@/lib/protocol/guards"

/** Every Principal token (SY, PT, YT, LP) has 7 decimals; the underlying's come from the manifest. */
export const TOKEN_DECIMALS = 7

/** A preview amount with its unit, exact to the raw unit: "100.0000 SY", "4.5431818 STA". */
export const tokens = (raw: bigint, unit: string, decimals = TOKEN_DECIMALS) => `${formatTokenAmount(raw, decimals)} ${unit}`

/** An exact amount for a sentence, trailing zeros trimmed: "100", "104.9475". */
export const plain = (raw: bigint, decimals = TOKEN_DECIMALS) => formatAmount(raw, decimals, decimals)

/** The simulated output of the expected kind; any other kind throws (the line then says so). */
export function outputOf<K extends ActionOutput["kind"]>(output: ActionOutput, kind: K): Extract<ActionOutput, { kind: K }> {
  if (output.kind !== kind) throw new Error("The simulation returned another kind of result.")
  return output as Extract<ActionOutput, { kind: K }>
}

/** The single amount most actions return. */
export const amountOf = (output: ActionOutput) => outputOf(output, "amount").value

export const max0 = (value: bigint) => (value > 0n ? value : 0n)
