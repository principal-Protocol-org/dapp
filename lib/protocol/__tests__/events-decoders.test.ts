// @vitest-environment node
import { Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import { decodeEvent, type Role } from "../events"

const addr = () => Keypair.random().publicKey()
const A = addr()
const B = addr()
const C = addr()

/** The data a contract publishes, round-tripped the way the indexer reads it: ScVal then native. */
const native = (value: unknown, type?: Record<string, unknown>): unknown => {
  const sc = nativeToScVal(value, type as never)
  return scValToNative(xdr.ScVal.fromXDR(sc.toXDR()))
}
const addrVal = (a: string) => nativeToScVal(a, { type: "address" })
const tuple = (...vals: xdr.ScVal[]) => scValToNative(xdr.ScVal.scvVec(vals))

type Case = { role: Role; topic: string; data: unknown; fields: Record<string, unknown> }

const cases: Case[] = [
  // oracle_adapter
  {
    role: "oracle",
    topic: "ref_rej",
    data: tuple(nativeToScVal(11500000n, { type: "i128" }), nativeToScVal(1794606978n, { type: "u64" }), nativeToScVal("deviate", { type: "symbol" })),
    fields: { value: 11500000n, timestamp: 1794606978n, reason: "deviate" },
  },
  {
    role: "oracle",
    topic: "src_set",
    data: tuple(addrVal(A), addrVal(B)),
    fields: { primary: A, fallback: B },
  },
  {
    role: "oracle",
    topic: "src_set",
    data: tuple(addrVal(A), xdr.ScVal.scvVoid()),
    fields: { primary: A, fallback: null },
  },
  {
    role: "oracle",
    topic: "feed_set",
    data: tuple(addrVal(A), xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol("USDY")])),
    fields: { feed: A, asset: ["Other", "USDY"] },
  },
  { role: "oracle", topic: "adm_xfer", data: tuple(addrVal(A), addrVal(B)), fields: { current_admin: A, new_admin: B } },
  // permissioning
  { role: "permissioning", topic: "acc_grant", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, account: B } },
  { role: "permissioning", topic: "acc_rev", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, account: B } },
  { role: "permissioning", topic: "acc_batch", data: native(A, { type: "address" }), fields: { caller: A } },
  { role: "permissioning", topic: "ast_grant", data: tuple(addrVal(A), addrVal(B), addrVal(C)), fields: { caller: A, account: B, asset: C } },
  { role: "permissioning", topic: "ast_rev", data: tuple(addrVal(A), addrVal(B), addrVal(C)), fields: { caller: A, account: B, asset: C } },
  { role: "permissioning", topic: "adm_xfer", data: tuple(addrVal(A), addrVal(B)), fields: { current_admin: A, new_admin: B } },
  // risk_control
  { role: "riskControl", topic: "paused", data: tuple(addrVal(A), xdr.ScVal.scvBool(true)), fields: { caller: A, paused: true } },
  { role: "riskControl", topic: "paused", data: tuple(addrVal(A), xdr.ScVal.scvBool(false)), fields: { caller: A, paused: false } },
  { role: "riskControl", topic: "add_psr", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, pauser: B } },
  { role: "riskControl", topic: "rm_psr", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, pauser: B } },
  { role: "riskControl", topic: "add_cons", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, consumer: B } },
  { role: "riskControl", topic: "rm_cons", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, consumer: B } },
  {
    role: "riskControl",
    topic: "cb_limit",
    data: tuple(addrVal(A), nativeToScVal(100000000000000n, { type: "i128" })),
    fields: { caller: A, limit: 100000000000000n },
  },
  {
    role: "riskControl",
    topic: "ast_limit",
    data: tuple(addrVal(A), addrVal(B), nativeToScVal(5n, { type: "i128" })),
    fields: { caller: A, asset: B, limit: 5n },
  },
  {
    role: "riskControl",
    topic: "cb_window",
    data: tuple(addrVal(A), nativeToScVal(17280, { type: "u32" })),
    fields: { caller: A, ledgers: 17280 },
  },
  { role: "riskControl", topic: "adm_xfer", data: tuple(addrVal(A), addrVal(B)), fields: { current_admin: A, new_admin: B } },
  // bare-bool paused on sy / manager / pool
  { role: "sy", topic: "paused", data: true, fields: { paused: true } },
  { role: "manager", topic: "paused", data: false, fields: { paused: false } },
  { role: "pool", topic: "paused", data: true, fields: { paused: true } },
  // manager / pool
  { role: "manager", topic: "settled", data: native(10500000n, { type: "i128" }), fields: { rate: 10500000n } },
  {
    role: "manager",
    topic: "fee_claim",
    data: tuple(addrVal(A), nativeToScVal(7n, { type: "i128" }), xdr.ScVal.scvBool(true)),
    fields: { payee: A, owed: 7n, protocol: true },
  },
  {
    role: "pool",
    topic: "fee_claim",
    data: tuple(addrVal(A), nativeToScVal(9n, { type: "i128" }), xdr.ScVal.scvBool(false)),
    fields: { payee: A, owed: 9n, protocol: false },
  },
  // market_config
  {
    role: "config",
    topic: "fees_set",
    data: tuple(addrVal(A), nativeToScVal(10, { type: "u32" }), nativeToScVal(20, { type: "u32" }), nativeToScVal(30, { type: "u32" })),
    fields: { caller: A, tokenization_fee_bps: 10, yt_fee_bps: 20, swap_fee_tier_bps: 30 },
  },
  { role: "config", topic: "payee_set", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, payee: B } },
  { role: "config", topic: "share_set", data: tuple(addrVal(A), nativeToScVal(2500, { type: "u32" })), fields: { caller: A, protocol_share_bps: 2500 } },
  { role: "config", topic: "treas_set", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, treasury: B } },
  { role: "config", topic: "padm_xfer", data: tuple(addrVal(A), addrVal(B)), fields: { caller: A, new_admin: B } },
]

describe("decodeEvent: monitoring topics", () => {
  it.each(cases.map((c, i) => [`${c.role}.${c.topic} #${i}`, c] as const))("%s", (_name, c) => {
    expect(decodeEvent(c.role, c.topic, c.data)).toEqual({ role: c.role, topic: c.topic, fields: c.fields })
  })

  it("decodes the literal ref_rej example", () => {
    expect(decodeEvent("oracle", "ref_rej", [11500000n, 1794606978n, "deviate"])).toEqual({
      role: "oracle",
      topic: "ref_rej",
      fields: { value: 11500000n, timestamp: 1794606978n, reason: "deviate" },
    })
  })

  it("keeps the same topic distinct per role", () => {
    // riskControl paused is (caller, bool); a bare bool there, or a tuple on the pool, is not decoded.
    expect(decodeEvent("riskControl", "paused", true)).toBeNull()
    expect(decodeEvent("pool", "paused", [A, true])).toBeNull()
    expect(decodeEvent("pool", "src_set", [A, B])).toBeNull()
    // market_pool publishes no `settled` (only the manager does).
    expect(decodeEvent("pool", "settled", 1n)).toBeNull()
  })

  it("returns null on a wrong-length tuple", () => {
    expect(decodeEvent("permissioning", "ast_grant", [A, B])).toBeNull()
    expect(decodeEvent("oracle", "ref_rej", [1n, 2n])).toBeNull()
  })
})
