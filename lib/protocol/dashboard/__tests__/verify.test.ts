// @vitest-environment node
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import { allLive, liveValue, readLive, unavailable } from "../../reader"
import type { Live, ReadSource } from "../../types"
import { ARG_NAMES, NULL_ACCOUNT, decodedValue, evidenceRows, figureEvidence, nameArgs, verifyCommand, type VerifiableFigure } from "../verify"
import { fakeReader } from "./fake-reader"

const ORACLE = "CDYGBFGO7KD446CDTGJ7M4OWUXC7UPBGPVM5CUWP2NSNX2CKK2TYYIPS"
const ESCROW = "CAMOWBMTMDLFJLFOSTULXQO7MUK2PT3XAQ62CA4L5DGPQKZFJWEKN24Q"
const SAC = "CB2YO6BCOTN336RQUAMHOBCNABJG74URBIMNUHXB27K2QOLJKDCDXODZ"
const YT = "CAXVQIHH7US4DUK2E2GE2N6VNXDECC6D4DOGXUSEG6SPKS7USNMYXDCB"
const ACCOUNT = "GBLPAJ2GVSFUWCUIFMEV4EOV2XIOEWMJRIQ3LOM2Z42TNIY3J6ACB7UA"

const source = (fn: string, args: unknown[] = [], contractId = ORACLE): ReadSource => ({
  contractId,
  fn,
  args,
  rawXdr: "AAAABQAAAAAAAA4Q",
  ledger: 5719947,
  rpcUrl: "https://soroban-testnet.stellar.org",
})

describe("verifyCommand", () => {
  it("uses the simulation-only null account", () => {
    expect(NULL_ACCOUNT).toBe("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")
  })

  it("a no-argument view", () => {
    expect(verifyCommand("testnet", source("max_stale_seconds"))).toBe(
      `stellar contract invoke --network testnet --id ${ORACLE} --source-account ${NULL_ACCOUNT} --send=no -- max_stale_seconds`,
    )
  })

  it("get_record 0 names its argument (u64 recorded as a decimal string)", () => {
    expect(verifyCommand("testnet", source("get_record", [{ type: "u64", value: "0" }], ESCROW))).toBe(
      `stellar contract invoke --network testnet --id ${ESCROW} --source-account ${NULL_ACCOUNT} --send=no -- get_record --id 0`,
    )
  })

  it("SAC balance takes --id", () => {
    expect(verifyCommand("local", source("balance", [{ type: "address", value: ESCROW }], SAC))).toBe(
      `stellar contract invoke --network local --id ${SAC} --source-account ${NULL_ACCOUNT} --send=no -- balance --id ${ESCROW}`,
    )
  })

  it("an unavailable read's source (no rawXdr or ledger) still gives a command", () => {
    const partial = { contractId: YT, fn: "pending_claim", args: [{ type: "address", value: ACCOUNT }], rpcUrl: "https://soroban-testnet.stellar.org" }
    expect(verifyCommand("testnet", partial)).toBe(
      `stellar contract invoke --network testnet --id ${YT} --source-account ${NULL_ACCOUNT} --send=no -- pending_claim --account ${ACCOUNT}`,
    )
  })

  it("a name recorded on the argument wins over the map (YT balance takes --account)", () => {
    expect(verifyCommand("testnet", source("balance", [{ type: "address", value: ACCOUNT, name: "account" }], YT))).toBe(
      `stellar contract invoke --network testnet --id ${YT} --source-account ${NULL_ACCOUNT} --send=no -- balance --account ${ACCOUNT}`,
    )
  })

  it("two arguments keep their order", () => {
    const cmd = verifyCommand("testnet", source("is_allowed_for_asset", [{ type: "address", value: ACCOUNT }, { type: "address", value: YT }]))
    expect(cmd.endsWith(`-- is_allowed_for_asset --account ${ACCOUNT} --asset ${YT}`)).toBe(true)
  })

  it("Mainnet names its RPC and passphrase: the CLI's built-in mainnet has no RPC", () => {
    expect(verifyCommand("mainnet", { ...source("max_stale_seconds"), rpcUrl: "https://rpc.example" })).toBe(
      `stellar contract invoke --rpc-url https://rpc.example --network-passphrase 'Public Global Stellar Network ; September 2015' --id ${ORACLE} --source-account ${NULL_ACCOUNT} --send=no -- max_stale_seconds`,
    )
  })

  it("refuses a function whose argument names it does not know", () => {
    expect(() => verifyCommand("testnet", source("mystery", [{ type: "u32", value: 1 }]))).toThrow(/mystery/)
  })

  it("the map covers every view with arguments the dashboard reads", () => {
    for (const fn of ["get_record", "balance", "pending_claim", "last_claimed_index", "is_consumer", "get_asset_limit", "get_asset_volume", "swap_fee_rate", "balance_of", "market"]) {
      expect(ARG_NAMES[fn], fn).toBeDefined()
    }
  })
})

describe("nameArgs", () => {
  it("records argument names on the source, so verifyCommand uses them", async () => {
    const reader = fakeReader({ [`${YT}.balance`]: 5n })
    const live = nameArgs(await readLive(reader, { contractId: YT, functionName: "balance", args: [{ type: "address", value: ACCOUNT }] }), ["account"])
    expect(live.source?.args).toEqual([{ type: "address", value: ACCOUNT, name: "account" }])
    expect(verifyCommand("testnet", live.source!)).toMatch(/-- balance --account G/)
  })

  it("leaves an unavailable read's source named too", async () => {
    const reader = fakeReader({ [`${YT}.balance`]: new Error("boom") })
    const live = nameArgs(await readLive(reader, { contractId: YT, functionName: "balance", args: [{ type: "address", value: ACCOUNT }] }), ["account"])
    expect(live).toMatchObject({ status: "unavailable", source: { args: [{ name: "account" }] } })
  })
})

describe("evidenceRows", () => {
  const header =
    "| Dashboard metric | Contract ID / source | Function + params | Raw value | Display value | Ledger | RPC/indexer coverage | Cache/stale status | Verified |"

  const live = (fn: string, args: unknown[] = [], ledger = 5719947): Live<bigint> => ({
    status: "live",
    value: 1n,
    ledger,
    source: { ...source(fn, args), ledger },
  })

  it("has the TRANCHE_2_3 l.1824 columns", () => {
    const md = evidenceRows([{ label: "Max stale", display: "1 h", live: live("max_stale_seconds") }])
    const [h, sep, row] = md.trim().split("\n")
    expect(h).toBe(header)
    // Ledger is right-aligned.
    expect(sep).toBe("|---|---|---|---|---|---:|---|---|---|")
    // Raw value is the decoded return (u64 3600), as `stellar contract invoke` prints it, not the XDR.
    expect(row).toBe(`| Max stale | ${ORACLE} | max_stale_seconds() | 3600 | 1 h | 5719947 | https://soroban-testnet.stellar.org | Live | |`)
  })

  it("keeps the base64 XDR for the drawer, out of the table", () => {
    const f = { label: "Max stale", display: "1 h", live: live("max_stale_seconds") }
    expect(figureEvidence(f)).toMatchObject({ raw: "3600", rawXdr: ["AAAABQAAAAAAAA4Q"], ledger: "5719947", status: "Live" })
    expect(evidenceRows([f])).not.toContain("AAAABQAAAAAAAA4Q")
  })

  it("a composite such as TVL lists each input's decoded value", () => {
    const at = (fn: string, rawXdr: string, contractId: string, args: unknown[] = []): Live<bigint> => ({
      status: "live",
      value: 0n,
      ledger: 5719947,
      source: { ...source(fn, args, contractId), rawXdr },
    })
    const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" }).toXDR("base64")
    const tvl = allLive(
      [
        at("total_underlying", i128(2_230_113_029_038n), "CA62ACRTFADKNOP37CS7DPQ5DNJML4TFHIX6LZG5IBEHJM3PED2V7F2I"),
        at("balance", i128(0n), SAC, [{ type: "address", value: ESCROW, name: "id" }]),
      ] as const,
      ([a, b]) => a + b,
    )
    const e = figureEvidence({ label: "TVL", display: "223,011.30 USDY", live: tvl })
    expect(e.raw).toBe("total_underlying=2230113029038; balance=0")
    expect(e.rawXdr).toEqual([i128(2_230_113_029_038n), i128(0n)])
    expect(evidenceRows([{ label: "TVL", display: "223,011.30 USDY", live: tvl }])).toContain("| total_underlying=2230113029038; balance=0 |")
  })

  it("a function read twice in one figure is named with its arguments", () => {
    const yes = xdr.ScVal.scvBool(true).toXDR("base64")
    const read = (who: string): Live<boolean> => ({
      status: "live",
      value: true,
      ledger: 1,
      source: { ...source("is_consumer", [{ type: "address", value: who }]), rawXdr: yes, ledger: 1 },
    })
    const both = allLive([read(YT), read(ESCROW)] as const, ([a, b]) => a && b)
    expect(figureEvidence({ label: "x", display: "y", live: both }).raw).toBe(`is_consumer(account=${YT})=true; is_consumer(account=${ESCROW})=true`)
  })

  it("names the arguments in Function + params", () => {
    const md = evidenceRows([{ label: "Record 0", display: "x", live: live("get_record", [{ type: "u64", value: "0" }]) }])
    expect(md).toContain("| get_record(id=0) |")
  })

  it("escapes | in every cell", () => {
    const md = evidenceRows([{ label: "a|b", display: "1 | 2", live: unavailable("bad | thing") }])
    const row = md.trim().split("\n")[2]
    expect(row).toContain("a\\|b")
    expect(row).toContain("1 \\| 2")
    expect(row).toContain("Unavailable: bad \\| thing")
    // Nine cells: 10 unescaped pipes.
    expect(row.replace(/\\\|/g, "").split("|")).toHaveLength(11)
  })

  it("a composite lists every read and its ledger spread", () => {
    const both = allLive([live("get_cb_limit", [], 10), live("get_cb_volume", [], 12)] as const, ([a, b]) => a - b)
    const row = evidenceRows([{ label: "Remaining", display: "0", live: both }]).trim().split("\n")[2]
    expect(row).toContain("get_cb_limit(); get_cb_volume()")
    expect(row).toContain("| get_cb_limit=3600; get_cb_volume=3600 |")
    expect(row).toContain("| 10–12 |")
    expect(row).toContain("Read across ledgers 10–12")
  })

  it("an unavailable figure shows dashes for raw value and ledger", () => {
    const row = evidenceRows([{ label: "X", display: "Unavailable", live: unavailable("down") }]).trim().split("\n")[2]
    expect(row).toBe("| X | — | — | — | Unavailable | — | — | Unavailable: down | |")
  })

  it("a figure with no contract read says so", () => {
    const row = evidenceRows([{ label: "Y", display: "3", live: liveValue(3n, 9) }]).trim().split("\n")[2]
    expect(row).toBe("| Y | — | — | — | 3 | 9 | — | Live | |")
  })

  it("a newline in a cell does not break the row", () => {
    const row = evidenceRows([{ label: "a\nb", display: "c", live: liveValue(1n, 1) }]).trim().split("\n")
    expect(row).toHaveLength(3)
  })

  it("accepts VerifiableFigure", () => {
    const f: VerifiableFigure = { label: "l", display: "d", live: liveValue("x", 1) }
    expect(evidenceRows([f])).toContain("| l |")
  })
})

describe("decodedValue", () => {
  const b64 = (v: xdr.ScVal) => v.toXDR("base64")

  it("an integer as plain digits, any size", () => {
    expect(decodedValue(b64(nativeToScVal(100_000_000_000_000n, { type: "i128" })))).toBe("100000000000000")
    expect(decodedValue(b64(nativeToScVal(17_280, { type: "u32" })))).toBe("17280")
  })

  it("a bool, an address and a symbol as they are", () => {
    expect(decodedValue(b64(xdr.ScVal.scvBool(false)))).toBe("false")
    expect(decodedValue(b64(Address.fromString(ACCOUNT).toScVal()))).toBe(ACCOUNT)
    expect(decodedValue(b64(xdr.ScVal.scvSymbol("deviate")))).toBe("deviate")
  })

  it("void (None) as null, bytes as hex", () => {
    expect(decodedValue(b64(xdr.ScVal.scvVoid()))).toBe("null")
    expect(decodedValue(b64(xdr.ScVal.scvBytes(Buffer.from("8f157e8d", "hex"))))).toBe("8f157e8d")
  })

  it("a struct as compact JSON with bare integers", () => {
    const struct = nativeToScVal({ reason: xdr.ScVal.scvSymbol("deviate"), timestamp: nativeToScVal(5n, { type: "u64" }), value: nativeToScVal(99n, { type: "i128" }) })
    expect(decodedValue(b64(struct))).toBe('{"reason":"deviate","timestamp":5,"value":99}')
    const pair = xdr.ScVal.scvVec([nativeToScVal(9n, { type: "i128" }), nativeToScVal(20n, { type: "i128" })])
    expect(decodedValue(b64(pair))).toBe("[9,20]")
  })

  it("XDR that does not decode is shown as it is, marked", () => {
    expect(decodedValue("not-xdr")).toBe("(undecoded) not-xdr")
  })
})
