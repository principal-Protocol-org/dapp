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

/** The Wasm hash (lower-case hex) the contract's instance runs. */
export async function contractWasmHash(rpc: LedgerEntriesRpc, contractId: string): Promise<string> {
  const { entries } = await rpc.getLedgerEntries(new Contract(contractId).getFootprint())
  const data = entries
    .map((entry) => entry.val)
    .find((val) => val.type === "contractData" && Address.fromScAddress(val.contractData.contract).toString() === contractId)
  if (!data || data.type !== "contractData") throw new WasmReadError("missing", `There is no contract at ${contractId}.`)
  const instance = data.contractData.val
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
