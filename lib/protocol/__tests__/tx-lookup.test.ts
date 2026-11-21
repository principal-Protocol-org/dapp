// @vitest-environment node
import { nativeToScVal } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import { lookupTransaction, type PollRpcServer } from "../tx-lookup"
import type { Manifest } from "../types"

/**
 * One look at a sent transaction by its hash (spec 0005 M-21), as the route runner and the single
 * action panel both use it. RPC is a fake: these tests never reach a network.
 */

const manifest = { rpcUrl: "https://rpc.example" } as Manifest
const HASH = "ab".repeat(32)
const SENT = 1_700_000_000
const tx = { hash: HASH, validUntil: SENT + 300, sentAt: SENT }

/** A fake RPC answering every `getTransaction` with `answer`, recording the hashes asked. */
function rpc(answer: Record<string, unknown>) {
  const getTransaction = vi.fn<(hash: string) => Promise<Record<string, unknown>>>(async () => answer)
  return { server: { getTransaction } as unknown as PollRpcServer, getTransaction }
}
const notFound = (latest: unknown, oldest: unknown) => rpc({ status: "NOT_FOUND", latestLedgerCloseTime: latest, oldestLedgerCloseTime: oldest })

describe("lookupTransaction", () => {
  it("asks RPC once, by the transaction's hash", async () => {
    const { server, getTransaction } = notFound(SENT + 20, SENT - 3600)
    await lookupTransaction(manifest, tx, { server })
    expect(getTransaction).toHaveBeenCalledTimes(1)
    expect(getTransaction).toHaveBeenCalledWith(HASH)
  })

  it("is pending before the time bound: not final, not lost", async () => {
    const { server } = notFound(SENT + 20, SENT - 3600)
    expect(await lookupTransaction(manifest, tx, { server })).toEqual({ status: "NOT_FOUND", final: false, lost: false })
    // Exactly at the time bound the network can still include it.
    const { server: atBound } = notFound(SENT + 300, SENT - 3600)
    expect(await lookupTransaction(manifest, tx, { server: atBound })).toEqual({ status: "NOT_FOUND", final: false, lost: false })
  })

  it("is final after the time bound once RPC's history reaches back before the send", async () => {
    const { server } = notFound(SENT + 400, SENT - 3600)
    expect(await lookupTransaction(manifest, tx, { server })).toEqual({ status: "NOT_FOUND", final: true, lost: false })
  })

  it("is lost after the time bound when RPC's history does not reach back that far", async () => {
    // The oldest ledger RPC keeps closed after the send: the transaction may have landed before it.
    const { server } = notFound(SENT + 400, SENT + 100)
    expect(await lookupTransaction(manifest, tx, { server })).toEqual({ status: "NOT_FOUND", final: false, lost: true })
    // Within the clock slack of the send counts as not reaching back either.
    const { server: edge } = notFound(SENT + 400, SENT - 30)
    expect(await lookupTransaction(manifest, tx, { server: edge })).toEqual({ status: "NOT_FOUND", final: false, lost: true })
  })

  it("reads the close times RPC passes through as decimal strings", async () => {
    const { server } = notFound(String(SENT + 400), String(SENT - 3600))
    expect(await lookupTransaction(manifest, tx, { server })).toEqual({ status: "NOT_FOUND", final: true, lost: false })
  })

  it("never calls a transaction final or lost on close times it cannot read", async () => {
    for (const [latest, oldest] of [
      [undefined, undefined],
      ["", ""],
      ["soon", "long ago"],
      [0, 0],
    ]) {
      const { server } = notFound(latest, oldest)
      expect(await lookupTransaction(manifest, tx, { server })).toEqual({ status: "NOT_FOUND", final: false, lost: false })
    }
  })

  it("calls a transaction with no recorded time bound lost, never final (a route step logged without one)", async () => {
    const { server } = notFound(SENT + 400, SENT - 3600)
    expect(await lookupTransaction(manifest, { hash: HASH, sentAt: SENT }, { server })).toEqual({ status: "NOT_FOUND", final: false, lost: true })
    // No send time: the history cannot be shown to cover it.
    expect(await lookupTransaction(manifest, { hash: HASH, validUntil: SENT + 300 }, { server })).toEqual({ status: "NOT_FOUND", final: false, lost: true })
  })

  it("passes a success's return value through, decoded from its ScVal", async () => {
    const { server } = rpc({ status: "SUCCESS", returnValue: nativeToScVal(95n, { type: "i128" }) })
    expect(await lookupTransaction(manifest, tx, { server })).toEqual({ status: "SUCCESS", returnValue: 95n })
    const { server: bare } = rpc({ status: "SUCCESS" })
    expect(await lookupTransaction(manifest, tx, { server: bare })).toEqual({ status: "SUCCESS" })
  })

  it("names the cause of a failed transaction in plain words (R49)", async () => {
    const { server } = rpc({ status: "FAILED" })
    expect(await lookupTransaction(manifest, tx, { server })).toEqual({
      status: "FAILED",
      reason: "The network did not say why. Nothing was taken except the network fee.",
    })
  })

  it("rejects when RPC cannot be asked, so the caller keeps waiting", async () => {
    const server = { getTransaction: vi.fn(async () => Promise.reject(new Error("socket hang up"))) } as unknown as PollRpcServer
    await expect(lookupTransaction(manifest, tx, { server })).rejects.toThrow("socket hang up")
  })
})
