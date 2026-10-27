import { createRpcServer, simulateContractRead, type ContractReadResult, type ScArg } from "./stellar"
import type { Manifest } from "./types"

export type ContractReader = <T>(call: {
  contractId: string
  functionName: string
  args?: ScArg[]
}) => Promise<ContractReadResult<T>>

export function createRpcReader(m: Manifest): ContractReader {
  const server = createRpcServer(m.rpcUrl)
  return <T>(call: { contractId: string; functionName: string; args?: ScArg[] }) =>
    simulateContractRead<T>({
      rpcUrl: m.rpcUrl,
      networkPassphrase: m.networkPassphrase,
      server,
      invocation: { contractId: call.contractId, functionName: call.functionName, args: call.args ?? [] },
    })
}
