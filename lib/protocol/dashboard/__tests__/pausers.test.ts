// @vitest-environment node
import { describe, expect, it } from "vitest"
import testnetJson from "@/config/manifests/testnet.json"
import { parseManifest } from "../../manifest"
import { verifyCommand } from "../verify"
import { fetchPausers, indexedPausers, type PauserEvent } from "../pausers"
import { fakeReader, type Calls } from "./fake-reader"

const manifest = parseManifest(testnetJson)
const RISK = manifest.shared.riskControl
const ADMIN = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"
const A = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"
const B = "GBBPZ6KVXM72MVKSZMAPMM6O4UN6XID22ZO7EOEXGCKFCOZTNVY3JVXG"

const ev = (ledger: number, topic: "add_psr" | "rm_psr", pauser: string, index = 0): PauserEvent => ({
  id: `${String(ledger).padStart(19, "0")}-${String(index).padStart(10, "0")}`,
  contractId: RISK,
  topic,
  ledger,
  closeTime: "2026-11-14T00:00:00.000Z",
  txHash: `tx${ledger}${index}`,
  data: { caller: ADMIN, pauser },
})

describe("indexedPausers", () => {
  it("replays add_psr and rm_psr oldest first, whatever order the index lists them in (newest first)", () => {
    const rows = [ev(30, "add_psr", A), ev(20, "rm_psr", A), ev(15, "add_psr", B), ev(10, "add_psr", A)]
    // A was added, removed, then added again: listed, with its latest add. B stays listed.
    expect(indexedPausers(rows, RISK)).toEqual([
      { account: B, added: rows[2] },
      { account: A, added: rows[0] },
    ])
  })

  it("a pauser removed last is not listed; within one ledger the event index orders them", () => {
    expect(indexedPausers([ev(10, "rm_psr", A, 1), ev(10, "add_psr", A, 0)], RISK)).toEqual([])
    expect(indexedPausers([ev(10, "add_psr", A, 1), ev(10, "rm_psr", A, 0)], RISK).map((p) => p.account)).toEqual([A])
  })

  it("ignores other topics and rows whose pauser is not an address", () => {
    expect(indexedPausers([{ ...ev(10, "add_psr", A), topic: "paused" }, { ...ev(11, "add_psr", A), data: {} }], RISK)).toEqual([])
  })

  it("reads only RiskControl's events: another contract's add_psr is not a pauser of RiskControl", () => {
    const other = { ...ev(12, "add_psr", B), contractId: manifest.markets[0].contracts.pool }
    expect(indexedPausers([other, ev(10, "add_psr", A)], RISK).map((p) => p.account)).toEqual([A])
  })
})

describe("fetchPausers", () => {
  it("confirms each indexed pauser live with is_pauser(account), and reads the admin, a pauser by the contract's rule", async () => {
    const calls: Calls = []
    const reader = fakeReader(
      {
        [`${RISK}.get_admin`]: ADMIN,
        [`${RISK}.is_pauser`]: (args: { value: unknown }[]) => args[0].value === ADMIN || args[0].value === A,
      },
      calls,
    )
    const view = await fetchPausers(reader, manifest, [A, B])
    expect(view.admin).toMatchObject({ status: "live", value: ADMIN, source: { contractId: RISK, fn: "get_admin" } })
    expect(view.adminIsPauser).toMatchObject({ status: "live", value: true })
    expect(view.pausers.map((p) => [p.account, p.isPauser.status === "live" && p.isPauser.value])).toEqual([
      [A, true],
      [B, false],
    ])
    const read = view.pausers[1].isPauser
    expect(read.status === "live" && read.source && verifyCommand("testnet", read.source)).toContain(`-- is_pauser --account ${B}`)
    expect(calls.filter((c) => c.key.endsWith(".is_pauser")).map((c) => c.args[0])).toEqual(
      expect.arrayContaining([
        { type: "address", value: A },
        { type: "address", value: B },
        { type: "address", value: ADMIN },
      ]),
    )
  })

  it("a failed read is Unavailable for that account only; no admin, no admin check", async () => {
    const reader = fakeReader({
      [`${RISK}.get_admin`]: new Error("rpc down"),
      [`${RISK}.is_pauser`]: (args: { value: unknown }[]) => (args[0].value === A ? new Error("rate limited") : true),
    })
    const view = await fetchPausers(reader, manifest, [A, B])
    expect(view.admin).toMatchObject({ status: "unavailable", error: "rpc down" })
    expect(view.adminIsPauser).toMatchObject({ status: "unavailable" })
    expect(view.pausers[0].isPauser).toMatchObject({ status: "unavailable", error: "rate limited" })
    expect(view.pausers[1].isPauser).toMatchObject({ status: "live", value: true })
  })
})
