// @vitest-environment node
import { describe, expect, it } from "vitest"
import { formatUnixTime } from "@/lib/protocol/format"
import { SubmissionRejectedError } from "@/lib/protocol/stellar"
import { noticeForError, noticeForPending, noticeForResult, noticeForSettled } from "../tx-notice"

const HASH = "ab".repeat(32)

describe("noticeForResult", () => {
  it("confirms a success with its link", () => {
    expect(noticeForResult("Buy PT", { hash: HASH, status: "SUCCESS" }, "testnet")).toEqual({
      tone: "success",
      title: "Buy PT confirmed.",
      hash: HASH,
      url: `https://stellar.expert/explorer/testnet/tx/${HASH}`,
    })
  })

  it("uses the action's result message as the title of a success", () => {
    const n = noticeForResult("Buy PT", { hash: HASH, status: "SUCCESS" }, "testnet", "You bought 100 PT.")
    expect(n.title).toBe("You bought 100 PT.")
    expect(n.hash).toBe(HASH)
    // Never for anything but a success.
    expect(noticeForResult("Buy PT", { hash: HASH, status: "FAILED" }, "testnet", "You bought 100 PT.").title).toBe("Buy PT failed on-chain.")
  })

  it("keeps the hash of a success whose result could not be read", () => {
    const n = noticeForResult("Buy PT", { hash: HASH, status: "SUCCESS", decodeError: "The transaction succeeded, but its result could not be read (x)." }, "testnet")
    expect(n.tone).toBe("success")
    expect(n.detail).toMatch(/could not be read/)
    expect(n.hash).toBe(HASH)
  })

  it("keeps the hash of a failed transaction and says to look it up", () => {
    const n = noticeForResult("Buy PT", { hash: HASH, status: "FAILED" }, "testnet")
    expect(n.tone).toBe("error")
    expect(n.title).toBe("Buy PT failed on-chain.")
    expect(n.detail).toMatch(/look it up by its hash/)
    expect(n.hash).toBe(HASH)
    expect(n.url).toContain(HASH)
  })

  it("names the cause of a failed transaction (R49)", () => {
    const reason = "Amounts moved between your review and inclusion. Nothing was taken except the network fee; prepare again."
    const n = noticeForResult("Buy YT", { hash: HASH, status: "FAILED", reason }, "testnet")
    expect(n.tone).toBe("error")
    expect(n.title).toBe("Buy YT failed on-chain.")
    expect(n.detail).toBe(`${reason} Look it up by its hash for the details.`)
    expect(n.hash).toBe(HASH)
  })

  it("keeps the hash of an ambiguous result and says to look it up", () => {
    const n = noticeForResult("Buy PT", { hash: HASH, status: "NOT_FOUND" }, "local")
    expect(n.tone).toBe("warning")
    expect(n.detail).toMatch(/look it up by its hash/)
    expect(n.hash).toBe(HASH)
    expect(n.url).toBeNull()
    const polled = noticeForResult("Buy PT", { hash: HASH, status: "NOT_FOUND", pollError: "Sending failed. Look it up by its hash before trying again." }, "testnet")
    expect(polled.detail).toBe("Sending failed. Look it up by its hash before trying again.")
  })
})

describe("noticeForError", () => {
  it("keeps the hash of a refused submission", () => {
    const n = noticeForError("Buy PT", new SubmissionRejectedError("The network is busy.", HASH), "testnet")
    expect(n).toEqual({ tone: "error", title: "Buy PT was not accepted by the network.", detail: "The network is busy.", hash: HASH, url: `https://stellar.expert/explorer/testnet/tx/${HASH}` })
  })

  it("says nothing was sent for a refusal before submission", () => {
    expect(noticeForError("Buy PT", new Error("User declined"), "testnet")).toEqual({
      tone: "error",
      title: "Buy PT was not sent.",
      detail: "User declined",
    })
    expect(noticeForError("Buy PT", "weird", "testnet").detail).toBe("weird")
  })
})

describe("noticeForPending (M-21)", () => {
  it("says the last action was sent, is being checked, and until when it can land", () => {
    const n = noticeForPending("Buy PT", { hash: HASH, validUntil: 1_700_000_300 }, "testnet")
    expect(n).toEqual({
      tone: "warning",
      title: "Your last Buy PT was sent but is not confirmed yet.",
      detail: `Checking… It can still land until ${formatUnixTime(1_700_000_300)}.`,
      hash: HASH,
      url: `https://stellar.expert/explorer/testnet/tx/${HASH}`,
    })
    expect(noticeForPending("Buy PT", { hash: HASH, validUntil: 1_700_000_300 }, "local").url).toBeNull()
  })
})

describe("noticeForSettled (M-21)", () => {
  it("confirms a pending action that landed", () => {
    expect(noticeForSettled("Buy PT", HASH, { status: "SUCCESS", returnValue: 5n }, "testnet")).toEqual({
      tone: "success",
      title: "Buy PT confirmed.",
      hash: HASH,
      url: `https://stellar.expert/explorer/testnet/tx/${HASH}`,
    })
  })

  it("names the cause of a pending action that failed on-chain, as a direct result does", () => {
    const reason = "Cause: the contract call failed. Nothing was taken except the network fee."
    expect(noticeForSettled("Buy PT", HASH, { status: "FAILED", reason }, "testnet")).toEqual(
      noticeForResult("Buy PT", { hash: HASH, status: "FAILED", reason }, "testnet"),
    )
  })

  it("says a pending action that can no longer land did not land, and moved nothing", () => {
    const n = noticeForSettled("Buy PT", HASH, { status: "NOT_FOUND", final: true, lost: false }, "testnet")
    expect(n.tone).toBe("warning")
    expect(n.title).toBe("Buy PT did not land.")
    expect(n.detail).toBe("Its time limit passed before the network included it, so it moved nothing and charged no fee. You can review it again.")
    expect(n.hash).toBe(HASH)
  })

  it("says when the network can no longer tell whether a pending action landed", () => {
    const n = noticeForSettled("Buy PT", HASH, { status: "NOT_FOUND", final: false, lost: true }, "testnet")
    expect(n.tone).toBe("warning")
    expect(n.title).toBe("Buy PT: the network can no longer say whether it landed.")
    expect(n.detail).toMatch(/can no longer land/)
    expect(n.detail).toMatch(/look it up by its hash and check your balances/i)
    expect(n.hash).toBe(HASH)
  })

  it("an answer that is still pending reads as a result not known yet", () => {
    expect(noticeForSettled("Buy PT", HASH, { status: "NOT_FOUND", final: false, lost: false }, "testnet")).toEqual(
      noticeForResult("Buy PT", { hash: HASH, status: "NOT_FOUND" }, "testnet"),
    )
  })
})
