// @vitest-environment node
import { Keypair, Transaction, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import testnetJson from "@/config/manifests/testnet.json";
import { parseManifest } from "../manifest";
import {
  assertSignedTransactionMatchesReview,
  buildInvokeTransaction,
  getLedgerClock,
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
