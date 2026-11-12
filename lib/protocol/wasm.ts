import { Address, Contract, type xdr } from "@stellar/stellar-sdk"
import { bytesToHex } from "./bytes"

/**
 * Which code a contract runs (spec 0002 §1): the Wasm hash in its instance ledger entry. Pure: the
 * RPC is a parameter, so tests inject a fake and the server passes `createRpcServer(...)`.
 *
 * Only a plain Wasm executable has a hash that a manifest can pin. A Stellar Asset Contract runs
 * built-in code, and a CAP-85 external reference names a hash another contract stores (and may
 * change), so both are refused as `not_wasm` / `external_ref` rather than resolved.
 */

/** The RPC call used here; the SDK's `rpc.Server` satisfies it. */
export type LedgerEntriesRpc = {
  getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<{ entries: { key?: xdr.LedgerKey; val: xdr.LedgerEntryData }[] }>
}

/** An answer from the chain that is not a pinnable hash. Any other error is the RPC failing. */
export class WasmReadError extends Error {
  constructor(
    readonly kind: "missing" | "not_wasm" | "external_ref",
    message: string,
  ) {
    super(message)
    this.name = "WasmReadError"
  }
}

function hashOf(contractId: string, val: xdr.LedgerEntryData | undefined): string {
  if (!val || val.type !== "contractData" || Address.fromScAddress(val.contractData.contract).toString() !== contractId) {
    throw new WasmReadError("missing", `There is no contract at ${contractId}.`)
  }
  const instance = val.contractData.val
  if (instance.type !== "scvContractInstance") {
    throw new WasmReadError("missing", `The ledger entry of ${contractId} is not a contract instance.`)
  }
  const executable = instance.value.executable
  switch (executable.type) {
    case "contractExecutableWasm":
      return bytesToHex(executable.wasmHash.toBytes()).toLowerCase()
    case "contractExecutableStellarAsset":
      throw new WasmReadError("not_wasm", `${contractId} is a Stellar Asset Contract, which runs no Wasm.`)
    case "contractExecutableExternalRef":
      throw new WasmReadError("external_ref", `${contractId} runs code by external reference, which cannot be pinned.`)
  }
}

/** The Wasm hash (lower-case hex) the contract's instance runs. */
export async function contractWasmHash(rpc: LedgerEntriesRpc, contractId: string): Promise<string> {
  return (await contractWasmHashes(rpc, [contractId]))[0] as string
}

/**
 * The Wasm hashes of several contracts from ONE `getLedgerEntries` call, one atomic ledger snapshot
 * (a phase landing between separate reads could otherwise look half deployed). Results are in the
 * order of `ids`: a hash, or the `WasmReadError` that contract's entry gave. An RPC failure throws.
 */
export async function contractWasmHashesSettled(rpc: LedgerEntriesRpc, ids: string[]): Promise<(string | WasmReadError)[]> {
  const { entries } = await rpc.getLedgerEntries(...ids.map((id) => new Contract(id).getFootprint()))
  return ids.map((id) => {
    const data = entries.map((entry) => entry.val).find((val) => val.type === "contractData" && Address.fromScAddress(val.contractData.contract).toString() === id)
    try {
      return hashOf(id, data)
    } catch (error) {
      if (error instanceof WasmReadError) return error
      throw error
    }
  })
}

async function contractWasmHashes(rpc: LedgerEntriesRpc, ids: string[]): Promise<string[]> {
  const settled = await contractWasmHashesSettled(rpc, ids)
  return settled.map((r) => {
    if (r instanceof WasmReadError) throw r
    return r
  })
}
