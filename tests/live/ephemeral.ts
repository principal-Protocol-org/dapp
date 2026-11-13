/**
 * Suite B's throwaway Testnet market (plan 0007, R7-2, ruling S1): run-unique key names, the
 * ephemeral deploy (`scripts/dev-stack/deploy.sh` with `EPHEMERAL=1`), the run's own secrets read
 * from the Stellar CLI keystore in-process, and their removal afterwards.
 *
 * Every keystore call here is for one of the run's own names (`e2e-<runId>-<role>`), checked before
 * the call: an official name (`principal-…`) is never read, used or removed. A secret is held in
 * memory only, never printed; every line of the deploy goes through `redact` before it is shown.
 */
import { execFile, spawn } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import { StrKey } from "@stellar/stellar-sdk"
import { redact } from "./util"

const execFileAsync = promisify(execFile)

export type Role = "admin" | "treasury" | "issuer" | "oracle"
export const ROLES: readonly Role[] = ["admin", "treasury", "issuer", "oracle"]
export type KeyNames = Record<Role, string>
/** An environment as `process.env` holds it. */
export type Env = Record<string, string | undefined>

/** deploy.sh's rule for a testnet key name, and its reserved prefix (any letter case). */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const OFFICIAL_PREFIX = /^principal[-_]/i

/**
 * This run's id: the CI run and attempt when there is one, else the clock, then the process id.
 * Only letters, digits and `-`, so the key names stay plain keystore names.
 */
export function runIdFrom(env: Env = process.env, now: number = Date.now(), pid: number = process.pid): string {
  const parts = [env.GITHUB_RUN_ID || String(now), env.GITHUB_RUN_ATTEMPT || "0", String(pid)]
  return parts.map((p) => p.replace(/[^A-Za-z0-9]/g, "")).join("-")
}

/** The four role names of a run: `e2e-<runId>-<role>`, plain, distinct and never an official name. */
export function keyNamesFor(runId: string): KeyNames {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(runId)) throw new Error(`run id "${runId}" is not letters, digits and -`)
  const names = Object.fromEntries(ROLES.map((role) => [role, `e2e-${runId}-${role}`])) as KeyNames
  for (const role of ROLES) assertPlainRunName(names[role])
  return names
}

function assertPlainRunName(name: string): void {
  if (!PLAIN_NAME.test(name)) throw new Error(`"${name}" is not a plain keystore name`)
  if (OFFICIAL_PREFIX.test(name)) throw new Error(`"${name}" is an official key name; a run never touches it`)
}

/** `name` must be one of this run's names: the only names the suite may read or remove. */
export function assertRunKey(name: string, names: KeyNames): void {
  assertPlainRunName(name)
  if (!ROLES.some((role) => names[role] === name)) throw new Error(`"${name}" is not one of this run's keys`)
}

/**
 * The environment of the ephemeral deploy: the caller's, with every deploy variable set here so a
 * leftover one (an official key name, `ALLOW_TESTNET_OVERRIDES`, another `MANIFEST_OUT`) never reaches
 * it. The contracts are pinned to `sourceCommit`, never to a branch head.
 */
export function ephemeralDeployEnv(p: {
  base: Env
  names: KeyNames
  manifestOut: string
  sourceCommit: string
  maturitySeconds: number
  oracleMaxStaleSeconds: number
}): Env {
  if (!/^[0-9a-f]{40}$/.test(p.sourceCommit)) throw new Error(`source commit "${p.sourceCommit}" is not a full commit hash`)
  for (const role of ROLES) assertPlainRunName(p.names[role])
  const env: Env = { ...p.base }
  for (const k of ["ALLOW_TESTNET_OVERRIDES", "ASSET_CODE", "RPC_URL", "HORIZON_URL", "FRIENDBOT_URL"]) delete env[k]
  return {
    ...env,
    EPHEMERAL: "1",
    PRINCIPAL_NETWORK: "testnet",
    MANIFEST_OUT: p.manifestOut,
    PRINCIPAL_REF: p.sourceCommit,
    MATURITY_SECONDS: String(p.maturitySeconds),
    ORACLE_MAX_STALE_SECONDS: String(p.oracleMaxStaleSeconds),
    ADMIN_KEY: p.names.admin,
    TREASURY_KEY: p.names.treasury,
    ISSUER_KEY: p.names.issuer,
    ORACLE_KEY: p.names.oracle,
  }
}

/** The lines of the deploy worth showing as it runs: its own steps and its errors. */
export const isDeployStep = (line: string) => line.startsWith("==>") || line.startsWith("error:")

/**
 * Runs `scripts/dev-stack/deploy.sh` with `env`. Each line is redacted, kept (the last `keep` of
 * them), and passed to `onLine`. Resolves with the duration and the kept lines; on a non-zero exit
 * or a timeout, rejects with the redacted tail.
 */
export function runDeploy(p: {
  dappDir: string
  env: Env
  onLine?: (line: string) => void
  timeoutMs: number
  keep?: number
}): Promise<{ seconds: number; tail: string[] }> {
  const keep = p.keep ?? 60
  const started = Date.now()
  const tail: string[] = []
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [join(p.dappDir, "scripts", "dev-stack", "deploy.sh")], { cwd: p.dappDir, env: p.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] })
    const timer = setTimeout(() => child.kill("SIGTERM"), p.timeoutMs)
    const reader = () => {
      let rest = ""
      return (chunk: Buffer) => {
        const lines = (rest + chunk.toString("utf8")).split(/\r?\n/)
        rest = lines.pop() ?? ""
        for (const raw of lines) {
          const line = redact(raw)
          tail.push(line)
          if (tail.length > keep) tail.shift()
          p.onLine?.(line)
        }
      }
    }
    child.stdout.on("data", reader())
    child.stderr.on("data", reader())
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(new Error(`deploy.sh could not start: ${redact(error.message)}`))
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      const seconds = Math.round((Date.now() - started) / 1_000)
      if (code === 0) resolve({ seconds, tail })
      else reject(new Error(`deploy.sh failed after ${seconds} s (${signal ? `signal ${signal}` : `exit ${code}`}):\n${tail.join("\n")}`))
    })
  })
}

/** Whether the keystore holds `name` (a local read, no network). */
export async function keyExists(name: string): Promise<boolean> {
  assertPlainRunName(name)
  try {
    await execFileAsync("stellar", ["keys", "address", name])
    return true
  } catch {
    return false
  }
}

/** The public key of one of this run's keys. */
export async function runKeyAddress(name: string, names: KeyNames): Promise<string> {
  assertRunKey(name, names)
  const { stdout } = await execFileAsync("stellar", ["keys", "address", name])
  const address = stdout.trim()
  if (!StrKey.isValidEd25519PublicKey(address)) throw new Error(`the keystore gave no address for ${name}`)
  return address
}

/**
 * The secret of one of this run's keys, read in-process to sign; never printed. An official name
 * is refused before the keystore is asked.
 */
export async function runKeySecret(name: string, names: KeyNames): Promise<string> {
  assertRunKey(name, names)
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync("stellar", ["keys", "secret", name]))
  } catch (error) {
    throw new Error(`could not read the secret of ${name}: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 300)}`)
  }
  const secret = stdout.trim()
  if (!StrKey.isValidEd25519SecretSeed(secret)) throw new Error(`the keystore did not return a secret key for ${name}`)
  return secret
}

/**
 * Removes every one of this run's keys that exists (`stellar keys rm --force`), whatever happened
 * before. Returns the names removed and the failures, each redacted; never throws.
 */
export async function removeRunKeys(names: KeyNames): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = []
  const failed: string[] = []
  for (const role of ROLES) {
    const name = names[role]
    try {
      assertRunKey(name, names)
      if (!(await keyExists(name))) continue
      await execFileAsync("stellar", ["keys", "rm", name, "--force"])
      if (await keyExists(name)) failed.push(`${name}: still in the keystore`)
      else removed.push(name)
    } catch (error) {
      failed.push(`${name}: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`)
    }
  }
  return { removed, failed }
}
