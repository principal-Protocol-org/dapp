/**
 * Mock state shared by the action-tab tests (Tasks 15–18). Plain data and `vi.fn`s only: it is
 * loaded inside `vi.hoisted`, before any app module, so it must not import one.
 *
 * Usage in a test file (the `vi.mock` lines must stay in the test file to be hoisted):
 *   const mocks = await vi.hoisted(async () => (await import("./panel-mocks")).createPanelMocks())
 */
import { vi } from "vitest"
import type { AccountState } from "@/lib/protocol/account-state"
import type { Finding } from "@/lib/protocol/types"

export const PASSPHRASE = "Test SDF Network ; September 2015"
export const A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

export const MARKET = {
  marketId: "m1",
  displayName: "STA · test",
  underlying: { code: "STA", issuer: "GISSUER", sac: "CSAC", decimals: 7 },
  maturity: 1_800_000_000,
  contracts: {
    router: "CROUTER",
    oracle: "CORACLE",
    sy: "CSY",
    pt: "CPT",
    yt: "CYT",
    config: "CCONFIG",
    manager: "CMANAGER",
    pool: "CPOOL",
    recoveryEscrow: "CESCROW",
  },
}

export const MANIFEST = {
  schemaVersion: 1 as const,
  network: "testnet" as const,
  networkPassphrase: PASSPHRASE,
  rpcUrl: "https://rpc.example",
  horizonUrl: "https://horizon.example",
  generatedAt: "2026-10-01T00:00:00Z",
  sourceCommit: "6cf257a",
  shared: { riskControl: "CRISK", permissioning: "CPERM" },
  markets: [MARKET],
}

/** A pool view's answer: a value, or a function of the call's arguments. An `Error` is thrown. */
export type ReadAnswer = unknown | ((args: { type: string; value: unknown }[]) => unknown)

export function createPanelMocks() {
  return {
    manifest: MANIFEST,
    findings: [] as Finding[],
    accounts: {} as Record<string, AccountState | "pending">,
    /** Answers of `createRpcReader(...)` calls (pool quotes), by function name. */
    reads: {} as Record<string, ReadAnswer>,
    read: vi.fn(),
    adapter: { restore: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), sign: vi.fn(), watch: vi.fn() },
    fetchMarketState: vi.fn(),
    fetchAccountState: vi.fn(),
    fetchMarketCompliance: vi.fn(),
    getLedgerClock: vi.fn(),
    simulateInvocation: vi.fn(),
    prepareReview: vi.fn(),
    executeReview: vi.fn(),
    prepareRestore: vi.fn(),
    executeRestore: vi.fn(),
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
  }
}

export type PanelMocks = ReturnType<typeof createPanelMocks>
