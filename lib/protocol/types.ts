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

/** A chain value, or the reason it could not be read. Gates treat `unavailable` as a refusal. */
export type Live<T> = { status: "live"; value: T; ledger: number } | { status: "unavailable"; error: string }
