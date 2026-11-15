export type Network = "local" | "testnet" | "mainnet"

export type MarketContracts = {
  router: string
  oracle: string
  sy: string
  pt: string
  yt: string
  config: string
  manager: string
  pool: string
  recoveryEscrow: string
}

export type MarketContractName = "sy" | "pt" | "yt" | "config" | "manager" | "pool" | "recoveryEscrow"

/** Keys a pinned Wasm hash may carry: a market contract kind or a shared contract. */
export type WasmHashKey = MarketContractName | "router" | "oracle" | "permissioning" | "riskControl" | "factory"

/** Contracts shared by every market. `router` and `oracle` are the ones each market is wired to. */
export type SharedContracts = {
  router: string
  oracle: string
  permissioning: string
  riskControl: string
  factory?: string
}

/** The test underlying (USDY on local and Testnet); optional until a deploy emits it. */
export type TestAsset = { code: string; issuer: string; sac: string; decimals: number; displayName: string }

export type Market = {
  marketId: string
  displayName: string
  underlying: { code: string; issuer: string; sac: string; decimals: number }
  maturity: number
  contracts: MarketContracts
  /** Wasm hash (hex) each contract runs, by contract name; optional in the manifest. */
  wasmHashes?: Record<string, string>
  /**
   * Registry markets only: the earliest ledger at which discovery saw the factory build this market
   * (its salt's `mkt_tok`, `mkt_eng` or `mkt_new`, in the page of events that named its pool). The
   * indexer reads a newly listed market from there instead of `deployLedger` (spec 0004 D-14).
   * Absent for the manifest seeds and for a market discovery has not seen built.
   */
  createdLedger?: number
}

export type Manifest = {
  schemaVersion: 2
  network: Network
  networkPassphrase: string
  rpcUrl: string
  horizonUrl: string
  friendbotUrl?: string
  generatedAt: string
  sourceCommit: string
  /** Ledger of the deployment's first contract creation: where the indexer starts. */
  deployLedger?: number
  /** Oracle source hashes the monitor recognises: sha256(preimage) = hash. */
  oracleSources?: { hash: string; preimage: string }[]
  /** RPC endpoints tried, in order, after `rpcUrl`. */
  rpcFallbackUrls?: string[]
  shared: SharedContracts
  /** Pinned Wasm hash (hex) per market contract kind; the trust anchor for restoring code (R29b). */
  wasmHashes: Partial<Record<WasmHashKey, string>>
  /** Router functions the dApp may call in user flows. */
  routerFunctions: string[]
  testAsset?: TestAsset
  markets: Market[]
}

export type Finding = { severity: "error" | "warning"; message: string }

export type WalletState =
  | { status: "not_installed" }
  | { status: "locked" }
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "connected"; publicKey: string; networkPassphrase: string }
  | { status: "unverified_network"; publicKey: string; expectedPassphrase: string; reason: string }
  | { status: "wrong_network"; publicKey: string; actualPassphrase: string; expectedPassphrase: string }
  | { status: "rejected"; reason: string }

/** Where a figure was read: enough for a reviewer to repeat the call and compare the raw return value. */
/** Where a figure was read; `viaFallback` when `rpcUrl` is one of the manifest's fallbacks (D-6). */
export type ReadSource = { contractId: string; fn: string; args: unknown[]; rawXdr: string; ledger: number; rpcUrl: string; viaFallback?: boolean }

/** A chain value, or the reason it could not be read. Gates treat `unavailable` as a refusal. */
export type Live<T> =
  | { status: "live"; value: T; ledger: number; source?: ReadSource; sources?: ReadSource[]; ledgerSpread?: { min: number; max: number } }
  | { status: "unavailable"; error: string; source?: Omit<ReadSource, "rawXdr" | "ledger"> }
