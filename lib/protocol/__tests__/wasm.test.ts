// @vitest-environment node
import { Address, Contract, xdr } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import { contractWasmHash, WasmReadError, type LedgerEntriesRpc } from "../wasm"

const ID = "CCS6TZQLVBOPHYEQLMHGSYWF6HRPBV6QKPXQREMIEW73FDAB3GI6WHZF"
const OTHER = "CBVDMYG2MTQTHKVZBFW5BL4HKELSXROMYYX5CLVL7R5CSE3OFY2LQUDD"
const HASH = "36dace72592a3eb4fddee66948a07514f10ed69ed162d2f173dc6922b7c5796a"

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)))

/** The instance entry RPC returns for `contractId`, running `executable`. */
function instanceEntry(contractId: string, executable: xdr.ContractExecutable) {
  const val = xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.v0(),
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent,
      val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: null })),
    }),
  )
  return { key: new Contract(contractId).getFootprint(), val, lastModifiedLedgerSeq: 10 }
}

function rpcWith(entries: ReturnType<typeof instanceEntry>[]): LedgerEntriesRpc & { getLedgerEntries: ReturnType<typeof vi.fn> } {
  return { getLedgerEntries: vi.fn(async () => ({ entries, latestLedger: 100 })) } as never
}

describe("contractWasmHash", () => {
  it("reads the instance ledger entry and returns the executable's Wasm hash as lower-case hex", async () => {
    const rpc = rpcWith([instanceEntry(ID, xdr.ContractExecutable.contractExecutableWasm(hexBytes(HASH)))])
    expect(await contractWasmHash(rpc, ID)).toBe(HASH)
    // One key: the contract's persistent instance entry.
    const [key] = rpc.getLedgerEntries.mock.calls[0] as xdr.LedgerKey[]
    expect(key.toXDR("base64")).toBe(new Contract(ID).getFootprint().toXDR("base64"))
  })

  it("a contract with no instance entry is missing, not a hash", async () => {
    const err = await contractWasmHash(rpcWith([]), ID).catch((e) => e)
    expect(err).toBeInstanceOf(WasmReadError)
    expect(err.kind).toBe("missing")
    expect(err.message).toMatch(/no contract/i)
  })

  it("a Stellar Asset Contract runs no Wasm", async () => {
    const err = await contractWasmHash(rpcWith([instanceEntry(ID, xdr.ContractExecutable.contractExecutableStellarAsset())]), ID).catch((e) => e)
    expect(err).toBeInstanceOf(WasmReadError)
    expect(err.kind).toBe("not_wasm")
  })

  it("code by external reference (CAP-85) cannot be pinned", async () => {
    const ref = new xdr.ContractExecutableExternalRef({ executableOwner: Address.fromString(OTHER).toScAddress(), tag: "v1" })
    const err = await contractWasmHash(rpcWith([instanceEntry(ID, xdr.ContractExecutable.contractExecutableExternalRef(ref))]), ID).catch((e) => e)
    expect(err).toBeInstanceOf(WasmReadError)
    expect(err.kind).toBe("external_ref")
  })

  it("an entry for another contract is refused", async () => {
    const rpc = rpcWith([instanceEntry(OTHER, xdr.ContractExecutable.contractExecutableWasm(hexBytes(HASH)))])
    const err = await contractWasmHash(rpc, ID).catch((e) => e)
    expect(err).toBeInstanceOf(WasmReadError)
    expect(err.kind).toBe("missing")
  })

  it("an RPC failure is passed through as is (not a WasmReadError): it is not an answer", async () => {
    const rpc = { getLedgerEntries: vi.fn(async () => Promise.reject(new Error("503 Service Unavailable"))) }
    const err = await contractWasmHash(rpc, ID).catch((e) => e)
    expect(err).not.toBeInstanceOf(WasmReadError)
    expect(err.message).toMatch(/503/)
  })
})
