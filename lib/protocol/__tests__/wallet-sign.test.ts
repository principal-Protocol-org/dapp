// @vitest-environment node
import { Account, BASE_FEE, Contract, Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import testnetJson from "@/lib/protocol/__tests__/fixtures/testnet-interim.json";
import { parseManifest } from "../manifest";

const { signTransactionMock } = vi.hoisted(() => ({ signTransactionMock: vi.fn() }));
vi.mock("@stellar/freighter-api", () => ({ signTransaction: signTransactionMock }));

import { freighterAdapter } from "../wallet";

const manifest = parseManifest(testnetJson);
const PASS = manifest.networkPassphrase;
const router = manifest.markets[0].contracts.router;

function build(source: string, ops = 1) {
  let b = new TransactionBuilder(new Account(source, "1"), { fee: BASE_FEE, networkPassphrase: PASS });
  for (let i = 0; i < ops; i++) b = b.addOperation(new Contract(router).call("claim_yield"));
  return b.setTimeout(300).build();
}

describe("freighterAdapter.sign with real transactions", () => {
  beforeEach(() => signTransactionMock.mockReset());

  it("rejects a different signer", async () => {
    const expected = Keypair.random();
    const xdr = build(expected.publicKey()).toXDR();
    signTransactionMock.mockResolvedValue({ signedTxXdr: xdr, signerAddress: Keypair.random().publicKey() });
    await expect(freighterAdapter.sign(xdr, PASS, expected.publicKey())).rejects.toThrow("Your wallet signed with");
  });

  it("accepts a matching signed transaction from the expected account", async () => {
    const signer = Keypair.random();
    const xdr = build(signer.publicKey()).toXDR();
    const tx = new Transaction(xdr, PASS);
    tx.sign(signer);
    signTransactionMock.mockResolvedValue({ signedTxXdr: tx.toXDR(), signerAddress: signer.publicKey() });
    await expect(freighterAdapter.sign(xdr, PASS, signer.publicKey())).resolves.toBe(tx.toXDR());
  });

  it("rejects a tampered body even when the reported signer matches", async () => {
    const signer = Keypair.random();
    const xdr = build(signer.publicKey()).toXDR();
    const tampered = build(signer.publicKey(), 2);
    tampered.sign(signer);
    signTransactionMock.mockResolvedValue({ signedTxXdr: tampered.toXDR(), signerAddress: signer.publicKey() });
    await expect(freighterAdapter.sign(xdr, PASS, signer.publicKey())).rejects.toThrow(
      "does not match the reviewed unsigned transaction",
    );
  });
});
