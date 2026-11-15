// @vitest-environment node
/**
 * `scripts/dev-stack/drill.sh` on Testnet is the developer's run only (spec 0004 D-31, plan 0008
 * Task 12): it signs with the official keys, so it refuses CI, any key name but the official ones, and
 * a run without a terminal to confirm on. These checks run the script with `stellar` and `curl`
 * replaced by stubs that record any call: each refusal must come before the keystore or the network
 * is touched. Nothing here reaches Testnet; the local run is `tests/integration/drill.test.ts`.
 */
import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const DRILL = join(process.cwd(), "scripts", "dev-stack", "drill.sh")

let dir: string
let marker: string
let stubs: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "drill-guards-"))
  marker = join(dir, "calls.log")
  stubs = join(dir, "bin")
  mkdirSync(stubs)
  for (const tool of ["stellar", "curl"]) {
    const path = join(stubs, tool)
    writeFileSync(path, `#!/bin/sh\necho "${tool} $*" >> "${marker}"\nexit 97\n`)
    chmodSync(path, 0o755)
  }
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** Runs drill.sh with stdin, stdout and stderr on pipes (no terminal) and the stubs first on PATH. */
function drill(env: Record<string, string | undefined>, script: string = DRILL): Promise<{ code: number; stderr: string; stdout: string }> {
  const base: Record<string, string> = { PATH: `${stubs}:${process.env.PATH ?? ""}`, HOME: process.env.HOME ?? dir }
  const full: Record<string, string | undefined> = { ...base, ...env }
  for (const k of Object.keys(full)) if (full[k] === undefined) delete full[k]
  return new Promise((resolve) => {
    // Only these variables: CI, GITHUB_ACTIONS and key names of the test run never leak in.
    execFile("bash", [script], { env: full as NodeJS.ProcessEnv, timeout: 20_000, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      resolve({ code, stdout, stderr })
    })
  })
}

const calls = () => (existsSync(marker) ? readFileSync(marker, "utf8") : "")

describe("drill.sh on testnet refuses before touching the keystore or the network", () => {
  it("refuses to run from CI", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", CI: "true" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/never runs? (from|in) CI/i)
    expect(r.stdout).toBe("")
    expect(calls()).toBe("")
  })

  it("refuses GitHub Actions even without CI set", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", GITHUB_ACTIONS: "true" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/never runs? (from|in) CI/i)
    expect(calls()).toBe("")
  })

  it("refuses an agent session (CLAUDECODE)", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", CLAUDECODE: "1" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("The Testnet drill is run by the developer, not by an agent.")
    expect(calls()).toBe("")
  })

  it("refuses Stellar CLI variables that would change the network, source, signer or sending", async () => {
    for (const name of [
      "STELLAR_RPC_URL",
      "STELLAR_NETWORK_PASSPHRASE",
      "STELLAR_NETWORK",
      "STELLAR_ACCOUNT",
      "STELLAR_RPC_HEADERS",
      "STELLAR_SIGN_WITH_KEY",
      "STELLAR_SIGN_WITH_LEDGER",
      "STELLAR_SIGN_WITH_LAB",
      "STELLAR_SEND",
      "STELLAR_INVOKE_VIEW",
      // Another config directory: another `testnet`, another keystore.
      "STELLAR_CONFIG_HOME",
      // The CLI reads every SOROBAN_* name as its STELLAR_* twin: any of them is refused, known or not.
      "SOROBAN_RPC_URL",
      "SOROBAN_NETWORK_PASSPHRASE",
      "SOROBAN_SOMETHING_NEW",
    ]) {
      const r = await drill({ PRINCIPAL_NETWORK: "testnet", [name]: "x" })
      expect(r.code, name).not.toBe(0)
      expect(r.stderr, name).toContain(`${name} is set`)
      expect(calls()).toBe("")
    }
  })

  it("refuses another manifest on testnet, in the drill and in oracle-tick.sh", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet", DRILL_MANIFEST: join(dir, "m.json") })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/DRILL_MANIFEST and ORACLE_TICK_MANIFEST are for the local network only/)
    const tick = await drill({ PRINCIPAL_NETWORK: "testnet", ORACLE_TICK_MANIFEST: join(dir, "m.json") }, join(process.cwd(), "scripts", "dev-stack", "oracle-tick.sh"))
    expect(tick.code).not.toBe(0)
    expect(tick.stderr).toMatch(/ORACLE_TICK_MANIFEST is for the local network only/)
    expect(calls()).toBe("")
  })

  it("refuses key names other than the official ones", async () => {
    for (const name of ["ADMIN_KEY", "ORACLE_KEY", "ISSUER_KEY"]) {
      const r = await drill({ PRINCIPAL_NETWORK: "testnet", [name]: "e2e-123-admin" })
      expect(r.code, name).not.toBe(0)
      expect(r.stderr).toContain(name)
      expect(calls()).toBe("")
    }
  })

  it("refuses to run without a terminal", async () => {
    const r = await drill({ PRINCIPAL_NETWORK: "testnet" })
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/terminal/i)
    expect(r.stdout).toBe("")
    expect(calls()).toBe("")
  })

  it("refuses mainnet and any other network", async () => {
    for (const network of ["mainnet", "futurenet"]) {
      const r = await drill({ PRINCIPAL_NETWORK: network })
      expect(r.code, network).not.toBe(0)
      expect(r.stderr).toMatch(/local or testnet/)
      expect(calls()).toBe("")
    }
  })

  it("refuses an unknown step or a pause of a minute or more, on any network", async () => {
    const steps = await drill({ PRINCIPAL_NETWORK: "local", DRILL_STEPS: "recovery,finalize" })
    expect(steps.code).not.toBe(0)
    expect(steps.stderr).toMatch(/DRILL_STEPS/)
    const pause = await drill({ PRINCIPAL_NETWORK: "local", DRILL_PAUSE_SECONDS: "60" })
    expect(pause.code).not.toBe(0)
    expect(pause.stderr).toMatch(/DRILL_PAUSE_SECONDS/)
    expect(calls()).toBe("")
  })
})
