import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { formatUnixTime } from "@/lib/protocol/format"
import type { Review } from "@/lib/protocol/review"
import { ReviewDialog } from "../actions/review-dialog"

const NOW = 1_800_000_000

function review(summary: Partial<Review["summary"]>): Review {
  return {
    input: { action: "buy_pt", marketId: "m1", source: "G", amount: 1n, guards: { minOut: 1n }, deadline: 0n },
    invocation: { contractId: "CROUTER", functionName: "swap_sy_for_pt", args: [] },
    unsignedXdr: "AAAA",
    unsignedXdrHash: "sha256:00",
    fee: "100",
    preparedAtMs: NOW * 1000,
    expiresAtMs: NOW * 1000 + 60_000,
    summary: { give: ["10 SY"], getAtLeast: ["9 PT"], fees: ["Network fee: up to 0.00001 XLM"], validUntil: NOW + 300, ...summary },
    callTree: ["Router.swap_sy_for_pt"],
  }
}

function show(r: Review, ledgerTime: number | null = NOW) {
  render(
    <ReviewDialog
      open
      title="Buy PT"
      phase="review"
      review={r}
      blockers={[]}
      ledgerTime={ledgerTime}
      secondsLeft={60}
      pending={false}
      canSign
      onSign={() => {}}
      onClose={() => {}}
    />,
  )
  return screen.getByRole("dialog").textContent ?? ""
}

describe("ReviewDialog time limits (M3)", () => {
  it("names the transaction's own time bound when it closes before the contract deadline", () => {
    const text = show(review({ deadline: NOW + 1800, validUntil: NOW + 300 }))
    expect(text).toContain(`${formatUnixTime(NOW + 300)}, in 5m 0s by ledger time. After it the network refuses the transaction`)
    expect(text).toContain(`Your deadline, ${formatUnixTime(NOW + 1800)}, comes later, so this is the limit that applies.`)
    // The later contract deadline is never presented as the moment the network refuses it.
    expect(text).not.toContain(`${formatUnixTime(NOW + 1800)}, in 30m 0s by ledger time. After it the network refuses`)
  })

  it("names the contract deadline when it comes first, and says who refuses what", () => {
    const text = show(review({ deadline: NOW + 120, validUntil: NOW + 300 }))
    expect(screen.getByText("Deadline")).toBeTruthy()
    expect(text).toContain(`${formatUnixTime(NOW + 120)}, in 2m 0s by ledger time. If the transaction lands after it, the contract refuses it`)
    expect(text).not.toContain("network refuses")
  })

  it("an action without a deadline shows how long the transaction is valid", () => {
    const text = show(review({ deadline: undefined, validUntil: NOW + 300 }))
    expect(screen.getByText("Valid until")).toBeTruthy()
    expect(text).toContain(`${formatUnixTime(NOW + 300)}, in 5m 0s by ledger time. After it the network refuses the transaction`)
  })

  it("says to check the device clock when the time bound has already passed by ledger time", () => {
    const text = show(review({ deadline: NOW + 300, validUntil: NOW - 600 }))
    expect(text).toContain("Check your device clock")
  })
})
