/**
 * What the live suites share on the local stack (`scripts/dev-stack`): the manifest, why a suite
 * cannot run, the dev stack's oracle tick and faucet key, and onboarding a fresh keypair. The chain
 * helpers every network shares (units, balances, the ledger clock, the log) live in `tests/live/`
 * and are re-exported here.
 *
 * Nothing here deploys or rewrites `config/manifests/local.json`: the developer may be testing on
 * that market (R2-68). Only the lifecycle suite may deploy, and only when asked to.
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { Keypair } from "@stellar/stellar-sdk"
import { fetchAccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { createHorizon } from "@/lib/protocol/horizon"
import { parseManifest } from "@/lib/protocol/manifest"
import { addTrustline } from "@/lib/protocol/onboarding"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer, getLedgerClock } from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"
import { createStellarFaucetChain, resetFaucetStateForTests, runFaucet } from "@/lib/server/faucet"
import { fundOnce } from "../live/context"
import { retryOnce } from "../live/retry"
import { eventually, json, redact } from "../live/util"
import { keypairSigner, type KeypairSigner } from "./keypair-signer"

export { eventually, json, redact, sleep } from "../live/util"
export {
  balancesOf,
  complianceKind,
  createLog,
  HISTORY_KIND,
  ledgerClock,
  MINUTE,
  showBalances,
  U,
  units,
  type Balances,
} from "../live/chain"

export const run = promisify(execFile)

export const DAPP = join(__dirname, "..", "..")
export const MANIFEST_PATH = join(DAPP, "config", "manifests", "local.json")
export const DEV_STACK = join(DAPP, "scripts", "dev-stack")

export function readManifest(): Manifest {
  return parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")))
}

/** Why a live suite cannot run here, or null: a local manifest and a healthy RPC are required. */
export async function skipReason(): Promise<string | null> {
  if (!existsSync(MANIFEST_PATH)) return "config/manifests/local.json does not exist"
  let manifest: Manifest
  try {
    manifest = readManifest()
  } catch (error) {
    return `config/manifests/local.json is not a valid manifest (${error instanceof Error ? error.message : String(error)})`
  }
  if (manifest.network !== "local") return `config/manifests/local.json is for "${manifest.network}", not "local"`
  try {
    const health = await createRpcServer(manifest.rpcUrl).getHealth()
    if (health.status !== "healthy") return `the local RPC reports "${health.status}"`
  } catch (error) {
    return `the local RPC does not answer (${error instanceof Error ? error.message : String(error)})`
  }
  return null
}

/** Seconds from the latest ledger to the first market's maturity. */
export async function runwaySeconds(manifest: Manifest): Promise<number> {
  return manifest.markets[0].maturity - (await getLedgerClock(createRpcServer(manifest.rpcUrl))).closeTime
}

/** The faucet key the dev stack wrote; read here, never printed. */
export function faucetIssuerSecret(): string {
  const prefix = "FAUCET_ISSUER_SECRET="
  const line = readFileSync(join(DAPP, ".env.local"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(prefix))
  if (!line) throw new Error(".env.local has no FAUCET_ISSUER_SECRET; run scripts/dev-stack/deploy.sh")
  return line.slice(prefix.length).trim()
}

/** `DATABASE_URL` for `principal-pg`, from `.env.local` when the environment has none; never printed. */
export function loadDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return
  try {
    for (const line of readFileSync(join(DAPP, ".env.local"), "utf8").split("\n")) {
      const m = /^DATABASE_URL=(.*)$/.exec(line.trim())
      if (m) process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, "")
    }
  } catch {
    /* no .env.local */
  }
}

/** `scripts/dev-stack/oracle-tick.sh` (admin key): default growth from the last reference time, or `rate`. */
export async function oracleTick(rate?: bigint): Promise<string> {
  const { stdout } = await run(join(DEV_STACK, "oracle-tick.sh"), rate === undefined ? [] : [rate.toString()], { cwd: DAPP })
  return redact(stdout.trim())
}

/**
 * A fresh keypair, onboarded as a user would be: Friendbot, the user's trustline, then the server
 * faucet on the real chain (authorize, grant account, PT, YT, pay 100,000 of the test asset).
 * `markets` is the faucet route's own list (`resolvedMarkets`: the seeds and the registry markets),
 * whose PT and YT the faucet grants; without it, the manifest's markets.
 */
export async function onboardFreshAccount(
  manifest: Manifest,
  market: Market,
  kind: ComplianceKind,
  markets?: () => Promise<Market[]>,
  /** The issuer's secret; the dev stack's `FAUCET_ISSUER_SECRET` when omitted. */
  issuerSecret?: string,
  /** The Permissioning admin's secret, when it is not the issuer. */
  permissioningAdminSecret?: string,
): Promise<KeypairSigner> {
  const signer = keypairSigner(Keypair.random(), manifest.networkPassphrase)
  const account = signer.publicKey
  const read = () => fetchAccountState(createRpcReader(manifest), createHorizon(manifest.horizonUrl), manifest, market.marketId, account, kind)
  // Friendbot and the trustline are retried once after an external failure (a run on Testnet: plan
  // 0007), as the endpoint mode does; locally the first try succeeds.
  const exists = async () => {
    const a = await read()
    return a.accountExists.status === "live" && a.accountExists.value
  }
  await fundOnce({ manifest, account, exists })
  await eventually(read, (a) => a.accountExists.status === "live" && a.accountExists.value, "the funded account on Horizon")
  await retryOnce({
    what: `the trustline of ${account}`,
    run: () =>
      addTrustline({
        manifest,
        account,
        asset: { code: market.underlying.code, issuer: market.underlying.issuer },
        sign: (xdr) => signer.sign(xdr, manifest.networkPassphrase, account),
      }),
    nothingLanded: async () => {
      const a = await read()
      return a.trustline.status === "live" && a.trustline.value === "none"
    },
    log: (line) => console.info(`[live] ${line}`),
  })
  await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value !== "none", "the trustline on Horizon")
  resetFaucetStateForTests()
  const chain = createStellarFaucetChain(manifest, {
    env: {
      FAUCET_ISSUER_SECRET: issuerSecret ?? faucetIssuerSecret(),
      ...(permissioningAdminSecret ? { FAUCET_PERMISSIONING_ADMIN_SECRET: permissioningAdminSecret } : {}),
    },
  })
  const outcome = await runFaucet({ account, manifest, ...(markets ? { markets } : {}), ip: "127.0.0.1", now: Date.now(), chain })
  if (!("performed" in outcome)) throw new Error(`faucet refused: ${json(outcome)}`)
  await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value === "authorized", "the authorized trustline on Horizon")
  return signer
}
