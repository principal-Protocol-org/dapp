import { z } from "zod"
import type { Finding, Manifest, Market, Network } from "./types"

const contractId = z.string().regex(/^C[A-Z2-7]{55}$/, "Expected Stellar contract ID (C...)")
const accountId = z.string().regex(/^G[A-Z2-7]{55}$/, "Expected Stellar account ID (G...)")

const hexHash = z.string().regex(/^[0-9a-fA-F]{64}$/, "Expected a 32-byte Wasm hash in hex")
// Market contract kinds plus the shared contracts: the generated v1 files pin both.
const wasmHashKey = z.enum([
  "sy", "pt", "yt", "config", "manager", "pool", "recoveryEscrow",
  "router", "oracle", "permissioning", "riskControl", "factory",
])
const wasmHashes = z.record(wasmHashKey, hexHash)

/** The Router's user-flow functions at be2a1a5 (admin, initialize, register_market, bump excluded). */
export const V1_ROUTER_FUNCTIONS = [
  "wrap_and_mint",
  "unwrap",
  "swap_sy_for_pt",
  "swap_pt_for_sy",
  "swap_sy_for_yt",
  "swap_yt_for_sy",
  "add_liquidity",
  "add_liquidity_single_sy",
  "remove_liquidity",
  "recombine",
  "redeem_at_maturity",
  "claim_yield",
]

const marketSchema = z.object({
  marketId: z.string().min(1),
  displayName: z.string().min(1),
  underlying: z.object({
    code: z.string().min(1).max(12),
    issuer: accountId,
    sac: contractId,
    decimals: z.number().int().min(0).max(18),
    /** Optional: the asset this underlying tracks (e.g. the token behind a wrapped one), shown beside it. */
    tracks: z.string().min(1).max(12).optional(),
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
  wasmHashes: z.record(z.string().min(1), hexHash).optional(),
  /** Optional, registry markets: the ledger discovery saw the factory build it at (the indexer's start for it). */
  createdLedger: z.number().int().positive().optional(),
})

const envelope = {
  network: z.enum(["local", "testnet", "mainnet"]),
  networkPassphrase: z.string().min(1),
  rpcUrl: z.string().url(),
  horizonUrl: z.string().url(),
  friendbotUrl: z.string().url().optional(),
  generatedAt: z.string().datetime(),
  sourceCommit: z.string().min(1),
  /** Ledger of the deployment's first contract creation: where the indexer starts. */
  deployLedger: z.number().int().positive().optional(),
  /** Oracle source hashes the monitor recognises: sha256(preimage) = hash. */
  oracleSources: z
    .array(z.object({ hash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Expected a 32-byte hash in hex"), preimage: z.string().min(1) }))
    .optional(),
  /** RPC endpoints tried, in order, after `rpcUrl`. */
  rpcFallbackUrls: z.array(z.string().url()).optional(),
}

const manifestSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  ...envelope,
  shared: z.object({ riskControl: contractId, permissioning: contractId }),
  markets: z.array(marketSchema).min(1, "At least one market is required"),
})

export const manifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    ...envelope,
    shared: z.object({
      router: contractId,
      oracle: contractId,
      permissioning: contractId,
      riskControl: contractId,
      factory: contractId.optional(),
    }),
    wasmHashes,
    routerFunctions: z.array(z.string().min(1)),
    testAsset: z
      .object({
        code: z.string().min(1).max(12),
        issuer: accountId,
        sac: contractId,
        decimals: z.number().int().min(0).max(18),
        displayName: z.string().min(1),
      })
      .optional(),
    /** Contract-interface version the Router speaks. Absent means 1 (Testnet). */
    protocolAbi: z.union([z.literal(1), z.literal(2)]).optional(),
    /** Where a person without access can ask for it. */
    accessContact: z
      .object({
        label: z.string().min(1),
        url: z.string().url().refine((u) => /^(https:|mailto:)/i.test(u), "Expected an https: or mailto: URL"),
      })
      .optional(),
    /** Ledger each contract was created at, by contract id. */
    createdLedgers: z.record(contractId, z.number().int().positive()).optional(),
    markets: z.array(marketSchema),
  })
  // The indexer starts at `deployLedger`: off the local network, a manifest without it would make
  // the indexer guess (or read from the RPC's oldest ledger and claim no gap). Local stacks start empty.
  .superRefine((m, ctx) => {
    if (m.network !== "local" && m.deployLedger === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["deployLedger"], message: `Required on ${m.network}: the ledger where the indexer starts` })
    }
  })

/** Router code hashes (hex) whose interface version is known. */
export const ROUTER_ABI_BY_WASM: Readonly<Record<string, 1 | 2>> = {
  // Testnet, 665bb67
  "9cd0403a156b192e09c1c614743e99c0b167e9a3c65c7e5553596639e772fd39": 1,
  // Mainnet, 3af9388
  "2a0997317651edb0f7e2bd753570b03a88462aa6d216c14b06ebec246bb3c1c2": 2,
}

/** The contract-interface version a manifest declares; 1 when it does not say. */
export function protocolAbi(m: Pick<Manifest, "protocolAbi">): 1 | 2 {
  return m.protocolAbi ?? 1
}

/** The distinct oracles of a manifest in first-seen order, each with the markets that use it. */
export function manifestOracles(m: Pick<Manifest, "markets">): { oracle: string; markets: Market[] }[] {
  const byOracle = new Map<string, Market[]>()
  for (const market of m.markets) {
    const list = byOracle.get(market.contracts.oracle)
    if (list) list.push(market)
    else byOracle.set(market.contracts.oracle, [market])
  }
  return [...byOracle].map(([oracle, markets]) => ({ oracle, markets }))
}

/** The underlying codes of `markets`, distinct, in order, joined by ", " ("USDY", "USTRY, GILT"): what an oracle's alerts and health name. */
export const assetCodes = (markets: Pick<Market, "underlying">[]): string => [...new Set(markets.map((m) => m.underlying.code))].join(", ")

export const PASSPHRASES: Record<Network, string> = {
  local: "Standalone Network ; February 2017",
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
}

function describe(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
}

/** Upgrades a v1 file: router and oracle come from the first market, wasm hashes from its pins. */
function upgradeV1(v1: z.infer<typeof manifestSchemaV1>): unknown {
  const rest: Partial<typeof v1> = { ...v1 }
  delete rest.schemaVersion
  const first = v1.markets[0]
  return {
    ...rest,
    schemaVersion: 2,
    shared: { ...v1.shared, router: first.contracts.router, oracle: first.contracts.oracle },
    wasmHashes: first.wasmHashes ?? {},
    routerFunctions: [...V1_ROUTER_FUNCTIONS],
  }
}

/** Accepts a v1 or v2 manifest and returns v2. */
export function parseManifest(json: unknown): Manifest {
  let input = json
  if (typeof json === "object" && json !== null && (json as { schemaVersion?: unknown }).schemaVersion === 1) {
    const v1 = manifestSchemaV1.safeParse(json)
    if (!v1.success) throw new Error(`Invalid manifest: ${describe(v1.error)}`)
    input = upgradeV1(v1.data)
  }
  const parsed = manifestSchema.safeParse(input)
  if (!parsed.success) throw new Error(`Invalid manifest: ${describe(parsed.error)}`)
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
    for (const url of m.rpcFallbackUrls ?? []) {
      if (!url.startsWith("https://")) error(`rpcFallbackUrls must use https:// on ${m.network}: ${url}.`)
    }
    if (m.friendbotUrl && !m.friendbotUrl.startsWith("https://")) {
      error(`friendbotUrl must use https:// on ${m.network}.`)
    }
  }

  const routerHash = m.wasmHashes?.router?.toLowerCase()
  // Own keys only: a hash such as "constructor" must not find a prototype member.
  const known = routerHash && Object.hasOwn(ROUTER_ABI_BY_WASM, routerHash) ? ROUTER_ABI_BY_WASM[routerHash] : undefined
  if (known !== undefined && known !== protocolAbi(m)) {
    error(`protocolAbi is ${protocolAbi(m)} but the Router code is the version-${known} one.`)
  }

  const seen = new Set<string>()
  for (const market of m.markets) {
    if (market.contracts.router !== m.shared.router) {
      error(`Market "${market.marketId}" router differs from shared.router.`)
    }
    if (seen.has(market.marketId)) error(`Duplicate marketId "${market.marketId}".`)
    seen.add(market.marketId)
  }

  return findings
}

/** One market record (e.g. a registry row's), checked against the manifest's market schema. */
export function parseMarket(json: unknown): Market {
  const parsed = marketSchema.safeParse(json)
  if (!parsed.success) throw new Error(`Invalid market: ${describe(parsed.error)}`)
  return parsed.data
}

export function getMarket(m: Manifest, marketId: string): Market | undefined {
  return m.markets.find((x) => x.marketId === marketId)
}
