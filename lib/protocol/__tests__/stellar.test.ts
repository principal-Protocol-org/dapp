// @vitest-environment node
import { Keypair, StrKey, Transaction, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import testnetJson from "@/config/manifests/testnet.json";
import { parseManifest } from "../manifest";
import {
  AMOUNTS_MOVED_REASON,
  assertSignedTransactionMatchesReview,
  buildInvokeTransaction,
  describeTransactionResult,
  failedTransactionReason,
  getLedgerClock,
  SubmissionRejectedError,
  pollTransactionStatus,
  simulateContractRead,
  simulateInvocation,
  submitSignedTransaction,
  type ContractInvocation,
} from "../stellar";

const manifest = parseManifest(testnetJson);
const market = manifest.markets[0];
const testnetMarket = {
  rpcUrl: manifest.rpcUrl,
  networkPassphrase: manifest.networkPassphrase,
  contracts: market.contracts,
  marketId: market.marketId,
};

function principalInvocationForIntent(
  m: typeof testnetMarket,
  intent: { action: string; source: string; amount: string },
): ContractInvocation {
  return {
    contractId: m.contracts.router,
    functionName: intent.action,
    args: [
      { type: "address", value: intent.source },
      { type: "i128", value: intent.amount },
    ],
  };
}

describe("buildInvokeTransaction", () => {
  it("builds parseable unsigned XDR for a Principal Router call", () => {
    const source = Keypair.random().publicKey();
    const invocation = principalInvocationForIntent(testnetMarket, {
      action: "mint",
      source,
      amount: "10000000",
    });

    const built = buildInvokeTransaction({
      source,
      sequence: "1",
      networkPassphrase: testnetMarket.networkPassphrase,
      invocation,
    });

    const transaction = new Transaction(built.unsignedXdr, testnetMarket.networkPassphrase);

    expect(built.unsignedXdrHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(transaction.operations).toHaveLength(1);
    expect(built.call).toBe(`${testnetMarket.contracts.router}.mint`);
  });
});

describe("simulateContractRead", () => {
  function readInvocation() {
    return principalInvocationForIntent(testnetMarket, {
      action: "claim_yield",
      source: Keypair.random().publicKey(),
      amount: "1",
    });
  }

  it("decodes a successful Soroban simulation return value", async () => {
    const read = await simulateContractRead<bigint>({
      rpcUrl: testnetMarket.rpcUrl,
      networkPassphrase: testnetMarket.networkPassphrase,
      invocation: readInvocation(),
      server: {
        async simulateTransaction() {
          return {
            id: "1",
            _parsed: true,
            latestLedger: 77,
            events: [],
            minResourceFee: "321",
            transactionData: {},
            result: {
              auth: [],
              retval: nativeToScVal(123n, { type: "i128" }),
            },
          } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
        },
      },
    });

    expect(read).toEqual({
      value: 123n,
      latestLedger: 77,
      minResourceFee: "321",
    });
  });

  it("fails closed when a read requires auth", async () => {
    await expect(
      simulateContractRead({
        rpcUrl: testnetMarket.rpcUrl,
        networkPassphrase: testnetMarket.networkPassphrase,
        invocation: readInvocation(),
        server: {
          async simulateTransaction() {
            return {
              id: "1",
              _parsed: true,
              latestLedger: 77,
              events: [],
              minResourceFee: "321",
              transactionData: {},
              result: {
                auth: [{}],
                retval: nativeToScVal(123n, { type: "i128" }),
              },
            } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
          },
        },
      }),
    ).rejects.toThrow("requires authorization");
  });

  it("fails closed when simulation returns no result", async () => {
    await expect(
      simulateContractRead({
        rpcUrl: testnetMarket.rpcUrl,
        networkPassphrase: testnetMarket.networkPassphrase,
        invocation: readInvocation(),
        server: {
          async simulateTransaction() {
            return {
              id: "1",
              _parsed: true,
              latestLedger: 77,
              events: [],
              minResourceFee: "321",
              transactionData: {},
            } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
          },
        },
      }),
    ).rejects.toThrow("returned no result");
  });

  it("surfaces simulation errors", async () => {
    await expect(
      simulateContractRead({
        rpcUrl: testnetMarket.rpcUrl,
        networkPassphrase: testnetMarket.networkPassphrase,
        invocation: readInvocation(),
        server: {
          async simulateTransaction() {
            return {
              id: "1",
              _parsed: true,
              latestLedger: 77,
              events: [],
              error: "contract trapped",
            } as rpc.Api.SimulateTransactionErrorResponse;
          },
        },
      }),
    ).rejects.toThrow("contract trapped");
  });

  it("surfaces restore requirements", async () => {
    await expect(
      simulateContractRead({
        rpcUrl: testnetMarket.rpcUrl,
        networkPassphrase: testnetMarket.networkPassphrase,
        invocation: readInvocation(),
        server: {
          async simulateTransaction() {
            return {
              id: "1",
              _parsed: true,
              latestLedger: 77,
              events: [],
              minResourceFee: "321",
              transactionData: {},
              result: {
                auth: [],
                retval: nativeToScVal(123n, { type: "i128" }),
              },
              restorePreamble: {
                minResourceFee: "999",
                transactionData: {},
              },
            } as unknown as rpc.Api.SimulateTransactionRestoreResponse;
          },
        },
      }),
    ).rejects.toThrow("requires restoring");
  });
});

describe("submitSignedTransaction", () => {
  it("submits parseable XDR and returns the RPC hash", async () => {
    const source = Keypair.random().publicKey();
    const invocation = principalInvocationForIntent(testnetMarket, {
      action: "claim_yield",
      source,
      amount: "1",
    });
    const built = buildInvokeTransaction({
      source,
      sequence: "1",
      networkPassphrase: testnetMarket.networkPassphrase,
      invocation,
    });

    const submitted = await submitSignedTransaction({
      rpcUrl: testnetMarket.rpcUrl,
      networkPassphrase: testnetMarket.networkPassphrase,
      signedXdr: built.unsignedXdr,
      server: {
        async sendTransaction(transaction) {
          expect(transaction.operations).toHaveLength(1);
          return { status: "PENDING", hash: "abc123" };
        },
      },
    });

    expect(submitted).toEqual({ status: "PENDING", hash: "abc123" });
  });

  it("fails closed when RPC submission returns ERROR", async () => {
    const source = Keypair.random().publicKey();

    await expect(
      submitSignedTransaction({
        rpcUrl: testnetMarket.rpcUrl,
        networkPassphrase: testnetMarket.networkPassphrase,
        signedXdr: buildInvokeTransaction({
          source,
          sequence: "1",
          networkPassphrase: testnetMarket.networkPassphrase,
          invocation: principalInvocationForIntent(testnetMarket, {
            action: "claim_yield",
                  source,
            amount: "1",
          }),
        }).unsignedXdr,
        server: {
          async sendTransaction() {
            return { status: "ERROR", errorResultXdr: "AAAA" };
          },
        },
      }),
    ).rejects.toThrow("Soroban submission failed");
  });

  describe("explains a rejected submission in plain words (R30)", () => {
    const source = Keypair.random().publicKey();
    const signedXdr = buildInvokeTransaction({
      source,
      sequence: "1",
      networkPassphrase: testnetMarket.networkPassphrase,
      invocation: principalInvocationForIntent(testnetMarket, { action: "claim_yield", source, amount: "1" }),
    }).unsignedXdr;
    const result = (outcome: xdr.TransactionResultResult) =>
      new xdr.TransactionResult({ feeCharged: 100n, result: outcome, ext: xdr.TransactionResultExt.v0() });
    const rejected = (response: { errorResult?: xdr.TransactionResult; errorResultXdr?: string }) =>
      submitSignedTransaction({
        rpcUrl: testnetMarket.rpcUrl,
        networkPassphrase: testnetMarket.networkPassphrase,
        signedXdr,
        server: {
          async sendTransaction() {
            return { status: "ERROR", hash: "abc123", ...response };
          },
        },
      });

    it("reads the SDK's parsed errorResult", async () => {
      const failure = rejected({ errorResult: result(xdr.TransactionResultResult.txBadSeq()) });
      await expect(failure).rejects.toThrow(SubmissionRejectedError);
      await expect(failure).rejects.toThrow(
        "Soroban submission failed: the network rejected the transaction because the account's sequence number changed, so another transaction was sent from this account; prepare it again. Nothing was executed.",
      );
    });

    it("falls back to a raw errorResultXdr", async () => {
      const raw = result(xdr.TransactionResultResult.txTooLate()).toXdr("base64");
      // A device clock behind the network makes every transaction too late: say so (M3).
      await expect(rejected({ errorResultXdr: raw })).rejects.toThrow(
        "it reached the network after its time window closed; check your device clock, then prepare it again",
      );
    });

    it("names the contract-call failure inside txFailed", async () => {
      const archived = xdr.OperationResult.opInner(
        xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionEntryArchived()),
      );
      await expect(rejected({ errorResult: result(xdr.TransactionResultResult.txFailed([archived])) })).rejects.toThrow(
        "contract data it needs is archived; restore it first",
      );
    });

    it("reports an undecodable result as raw XDR", async () => {
      await expect(rejected({ errorResultXdr: "AAAA" })).rejects.toThrow(
        "the network rejected the transaction (result AAAA). Nothing was executed.",
      );
    });
  });
});

describe("assertSignedTransactionMatchesReview", () => {
  function built(source: string) {
    return buildInvokeTransaction({
      source,
      sequence: "1",
      networkPassphrase: testnetMarket.networkPassphrase,
      invocation: principalInvocationForIntent(testnetMarket, {
        action: "claim_yield",
          source,
        amount: "1",
      }),
    });
  }

  it("accepts a signed transaction whose body matches the review and was signed by the expected account", () => {
    const signer = Keypair.random();
    const unsignedXdr = built(signer.publicKey()).unsignedXdr;
    const transaction = new Transaction(unsignedXdr, testnetMarket.networkPassphrase);
    transaction.sign(signer);

    expect(() =>
      assertSignedTransactionMatchesReview({
        unsignedXdr,
        signedXdr: transaction.toXDR(),
        networkPassphrase: testnetMarket.networkPassphrase,
        expectedSigner: signer.publicKey(),
      }),
    ).not.toThrow();
  });

  it("rejects a signed transaction whose body differs from the reviewed unsigned transaction", () => {
    const signer = Keypair.random();
    const unsignedXdr = built(signer.publicKey()).unsignedXdr;
    const otherSource = Keypair.random().publicKey();
    const tamperedTransaction = new Transaction(built(otherSource).unsignedXdr, testnetMarket.networkPassphrase);
    tamperedTransaction.sign(signer);

    expect(() =>
      assertSignedTransactionMatchesReview({
        unsignedXdr,
        signedXdr: tamperedTransaction.toXDR(),
        networkPassphrase: testnetMarket.networkPassphrase,
        expectedSigner: signer.publicKey(),
      }),
    ).toThrow("does not match the reviewed unsigned transaction");
  });

  it("rejects a transaction signed by a different account than the connected wallet", () => {
    const expectedSigner = Keypair.random();
    const actualSigner = Keypair.random();
    const unsignedXdr = built(expectedSigner.publicKey()).unsignedXdr;
    const transaction = new Transaction(unsignedXdr, testnetMarket.networkPassphrase);
    transaction.sign(actualSigner);

    expect(() =>
      assertSignedTransactionMatchesReview({
        unsignedXdr,
        signedXdr: transaction.toXDR(),
        networkPassphrase: testnetMarket.networkPassphrase,
        expectedSigner: expectedSigner.publicKey(),
      }),
    ).toThrow("not signed by the connected wallet account");
  });

  it("rejects a transaction with no signatures", () => {
    const signer = Keypair.random();
    const unsignedXdr = built(signer.publicKey()).unsignedXdr;

    expect(() =>
      assertSignedTransactionMatchesReview({
        unsignedXdr,
        signedXdr: unsignedXdr,
        networkPassphrase: testnetMarket.networkPassphrase,
        expectedSigner: signer.publicKey(),
      }),
    ).toThrow("no signatures");
  });
});

describe("pollTransactionStatus", () => {
  it("polls until the transaction is found", async () => {
    let calls = 0;
    const result = await pollTransactionStatus({
      rpcUrl: testnetMarket.rpcUrl,
      hash: "abc123",
      attempts: 3,
      intervalMs: 1,
      wait: async () => undefined,
      server: {
        async getTransaction() {
          calls += 1;
          return { status: calls === 1 ? "NOT_FOUND" : "SUCCESS" };
        },
      },
    });

    expect(result).toEqual({ hash: "abc123", status: "SUCCESS", attempts: 2 });
  });

  it("returns NOT_FOUND after the polling budget is exhausted", async () => {
    const result = await pollTransactionStatus({
      rpcUrl: testnetMarket.rpcUrl,
      hash: "abc123",
      attempts: 2,
      intervalMs: 1,
      wait: async () => undefined,
      server: {
        async getTransaction() {
          return { status: "NOT_FOUND" };
        },
      },
    });

    expect(result).toEqual({ hash: "abc123", status: "NOT_FOUND", attempts: 2 });
  });

  it("keeps the result and diagnostic events of a FAILED transaction (R49)", async () => {
    const resultXdr = txResult(trapped);
    const diagnosticEventsXdr = [authRefused()];
    const result = await pollTransactionStatus({
      rpcUrl: testnetMarket.rpcUrl,
      hash: "abc123",
      wait: async () => undefined,
      server: {
        async getTransaction() {
          return { status: "FAILED", resultXdr, diagnosticEventsXdr };
        },
      },
    });
    expect(result).toEqual({ hash: "abc123", status: "FAILED", attempts: 1, failure: { result: resultXdr, diagnosticEvents: diagnosticEventsXdr } });
  });
});

// A FAILED Soroban transaction as RPC reports it (shapes from the Task 23 live run).
const txResult = (outcome: xdr.TransactionResultResult) =>
  new xdr.TransactionResult({ feeCharged: 48_031n, result: outcome, ext: xdr.TransactionResultExt.v0() });
const trapped = xdr.TransactionResultResult.txFailed([
  xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped())),
]);
/** A diagnostic `error` event, decoded from base64 as the SDK's getTransaction does. */
function diagnosticError(error: xdr.ScError, text: string, inSuccessfulContractCall = false): xdr.DiagnosticEvent {
  const event = new xdr.DiagnosticEvent({
    inSuccessfulContractCall,
    event: new xdr.ContractEvent({
      ext: xdr.ExtensionPoint.v0(),
      contractId: null,
      type: xdr.ContractEventType.diagnostic,
      body: xdr.ContractEventBody.v0(
        new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(error)], data: xdr.ScVal.scvString(text) }),
      ),
    }),
  });
  return xdr.DiagnosticEvent.fromXdr(event.toXdr("base64"), "base64");
}
/** The host refusing a nested call whose arguments no longer match the signed authorization. */
const authRefused = () => diagnosticError(xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction), "Unauthorized function call for address");

describe("failedTransactionReason (R49)", () => {
  it("says the amounts moved when the host refused an authorization (Error(Auth, InvalidAction))", () => {
    expect(failedTransactionReason({ result: txResult(trapped), diagnosticEvents: [authRefused()] })).toBe(AMOUNTS_MOVED_REASON);
    // No cause beyond what the event shows is claimed (R49 hint).
    expect(AMOUNTS_MOVED_REASON).toBe(
      "Amounts moved between your review and inclusion. Nothing was taken except the network fee; prepare again.",
    );
  });

  it("counts only an authorization refusal raised in a call that failed (inSuccessfulContractCall false)", () => {
    const inSuccessfulCall = diagnosticError(
      xdr.ScError.sceAuth(xdr.ScErrorCode.scecInvalidAction),
      "Unauthorized function call for address",
      true,
    );
    expect(failedTransactionReason({ result: txResult(trapped), diagnosticEvents: [inSuccessfulCall] })).toBe(
      "Cause: the contract call failed. Nothing was taken except the network fee.",
    );
  });

  it("names the result code otherwise, and that only the fee was taken", () => {
    expect(failedTransactionReason({ result: txResult(trapped) })).toBe("Cause: the contract call failed. Nothing was taken except the network fee.");
    const contractError = diagnosticError(xdr.ScError.sceContract(9), "failing with contract error");
    expect(failedTransactionReason({ result: txResult(trapped), diagnosticEvents: [contractError] })).toBe(
      "Cause: the contract call failed. Nothing was taken except the network fee.",
    );
    const archived = xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionEntryArchived())),
    ]);
    expect(failedTransactionReason({ result: txResult(archived) })).toBe(
      "Cause: contract data it needs is archived; restore it first. Nothing was taken except the network fee.",
    );
  });

  it("describes a failed restore in plain words (R49)", () => {
    const restore = (r: xdr.RestoreFootprintResult) =>
      txResult(xdr.TransactionResultResult.txFailed([xdr.OperationResult.opInner(xdr.OperationResultTr.restoreFootprint(r))]));
    expect(failedTransactionReason({ result: restore(xdr.RestoreFootprintResult.restoreFootprintResourceLimitExceeded()) })).toBe(
      "Cause: the restore ran out of the resources it declared; prepare it again. Nothing was taken except the network fee.",
    );
    expect(failedTransactionReason({ result: restore(xdr.RestoreFootprintResult.restoreFootprintInsufficientRefundableFee()) })).toBe(
      "Cause: its refundable fee is too low to restore the data; prepare it again. Nothing was taken except the network fee.",
    );
    expect(failedTransactionReason({ result: restore(xdr.RestoreFootprintResult.restoreFootprintMalformed()) })).toBe(
      "Cause: the restore is malformed; prepare it again. Nothing was taken except the network fee.",
    );
  });

  it("never prints the raw operation-result discriminant", () => {
    const failed = (op: xdr.OperationResult) => describeTransactionResult(txResult(xdr.TransactionResultResult.txFailed([op])));
    const results = [
      xdr.OperationResult.opInner(xdr.OperationResultTr.restoreFootprint(xdr.RestoreFootprintResult.restoreFootprintMalformed())),
      xdr.OperationResult.opInner(xdr.OperationResultTr.extendFootprintTtl(xdr.ExtendFootprintTtlResult.extendFootprintTtlMalformed())),
      xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentUnderfunded())),
      xdr.OperationResult.opBadAuth(),
      xdr.OperationResult.opNoAccount(),
      xdr.OperationResult.opTooManySubentries(),
    ];
    for (const op of results) expect(failed(op)).not.toMatch(/opInner|opBad|opNo|opToo/);
    expect(failed(xdr.OperationResult.opBadAuth())).toBe(
      "its operation is not signed by the right account; reconnect the wallet, then prepare it again",
    );
    expect(failed(results[2])).toBe("its payment operation failed (paymentUnderfunded)");
  });

  it("says the network gave no reason when RPC returned no result", () => {
    expect(failedTransactionReason(undefined)).toBe("The network did not say why. Nothing was taken except the network fee.");
    expect(failedTransactionReason({})).toBe("The network did not say why. Nothing was taken except the network fee.");
  });
});


describe("simulateInvocation", () => {
  const source = Keypair.random().publicKey();
  const invocation: ContractInvocation = {
    contractId: testnetMarket.contracts.router,
    functionName: "mint",
    args: [{ type: "address", value: source }],
  };
  const account = { sequenceNumber: () => "5" };
  const run = (simulate: () => unknown) =>
    simulateInvocation({
      rpcUrl: testnetMarket.rpcUrl,
      networkPassphrase: testnetMarket.networkPassphrase,
      source,
      invocation,
      server: {
        async getAccount() {
          return account;
        },
        async simulateTransaction() {
          return simulate() as rpc.Api.SimulateTransactionResponse;
        },
      },
    });

  it("decodes a successful write simulation", async () => {
    const out = await run(() => ({
      id: "1",
      _parsed: true,
      latestLedger: 90,
      events: [],
      minResourceFee: "555",
      transactionData: {},
      result: { auth: [{}], retval: nativeToScVal(7n, { type: "i128" }) },
    }));
    expect(out).toEqual({ ok: true, retval: 7n, latestLedger: 90, minResourceFee: "555" });
  });

  it("restore-required simulation", async () => {
    const out = await run(() => ({
      id: "1",
      _parsed: true,
      latestLedger: 90,
      events: [],
      minResourceFee: "1",
      transactionData: {},
      result: { auth: [], retval: nativeToScVal(1n, { type: "i128" }) },
      restorePreamble: { minResourceFee: "999", transactionData: {} },
    }));
    expect(out).toEqual({ ok: false, kind: "restore_required" });
  });

  it("contract error is parsed", async () => {
    const out = await run(() => ({
      id: "1",
      _parsed: true,
      latestLedger: 90,
      events: [],
      error: "HostError: Error(Contract, #9)",
    }));
    expect(out).toEqual({
      ok: false,
      kind: "contract_error",
      contractId: testnetMarket.contracts.router,
      code: 9,
      message: "HostError: Error(Contract, #9)",
    });
  });

  describe("attributes a contract error to the contract that raised it (R25)", () => {
    const { router, manager, pool } = testnetMarket.contracts;
    const contractBytes = (id: string) => xdr.ScVal.scvBytes(StrKey.decodeContract(id));
    const errorTopics = (code: number) => [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(xdr.ScError.sceContract(code))];
    const message = (text: string) => xdr.ScVal.scvString(text);
    // One diagnostic event as RPC sends it: base64 XDR, decoded by the SDK's parseRawSimulation.
    function diagnostic(contractId: string | null, topics: xdr.ScVal[], data: xdr.ScVal): string {
      return new xdr.DiagnosticEvent({
        inSuccessfulContractCall: false,
        event: new xdr.ContractEvent({
          ext: xdr.ExtensionPoint.v0(),
          contractId: contractId ? new xdr.ContractId(StrKey.decodeContract(contractId)) : null,
          type: xdr.ContractEventType.diagnostic,
          body: xdr.ContractEventBody.v0(new xdr.ContractEventV0({ topics, data })),
        }),
      }).toXdr("base64");
    }
    const failedSimulation = (code: number, events: string[]) =>
      rpc.parseRawSimulation({
        id: "1",
        latestLedger: 90,
        events,
        error: `HostError: Error(Contract, #${code})\n\nEvent log (newest first): ...`,
      } as rpc.Api.RawSimulateTransactionResponse);
    const fnCall = (caller: string | null, callee: string, fn: string) =>
      diagnostic(caller, [xdr.ScVal.scvSymbol("fn_call"), contractBytes(callee), xdr.ScVal.scvSymbol(fn)], xdr.ScVal.scvVec([]));

    it("nested failure: Router invoked, PrincipalManager raised #9 -> the manager", async () => {
      const out = await run(() =>
        failedSimulation(9, [
          fnCall(null, router, "swap_sy_for_yt"),
          fnCall(router, manager, "mint"),
          diagnostic(manager, errorTopics(9), message("failing with contract error")),
          diagnostic(router, errorTopics(9), message("contract call failed")),
          diagnostic(null, errorTopics(9), message("contract call failed")),
        ]),
      );
      expect(out).toMatchObject({ ok: false, kind: "contract_error", contractId: manager, code: 9 });
    });

    it("an error the invoked contract raised itself stays on the invoked contract", async () => {
      const out = await run(() =>
        failedSimulation(9, [
          fnCall(null, router, "swap_sy_for_yt"),
          diagnostic(router, errorTopics(9), message("failing with contract error")),
          diagnostic(null, errorTopics(9), message("contract call failed")),
        ]),
      );
      expect(out).toMatchObject({ kind: "contract_error", contractId: router, code: 9 });
    });

    it("skips error events with another code or without a contract id", async () => {
      const out = await run(() =>
        failedSimulation(3, [
          // A caught failure earlier in the call (another code) is not the error that failed it.
          diagnostic(manager, errorTopics(9), message("failing with contract error")),
          diagnostic(null, errorTopics(3), message("contract call failed")),
          diagnostic(pool, errorTopics(3), message("failing with contract error")),
        ]),
      );
      expect(out).toMatchObject({ kind: "contract_error", contractId: pool, code: 3 });
    });

    it("falls back to the invoked contract when no error event names the raiser", async () => {
      const out = await run(() =>
        failedSimulation(9, [diagnostic(null, errorTopics(9), message("contract call failed"))]),
      );
      expect(out).toMatchObject({ kind: "contract_error", contractId: router, code: 9 });
    });
  });

  it("maps other simulation errors and thrown failures to rpc_error", async () => {
    const trapped = await run(() => ({ id: "1", _parsed: true, latestLedger: 1, events: [], error: "trapped" }));
    expect(trapped).toEqual({ ok: false, kind: "rpc_error", message: "trapped" });
    const down = await run(() => {
      throw new Error("network down");
    });
    expect(down).toEqual({ ok: false, kind: "rpc_error", message: "network down" });
  });

  it("uses the user's sequence and never prepares the transaction", async () => {
    let seen: Transaction | undefined;
    await simulateInvocation({
      rpcUrl: testnetMarket.rpcUrl,
      networkPassphrase: testnetMarket.networkPassphrase,
      source,
      invocation,
      server: {
        async getAccount(address: string) {
          expect(address).toBe(source);
          return account;
        },
        async simulateTransaction(tx: Transaction) {
          seen = tx;
          return { id: "1", _parsed: true, latestLedger: 1, events: [], error: "x" } as rpc.Api.SimulateTransactionErrorResponse;
        },
      },
    });
    expect(seen?.source).toBe(source);
    expect(seen?.sequence).toBe("6");
  });
});

describe("pollTransactionStatus return value", () => {
  it("poll decodes return value", async () => {
    const result = await pollTransactionStatus({
      rpcUrl: testnetMarket.rpcUrl,
      hash: "abc123",
      attempts: 1,
      wait: async () => undefined,
      server: {
        async getTransaction() {
          return { status: "SUCCESS", returnValue: nativeToScVal(42n, { type: "i128" }) };
        },
      },
    });
    expect(result.returnValue).toBe(42n);
    expect(result.status).toBe("SUCCESS");
  });

  it("keeps the hash and status when the return value cannot be decoded", async () => {
    const result = await pollTransactionStatus({
      rpcUrl: testnetMarket.rpcUrl,
      hash: "abc123",
      attempts: 1,
      wait: async () => undefined,
      server: {
        async getTransaction() {
          // A corrupt value: decoding it throws.
          return { status: "SUCCESS", returnValue: { type: "scvMap", map: [null], value: [null] } as unknown as xdr.ScVal };
        },
      },
    });
    expect(result).toMatchObject({ hash: "abc123", status: "SUCCESS", attempts: 1 });
    expect(result.returnValue).toBeUndefined();
    expect(result.decodeError).toMatch(/could not be decoded/);
  });
});

describe("getLedgerClock", () => {
  it("reads sequence and close time from the latest ledger", async () => {
    const before = Date.now();
    const clock = await getLedgerClock({
      async getLatestLedger() {
        return { sequence: 1234, closeTime: "1790000000" };
      },
    });
    expect(clock.sequence).toBe(1234);
    expect(clock.closeTime).toBe(1790000000);
    expect(clock.readAtMs).toBeGreaterThanOrEqual(before);
  });

  it("refuses a missing close time", async () => {
    await expect(
      getLedgerClock({
        async getLatestLedger() {
          return { sequence: 1, closeTime: "" };
        },
      }),
    ).rejects.toThrow("close time");
  });
});
