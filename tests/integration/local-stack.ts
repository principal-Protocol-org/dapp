/**
 * What the live suites share on the local stack (`scripts/dev-stack`): the manifest, its second
 * market, why a suite cannot run, the dev stack's oracle tick and faucet key, and onboarding a fresh
 * keypair (through the faucet, or with the issuer's own steps on any market). The chain
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

/**
 * `scripts/dev-stack/oracle-tick.sh` (admin key): every oracle of the manifest grows by the default rate
 * from its own last reference time, or only `oracle` (`ORACLE_TICK_ORACLE`). A `rate` is one oracle's
 * value: it goes to `oracle`, by default the manifest's first oracle (`shared.oracle`).
 */
export async function oracleTick(rate?: bigint, oracle?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ORACLE_TICK_ORACLE
  const target = oracle ?? (rate === undefined ? undefined : readManifest().shared.oracle)
  if (target) env.ORACLE_TICK_ORACLE = target
  const { stdout } = await run(join(DEV_STACK, "oracle-tick.sh"), rate === undefined ? [] : [rate.toString()], { cwd: DAPP, env })
  return redact(stdout.trim())
}

/** The local stack's second market (`deploy.sh` makes it on its own asset and oracle), or a clear error. */
export function secondMarket(manifest: Manifest): Market {
  const market = manifest.markets[1]
  if (!market) {
    throw new Error(
      `the ${manifest.network} manifest lists ${manifest.markets.length} market(s), not two: run scripts/dev-stack/deploy.sh without SECOND_MARKET=0 (local only) for the second market`,
    )
  }
  return market
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

/** The dev stack's one local key: issuer, SAC admin and Permissioning admin of every local asset (`common.sh`). */
const LOCAL_ADMIN_KEY = "principal-localdev-admin"

/** The Stellar CLI on the local network, as the local admin; never inherits a Stellar CLI override. */
async function localCli(what: string, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (/^(STELLAR|SOROBAN)_/.test(k)) delete env[k]
  try {
    const { stdout } = await run("stellar", args, { cwd: DAPP, env })
    return stdout.trim()
  } catch (error) {
    const e = error as { stderr?: string; message?: string }
    throw new Error(`${what} failed: ${redact((e.stderr || e.message || String(error)).trim())}`)
  }
}

/**
 * Onboards `account` on `market` with the issuer's own steps, as `scripts/dev-stack/drill.sh` does on
 * the local network, so it works on either market (the faucet pays only the manifest's `testAsset`):
 * Friendbot when the account does not exist yet, its trustline to the market's underlying (signed with
 * its own key), then, signed by the local admin key through the Stellar CLI, the trustline's
 * authorization, `grant_account`, `grant_asset` for the market's PT and YT, and a payment of 100,000
 * of the underlying. It returns once Horizon and the contracts show all of it. Local network only.
 */
export async function onboardWithIssuer(manifest: Manifest, market: Market, account: Keypair): Promise<void> {
  if (manifest.network !== "local") {
    throw new Error(`onboardWithIssuer is for the local network only: this manifest is for "${manifest.network}"`)
  }
  const id = account.publicKey()
  const { code, issuer, decimals } = market.underlying
  const asset = `${code}:${issuer}`
  const amount = 100_000n * 10n ** BigInt(decimals)
  const read = () => fetchAccountState(createRpcReader(manifest), createHorizon(manifest.horizonUrl), manifest, market.marketId, id, "sac")

  const admin = await localCli(`reading the ${LOCAL_ADMIN_KEY} address`, ["keys", "address", LOCAL_ADMIN_KEY])
  if (admin !== issuer) throw new Error(`${LOCAL_ADMIN_KEY} (${admin}) is not the ${code} issuer (${issuer}): nothing was signed`)

  const exists = async () => {
    const a = await read()
    return a.accountExists.status === "live" && a.accountExists.value
  }
  if (!(await exists())) {
    await fundOnce({ manifest, account: id, exists })
    await eventually(exists, Boolean, `${id} funded, on Horizon`)
  }
  const first = await read()
  if (first.trustline.status !== "live" || first.trustline.value === "none") {
    const signer = keypairSigner(account, manifest.networkPassphrase)
    await addTrustline({ manifest, account: id, asset: { code, issuer }, sign: (xdr) => signer.sign(xdr, manifest.networkPassphrase, id) })
    await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value !== "none", `the ${code} trustline of ${id} on Horizon`)
  }

  const as = ["--source", LOCAL_ADMIN_KEY, "--network", "local"]
  const invoke = (what: string, contract: string, fn: string[]) => localCli(what, ["contract", "invoke", "--id", contract, ...as, "--", ...fn])
  await localCli(`authorizing the ${code} trustline`, ["tx", "new", "set-trustline-flags", ...as, "--asset", asset, "--trustor", id, "--set-authorize"])
  const perm = manifest.shared.permissioning
  await invoke("grant_account", perm, ["grant_account", "--caller", issuer, "--account", id])
  // PT and YT check the account against the allow-list for each token when they mint (is_allowed_for_asset).
  await invoke("grant_asset (PT)", perm, ["grant_asset", "--caller", issuer, "--account", id, "--asset", market.contracts.pt])
  await invoke("grant_asset (YT)", perm, ["grant_asset", "--caller", issuer, "--account", id, "--asset", market.contracts.yt])
  // The CLI's payment amount is in the asset's smallest unit (stroops at 7 decimals).
  await localCli(`the ${code} payment`, ["tx", "new", "payment", ...as, "--destination", id, "--asset", asset, "--amount", amount.toString()])

  await eventually(
    read,
    (a) =>
      a.trustline.status === "live" &&
      a.trustline.value === "authorized" &&
      a.underlying.status === "live" &&
      a.underlying.value >= amount &&
      [a.permAllowed, a.permPt, a.permYt].every((p) => p.status === "live" && p.value),
    `${id} onboarded on ${market.marketId} (authorized ${code} trustline, 100,000 ${code}, allow-listed)`,
  )
}
