// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSession } from "@/lib/app/session";

const m = vi.hoisted(() => ({
  isConnected: vi.fn(),
  isAllowed: vi.fn(),
  requestAccess: vi.fn(),
  getAddress: vi.fn(),
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
  watch: vi.fn(),
  stop: vi.fn(),
  ctorArgs: [] as unknown[],
  assertMatch: vi.fn(),
}));

vi.mock("@stellar/freighter-api", () => ({
  isConnected: m.isConnected,
  isAllowed: m.isAllowed,
  requestAccess: m.requestAccess,
  getAddress: m.getAddress,
  getNetwork: m.getNetwork,
  signTransaction: m.signTransaction,
  WatchWalletChanges: class {
    constructor(ms?: number) {
      m.ctorArgs.push(ms);
    }
    watch = m.watch;
    stop = m.stop;
  },
}));
vi.mock("../stellar", () => ({ assertSignedTransactionMatchesReview: m.assertMatch }));

import { freighterAdapter } from "../wallet";

const PASS = "Test SDF Network ; September 2015";
const manifest = { networkPassphrase: PASS };
const PUBLIC = "Public Global Stellar Network ; September 2015";
const publicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function reset() {
  Object.values(m).forEach((f) => typeof f === "function" && "mockReset" in f && f.mockReset());
  m.ctorArgs.length = 0;
  localStorage.clear();
  delete (window as { freighterApi?: unknown }).freighterApi;
}

describe("freighterAdapter.restore", () => {
  beforeEach(reset);
  afterEach(reset);

  it("restore does not prompt: reads the address when allowed and never requests access", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.isAllowed.mockResolvedValue({ isAllowed: true });
    m.getAddress.mockResolvedValue({ address: publicKey });
    m.getNetwork.mockResolvedValue({ network: "TESTNET", networkPassphrase: PASS });
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({
      status: "connected",
      publicKey,
      networkPassphrase: PASS,
    });
    expect(m.getAddress).toHaveBeenCalled();
    expect(m.requestAccess).not.toHaveBeenCalled();
  });

  it("restore is disconnected when Freighter has not allowed the site, without prompting", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.isAllowed.mockResolvedValue({ isAllowed: false });
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({ status: "disconnected" });
    expect(m.requestAccess).not.toHaveBeenCalled();
    expect(m.getAddress).not.toHaveBeenCalled();
  });

  it("restore stays disconnected after an explicit disconnect", async () => {
    writeSession({ connected: false });
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.isAllowed.mockResolvedValue({ isAllowed: true });
    m.getAddress.mockResolvedValue({ address: publicKey });
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({ status: "disconnected" });
    expect(m.getAddress).not.toHaveBeenCalled();
    expect(m.requestAccess).not.toHaveBeenCalled();
  });

  it("restore reports not_installed when the package errors and no legacy API is injected", async () => {
    m.isConnected.mockResolvedValue({ isConnected: false, error: { code: 1, message: "not found" } });
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({ status: "not_installed" });
  });

  it("restore fails closed to locked when the package errors and the legacy API cannot confirm", async () => {
    m.isConnected.mockResolvedValue({ isConnected: false, error: { code: 1, message: "not found" } });
    (window as { freighterApi?: unknown }).freighterApi = {};
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({ status: "locked" });
  });

  // freighter-api 4.x: `isConnected` answers whether the extension is installed; a locked wallet is
  // installed and is caught later, by the empty address (I1).
  it("restore reports not_installed when the extension is absent (isConnected false, no error)", async () => {
    m.isConnected.mockResolvedValue({ isConnected: false });
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({ status: "not_installed" });
    expect(m.isAllowed).not.toHaveBeenCalled();
  });

  it("restore reports locked when the extension is installed but gives no address", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.isAllowed.mockResolvedValue({ isAllowed: true });
    m.getAddress.mockResolvedValue({ address: "" });
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({ status: "locked" });
    expect(m.getNetwork).not.toHaveBeenCalled();
  });

  it("restore asks an injected legacy API when the package finds no extension, and fails closed to locked", async () => {
    m.isConnected.mockResolvedValue({ isConnected: false });
    const isConnected = vi.fn(async () => false);
    (window as { freighterApi?: unknown }).freighterApi = { isConnected };
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({ status: "locked" });
    expect(isConnected).toHaveBeenCalled();
  });

  it("restore yields wrong_network when the Freighter passphrase differs from the manifest (R27)", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.isAllowed.mockResolvedValue({ isAllowed: true });
    m.getAddress.mockResolvedValue({ address: publicKey });
    m.getNetwork.mockResolvedValue({ network: "PUBLIC", networkPassphrase: PUBLIC });
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({
      status: "wrong_network",
      publicKey,
      actualPassphrase: PUBLIC,
      expectedPassphrase: PASS,
    });
  });

  it("restore reports unverified_network when the network cannot be read", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.isAllowed.mockResolvedValue({ isAllowed: true });
    m.getAddress.mockResolvedValue({ address: publicKey });
    m.getNetwork.mockResolvedValue({ error: { code: 2, message: "network read failed" } });
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({
      status: "unverified_network",
      publicKey,
      expectedPassphrase: PASS,
      reason: "network read failed",
    });
  });

  it("restore reports rejected when a wallet call throws", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.isAllowed.mockRejectedValue(new Error("boom"));
    await expect(freighterAdapter.restore(manifest)).resolves.toEqual({ status: "rejected", reason: "boom" });
  });
});

describe("freighterAdapter.connect", () => {
  beforeEach(reset);
  afterEach(reset);

  it("connect prompts via requestAccess and remembers the session", async () => {
    writeSession({ connected: false });
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.requestAccess.mockResolvedValue({ address: publicKey });
    m.getNetwork.mockResolvedValue({ network: "TESTNET", networkPassphrase: PASS });
    await expect(freighterAdapter.connect(manifest)).resolves.toEqual({
      status: "connected",
      publicKey,
      networkPassphrase: PASS,
    });
    expect(m.requestAccess).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem("pp-wallet") ?? "{}")).toEqual({ connected: true });
  });

  it("connect yields wrong_network when the Freighter passphrase differs from the manifest (R27)", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.requestAccess.mockResolvedValue({ address: publicKey });
    m.getNetwork.mockResolvedValue({ network: "PUBLIC", networkPassphrase: PUBLIC });
    await expect(freighterAdapter.connect(manifest)).resolves.toEqual({
      status: "wrong_network",
      publicKey,
      actualPassphrase: PUBLIC,
      expectedPassphrase: PASS,
    });
  });

  it("connect reports rejected when the user declines access", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.requestAccess.mockRejectedValue(new Error("User declined access"));
    await expect(freighterAdapter.connect(manifest)).resolves.toEqual({
      status: "rejected",
      reason: "User declined access",
    });
  });

  it("connect reports not_installed when the extension is absent, without prompting", async () => {
    m.isConnected.mockResolvedValue({ isConnected: false });
    await expect(freighterAdapter.connect(manifest)).resolves.toEqual({ status: "not_installed" });
    expect(m.requestAccess).not.toHaveBeenCalled();
  });

  it("connect reports locked when no address can be read after requestAccess errors", async () => {
    m.isConnected.mockResolvedValue({ isConnected: true });
    m.requestAccess.mockResolvedValue({ error: { code: 4, message: "denied" } });
    m.getAddress.mockResolvedValue({ error: { code: 4, message: "denied" } });
    m.getNetwork.mockResolvedValue({ network: "TESTNET", networkPassphrase: PASS });
    await expect(freighterAdapter.connect(manifest)).resolves.toEqual({ status: "locked" });
  });

  it("disconnect remembers an explicit disconnect", () => {
    freighterAdapter.disconnect();
    expect(JSON.parse(localStorage.getItem("pp-wallet") ?? "{}")).toEqual({ connected: false });
  });
});

describe("freighterAdapter.watch", () => {
  beforeEach(reset);
  afterEach(reset);

  it("watch reports account and network changes and stops on cleanup", () => {
    const onChange = vi.fn();
    const stop = freighterAdapter.watch(onChange);
    expect(m.watch).toHaveBeenCalledTimes(1);
    const cb = m.watch.mock.calls[0][0] as (p: unknown) => void;
    cb({ address: publicKey, network: "PUBLIC", networkPassphrase: PUBLIC });
    expect(onChange).toHaveBeenCalledWith({ address: publicKey, networkPassphrase: PUBLIC });
    cb({ address: publicKey, network: "x", networkPassphrase: PASS, error: { code: 1, message: "e" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(m.stop).toHaveBeenCalledTimes(1);
  });
});

describe("freighterAdapter.sign", () => {
  beforeEach(reset);
  afterEach(reset);

  it("sign refuses a different signer", async () => {
    m.signTransaction.mockResolvedValue({ signedTxXdr: "SIGNED", signerAddress: "GOTHER" });
    await expect(freighterAdapter.sign("XDR", PASS, "GEXPECTED")).rejects.toThrow("Your wallet signed with");
    expect(m.assertMatch).not.toHaveBeenCalled();
  });

  it("sign verifies the signed envelope against the reviewed XDR and returns it", async () => {
    m.signTransaction.mockResolvedValue({ signedTxXdr: "SIGNED", signerAddress: "GME" });
    await expect(freighterAdapter.sign("XDR", PASS, "GME")).resolves.toBe("SIGNED");
    // Freighter is told which account must sign (M2); the checks below still run on its answer.
    expect(m.signTransaction).toHaveBeenCalledWith("XDR", { networkPassphrase: PASS, address: "GME" });
    expect(m.assertMatch).toHaveBeenCalledWith({
      unsignedXdr: "XDR",
      signedXdr: "SIGNED",
      networkPassphrase: PASS,
      expectedSigner: "GME",
    });
  });

  it("sign propagates a body-mismatch rejection", async () => {
    m.signTransaction.mockResolvedValue({ signedTxXdr: "SIGNED", signerAddress: "GME" });
    m.assertMatch.mockImplementation(() => {
      throw new Error("does not match the reviewed unsigned transaction");
    });
    await expect(freighterAdapter.sign("XDR", PASS, "GME")).rejects.toThrow("does not match");
  });
});
