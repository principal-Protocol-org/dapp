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
  schemaVersion: 1
  network: Network
  networkPassphrase: string
  rpcUrl: string
  horizonUrl: string
  friendbotUrl?: string
  generatedAt: string
  sourceCommit: string
  shared: { riskControl: string; permissioning: string }
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
