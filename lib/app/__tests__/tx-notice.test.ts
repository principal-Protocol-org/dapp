// @vitest-environment node
import { describe, expect, it } from "vitest"
import { SubmissionRejectedError } from "@/lib/protocol/stellar"
import { explorerTxUrl, noticeForError, noticeForResult } from "../tx-notice"

const HASH = "ab".repeat(32)

describe("explorerTxUrl", () => {
  it("links Testnet transactions to stellar.expert", () => {
    expect(explorerTxUrl("testnet", HASH)).toBe(`https://stellar.expert/explorer/testnet/tx/${HASH}`)
  })
  it("has no link for a local network", () => {
    expect(explorerTxUrl("local", HASH)).toBeNull()
  })
})

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
    const reason = "Amounts moved between your review and inclusion (the pool or oracle changed). Nothing was taken except the network fee; prepare again."
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
