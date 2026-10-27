import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
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
  // SDK 17 parses the result into `errorResult`; a raw response carries `errorResultXdr` (base64).
  sendTransaction(transaction: Transaction): Promise<{
    status: string;
    hash?: string;
    errorResult?: xdr.TransactionResult;
    errorResultXdr?: string;
  }>;
};

type PollRpcServer = {
  // Only the fields read below, so the SDK's rpc.Server (parsed XDR objects) satisfies it.
  getTransaction(hash: string): Promise<{ status: string; returnValue?: xdr.ScVal }>;
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
  /** Set when a SUCCESS return value could not be decoded; hash and status are still reported. */
  decodeError?: string;
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

/** The network refused the submission (status ERROR): the transaction was not accepted. */
export class SubmissionRejectedError extends Error {}

const TX_RESULT_REASONS: Partial<Record<string, string>> = {
  txTooLate: "it reached the network after its time window closed; prepare it again",
  txTooEarly: "its time window has not opened yet; check the device clock, then prepare it again",
  txBadSeq: "the account's sequence number changed, so another transaction was sent from this account; prepare it again",
  txBadAuth: "the signature does not match this account or network; reconnect the wallet, then prepare it again",
  txBadAuthExtra: "it carries a signature it does not need; prepare it again",
  txInsufficientBalance: "the account has too little XLM for the fee and its reserve; add XLM, then try again",
  txNoAccount: "the account does not exist on this network; fund it first",
  txInsufficientFee: "its fee is too low for the current network load; prepare it again in a moment",
  txSorobanInvalid: "its Soroban resources or footprint are invalid; prepare it again",
  txMalformed: "it is malformed; prepare it again",
  txMissingOperation: "it has no operation; prepare it again",
  txInternalError: "the network hit an internal error; try again in a moment",
};

const HOST_FUNCTION_REASONS: Partial<Record<string, string>> = {
  invokeHostFunctionTrapped: "the contract call failed",
  invokeHostFunctionResourceLimitExceeded: "it ran out of the resources it declared; prepare it again",
  invokeHostFunctionEntryArchived: "contract data it needs is archived; restore it first",
  invokeHostFunctionInsufficientRefundableFee: "its refundable fee is too low; prepare it again",
  invokeHostFunctionMalformed: "the contract call is malformed; prepare it again",
};

/** A transaction result code in plain words, for a refusal message. */
export function describeTransactionResult(result: xdr.TransactionResult): string {
  const outcome = result.result;
  if (outcome.type === "txFailed") {
    const [operation] = outcome.results;
    if (operation?.type === "opInner" && operation.tr.type === "invokeHostFunction") {
      const code = operation.tr.invokeHostFunctionResult.type;
      return HOST_FUNCTION_REASONS[code] ?? `the contract call failed (${code})`;
    }
    return `its operation failed (${operation?.type ?? "no operation result"})`;
  }
  return TX_RESULT_REASONS[outcome.type] ?? `the network answered with result code ${outcome.type}`;
}

function rejectionReason(result: { errorResult?: xdr.TransactionResult; errorResultXdr?: string }): string | undefined {
  try {
    if (result.errorResult) return describeTransactionResult(result.errorResult);
    if (result.errorResultXdr) return describeTransactionResult(xdr.TransactionResult.fromXdr(result.errorResultXdr, "base64"));
  } catch {
    // An undecodable result: the raw XDR is reported instead.
  }
  return undefined;
}

export async function submitSignedTransaction(params: {
  rpcUrl: string;
  networkPassphrase: string;
  signedXdr: string;
  server?: SubmitRpcServer;
}): Promise<SubmitTransactionResult> {
  const server = params.server ?? createRpcServer(params.rpcUrl);
  const transaction = new Transaction(params.signedXdr, params.networkPassphrase);
  const result: Awaited<ReturnType<SubmitRpcServer["sendTransaction"]>> = await server.sendTransaction(transaction);

  if (result.status === "ERROR") {
    const reason = rejectionReason(result);
    const detail = reason
      ? ` because ${reason}`
      : result.errorResultXdr
        ? ` (result ${result.errorResultXdr})`
        : "";
    throw new SubmissionRejectedError(
      `Soroban submission failed: the network rejected the transaction${detail}. Nothing was executed.`,
    );
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
      if (result.status === "SUCCESS" && result.returnValue) {
        // The transaction is on-chain: a value that cannot be decoded must not lose its hash or status.
        try {
          found.returnValue = scValToNative(result.returnValue);
        } catch (error) {
          found.decodeError = `The return value could not be decoded: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
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

/**
 * The contract that raised `Error(Contract, #code)`, read from the simulation's diagnostic events
 * (R25): the first `error` event carrying that exact error and a contract id. The host records the
 * error in the frame that raised it first, then echoes it ("contract call failed") in every frame it
 * unwinds through, so the first match is the raiser. Events with another code (an earlier caught
 * failure) or no contract id (the top-level frame) are skipped. Undefined when none matches.
 */
function contractErrorSource(events: readonly xdr.DiagnosticEvent[] | undefined, code: number): string | undefined {
  try {
    for (const { event } of events ?? []) {
      if (event.type.name !== "diagnostic" || event.contractId === null) continue;
      const [topic, error] = event.body.value.topics;
      if (topic?.type !== "scvSymbol" || topic.value !== "error") continue;
      if (error?.type !== "scvError" || error.error.type !== "sceContract" || error.error.contractCode !== code) continue;
      return StrKey.encodeContract(event.contractId.toBytes());
    }
  } catch {
    // An event of unexpected shape: fall back to the invoked contract.
  }
  return undefined;
}

// Simulates a write as the user (never prepareTransaction). The contractId on a contract_error is the
// contract that raised it (see contractErrorSource), or the invoked contract if no event names one.
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
        const code = Number(match[1]);
        return {
          ok: false,
          kind: "contract_error",
          contractId: contractErrorSource(simulation.events, code) ?? params.invocation.contractId,
          code,
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
