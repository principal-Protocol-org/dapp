import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";
import { NULL_ACCOUNT } from "@stellar/stellar-sdk/contract";
import { bytesToHex } from "./bytes";
import { hashLike } from "./hash";

export type ScArg =
  | { type: "address"; value: string }
  | { type: "i128"; value: string | number | bigint }
  | { type: "u32"; value: number }
  | { type: "u64"; value: string | number | bigint }
  | { type: "bool"; value: boolean }
  | { type: "symbol"; value: string }
  | { type: "string"; value: string };

export type ContractInvocation = {
  contractId: string;
  functionName: string;
  args: ScArg[];
};

export type BuiltInvocation = {
  unsignedXdr: string;
  unsignedXdrHash: string;
  call: string;
  transactionFee: string;
  timeoutSeconds: number;
  accountSequence: string;
};

export type ContractReadResult<T> = {
  value: T;
  latestLedger: number;
  minResourceFee: string;
};

type ReadRpcServer = {
  simulateTransaction(transaction: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
};

type SubmitRpcServer = {
  sendTransaction(transaction: Transaction): Promise<{ status: string; hash?: string; errorResultXdr?: string }>;
};

type PollRpcServer = {
  getTransaction(hash: string): Promise<{ status: string; resultXdr?: string; resultMetaXdr?: string; returnValue?: xdr.ScVal }>;
};

export type SubmitTransactionResult = {
  hash: string;
  status: string;
};

export type PolledTransactionResult = {
  hash: string;
  status: string;
  attempts: number;
  returnValue?: unknown;
};

export function createRpcServer(rpcUrl: string) {
  return new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
    timeout: 20_000,
  });
}

export function scArgToVal(arg: ScArg): xdr.ScVal {
  if (arg.type === "string") return nativeToScVal(arg.value);
  return nativeToScVal(arg.value, { type: arg.type });
}

function invocationCall(invocation: ContractInvocation) {
  return `${invocation.contractId}.${invocation.functionName}`;
}

export function buildInvocationEnvelope(params: {
  source: string;
  sequence: string;
  networkPassphrase: string;
  invocation: ContractInvocation;
  timeoutSeconds?: number;
  baseFee?: string;
}): Transaction {
  const timeoutSeconds = params.timeoutSeconds ?? 300;
  const contract = new Contract(params.invocation.contractId);
  const account = new Account(params.source, params.sequence);
  const operation = contract.call(params.invocation.functionName, ...params.invocation.args.map(scArgToVal));
  return new TransactionBuilder(account, {
    fee: params.baseFee ?? BASE_FEE,
    networkPassphrase: params.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(timeoutSeconds)
    .build();
}

export function summarizeInvocationTransaction(params: {
  transaction: Transaction;
  invocation: ContractInvocation;
  timeoutSeconds: number;
  accountSequence: string;
}): BuiltInvocation {
  const unsignedXdr = params.transaction.toXDR();
  return {
    unsignedXdr,
    unsignedXdrHash: hashLike(unsignedXdr),
    call: invocationCall(params.invocation),
    transactionFee: params.transaction.fee,
    timeoutSeconds: params.timeoutSeconds,
    accountSequence: params.accountSequence,
  };
}

export function buildInvokeTransaction(params: {
  source: string;
  sequence: string;
  networkPassphrase: string;
  invocation: ContractInvocation;
  timeoutSeconds?: number;
  baseFee?: string;
}): BuiltInvocation {
  const timeoutSeconds = params.timeoutSeconds ?? 300;
  const transaction = buildInvocationEnvelope({ ...params, timeoutSeconds });
  return summarizeInvocationTransaction({
    transaction,
    invocation: params.invocation,
    timeoutSeconds,
    accountSequence: params.sequence,
  });
}

export function transactionEnvelopeHash(xdrString: string, networkPassphrase: string): string {
  return bytesToHex(new Transaction(xdrString, networkPassphrase).hash());
}

export function assertSignedTransactionMatchesReview(params: {
  unsignedXdr: string;
  signedXdr: string;
  networkPassphrase: string;
  expectedSigner: string;
}): void {
  const expectedHash = transactionEnvelopeHash(params.unsignedXdr, params.networkPassphrase);
  const signedHash = transactionEnvelopeHash(params.signedXdr, params.networkPassphrase);
  if (signedHash !== expectedHash) {
    throw new Error(
      "Signed transaction body does not match the reviewed unsigned transaction. Refusing to submit.",
    );
  }

  const signedTransaction = new Transaction(params.signedXdr, params.networkPassphrase);
  if (signedTransaction.signatures.length === 0) {
    throw new Error("Wallet returned a transaction with no signatures. Refusing to submit.");
  }

  const expectedHint = bytesToHex(Keypair.fromPublicKey(params.expectedSigner).rawPublicKey().slice(-4));
  const signedByExpectedKey = signedTransaction.signatures.some(
    (signature) => bytesToHex(signature.hint.value) === expectedHint,
  );
  if (!signedByExpectedKey) {
    throw new Error("Signed transaction was not signed by the connected wallet account. Refusing to submit.");
  }
}

export async function simulateContractRead<T = unknown>(params: {
  rpcUrl: string;
  networkPassphrase: string;
  invocation: ContractInvocation;
  server?: ReadRpcServer;
}): Promise<ContractReadResult<T>> {
  const server = params.server ?? createRpcServer(params.rpcUrl);
  const transaction = buildInvocationEnvelope({
    source: NULL_ACCOUNT,
    sequence: "0",
    networkPassphrase: params.networkPassphrase,
    invocation: params.invocation,
  });
  const simulation = await server.simulateTransaction(transaction);

  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new Error("Contract read requires restoring archived ledger entries before it can be queried.");
  }

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error);
  }

  if (!simulation.result) {
    throw new Error("Contract read simulation returned no result.");
  }

  if (simulation.result.auth.length > 0) {
    throw new Error("Contract read unexpectedly requires authorization.");
  }

  return {
    value: scValToNative(simulation.result.retval) as T,
    latestLedger: simulation.latestLedger,
    minResourceFee: simulation.minResourceFee,
  };
}

export async function submitSignedTransaction(params: {
  rpcUrl: string;
  networkPassphrase: string;
  signedXdr: string;
  server?: SubmitRpcServer;
}): Promise<SubmitTransactionResult> {
  const server = params.server ?? createRpcServer(params.rpcUrl);
  const transaction = new Transaction(params.signedXdr, params.networkPassphrase);
  const result = (await server.sendTransaction(transaction)) as {
    status: string;
    hash?: string;
    errorResultXdr?: string;
  };

  if (result.status === "ERROR") {
    throw new Error(result.errorResultXdr ? `Soroban submission failed: ${result.errorResultXdr}` : "Soroban submission failed.");
  }

  if (!result.hash) {
    throw new Error(`Soroban submission returned no transaction hash. Status: ${result.status}`);
  }

  return {
    hash: result.hash,
    status: result.status,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function pollTransactionStatus(params: {
  rpcUrl: string;
  hash: string;
  attempts?: number;
  intervalMs?: number;
  server?: PollRpcServer;
  wait?: (ms: number) => Promise<unknown>;
}): Promise<PolledTransactionResult> {
  const server = params.server ?? createRpcServer(params.rpcUrl);
  const attempts = params.attempts ?? 10;
  const intervalMs = params.intervalMs ?? 2_000;
  const wait = params.wait ?? delay;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await server.getTransaction(params.hash);
    if (result.status !== "NOT_FOUND") {
      const found: PolledTransactionResult = { hash: params.hash, status: result.status, attempts: attempt };
      if (result.status === "SUCCESS" && result.returnValue) found.returnValue = scValToNative(result.returnValue);
      return found;
    }
    if (attempt < attempts) await wait(intervalMs);
  }

  return { hash: params.hash, status: "NOT_FOUND", attempts };
}


type SimulateWriteRpcServer = ReadRpcServer & {
  getAccount(address: string): Promise<{ sequenceNumber(): string }>;
};

export type SimulationOutcome =
  | { ok: true; retval: unknown; latestLedger: number; minResourceFee: string }
  | { ok: false; kind: "contract_error"; contractId: string; code: number; message: string }
  | { ok: false; kind: "restore_required" }
  | { ok: false; kind: "rpc_error"; message: string };

const CONTRACT_ERROR = /Error\(Contract, #(\d+)\)/;

// Simulates a write as the user (never prepareTransaction). The contractId on a contract_error is the
// invoked contract; diagnostic events are not inspected, so an error raised by a nested contract is
// still attributed to the invoked one.
export async function simulateInvocation(params: {
  rpcUrl: string;
  networkPassphrase: string;
  source: string;
  invocation: ContractInvocation;
  server?: SimulateWriteRpcServer;
}): Promise<SimulationOutcome> {
  try {
    const server = params.server ?? createRpcServer(params.rpcUrl);
    const account = await server.getAccount(params.source);
    const transaction = buildInvocationEnvelope({
      source: params.source,
      sequence: account.sequenceNumber(),
      networkPassphrase: params.networkPassphrase,
      invocation: params.invocation,
    });
    const simulation = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationRestore(simulation)) return { ok: false, kind: "restore_required" };

    if (rpc.Api.isSimulationError(simulation)) {
      const match = CONTRACT_ERROR.exec(simulation.error);
      if (match) {
        return {
          ok: false,
          kind: "contract_error",
          contractId: params.invocation.contractId,
          code: Number(match[1]),
          message: simulation.error,
        };
      }
      return { ok: false, kind: "rpc_error", message: simulation.error };
    }

    if (!simulation.result) return { ok: false, kind: "rpc_error", message: "Simulation returned no result." };

    return {
      ok: true,
      retval: scValToNative(simulation.result.retval),
      latestLedger: simulation.latestLedger,
      minResourceFee: simulation.minResourceFee,
    };
  } catch (error) {
    return { ok: false, kind: "rpc_error", message: error instanceof Error ? error.message : String(error) };
  }
}

type LedgerClockServer = {
  getLatestLedger(): Promise<{ sequence: number; closeTime: string | number }>;
};

// The SDK's getLatestLedger exposes closeTime (unix seconds), so no getLedgers call is needed.
export async function getLedgerClock(
  server: LedgerClockServer,
): Promise<{ sequence: number; closeTime: number; readAtMs: number }> {
  const latest = await server.getLatestLedger();
  const closeTime = Number(latest.closeTime);
  if (!Number.isFinite(closeTime) || closeTime <= 0) throw new Error("RPC returned no ledger close time.");
  return { sequence: latest.sequence, closeTime, readAtMs: Date.now() };
}
