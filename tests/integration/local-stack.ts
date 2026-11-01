/**
 * What the live suites share on the local stack (`scripts/dev-stack`): the manifest, why a suite
 * cannot run, the dev stack's oracle tick and faucet key, onboarding a fresh keypair, and the log
 * each suite prints again at the end.
 *
 * Nothing here deploys or rewrites `config/manifests/local.json`: the developer may be testing on
 * that market (R2-68). Only the lifecycle suite may deploy, and only when asked to.
 */
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { fetchAccountState, type AccountState, type ComplianceKind } from "@/lib/protocol/account-state"
import { fetchMarketCompliance } from "@/lib/protocol/compliance"
import { createHorizon } from "@/lib/protocol/horizon"
import { parseManifest } from "@/lib/protocol/manifest"
import { addTrustline } from "@/lib/protocol/onboarding"
import { createRpcReader } from "@/lib/protocol/reader"
import { createRpcServer, getLedgerClock } from "@/lib/protocol/stellar"
import type { Manifest, Market } from "@/lib/protocol/types"
import { createStellarFaucetChain, resetFaucetStateForTests, runFaucet } from "@/lib/server/faucet"
import { fundedKeypairSigner, type KeypairSigner } from "./keypair-signer"

export const run = promisify(execFile)

export const DAPP = join(__dirname, "..", "..")
export const MANIFEST_PATH = join(DAPP, "config", "manifests", "local.json")
export const DEV_STACK = join(DAPP, "scripts", "dev-stack")

/** One whole token at 7 decimals. */
export const U = 10_000_000n
export const MINUTE = 60_000

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

/** Secret keys (S + 55 base32 characters) never reach a log or an error. */
export const redact = (text: unknown) => String(text ?? "").replace(/S[A-Z2-7]{55}/g, "S…[redacted]")

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls `read` until `done` holds (Horizon trails RPC by a ledger or two). */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(1_000)
  }
}

/** JSON that survives bigints (results and outcomes carry them). */
export const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))

/** A log whose lines are printed as they come and again, all together, at the end of the suite. */
export function createLog(prefix = "integration") {
  const lines: string[] = []
  return {
    lines,
    log(line: string) {
      const safe = redact(line)
      lines.push(safe)
      console.info(`[${prefix}] ${safe}`)
    },
    summary() {
      console.info(`[${prefix}] summary\n${lines.join("\n")}`)
    },
  }
}

/** `scripts/dev-stack/oracle-tick.sh` (admin key): default growth from the last reference time, or `rate`. */
export async function oracleTick(rate?: bigint): Promise<string> {
  const { stdout } = await run(join(DEV_STACK, "oracle-tick.sh"), rate === undefined ? [] : [rate.toString()], { cwd: DAPP })
  return redact(stdout.trim())
}

/** The live ledger clock, interpolated between reads. */
export async function ledgerClock(manifest: Manifest) {
  const clock = await getLedgerClock(createRpcServer(manifest.rpcUrl))
  return { ...clock, now: () => clock.closeTime + (Date.now() - clock.readAtMs) / 1000 }
}

/** The market's compliance model kind (`sac` for the dev stack's USDY). */
export async function complianceKind(manifest: Manifest, market: Market): Promise<ComplianceKind> {
  const model = await fetchMarketCompliance(createHorizon(manifest.horizonUrl), createRpcReader(manifest), market)
  if (model.status !== "live") throw new Error(`compliance model: ${model.error}`)
  return model.value.kind
}

/**
 * A fresh keypair, onboarded as a user would be: Friendbot, the user's trustline, then the server
 * faucet on the real chain (authorize, grant account, PT, YT, pay 100,000 of the test asset).
 */
export async function onboardFreshAccount(manifest: Manifest, market: Market, kind: ComplianceKind): Promise<KeypairSigner> {
  const signer = await fundedKeypairSigner(manifest)
  const account = signer.publicKey
  const read = () => fetchAccountState(createRpcReader(manifest), createHorizon(manifest.horizonUrl), manifest, market.marketId, account, kind)
  await eventually(read, (a) => a.accountExists.status === "live" && a.accountExists.value, "the funded account on Horizon")
  await addTrustline({
    manifest,
    account,
    asset: { code: market.underlying.code, issuer: market.underlying.issuer },
    sign: (xdr) => signer.sign(xdr, manifest.networkPassphrase, account),
  })
  await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value !== "none", "the trustline on Horizon")
  resetFaucetStateForTests()
  const chain = createStellarFaucetChain(manifest, { env: { FAUCET_ISSUER_SECRET: faucetIssuerSecret() } })
  const outcome = await runFaucet({ account, manifest, ip: "127.0.0.1", now: Date.now(), chain })
  if (!("performed" in outcome)) throw new Error(`faucet refused: ${json(outcome)}`)
  await eventually(read, (a) => a.trustline.status === "live" && a.trustline.value === "authorized", "the authorized trustline on Horizon")
  return signer
}

/** Balances of `account` in this market, raw: USDY, SY, PT, YT, LP. */
export type Balances = Record<"underlying" | "sy" | "pt" | "yt" | "lp", bigint>

export function balancesOf(acc: AccountState): Balances {
  const v = (l: AccountState["underlying"], what: string) => {
    if (l.status !== "live") throw new Error(`${what}: ${l.error}`)
    return l.value
  }
  return { underlying: v(acc.underlying, "USDY"), sy: v(acc.sy, "SY"), pt: v(acc.pt, "PT"), yt: v(acc.yt, "YT"), lp: v(acc.lp, "LP") }
}

/** `1234567890n` at 7 decimals as "123.4567890". */
export function units(v: bigint, decimals = 7): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  return `${neg ? "-" : ""}${a / base}.${(a % base).toString().padStart(decimals, "0")}`
}

export const showBalances = (b: Balances) =>
  `USDY ${units(b.underlying)}, SY ${units(b.sy)}, PT ${units(b.pt)}, YT ${units(b.yt)}, LP ${units(b.lp)}`
