import { z } from "zod"
import type { Finding, Manifest, Market, Network } from "./types"

const contractId = z.string().regex(/^C[A-Z2-7]{55}$/, "Expected Stellar contract ID (C...)")
const accountId = z.string().regex(/^G[A-Z2-7]{55}$/, "Expected Stellar account ID (G...)")

const marketSchema = z.object({
  marketId: z.string().min(1),
  displayName: z.string().min(1),
  underlying: z.object({
    code: z.string().min(1).max(12),
    issuer: accountId,
    sac: contractId,
    decimals: z.number().int().min(0).max(18),
  }),
  maturity: z.number().int().positive(),
  contracts: z.object({
    router: contractId,
    oracle: contractId,
    sy: contractId,
    pt: contractId,
    yt: contractId,
    config: contractId,
    manager: contractId,
    pool: contractId,
    recoveryEscrow: contractId,
  }),
  /** Optional (spec §1): the Wasm hash (hex) each contract runs, by contract name. The only trust anchor for restoring contract code (R29b). */
  wasmHashes: z.record(z.string().min(1), z.string().regex(/^[0-9a-fA-F]{64}$/, "Expected a 32-byte Wasm hash in hex")).optional(),
})

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  network: z.enum(["local", "testnet", "mainnet"]),
  networkPassphrase: z.string().min(1),
  rpcUrl: z.string().url(),
  horizonUrl: z.string().url(),
  friendbotUrl: z.string().url().optional(),
  generatedAt: z.string().datetime(),
  sourceCommit: z.string().min(1),
  shared: z.object({ riskControl: contractId, permissioning: contractId }),
  markets: z.array(marketSchema).min(1, "At least one market is required"),
})

export const PASSPHRASES: Record<Network, string> = {
  local: "Standalone Network ; February 2017",
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
}

export function parseManifest(json: unknown): Manifest {
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    throw new Error(`Invalid manifest: ${detail}`)
  }
  return parsed.data
}

export function validateManifest(m: Manifest): Finding[] {
  const findings: Finding[] = []
  const error = (message: string) => findings.push({ severity: "error", message })

  const parsed = manifestSchema.safeParse(m)
  if (!parsed.success) {
    for (const i of parsed.error.issues) error(`${i.path.join(".") || "(root)"}: ${i.message}`)
  }

  if (m.networkPassphrase !== PASSPHRASES[m.network]) {
    error(`networkPassphrase does not match network "${m.network}": expected "${PASSPHRASES[m.network]}".`)
  }

  // Plain http lets a network attacker feed fabricated balances and quotes. Fine locally only.
  if (m.network !== "local") {
    if (!m.rpcUrl.startsWith("https://")) error(`rpcUrl must use https:// on ${m.network}.`)
    if (!m.horizonUrl.startsWith("https://")) error(`horizonUrl must use https:// on ${m.network}.`)
    if (m.friendbotUrl && !m.friendbotUrl.startsWith("https://")) {
      error(`friendbotUrl must use https:// on ${m.network}.`)
    }
  }

  const seen = new Set<string>()
  for (const market of m.markets) {
    if (seen.has(market.marketId)) error(`Duplicate marketId "${market.marketId}".`)
    seen.add(market.marketId)
  }

  return findings
}

export function getMarket(m: Manifest, marketId: string): Market | undefined {
  return m.markets.find((x) => x.marketId === marketId)
}
